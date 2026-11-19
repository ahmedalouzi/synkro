import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { FLUTTER_SYSTEM_PROMPT } from '../src/prompts/flutter-system';

/**
 * The chat reply as on the website's Live Demo: "Thought for Ns", the one-line plan, compact steps (with Blocked,
 * Added package and Waiting for your approval + its card), ONE card for all the files of a run (N files, +/-, a list
 * that opens, Undo All / Keep All / Review), "Fast Refresh … ms · device", and a short final answer. Renders the real
 * AgentRun in Electron (Windows and macOS, Linux with a display).
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const desktop = path.join(root, 'apps/desktop');

export default async function run() {
  console.log('  [chat-design] The agent writes short replies in the user\'s language, without its own files or extra instructions...');
  assert.match(FLUTTER_SYSTEM_PROMPT, /Your FINAL message is 1-3 short sentences/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /Never mention the agent's own files \(\.peep\/plan\.md, \.peep\/walkthrough\.md, \.peep\/\*\)/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /never add instructions the user did not ask for \(e\.g\. where a built APK ends up/);
  const orchestrator = fs.readFileSync(path.join(root, 'packages/agent/src/orchestrator.ts'), 'utf8');
  assert.match(orchestrator, /if \(typeof assistantMessage\.content === 'string' && assistantMessage\.content\.trim\(\)\) callbacks\.onDelta\('\\n\\n'\);/,
    'the plan sentence and the final answer are separate paragraphs');
  assert.match(orchestrator, /In one to three short sentences, in the language of my last message/);
  const chat = fs.readFileSync(path.join(desktop, 'src/renderer/src/layout/ChatPane.tsx'), 'utf8');
  assert.doesNotMatch(chat, /cx-changes__bar/, 'no second, flat list of changed files under the chat');

  if (process.platform === 'linux' && !process.env.DISPLAY) {
    console.log('  (skipped rendering AgentRun: no display)');
    return;
  }
  const requireDesktop = createRequire(path.join(desktop, 'package.json'));
  const esbuild = createRequire(requireDesktop.resolve('vite'))('esbuild') as typeof import('esbuild');
  const electronDir = path.dirname(requireDesktop.resolve('electron/package.json'));
  const electron = path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim());
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-design-'));
  const fixtures = path.join(root, 'packages/agent/tests/fixtures/chat-design');
  try {
    console.log('  [chat-design] Rendering the real AgentRun with a 15-file run...');
    const common = { bundle: true, logLevel: 'error' as const, nodePaths: [path.join(desktop, 'node_modules')] };
    await esbuild.build({ ...common, entryPoints: [path.join(fixtures, 'harness-main.ts')], outfile: path.join(out, 'main.js'), platform: 'node', format: 'cjs', external: ['electron'] });
    await esbuild.build({
      ...common, entryPoints: [path.join(fixtures, 'harness-renderer.tsx')], outfile: path.join(out, 'renderer.js'),
      platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    });
    fs.writeFileSync(path.join(out, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="renderer.css"></head><body><div id="root"></div><script src="renderer.js"></script></body></html>');
    const resultFile = path.join(out, 'result.json');
    const env = { ...process.env, HARNESS_DIR: out, RESULT_FILE: resultFile };
    delete (env as any).ELECTRON_RUN_AS_NODE;
    const runE = spawnSync(electron, [path.join(out, 'main.js')], { env, timeout: 60_000, encoding: 'utf8' });
    assert.ok(fs.existsSync(resultFile), `Electron wrote no result (status ${runE.status}): ${runE.stderr?.slice(-2000)}`);
    const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(r.error, undefined, String(r.error));

    assert.equal(r.thought, 'Thought for 4s');
    assert.equal(r.plan, "I'll add the camera screen and its tab.");
    const steps: string[] = r.steps;
    assert.ok(steps.some((s) => /^Read.*lib\/main\.dart/.test(s)), 'Read');
    assert.ok(steps.some((s) => /^Searched.*NavigationBar/.test(s)), 'Searched');
    assert.ok(steps.some((s) => /Added package: expo-camera/.test(s)), 'Added package');
    assert.ok(steps.some((s) => /^Blocked.*taskkill.*Stopping processes by name/.test(s)), 'Blocked with its reason');
    assert.ok(steps.some((s) => /^Waiting for your approval.*git checkout -b demo/.test(s)), 'waiting step');
    assert.ok(steps.some((s) => /Fast Refresh.*412 ms · iPhone 15/.test(s)), 'Fast Refresh');
    assert.ok(!steps.some((s) => /screen_\d+\.dart/.test(s)), 'files are not steps');
    assert.equal(r.approvalCards, 1, 'the approval card under the steps');
    assert.equal(r.fileCards, 1, 'ONE card for all the files');
    assert.equal(r.perFileCards, 0, 'no card per file');
    assert.match(r.filesHead, /15 files changed\+150.*Ready to review/);
    assert.equal(r.rowsClosed, 0, 'many files: one line until opened');
    assert.equal(r.rowsOpen, 15, 'opens to the list of files');
    assert.deepEqual(r.buttons, ['Undo All', 'Keep All', 'Review']);
    assert.deepEqual(r.calls, ['undo 15', 'keep 15', 'review'], 'the buttons act on all the run\'s files');
  } finally {
    try {
      fs.rmSync(out, { recursive: true, force: true });
    } catch {
      // Electron may still hold its cache folder for a moment on Windows.
    }
  }
  console.log('  🟢 Chat design passed.');
}
