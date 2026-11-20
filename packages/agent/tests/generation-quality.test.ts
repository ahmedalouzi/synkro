import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AIGateway, AIRequest, AIStreamEvent } from '@peep/shared';
import {
  FailureGate, OncePerFailure, autoFixBlocked, describeFlutterError, escapedDartInterpolations, failureSignature, parsePreviewRuntimeReport,
  runtimeFixMessage,
} from '@peep/shared';
import { parseFlutterAnalyze } from '@peep/flutter-adapter';
import { RunVerification, runAgentLoop, SELF_CHECK_MAX_ROUNDS } from '../src/orchestrator';
import { dartStringIssues, selfCheckErrors } from '../src/verification/self-check';
import { FLUTTER_SYSTEM_PROMPT } from '../src/prompts/flutter-system';
import { formatPreviewReport } from '../../../apps/desktop/src/main/services/preview-log';
import { previewEntrySource } from '../../../apps/desktop/src/main/services/flutter-preview-entry';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

/** `flutter analyze` (Flutter 3.44) on the two errors from a real barber app, captured in synkro/flutter-sandbox:2. */
const REAL_ANALYZE = `Analyzing app...

warning • The value of the local variable 'selectedTotal' isn't used. Try removing the variable or using it • lib/screens/home_screen.dart:6:18 • unused_local_variable
  error • Undefined name 'CrossAlignment'. Try correcting the name to one that is defined, or defining the name • lib/screens/home_screen.dart:7:39 • undefined_identifier
  error • Too many positional arguments: 0 expected, but 1 found. Try removing the extra positional arguments, or specifying the name for named arguments • lib/screens/explore_screen.dart:8:82 • extra_positional_arguments_could_be_named

3 issues found. (ran in 8.0s)`;

/** What the preview entry recorded for a real overflow (flutter run -d web-server, debug, in the sandbox). */
const REAL_OVERFLOW = 'A RenderFlex overflowed by 399 pixels on the right. (lib/screens/booking_bar.dart:6:12)';

type Step = { text: string } | { tool: string; args?: Record<string, unknown> };
class ScriptedGateway implements AIGateway {
  requests: AIRequest[] = [];
  constructor(private steps: Step[]) {}
  getContextLimit() { return 100000; }
  async generate(): Promise<never> { throw new Error('not used'); }
  async estimateCost() { return { cost: 0, currency: 'USD' as const }; }
  async *stream(request: AIRequest): AsyncIterable<AIStreamEvent> {
    this.requests.push(JSON.parse(JSON.stringify(request)));
    const step = this.steps.shift() ?? { text: '(script ended)' };
    if ('tool' in step) yield { type: 'tool_call', toolCall: { id: `call-${this.requests.length}`, name: step.tool, arguments: step.args ?? {} } } as AIStreamEvent;
    else yield { type: 'delta', content: step.text } as AIStreamEvent;
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: { cost: 0, currency: 'USD' } } as AIStreamEvent;
  }
}
const CLEAN_PREVIEW = formatPreviewReport({ url: 'http://localhost:8080', processId: 1, status: 'running' }, 'Serving\n', {
  errors: [], rendered: true, textChars: 300, overlay: '', layout: [],
});

async function run(steps: Step[], checks: Array<string[] | null>) {
  const gateway = new ScriptedGateway(steps);
  const executed: string[] = [];
  const toolResults: string[] = [];
  let selfChecks = 0;
  await runAgentLoop(
    { capabilityTier: 'fast', sessionToken: 'gq_tok', gateway },
    'sys',
    [{ role: 'user', content: 'Build the booking screen' }],
    {
      execute: async (name) => {
        executed.push(name);
        if (name === 'restart_preview') return CLEAN_PREVIEW;
        if (name === 'validate_project') return JSON.stringify({ success: true, checks: [] });
        return 'Proposed edit applied to lib/screens/home_screen.dart.';
      },
      selfCheck: async () => {
        selfChecks++;
        return checks.length ? checks.shift()! : [];
      },
    },
    { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {} },
    new AbortController().signal,
  );
  for (const r of gateway.requests) {
    const last = r.messages[r.messages.length - 1];
    if (last && (last.role === 'tool' || last.role === 'user')) toolResults.push(String(last.content));
  }
  return { executed, toolResults, selfChecks, requests: gateway.requests.length };
}

export default async function runTest() {
  console.log('  [genq] flutter analyze: errors are found (they are indented), warnings do not block...');
  const diags = parseFlutterAnalyze(REAL_ANALYZE);
  assert.deepEqual(diags.filter((d) => d.severity === 'error').map((d) => `${d.file}:${d.line}`), [
    'lib/screens/home_screen.dart:7', 'lib/screens/explore_screen.dart:8',
  ]);
  assert.equal(diags.filter((d) => d.severity === 'warning').length, 1);
  const flutterService = read('apps/desktop/src/main/services/flutter-service.ts');
  assert.doesNotMatch(flutterService, /async validateProject\(_projectPath: string\): Promise<any> \{\s*return \{ success: true/, 'no stub that always passes');
  assert.match(flutterService, /output = await this\.runCommand\(\['analyze'\], root\);/);

  console.log('  [genq] The self-check errors from validate_project (Flutter and React Native)...');
  assert.deepEqual(selfCheckErrors({
    success: false, framework: 'flutter', environment: 'local', blockingErrors: 2, warnings: 1, errorCategory: 'compile_error',
    checks: [{ type: 'flutter analyze', success: false, exitCode: 1, stdout: '', stderr: '', errors: ['lib/a.dart:7:39: error: Undefined name', 'lib/b.dart:8:82: error: Too many positional arguments'] }],
  }), ['lib/a.dart:7:39: error: Undefined name', 'lib/b.dart:8:82: error: Too many positional arguments']);
  assert.deepEqual(selfCheckErrors({
    success: false, framework: 'react-native', environment: 'managed', blockingErrors: 1, warnings: 0, errorCategory: 'type_error',
    checks: [{ type: 'tsc', success: false, exitCode: 2, stdout: "src/App.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\nFound 1 error.", stderr: '' }],
  }), ["src/App.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'."]);
  assert.deepEqual(selfCheckErrors({ success: true, framework: 'flutter', environment: 'local', blockingErrors: 0, warnings: 3, errorCategory: 'success', checks: [{ type: 'flutter analyze', success: true, exitCode: 0, stdout: 'No errors.', stderr: '' }] }), []);

  console.log('  [genq] The engine checks the code before the preview starts, up to 3 rounds...');
  {
    // Compile errors, fixed on the second check: the first restart_preview is refused, the second runs.
    const r = await run([
      { tool: 'propose_file_edit', args: { path: 'lib/screens/home_screen.dart', content: 'x' } },
      { tool: 'restart_preview' },
      { tool: 'patch_file', args: { path: 'lib/screens/home_screen.dart', oldText: 'a', newText: 'b' } },
      { tool: 'restart_preview' },
      { text: 'Done. The booking screen works.' },
    ], [["lib/screens/home_screen.dart:7:39: error: Undefined name 'CrossAlignment'"], []]);
    assert.deepEqual(r.executed, ['propose_file_edit', 'patch_file', 'restart_preview'], 'the preview started only once the code compiled');
    const refused = r.toolResults.find((t) => t.startsWith('Not run: the preview was not started'));
    assert.ok(refused && refused.includes("Undefined name 'CrossAlignment'") && refused.includes(`check 1 of ${SELF_CHECK_MAX_ROUNDS}`), refused);
    assert.equal(r.selfChecks, 2);
  }
  {
    // It tries to finish with errors: it gets the errors back instead, at most 3 times; then the run ends.
    const r = await run([
      { tool: 'propose_file_edit', args: { path: 'lib/a.dart', content: 'x' } },
      { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' }, { text: 'Done.' },
    ], [['e1'], ['e1'], ['e1'], ['e1']]);
    assert.equal(r.selfChecks, SELF_CHECK_MAX_ROUNDS, 'never more than 3 rounds');
    assert.equal(r.toolResults.filter((t) => t.startsWith('[Atomvs] Not done yet: the project does not compile')).length, SELF_CHECK_MAX_ROUNDS);
  }
  {
    // No change, or a check that cannot run (no SDK): nothing is blocked.
    const none = await run([{ text: 'Hi!' }], []);
    assert.equal(none.selfChecks, 0);
    const cannot = await run([{ tool: 'propose_file_edit', args: { path: 'lib/a.dart', content: 'x' } }, { tool: 'restart_preview' }, { text: 'Done.' }], [null, null]);
    assert.deepEqual(cannot.executed, ['propose_file_edit', 'restart_preview']);
  }
  // The model's own clean validate_project counts: no extra analyze run.
  {
    const r = await run([
      { tool: 'propose_file_edit', args: { path: 'lib/a.dart', content: 'x' } },
      { tool: 'validate_project' },
      { tool: 'restart_preview' },
      { text: 'Done.' },
    ], []);
    assert.equal(r.selfChecks, 0);
  }
  const ipc = read('apps/desktop/src/main/ipc/index.ts');
  assert.match(ipc, /if \(agentSvc\.isRunning\(\)\) return;/, 'no auto-reload while the agent writes files');
  const agentService = read('apps/desktop/src/main/services/agent-service.ts');
  assert.match(agentService, /if \(this\.reloadAfterRun && this\.preview\?\.getSession\(\)\?\.status === 'running'\) this\.preview\.reload\(\);/);

  console.log('  [genq] (b) Auto-Fix Build: once per failure, never while the agent works...');
  const gate = new FailureGate();
  assert.equal(gate.claim(false), false, 'no failure yet');
  gate.noteFailure();
  assert.equal(gate.claim(true), false, 'agent busy');
  assert.equal(gate.claim(false), true, 'first click');
  assert.equal(gate.claim(false), false, 'second click / double click: same failure');
  assert.equal(gate.sent, true);
  gate.noteFailure();
  assert.equal(gate.sent, false, 'a new failure (Retry) allows it again');
  assert.equal(gate.claim(false), true);
  const chat = read('apps/desktop/src/renderer/src/layout/ChatPane.tsx');
  assert.match(chat, /const handleTriggerAgent = \(e: Event\) => \{[\s\S]{0,300}if \(useChatStore\.getState\(\)\.isStreaming\) return;/, 'the chat ignores a trigger while the agent works');
  const preview = read('apps/desktop/src/renderer/src/layout/PreviewPane.tsx');
  assert.match(preview, /if \(!fixGate\.current\.claim\(useChatStore\.getState\(\)\.isStreaming\)\) return;/);
  assert.match(preview, /disabled=\{!project \|\| agentBusy \|\| fixSent\}/);
  assert.match(preview, /\}, \[failedError, session\?\.status\]\);/, 'one failure per status/error change, not per session object');

  console.log('  [genq] (c) Flutter errors from the preview: captured, described, sent once (deduped)...');
  const entry = previewEntrySource('barber', false);
  assert.match(entry, /FlutterError\.onError = \(FlutterErrorDetails details\) \{/);
  assert.match(entry, /\(previous \?\? FlutterError\.presentError\)\(details\);/, 'Flutter still prints them');
  assert.match(entry, /void reassemble\(\) \{[\s\S]{0,200}_atomvsErrors\.clear\(\);/, 'hot reload clears the old errors');
  assert.match(entry, /split\('\\n'\)/, 'Dart escapes survive the template');
  assert.match(read('apps/desktop/src/preload/preview-safe-area-page.ts'), /__atomvsFlutterErrors[\s\S]{0,200}kind: 'flutter-error'/);
  const report = parsePreviewRuntimeReport({ type: 'atomvs:runtime', errors: [{ kind: 'flutter-error', message: REAL_OVERFLOW }], rendered: true, textChars: 10, overlay: '', layout: [] });
  assert.ok(report && report.errors[0].kind === 'flutter-error');
  const text = formatPreviewReport({ url: 'http://x', processId: 1, status: 'running' }, '', report);
  assert.match(text, /Runtime errors in the page \(1[\s\S]*\[flutter-error\] A RenderFlex overflowed by 399 pixels on the right\. \(lib\/screens\/booking_bar\.dart:6:12\) Fix: in that Row\/Column, wrap long text and prices in Flexible or Expanded/);
  assert.ok(new RunVerification() instanceof RunVerification);
  const v = new RunVerification();
  v.record('change', 'ok');
  v.record('preview', formatPreviewReport({ url: 'http://x', processId: 1, status: 'running' }, '', { errors: [], rendered: true, textChars: 9, overlay: '', layout: [{ kind: 'too-many-tabs', message: 'x' }] }));
  assert.ok(v.gaps().includes('the preview shows errors or an empty screen'), 'layout problems count as a failed preview');
  assert.match(describeFlutterError('Vertical viewport was given unbounded height.'), /Expanded/);

  const once = new OncePerFailure(3);
  assert.equal(failureSignature(REAL_OVERFLOW), failureSignature('A RenderFlex overflowed by 204 pixels on the right. (lib/screens/booking_bar.dart:9:3)'));
  assert.deepEqual(once.claimAll([REAL_OVERFLOW, REAL_OVERFLOW]), [REAL_OVERFLOW], 'one per failure');
  assert.deepEqual(once.claimAll(['A RenderFlex overflowed by 204 pixels on the right. (lib/screens/booking_bar.dart:6:12)']), [], 'the same overflow with another pixel count');
  assert.deepEqual(once.claimAll(['unbounded height', 'setState during build', 'null check']), ['unbounded height', 'setState during build'], 'at most 3 per project');
  once.reset();
  assert.deepEqual(once.claimAll([REAL_OVERFLOW]), [REAL_OVERFLOW], 'another project starts fresh');
  assert.match(runtimeFixMessage([REAL_OVERFLOW]), /^The running preview reported Flutter errors[\s\S]*restart_preview[\s\S]*\n- A RenderFlex overflowed by 399 pixels[\s\S]*Fix:/);
  assert.match(preview, /runtimeFixes\.current\.claimAll\(runtimeErrors\)/);
  assert.match(preview, /if \(!project \|\| agentBusy \|\| runtimeErrors\.length === 0\) return;/, 'only while the agent is idle');

  console.log('  [genq] Automatic layout fixes use credits: never with none left, never into a paused or blocked run...');
  const idle = { agentBusy: false, pendingApprovals: 0, lastRunInterrupted: false, creditsRemaining: 120 };
  assert.equal(autoFixBlocked(idle), null);
  assert.equal(autoFixBlocked({ ...idle, creditsRemaining: undefined }), null, 'credits unknown (own key): allowed');
  assert.equal(autoFixBlocked({ ...idle, creditsRemaining: 0 }), 'no-credits');
  assert.equal(autoFixBlocked({ ...idle, creditsRemaining: -3 }), 'no-credits');
  assert.equal(autoFixBlocked({ ...idle, pendingApprovals: 1 }), 'approval', 'a run waiting for an approval is blocked');
  assert.equal(autoFixBlocked({ ...idle, lastRunInterrupted: true }), 'paused', 'stopped by the user, or failed');
  assert.equal(autoFixBlocked({ ...idle, agentBusy: true }), 'busy');
  // The window: the fresh credits, the rule before claiming (a blocked send is not counted), one short line in chat.
  assert.match(preview, /creditsRemaining = \(await window\.peep\.authGetAccount\(\)\)\?\.creditsRemaining;/);
  assert.match(preview, /if \(cancelled \|\| blocked\) return;\s+const fresh = runtimeFixes\.current\.claimAll\(runtimeErrors\);/);
  assert.match(preview, /display: t\('chat\.autoLayoutFix'\)/);
  assert.match(chat, /content: display \?\? message,/);
  assert.match(chat, /setLastRunInterrupted\(true\); void window\.peep\.cancelAgent\(\);/, 'Stop pauses automatic fixes');
  const events = read('apps/desktop/src/renderer/src/hooks/usePeepEvents.ts');
  assert.match(events, /event\.type === 'done'\) \{\s+useChatStore\.getState\(\)\.setLastRunInterrupted\(false\);/);
  assert.match(events, /event\.type === 'error'\) \{\s+useChatStore\.getState\(\)\.setLastRunInterrupted\(true\);/);
  for (const lang of ['en', 'ar', 'tr']) {
    assert.ok(JSON.parse(read(`apps/desktop/src/renderer/src/i18n/locales/${lang}.json`)).chat.autoLayoutFix, `${lang}: chat.autoLayoutFix`);
  }

  console.log('  [genq] (d) Dart strings: a dead \\${…} is flagged; \\$${…} (a price with $) is not...');
  const dart = [
    "Text('Total: \\${selectedTotal.toStringAsFixed(2)}'),",
    "Text('\\$${selectedTotal.toStringAsFixed(2)}'),",
    "Text('${count} items'),",
    "// Text('\\${commented}'),",
    "/* Text('\\${block}') */",
    "const url = 'https://example.com/a';",
  ].join('\n');
  assert.deepEqual(escapedDartInterpolations(dart).map((h) => h.line), [1]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genq-'));
  try {
    fs.mkdirSync(path.join(tmp, 'lib', 'screens'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'lib', 'screens', 'cart.dart'), `class A {}\n${dart}\n`);
    fs.writeFileSync(path.join(tmp, 'lib', 'main.dart'), "void main() { print('\\$${1}'); }\n");
    const issues = await dartStringIssues(tmp);
    assert.equal(issues.length, 1);
    assert.match(issues[0], /^lib\/screens\/cart\.dart:2: error: `\\\$\{…\}` in a string shows the text literally[\s\S]*'\\\$\$\{value\.toStringAsFixed\(2\)\}'/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  assert.match(agentService, /errors\.push\(\.\.\.await dartStringIssues\(root\)\)/, 'part of the self-check');
  assert.match(agentService, /Warning: \$\{escapedInterpolationMessage\(rel, hits\)\}/, 'and flagged right after the write');

  console.log('  [genq] (e) Prompt rules: exact API names, interpolation, overflow-safe layout at 360 px...');
  for (const needle of [
    'CrossAxisAlignment / MainAxisAlignment (never CrossAlignment',
    "ListTile(subtitle: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [Text(...), Text(...)]))",
    "A price with a dollar sign: '\\$${total.toStringAsFixed(2)}'",
    "Never write '\\${...}'",
    'Flexible or Expanded with maxLines: 1 (or 2) and overflow: TextOverflow.ellipsis',
    'so the whole bar fits 360 px',
  ]) assert.ok(FLUTTER_SYSTEM_PROMPT.includes(needle), needle);
  console.log('  🟢 Passed');
}
