import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

/**
 * "Review Changes" with many files: a user saw only grey lines for 15 proposed files. The cards are flex items of the
 * scrolling list and had overflow: hidden, so their minimum height was 0 and they shrank to fit the list (about 30 px
 * each for 15 files) instead of the list scrolling. Renders the real DiffViewer, with its CSS, in Electron at an
 * editor's size, with 3, 15 and 40 new files. Runs on Windows and macOS, and on Linux with a display.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const desktop = path.join(root, 'apps/desktop');

export default async function run() {
  if (process.platform === 'linux' && !process.env.DISPLAY) {
    console.log('  (skipped the Review Changes layout check: no display)');
    return;
  }
  const requireDesktop = createRequire(path.join(desktop, 'package.json'));
  const esbuild = createRequire(requireDesktop.resolve('vite'))('esbuild') as typeof import('esbuild');
  // The binary itself (electron/path.txt), not require('electron'): another test may have stubbed that module.
  const electronDir = path.dirname(requireDesktop.resolve('electron/package.json'));
  const electron = path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim());
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'review-changes-'));
  const fixtures = path.join(root, 'packages/agent/tests/fixtures/review-changes');
  try {
    console.log('  [review] Rendering the real DiffViewer with 3, 15 and 40 new files...');
    const common = { bundle: true, logLevel: 'error' as const, nodePaths: [path.join(desktop, 'node_modules')] };
    await esbuild.build({ ...common, entryPoints: [path.join(fixtures, 'harness-main.ts')], outfile: path.join(out, 'main.js'), platform: 'node', format: 'cjs', external: ['electron'] });
    await esbuild.build({
      ...common, entryPoints: [path.join(fixtures, 'harness-renderer.tsx')], outfile: path.join(out, 'renderer.js'),
      platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
    });
    fs.writeFileSync(path.join(out, 'index.html'),
      '<!doctype html><html><head><link rel="stylesheet" href="renderer.css"></head><body style="margin:0"><div id="root"></div><script src="renderer.js"></script></body></html>');

    const resultFile = path.join(out, 'result.json');
    const env = { ...process.env, HARNESS_DIR: out, RESULT_FILE: resultFile };
    delete (env as any).ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electron, [path.join(out, 'main.js')], { env, timeout: 60_000, encoding: 'utf8' });
    assert.ok(fs.existsSync(resultFile), `Electron wrote no result (status ${run.status}): ${run.stderr?.slice(-2000)}`);
    const r = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    assert.equal(r.error, undefined, String(r.error));

    for (const files of [3, 15, 40]) {
      const m = r[files];
      assert.equal(m.cards, files, `${files} cards`);
      const smallest = Math.min(...m.heights);
      assert.ok(smallest >= 150, `${files} files: every card keeps its size (smallest ${smallest} px; heights ${m.heights.join(', ')})`);
      assert.ok(m.headerVisible.every(Boolean), `${files} files: every header fits`);
      assert.ok(Math.min(...m.patchShown) >= 100, `${files} files: every diff is visible (${m.patchShown.join(', ')})`);
    }
    assert.equal(r[15].listScrolls, true, 'many files: the list scrolls instead of squeezing the cards');
  } finally {
    try {
      fs.rmSync(out, { recursive: true, force: true });
    } catch {
      // Electron may still hold its cache folder for a moment on Windows.
    }
  }
  console.log('  🟢 Review Changes layout passed.');
}
