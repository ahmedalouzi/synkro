import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * The approval card, end to end in a real Electron: main (ApprovalService + registerApprovalIpc) <-> the real
 * preload (window.peep) <-> the window (the real ApprovalCard and store). Allow once (Enter), Always allow (click),
 * Reject (Esc) for a file deletion without an "Always" button, no answer (cancelAll), a reloaded window, and answers
 * the window may not give. Runs on Windows and macOS, and on Linux with a display; skipped otherwise.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const desktop = path.join(root, 'apps/desktop');

export default async function run() {
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    console.log('  (skipped the Electron approval round-trip: no display)');
    return;
  }
  const requireDesktop = createRequire(path.join(desktop, 'package.json'));
  const esbuild = createRequire(requireDesktop.resolve('vite'))('esbuild') as typeof import('esbuild');
  const electron = requireDesktop('electron') as unknown as string;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-ipc-'));
  const fixtures = path.join(root, 'packages/agent/tests/fixtures/approval-ipc');
  try {
    console.log('  [approval-ipc] Bundling the real preload, main services and ApprovalCard...');
    const common = { bundle: true, logLevel: 'error' as const, nodePaths: [path.join(desktop, 'node_modules')] };
    await esbuild.build({ ...common, entryPoints: [path.join(desktop, 'src/preload/index.ts')], outfile: path.join(out, 'preload.js'), platform: 'node', format: 'cjs', external: ['electron'] });
    await esbuild.build({ ...common, entryPoints: [path.join(fixtures, 'harness-main.ts')], outfile: path.join(out, 'main.js'), platform: 'node', format: 'cjs', external: ['electron'] });
    await esbuild.build({
      ...common, entryPoints: [path.join(fixtures, 'harness-renderer.tsx')], outfile: path.join(out, 'renderer.js'),
      platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' },
    });
    fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="renderer.js"></script></body></html>');

    console.log('  [approval-ipc] Running it in Electron...');
    const resultFile = path.join(out, 'result.json');
    const env = { ...process.env, HARNESS_DIR: out, RESULT_FILE: resultFile, ELECTRON_ENABLE_LOGGING: '0' };
    delete (env as any).ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electron, [path.join(out, 'main.js')], { env, timeout: 60_000, encoding: 'utf8' });
    assert.ok(fs.existsSync(resultFile), `Electron wrote no result (status ${run.status}): ${run.stderr?.slice(-2000)}`);
    const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(r.error, undefined, String(r.error));

    assert.equal(r.focusedOnShow, true, 'the card takes the keyboard when the user is not typing');
    assert.match(r.alwaysButtonText, /Always allow "gradlew assembleDebug" in this project/);
    assert.equal(r.r1, 'allow-once', 'Enter = Allow once');
    assert.equal(r.r2, 'always', 'the Always allow button');
    assert.deepEqual(r.deleteButtons.map((b: string) => b.replace(/(Enter|Esc)$/, '').trim()), ['Delete', 'Reject'], 'no "Always" for deleting');
    assert.match(r.deleteText, /Restore checkpoint/);
    assert.equal(r.r3, 'reject', 'Esc = Reject');
    assert.equal(r.r4, 'no-answer', 'a new message / Stop: no answer, the card goes away');
    assert.equal(r.r5, 'allow-once', 'a reloaded window shows the waiting card again');
    assert.equal(r.forgedAlways, false, '"always" where it was not offered is refused');
    assert.equal(r.unknownId, false);
    assert.equal(r.stillPending, 1);
    assert.equal(r.r6, 'reject');
  } finally {
    try {
      fs.rmSync(out, { recursive: true, force: true });
    } catch {
      // Electron may still hold its cache folder for a moment on Windows.
    }
  }
  console.log('  🟢 Approval IPC round-trip passed.');
}
