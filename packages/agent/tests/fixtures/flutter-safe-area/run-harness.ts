/**
 * Runs the Flutter safe-area harness: bundles the real preload and harness-main, starts Electron, returns what the
 * Flutter app reported per device. Shared by flutter-safe-area.test.ts and manual checks.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

export interface HarnessDevice {
  id: string;
  width: number;
  height: number;
  insets: { top: number; right: number; bottom: number; left: number };
}

export interface FlutterReport {
  size: [number, number];
  padding: [number, number, number, number];
  viewPadding: [number, number];
  title: [number, number];
  nav: [number, number];
  runtime: { layout: Array<{ kind: string; message: string }> } | null;
}

export async function runFlutterHarness(root: string, webDir: string, devices: HarnessDevice[]): Promise<Record<string, FlutterReport | null>> {
  const desktop = path.join(root, 'apps/desktop');
  const requireDesktop = createRequire(path.join(desktop, 'package.json'));
  const esbuild = createRequire(requireDesktop.resolve('vite'))('esbuild') as typeof import('esbuild');
  const electronDir = path.dirname(requireDesktop.resolve('electron/package.json'));
  const electron = path.join(electronDir, 'dist', fs.readFileSync(path.join(electronDir, 'path.txt'), 'utf8').trim());
  const fixtures = path.join(root, 'packages/agent/tests/fixtures/flutter-safe-area');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-safe-area-'));
  try {
    const common = { bundle: true, logLevel: 'error' as const, nodePaths: [path.join(desktop, 'node_modules')], platform: 'node' as const, format: 'cjs' as const, external: ['electron'] };
    await esbuild.build({ ...common, entryPoints: [path.join(desktop, 'src/preload/index.ts')], outfile: path.join(out, 'preload.js') });
    await esbuild.build({ ...common, entryPoints: [path.join(fixtures, 'harness-main.ts')], outfile: path.join(out, 'main.js') });
    fs.copyFileSync(path.join(fixtures, 'host.html'), path.join(out, 'host.html'));
    const resultFile = path.join(out, 'result.json');
    const env = { ...process.env, HARNESS_DIR: out, RESULT_FILE: resultFile, WEB_DIR: webDir, DEVICES: JSON.stringify(devices) };
    delete (env as any).ELECTRON_RUN_AS_NODE;
    const run = spawnSync(electron, [path.join(out, 'main.js')], { env, timeout: 180_000, encoding: 'utf8' });
    if (!fs.existsSync(resultFile)) throw new Error(`Electron wrote no result (status ${run.status}): ${run.stderr?.slice(-2000)}`);
    const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
    if (result.error) throw new Error(result.error);
    return result;
  } finally {
    try {
      fs.rmSync(out, { recursive: true, force: true });
    } catch {
      // Electron may still hold its cache folder for a moment on Windows.
    }
  }
}
