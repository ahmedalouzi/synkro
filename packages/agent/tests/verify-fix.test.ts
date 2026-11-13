import type { AIGateway, AIRequest, AIStreamEvent } from '@peep/shared';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parsePreviewRuntimeReport, parseProposedEditsPayload } from '@peep/shared';
import { changesDependencies, fastRefreshHint, toExpoInstall } from '../../../apps/desktop/src/main/services/expo-deps';
import { PREVIEW_ENTRY } from '../../../apps/desktop/src/main/services/providers/react-native-managed';
import { runAgentLoop, verificationRole, VERIFY_REMINDER } from '../src/orchestrator';
import { buildAgentContext } from '../src/context/builder';
import { OPENAI_TOOLS } from '../src/tools/definitions';
import { formatPreviewReport, PreviewLog, waitForBundle } from '../../../apps/desktop/src/main/services/preview-log';
import { userProjectEnv } from '../../../apps/desktop/src/main/services/process-manager';

type Step = { text: string } | { tool: string; args?: Record<string, unknown> };

/** A model that plays a fixed script, one step per call, and records what it was sent. */
class ScriptedGateway implements AIGateway {
  requests: AIRequest[] = [];
  constructor(private steps: Step[]) {}
  getContextLimit() { return 100000; }
  async generate(): Promise<never> { throw new Error('not used'); }
  async estimateCost() { return { cost: 0, currency: 'USD' as const }; }
  async *stream(request: AIRequest): AsyncIterable<AIStreamEvent> {
    this.requests.push(JSON.parse(JSON.stringify(request)));
    const step = this.steps.shift() ?? { text: '(script ended)' };
    if ('tool' in step) {
      yield { type: 'tool_call', toolCall: { id: `call-${this.requests.length}`, name: step.tool, arguments: step.args ?? {} } } as AIStreamEvent;
    } else {
      yield { type: 'delta', content: step.text } as AIStreamEvent;
    }
    yield { type: 'done', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, cost: { cost: 0, currency: 'USD' } } as AIStreamEvent;
  }
}

const RUNNING = { url: 'http://localhost:8081', processId: 1, status: 'running' as const };
const BUNDLED = 'Web Bundled 812ms index.js (363 modules)\n';
/** The black screen from the field: the bundle builds, the page crashes before React mounts anything. */
const CRASHED = formatPreviewReport(RUNNING, BUNDLED, {
  errors: [{ kind: 'exception', message: 'TypeError: (0 , _expoModulesCore.registerWebModule) is not a function' }],
  rendered: false, textChars: 0, overlay: '',
});
const CLEAN = formatPreviewReport(RUNNING, BUNDLED, { errors: [], rendered: true, textChars: 412, overlay: '' });
const TYPES_OK = JSON.stringify({ success: true, checks: [{ type: 'tsc', success: true }] }, null, 2);
const TYPES_FAIL = JSON.stringify({ success: false, checks: [{ type: 'tsc', success: false, stdout: "src/screens/TodoScreen.tsx(12,7): error TS2322: Type 'string' is not assignable to type 'number'." }] }, null, 2);

async function run(userText: string, steps: Step[], results: Record<string, string[]> = {}) {
  const gateway = new ScriptedGateway(steps);
  let text = '';
  await runAgentLoop(
    { capabilityTier: 'fast', sessionToken: 'verify_tok', gateway },
    'sys',
    [{ role: 'user', content: userText }],
    { execute: async (name) => results[name]?.shift() ?? (name === 'patch_file' ? 'PATCH SUCCESS' : 'ok') },
    { onStatus: () => {}, onDelta: (d) => { text += d; }, onError: () => {}, onDone: () => {} },
    new AbortController().signal,
  );
  const sentReminder = gateway.requests.some((r) => JSON.stringify(r.messages).includes('[Atomvs] When you have finished changing the app'));
  return { text, calls: gateway.requests.length, sentReminder };
}

export default async function runTests() {
  console.log('  [verify] The rule is in the system prompt and the agent can read and restart the preview...');
  const prompt = buildAgentContext({ userMessage: 'x' });
  for (const needle of ['VERIFY BEFORE CLAIMING DONE OR FIXED', 'restart_preview', 'get_preview_logs', 'validate_project', 'visible content yes']) {
    if (!prompt.includes(needle)) throw new Error(`System prompt is missing "${needle}"`);
  }
  const toolNames = OPENAI_TOOLS.map((t: { function: { name: string } }) => t.function.name);
  for (const name of ['get_preview_logs', 'restart_preview', 'validate_project']) {
    if (!toolNames.includes(name)) throw new Error(`Tool ${name} is not offered to the model`);
  }

  console.log('  [verify] Tool roles...');
  const roles = [
    verificationRole('patch_file', { path: 'src/App.tsx' }),
    verificationRole('propose_file_edit', { path: '.peep/plan.md' }),
    verificationRole('propose_file_edit', { path: 'README.md' }),
    verificationRole('run_command', { command: 'npx expo install expo-font' }),
    verificationRole('run_command', { command: 'npx tsc --noEmit' }),
    verificationRole('run_command', { command: 'ls' }),
    verificationRole('validate_project', {}),
    verificationRole('restart_preview', {}),
    verificationRole('read_file', { path: 'App.tsx' }),
  ].join(',');
  if (roles !== 'change,,,deps,typecheck,,typecheck,preview,') throw new Error(`verificationRole: ${roles}`);

  console.log('  [verify] Feature "done" with no checks: reminded, one turn to check, the crash shows, marked not verified...');
  {
    const r = await run('Add a to-do screen', [
      { tool: 'patch_file', args: { path: 'src/screens/TodoScreen.tsx' } },
      { text: 'Başarıyla eklendi.' },
      { tool: 'restart_preview' },
      { text: 'The page still crashes: registerWebModule is not a function.' },
    ], { restart_preview: [CRASHED] });
    if (!r.sentReminder) throw new Error('No reminder at the first change');
    if (r.calls !== 4) throw new Error(`Expected a check turn (4 model calls), got ${r.calls}`);
    if (!r.text.includes('**Not verified:**') || !r.text.includes('the type check was not run') || !r.text.includes('registerWebModule')) {
      throw new Error(`Missing not-verified mark with the error: ${r.text}`);
    }
  }

  console.log('  [verify] Both checks clean after the change: no extra turn, no mark...');
  {
    const r = await run('Add a to-do screen', [
      { tool: 'patch_file', args: { path: 'src/screens/TodoScreen.tsx' } },
      { tool: 'validate_project' },
      { tool: 'restart_preview' },
      { text: 'Added the to-do screen; it renders with no errors.' },
      { text: 'unexpected extra turn' },
    ], { validate_project: [TYPES_OK], restart_preview: [CLEAN] });
    if (r.calls !== 4 || r.text.includes('unexpected') || r.text.includes('Not verified')) throw new Error(`Interfered with a verified run: ${r.text}`);
  }

  console.log('  [verify] Type error found, fixed and re-checked: accepted...');
  {
    const r = await run('Add a counter', [
      { tool: 'patch_file', args: { path: 'src/screens/TodoScreen.tsx' } },
      { tool: 'validate_project' },
      { tool: 'patch_file', args: { path: 'src/screens/TodoScreen.tsx' } },
      { tool: 'validate_project' },
      { tool: 'restart_preview' },
      { text: 'Done: types are clean and the screen renders.' },
    ], { validate_project: [TYPES_FAIL, TYPES_OK], restart_preview: [CLEAN] });
    if (r.calls !== 6 || r.text.includes('Not verified')) throw new Error(`Re-checked fix not accepted: ${r.text}`);
  }

  console.log('  [verify] A check that predates the last change does not count...');
  {
    const r = await run('Fix the preview error', [
      { tool: 'validate_project' },
      { tool: 'restart_preview' },
      { tool: 'patch_file', args: { path: 'babel.config.js' } },
      { text: 'Fixed.' },
      { text: 'Fixed, really.' },
    ], { validate_project: [TYPES_OK], restart_preview: [CLEAN] });
    if (!r.text.includes('**Not verified:**')) throw new Error('Unchecked final change was not marked');
  }

  console.log('  [verify] No change to the app (a question, or plan notes): no reminder, no extra turn...');
  {
    const q = await run('What does App.tsx do?', [{ tool: 'read_file', args: { path: 'App.tsx' } }, { text: 'It renders the login screen.' }, { text: 'x' }]);
    const notes = await run('Plan a login screen', [{ tool: 'propose_file_edit', args: { path: '.peep/plan.md' } }, { text: 'Plan written.' }, { text: 'x' }]);
    if (q.sentReminder || q.calls !== 2 || notes.sentReminder || notes.calls !== 2) throw new Error('Guard fired without a change to the app');
  }
  if (!VERIFY_REMINDER.includes('restart_preview')) throw new Error('Reminder does not name restart_preview');

  console.log('  [verify] Preview report: server output and the page...');
  if (!CRASHED.includes('visible content NO') || !CRASHED.includes('Runtime errors in the page (1') || !CRASHED.includes('registerWebModule')) {
    throw new Error(`Crash not in the report:\n${CRASHED}`);
  }
  if (!CLEAN.includes('visible content yes') || !CLEAN.includes('No runtime errors in the page')) throw new Error('Clean report');
  if (!formatPreviewReport(RUNNING, BUNDLED, null).includes('no report from the app page yet')) throw new Error('Missing page report not stated');
  if (!formatPreviewReport(null, '').includes('not running')) throw new Error('Report for no preview');
  const stale = formatPreviewReport(RUNNING, "Error [ERR_PACKAGE_PATH_NOT_EXPORTED]: Package subpath './src/lib/TerminalReporter'\n", null);
  if (!stale.includes('Error lines in the output (1')) throw new Error('Server error line not surfaced');

  console.log('  [verify] Runtime reports from the page are validated...');
  const good = parsePreviewRuntimeReport({ errors: [{ kind: 'exception', message: 'x'.repeat(5000) }], rendered: false, textChars: 0, overlay: '' });
  if (!good || good.errors[0].message.length !== 1500) throw new Error('Report not capped');
  for (const bad of [null, 'x', { errors: [{ kind: 'eval', message: 'x' }], rendered: true, textChars: 1, overlay: '' },
    { errors: [], rendered: 'yes', textChars: 1, overlay: '' }, { errors: 'x', rendered: true, textChars: 1, overlay: '' }]) {
    if (parsePreviewRuntimeReport(bad) !== null) throw new Error(`Accepted a bad report: ${JSON.stringify(bad)}`);
  }

  console.log('  [verify] Preview log...');
  const log = new PreviewLog(50);
  log.add('a'.repeat(40));
  log.add('Web Bundled 10ms');
  if (log.get().length > 50 || !log.get().endsWith('Web Bundled 10ms\n')) throw new Error('PreviewLog cap');
  let out = 'Starting Metro\n';
  setTimeout(() => { out += 'Web Bundled 900ms\n'; }, 30);
  const t0 = Date.now();
  await waitForBundle(() => 'running', () => out, 2000, 10);
  if (Date.now() - t0 > 1000) throw new Error('waitForBundle did not return on "Bundled"');

  console.log('  [verify] Processes for user projects do not inherit the Atomvs repo (pnpm dev)...');
  const sep = process.platform === 'win32' ? ';' : ':';
  const { env, removed } = userProjectEnv({
    NODE_PATH: 'C:\\peep\\node_modules\\.pnpm\\node_modules',
    npm_config_user_agent: 'pnpm/9', npm_lifecycle_event: 'dev', PNPM_SCRIPT_SRC_DIR: 'C:\\peep', INIT_CWD: 'C:\\peep',
    Path: ['C:\\peep\\apps\\desktop\\node_modules\\.bin', 'C:\\peep\\node_modules\\.bin', 'C:\\Program Files\\nodejs', 'C:\\Windows'].join(sep),
    HOME: 'C:\\Users\\me',
  });
  const left = Object.keys(env).sort().join(',');
  if (left !== 'HOME,Path') throw new Error(`Env keys left: ${left}`);
  if (env.Path !== ['C:\\Program Files\\nodejs', 'C:\\Windows'].join(sep)) throw new Error(`PATH: ${env.Path}`);
  if (!removed.includes('NODE_PATH') || !removed.some((r) => r.startsWith('Path (2'))) throw new Error(`removed: ${removed.join(', ')}`);

  console.log('  [expo] npm install <pkg> in an Expo project becomes npx expo install <pkg>...');
  const rewrites: Array<[string, string | null]> = [
    ['npm install @expo/vector-icons', 'npx expo install @expo/vector-icons'],
    ['npm i expo-font react-native-svg', 'npx expo install expo-font react-native-svg'],
    ['yarn add expo-image@^1.0.0', 'npx expo install expo-image'],
    ['npm i react-native-screens@4', 'npx expo install react-native-screens'], // the SDK decides
    // A library expo install does not know keeps the version asked for (React Navigation 6 on SDK 51).
    ['npm install @react-navigation/native@^6 @react-navigation/bottom-tabs@^6', 'npx expo install @react-navigation/native@^6 @react-navigation/bottom-tabs@^6'],
    ['pnpm add -D @types/react', 'npx expo install @types/react -- --save-dev'],
    ['npm install', null], // reinstall: nothing to rewrite
    ['npm install -g eas-cli', null], // global
    ['npm install x --legacy-peer-deps', null], // other flags: left as asked
    ['npm install x && npm test', null], // compound
    ['npx expo install expo-font', null], // already right
  ];
  for (const [command, expected] of rewrites) {
    const got = toExpoInstall(command);
    if (got !== expected) throw new Error(`toExpoInstall(${command}) = ${got}, expected ${expected}`);
  }
  if (!changesDependencies('npm i x') || changesDependencies('npx expo install --check') || changesDependencies('npm test')) {
    throw new Error('changesDependencies');
  }

  console.log('  [expo] A package change whose dependency check fails keeps the run unverified...');
  {
    const r = await run('Add icons', [
      { tool: 'run_command', args: { command: 'npm install @expo/vector-icons' } },
      { tool: 'validate_project' },
      { tool: 'restart_preview' },
      { text: 'Icons added.' },
      { text: 'Icons added, really.' },
    ], {
      run_command: ['Rewrote "npm install @expo/vector-icons" to "npx expo install @expo/vector-icons".\nCommand exited with code 0.\n\nnpx expo install --check:\nCommand exited with code 1.\nOutput:\nexpo-font@58.0.11 - expected version: ~12.0.10'],
      validate_project: [TYPES_OK.replace('"checks": [', '"checks": [{ "type": "tsc", "success": true },')], restart_preview: [CLEAN],
    });
    if (!r.text.includes("do not match the project's Expo SDK")) throw new Error(`Failed dependency check not reported: ${r.text}`);
  }
  {
    const r = await run('Add icons', [
      { tool: 'run_command', args: { command: 'npx expo install @expo/vector-icons' } },
      { tool: 'validate_project' },
      { tool: 'restart_preview' },
      { text: 'Icons added.' },
    ], {
      run_command: ['Command exited with code 0.\n\nnpx expo install --check:\nCommand exited with code 0.\nOutput:\nDependencies are up to date'],
      validate_project: [TYPES_OK], restart_preview: [CLEAN],
    });
    if (r.text.includes('Not verified') || r.calls !== 4) throw new Error(`Clean dependency change not accepted: ${r.text}`);
  }
  // A JS library whose peers need a newer SDK passes expo's check; npm ls catches it (Cloud Build's npm ci: ERESOLVE).
  {
    const r = await run('Add tabs', [
      { tool: 'run_command', args: { command: 'npx expo install @react-navigation/bottom-tabs' } },
      { tool: 'validate_project' },
      { tool: 'restart_preview' },
      { text: 'Tabs added.' },
      { text: 'Tabs added, really.' },
    ], {
      run_command: ['Command exited with code 0.\n\nnpx expo install --check:\nCommand exited with code 0.\nOutput:\nDependencies are up to date'
        + '\n\nnpm ls --depth=0:\nCommand exited with code 1.\nOutput:\n+-- react-native-screens@3.31.1 invalid: ">= 4.0.0" from node_modules/@react-navigation/bottom-tabs'],
      validate_project: [TYPES_OK.replace('"checks": [', '"checks": [{ "type": "tsc", "success": true },')], restart_preview: [CLEAN],
    });
    if (!r.text.includes('peer dependencies')) throw new Error(`Unmet peer dependency not reported: ${r.text}`);
  }
  if (verificationRole('run_command', { command: 'npm ls --depth=0' }) !== 'depscheck') throw new Error('npm ls is a dependency check');

  console.log('  [expo] New projects get Fast Refresh on the web; older entries get a hint...');
  if (!PREVIEW_ENTRY.startsWith("import '@expo/metro-runtime';")) throw new Error('Entry does not import metro-runtime first');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fast-refresh-'));
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'index.js', dependencies: { expo: '~51.0.0' } }));
    fs.writeFileSync(path.join(dir, 'index.js'), "import { registerRootComponent } from 'expo';\n");
    if (!(await fastRefreshHint(dir))?.includes("'@expo/metro-runtime'")) throw new Error('No hint for an entry without metro-runtime');
    fs.writeFileSync(path.join(dir, 'index.js'), PREVIEW_ENTRY);
    if (await fastRefreshHint(dir)) throw new Error('Hint for an entry that imports metro-runtime');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { expo: '~51.0.0' } }));
    if (!(await fastRefreshHint(dir))?.includes('expo/AppEntry')) throw new Error('No hint for the default AppEntry');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'expo-router/entry', dependencies: { expo: '~51.0.0', 'expo-router': '~3.5.0' } }));
    if (await fastRefreshHint(dir)) throw new Error('Hint for an expo-router app (it imports metro-runtime itself)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log('  [chat] Proposed-edits events: { edits, threadId } is read, anything else dropped...');
  const edit = { id: 'e1', path: 'App.tsx', originalContent: '', proposedContent: 'x' };
  const fromMain = parseProposedEditsPayload({ edits: [edit], threadId: 't1' });
  if (fromMain?.edits.length !== 1 || fromMain.threadId !== 't1') throw new Error('Main payload not read');
  if (parseProposedEditsPayload([edit])?.edits.length !== 1) throw new Error('Plain array not read');
  for (const bad of [null, undefined, {}, { edits: 'x' }, { edits: { 0: edit } }, 'edits']) {
    if (parseProposedEditsPayload(bad) !== null) throw new Error(`Accepted ${JSON.stringify(bad)}`);
  }

  console.log('  v Verify-before-claiming tests passed.');
}
