import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { flutterEnvironmentMessage, parseFlutterEnvironmentProblem, syncedFolderOf, FLUTTER_STARTUP_LOCK_LINE } from '@peep/shared';
import { FLUTTER_SYSTEM_PROMPT } from '../src/prompts/flutter-system';
import { ProcessManager } from '../../../apps/desktop/src/main/services/process-manager';
import { FlutterService, isFlutterCommand, lockedSdkPath, sdkFromPath } from '../../../apps/desktop/src/main/services/flutter-service';

/**
 * A user's preview failed with "Waiting for another flutter command to release the startup lock..." and "Flutter
 * failed to delete a directory at C:\Users\<user>\OneDrive\Desktop\flutter\.pub-preload-cache": the Flutter SDK was
 * inside OneDrive, whose sync locks files. The preview now says so plainly (no Auto-Fix: it is not the code), retries
 * a locked file once, and on a startup lock stops only the flutter commands Atomvs started (by PID) and waits a while
 * for one outside Atomvs. The Windows part runs the real FlutterService and ProcessManager against a fake
 * flutter.bat (a node script) that behaves like Flutter.
 */
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (check: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
};

/**
 * The fake Flutter. `run`: while bin/cache/lockfile names a live PID, prints Flutter's waiting line; then, as
 * told by bin/mode ("delete-fail-N": fail N times to delete .pub-preload-cache), fails or serves. `pub`: holds
 * the lock (writes its PID) and runs until stopped.
 */
const FAKE = `
const fs = require('fs'), path = require('path');
const sdk = path.dirname(__dirname);
const lock = path.join(sdk, 'bin', 'cache', 'lockfile');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const holder = () => { try { const pid = Number(fs.readFileSync(lock, 'utf8')); return pid && pid !== process.pid && alive(pid) ? pid : 0; } catch { return 0; } };
const args = process.argv.slice(2);
if (args[0] === 'pub' || args[0] === 'hold') {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, String(process.pid));
  setInterval(() => {}, 1000);
} else if (args[0] === 'run') {
  let said = false;
  const go = () => {
    if (holder()) {
      if (!said) { console.log('${FLUTTER_STARTUP_LOCK_LINE}...'); said = true; }
      return setTimeout(go, 100);
    }
    const counter = path.join(sdk, 'bin', 'runs');
    const runs = (fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0) + 1;
    fs.writeFileSync(counter, String(runs));
    const mode = fs.existsSync(path.join(sdk, 'bin', 'mode')) ? fs.readFileSync(path.join(sdk, 'bin', 'mode'), 'utf8') : '';
    const fails = Number((/delete-fail-(\\d+)/.exec(mode) || [])[1] || 0);
    if (runs <= fails) {
      console.error('Flutter failed to delete a directory at "' + path.join(sdk, '.pub-preload-cache') + '". The flutter tool cannot access the file or directory.');
      process.exit(1);
    }
    const port = args[args.indexOf('--web-port') + 1];
    console.log('lib/main.dart is being served at http://127.0.0.1:' + port);
    setInterval(() => {}, 1000);
  };
  go();
}
`;

function makeSdk(dir: string, mode = ''): string {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'fake-flutter.js'), FAKE);
  fs.writeFileSync(path.join(bin, 'flutter.bat'), `@"${process.execPath}" "%~dp0fake-flutter.js" %*\r\n`);
  fs.writeFileSync(path.join(bin, 'mode'), mode);
  return dir;
}

export default async function run() {
  console.log('  [flutter-env] Synced folders are recognised...');
  assert.equal(syncedFolderOf('C:\\Users\\Marco\\OneDrive\\Desktop\\flutter'), 'OneDrive');
  assert.equal(syncedFolderOf('C:\\Users\\Marco\\OneDrive - Contoso\\flutter'), 'OneDrive');
  assert.equal(syncedFolderOf('D:\\Sync\\Documenti\\flutter', { OneDrive: 'D:\\Sync' }), 'OneDrive', 'a renamed OneDrive folder, from the env');
  assert.equal(syncedFolderOf('C:\\Users\\a\\Dropbox\\flutter'), 'Dropbox');
  assert.equal(syncedFolderOf('G:\\My Drive\\flutter'), 'Google Drive');
  assert.equal(syncedFolderOf('C:\\Users\\a\\iCloudDrive\\flutter'), 'iCloud Drive');
  assert.equal(syncedFolderOf('C:\\src\\flutter'), null);
  assert.equal(syncedFolderOf('C:\\Users\\a\\Desktop\\flutter', { OneDrive: 'C:\\Users\\a\\OneDrive' }), null);
  assert.equal(syncedFolderOf('/home/a/onedrive-notes/flutter'), null, 'only a folder named like the client');

  console.log('  [flutter-env] Messages say what to do, and the Preview pane reads them back...');
  const synced = flutterEnvironmentMessage({ kind: 'sdk-in-synced-folder', folder: 'OneDrive', sdkPath: 'C:\\Users\\Marco\\OneDrive\\Desktop\\flutter' });
  assert.match(synced, /^The Flutter SDK is inside OneDrive \(C:\\Users\\Marco\\OneDrive\\Desktop\\flutter\)\. .*Move Flutter out of it \(e\.g\. C:\\src\\flutter\).*not a problem in the project code/);
  assert.deepEqual(parseFlutterEnvironmentProblem(synced), { kind: 'sdk-in-synced-folder', folder: 'OneDrive', sdkPath: 'C:\\Users\\Marco\\OneDrive\\Desktop\\flutter' });
  const lockMsg = flutterEnvironmentMessage({ kind: 'startup-lock', folder: 'OneDrive', sdkPath: 'C:\\x\\OneDrive\\flutter' });
  assert.deepEqual(parseFlutterEnvironmentProblem(lockMsg), { kind: 'startup-lock', folder: 'OneDrive', sdkPath: 'C:\\x\\OneDrive\\flutter' });
  assert.deepEqual(parseFlutterEnvironmentProblem(flutterEnvironmentMessage({ kind: 'startup-lock', folder: null, sdkPath: null })),
    { kind: 'startup-lock', folder: null, sdkPath: null });
  assert.equal(parseFlutterEnvironmentProblem('lib/main.dart:3:8: Error: Undefined name'), null, 'code errors keep Auto-Fix');
  assert.equal(parseFlutterEnvironmentProblem(undefined), null);

  console.log('  [flutter-env] Helpers: flutter commands, the locked path, the SDK from PATH...');
  assert.ok(isFlutterCommand('C:\\src\\flutter\\bin\\flutter.bat run -d web-server'));
  assert.ok(isFlutterCommand('flutter pub get'));
  assert.ok(isFlutterCommand('dart pub get'));
  assert.ok(!isFlutterCommand('npx expo start --web'));
  assert.ok(!isFlutterCommand('C:\\proj\\flutter_app\\run.bat'));
  assert.equal(lockedSdkPath('Flutter failed to delete a directory at "C:\\Users\\M\\OneDrive\\Desktop\\flutter\\.pub-preload-cache". The flutter tool cannot access the file'),
    'C:\\Users\\M\\OneDrive\\Desktop\\flutter\\.pub-preload-cache');
  assert.equal(lockedSdkPath('Error: something else'), null);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-env-'));
  try {
    const onPath = makeSdk(path.join(tmp, 'OneDrive', 'Desktop', 'flutter'));
    if (process.platform === 'win32') {
      assert.equal(sdkFromPath(`C:\\nope;${path.join(onPath, 'bin')}\\;C:\\Windows`, true), onPath);
    }
    assert.equal(sdkFromPath('', process.platform === 'win32'), null);

    console.log('  [flutter-env] The agent is told not to "fix" these in code...');
    assert.match(FLUTTER_SYSTEM_PROMPT, /\*\*FLUTTER INSTALLATION PROBLEMS\*\*: .*not the code\. Do not change code and do not stop processes for it/);

    if (process.platform !== 'win32') {
      console.log('  (skipped the fake-Flutter runs: Windows only)');
      console.log('  🟢 Flutter SDK environment tests passed.');
      return;
    }

    const start = async (sdk: string, timings = { lockWaitMs: 3_000, retryMs: 200 }) => {
      const pm = new ProcessManager();
      const flutter = new FlutterService(pm, sdk);
      Object.assign(flutter.timings, timings);
      const project = path.join(tmp, `app-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'pubspec.yaml'), 'name: app\n');
      const log: string[] = [];
      const result = flutter.startWebPreview(project, 5000 + Math.floor(Math.random() * 1000), (l) => log.push(l))
        .then((r) => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, e }));
      return { pm, flutter, project, log, result };
    };

    console.log('  [flutter-env] Windows: a lock held by a flutter command Atomvs started: stopped by PID, preview starts...');
    {
      const sdk = makeSdk(path.join(tmp, 'sdk-own'));
      const pm = new ProcessManager();
      const flutter = new FlutterService(pm, sdk);
      Object.assign(flutter.timings, { lockWaitMs: 5_000, retryMs: 200 });
      const project = path.join(tmp, 'app-own');
      fs.mkdirSync(project);
      fs.writeFileSync(path.join(project, 'pubspec.yaml'), 'name: app\n');
      const holder = pm.spawn(path.join(sdk, 'bin', 'flutter.bat'), ['pub', 'get'], project);
      await waitFor(() => fs.existsSync(path.join(sdk, 'bin', 'cache', 'lockfile')));
      const lockPid = Number(fs.readFileSync(path.join(sdk, 'bin', 'cache', 'lockfile'), 'utf8'));
      const outsider = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); // not Atomvs's
      const log: string[] = [];
      try {
        const r = await flutter.startWebPreview(project, 5101, (l) => log.push(l));
        assert.match(r.url, /127\.0\.0\.1:5101/);
        assert.match(log.join(''), /Stopped 1 Flutter command\(s\) Atomvs had started/);
        await waitFor(() => !alive(lockPid));
        await waitFor(() => holder.process.exitCode !== null);
        assert.equal(alive(outsider.pid!), true, 'a process Atomvs did not start is left alone');
      } finally {
        outsider.kill();
        pm.killAll();
      }
    }

    console.log('  [flutter-env] Windows: a lock held outside Atomvs: waits, then a clear message; that process is left alone...');
    {
      const sdk = makeSdk(path.join(tmp, 'OneDrive', 'flutter-lock'));
      const outside = spawn('cmd.exe', ['/d', '/c', path.join(sdk, 'bin', 'flutter.bat'), 'hold'], { stdio: 'ignore', windowsHide: true });
      await waitFor(() => fs.existsSync(path.join(sdk, 'bin', 'cache', 'lockfile')));
      const lockPid = Number(fs.readFileSync(path.join(sdk, 'bin', 'cache', 'lockfile'), 'utf8'));
      const t0 = Date.now();
      const s = await start(sdk, { lockWaitMs: 2_000, retryMs: 200 });
      const res = await s.result;
      try {
        assert.equal(res.ok, false);
        const problem = parseFlutterEnvironmentProblem(!res.ok ? res.e.message : '');
        assert.deepEqual(problem, { kind: 'startup-lock', folder: 'OneDrive', sdkPath: sdk });
        assert.ok(Date.now() - t0 >= 2_000, 'waited for the lock first');
        assert.match(s.log.join(''), /Waiting up to 2 s for it to be released/);
        assert.doesNotMatch(s.log.join(''), /Stopped \d+ Flutter/, 'nothing of Atomvs\'s to stop');
        assert.equal(alive(lockPid), true, 'the flutter command outside Atomvs keeps running');
        // The waiting preview was stopped, so it does not queue behind the lock.
        await waitFor(() => [...(s.pm as any).processes.values()].every((p: any) => p.process.exitCode !== null), 5_000);
      } finally {
        spawn('taskkill', ['/PID', String(outside.pid), '/T', '/F'], { stdio: 'ignore' });
        s.pm.killAll();
      }
    }

    console.log('  [flutter-env] Windows: the SDK inside OneDrive: warned, a locked file retried once...');
    {
      const sdk = makeSdk(path.join(tmp, 'OneDrive', 'Desktop', 'flutter-retry'), 'delete-fail-1');
      const s = await start(sdk);
      const res = await s.result;
      try {
        assert.equal(res.ok, true, 'the second run worked');
        assert.match(s.log.join(''), /\[Atomvs\] The Flutter SDK is inside OneDrive/);
        assert.match(s.log.join(''), /could not delete a folder in its SDK .*retrying once/);
      } finally {
        s.pm.killAll();
      }
    }
    {
      const sdk = makeSdk(path.join(tmp, 'OneDrive', 'Desktop', 'flutter'), 'delete-fail-9');
      const s = await start(sdk);
      const res = await s.result;
      s.pm.killAll();
      assert.equal(res.ok, false);
      assert.deepEqual(parseFlutterEnvironmentProblem(!res.ok ? res.e.message : ''), { kind: 'sdk-in-synced-folder', folder: 'OneDrive', sdkPath: sdk });
      assert.equal(Number(fs.readFileSync(path.join(sdk, 'bin', 'runs'), 'utf8')), 2, 'retried once, not more');
    }
    {
      const sdk = makeSdk(path.join(tmp, 'src', 'flutter'), 'delete-fail-9');
      const s = await start(sdk);
      const res = await s.result;
      s.pm.killAll();
      assert.equal(res.ok, false);
      assert.equal(parseFlutterEnvironmentProblem(!res.ok ? res.e.message : ''), null, 'not in a synced folder: Flutter\'s own message');
      assert.match(!res.ok ? res.e.message : '', /Flutter failed to delete a directory/);
    }
  } finally {
    await new Promise((r) => setTimeout(r, 300));
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // A stopped process can keep its folder busy for a moment on Windows; the temp folder is cleaned later.
    }
  }

  console.log('  🟢 Flutter SDK environment tests passed.');
}
