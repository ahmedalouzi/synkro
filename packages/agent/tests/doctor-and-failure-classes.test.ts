import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  DISK_ERROR_THRESHOLD_BYTES,
  DISK_WARN_THRESHOLD_BYTES,
  classifyFailure,
  evaluateAndroidToolchainCheck,
  evaluateDiskSpaceCheck,
  evaluateFlutterSdkCheck,
  evaluateNodeNpmCheck,
  evaluateStartupLockCheck,
  flutterLayoutIssues,
  parsePreviewRuntimeReport,
  scrubPiiString,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  summarizeDoctorReport,
  syncedFolderOf,
  type DoctorReport,
  type FlutterLayoutMeasurement,
} from '@peep/shared';
import { previewEntrySource } from '../../../apps/desktop/src/main/services/flutter-preview-entry';
import { formatPreviewReport } from '../../../apps/desktop/src/main/services/preview-log';
import { checkExpoPeerDepsCommand } from '../../../apps/desktop/src/main/services/expo-deps';
import { classifyError, selectRecoveryStrategy } from '../src/error-recovery/diagnostics';
import { FLUTTER_SYSTEM_PROMPT } from '../src/prompts/flutter-system';

const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '../../..',
);

function flattenKeys(obj: Record<string, any>, prefix = ''): string[] {
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      keys.push(...flattenKeys(v, full));
    } else {
      keys.push(full);
    }
  }
  return keys.sort();
}

export default async function run() {
  // ── 1. Atomvs Doctor: all 5 evaluators ─────────────────────────────────────
  console.log('  [doctor] Evaluating all 5 Atomvs Doctor checks...');

  // 1a. Flutter SDK (clean, missing, and 4 cloud-synced folders)
  {
    const ok = evaluateFlutterSdkCheck({ found: true, sdkPath: 'C:\\src\\flutter', version: '3.29.0', syncedFolder: null });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.fixKind, undefined);

    const missing = evaluateFlutterSdkCheck({ found: false, sdkPath: null, version: null, syncedFolder: null });
    assert.equal(missing.status, 'error');
    assert.equal(missing.fixKind, 'install-flutter-guide');

    const cloudPaths: Array<[string, string]> = [
      ['C:\\Users\\Marco\\OneDrive\\Desktop\\flutter', 'OneDrive'],
      ['C:\\Users\\Marco\\Dropbox\\flutter', 'Dropbox'],
      ['G:\\My Drive\\flutter', 'Google Drive'],
      ['/Users/marco/Library/Mobile Documents/iCloud Drive/flutter', 'iCloud Drive'],
    ];
    for (const [sdkPath, expectedFolder] of cloudPaths) {
      const folder = syncedFolderOf(sdkPath);
      assert.equal(folder, expectedFolder, `expected ${expectedFolder} for ${sdkPath}`);
      const item = evaluateFlutterSdkCheck({ found: true, sdkPath, version: '3.29.0', syncedFolder: folder });
      assert.equal(item.status, 'error');
      assert.equal(item.fixKind, 'choose-flutter-sdk');
      assert.match(item.summary, new RegExp(expectedFolder));
    }
  }

  // 1b. Startup lock (none, stale, Atomvs-owned, external live PID)
  {
    const clean = evaluateStartupLockCheck({ sdkPath: 'C:\\src\\flutter', lockExists: false });
    assert.equal(clean.status, 'ok');

    const stale = evaluateStartupLockCheck({
      sdkPath: 'C:\\src\\flutter',
      lockExists: true,
      lockFilePath: 'C:\\src\\flutter\\bin\\cache\\lockfile',
      holderPid: 99999,
      holderAlive: false,
      ownedByAtomvs: false,
    });
    assert.equal(stale.status, 'warn');
    assert.equal(stale.fixKind, 'release-startup-lock');

    const owned = evaluateStartupLockCheck({
      sdkPath: 'C:\\src\\flutter',
      lockExists: true,
      holderPid: 4321,
      holderAlive: true,
      ownedByAtomvs: true,
    });
    assert.equal(owned.status, 'warn');
    assert.equal(owned.fixKind, 'release-startup-lock');
    assert.match(owned.summary, /4321/);

    const external = evaluateStartupLockCheck({
      sdkPath: 'C:\\Users\\Marco\\OneDrive\\Desktop\\flutter',
      lockExists: true,
      holderPid: 8888,
      holderAlive: true,
      ownedByAtomvs: false,
      syncedFolder: 'OneDrive',
    });
    assert.equal(external.status, 'error');
    assert.match(external.summary, /outside Atomvs.*8888/i);
    assert.match(external.detail ?? '', /OneDrive/);
  }

  // 1c. Node / npm
  {
    assert.equal(evaluateNodeNpmCheck({ nodeVersion: 'v20.18.0', npmVersion: '10.8.2' }).status, 'ok');
    const missingNode = evaluateNodeNpmCheck({ nodeVersion: null, npmVersion: null });
    assert.equal(missingNode.status, 'error');
    assert.equal(missingNode.fixKind, 'install-node-guide');
    const missingNpm = evaluateNodeNpmCheck({ nodeVersion: 'v20.18.0', npmVersion: null });
    assert.equal(missingNpm.status, 'error');
    assert.match(missingNpm.summary, /npm/);
  }

  // 1d. Android SDK, Java, adb
  {
    const ready = evaluateAndroidToolchainCheck({
      androidSdkPath: 'C:\\Android\\Sdk',
      javaVersion: '17.0.10',
      adbVersion: '1.0.41',
    });
    assert.equal(ready.status, 'ok');

    const missing = evaluateAndroidToolchainCheck({ androidSdkPath: null, javaVersion: '17.0.10', adbVersion: null });
    assert.equal(missing.status, 'warn');
    assert.equal(missing.fixKind, 'install-android-guide');
    assert.match(missing.summary, /Android SDK/);
    assert.match(missing.summary, /adb/);
    assert.match(missing.detail ?? '', /Cloud Build/i);
  }

  // 1e. Disk space & report summary
  {
    const low = evaluateDiskSpaceCheck({ freeBytes: DISK_ERROR_THRESHOLD_BYTES - 1, checkPath: 'C:\\' });
    assert.equal(low.status, 'error');
    assert.equal(low.fixKind, 'clean-atomvs-cache');

    const warn = evaluateDiskSpaceCheck({ freeBytes: DISK_WARN_THRESHOLD_BYTES - 1024, checkPath: 'C:\\' });
    assert.equal(warn.status, 'warn');
    assert.equal(warn.fixKind, 'clean-atomvs-cache');

    const ok = evaluateDiskSpaceCheck({ freeBytes: 25 * 1024 * 1024 * 1024, checkPath: 'C:\\' });
    assert.equal(ok.status, 'ok');
    assert.equal(ok.fixKind, undefined);

    const summary = summarizeDoctorReport([
      evaluateFlutterSdkCheck({ found: true, sdkPath: 'C:\\Users\\Marco\\OneDrive\\flutter', version: '3.29.0', syncedFolder: 'OneDrive' }),
      evaluateStartupLockCheck({ sdkPath: 'C:\\Users\\Marco\\OneDrive\\flutter', lockExists: false }),
      evaluateNodeNpmCheck({ nodeVersion: 'v20.18.0', npmVersion: '10.8.2' }),
      evaluateAndroidToolchainCheck({ androidSdkPath: null, javaVersion: null, adbVersion: null }),
      ok,
    ]);
    assert.equal(summary.overall, 'error');
    assert.equal(summary.errorCount, 1);
    assert.equal(summary.warnCount, 1);
    assert.equal(summary.okCount, 3);
    assert.equal(summary.checks.length, 5);
  }

  // ── 2. DoctorCard JSDOM rendering & interactions ───────────────────────────
  console.log('  [doctor] Rendering DoctorCard in JSDOM...');
  {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      url: 'http://localhost/',
      pretendToBeVisual: true,
    });
    const g = globalThis as any;
    const saved: Record<string, unknown> = {};
    for (const key of [
      'window',
      'document',
      'navigator',
      'HTMLElement',
      'Node',
      'Element',
      'SVGElement',
      'getComputedStyle',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'IS_REACT_ACT_ENVIRONMENT',
      'React',
    ]) {
      saved[key] = g[key];
    }
    const win = dom.window as any;
    Object.assign(g, {
      window: win,
      document: win.document,
      HTMLElement: win.HTMLElement,
      Node: win.Node,
      Element: win.Element,
      SVGElement: win.SVGElement,
      getComputedStyle: win.getComputedStyle.bind(win),
      requestAnimationFrame: win.requestAnimationFrame.bind(win),
      cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    Object.defineProperty(g, 'navigator', { value: win.navigator, configurable: true });

    const React = await import('react');
    const { act } = React as any;
    g.React = React;
    const { createRoot } = await import('react-dom/client');
    const { renderDoctorCard } = await import('../../../apps/desktop/src/renderer/src/features/settings/DoctorCard');

    const initialReport: DoctorReport = summarizeDoctorReport([
      evaluateFlutterSdkCheck({ found: true, sdkPath: 'C:\\Users\\Marco\\OneDrive\\Desktop\\flutter', version: '3.29.0', syncedFolder: 'OneDrive' }),
      evaluateStartupLockCheck({ sdkPath: 'C:\\Users\\Marco\\OneDrive\\Desktop\\flutter', lockExists: true, holderAlive: false }),
      evaluateNodeNpmCheck({ nodeVersion: 'v20.18.0', npmVersion: '10.8.2' }),
      evaluateAndroidToolchainCheck({ androidSdkPath: null, javaVersion: '17.0.10', adbVersion: null }),
      evaluateDiskSpaceCheck({ freeBytes: 20 * 1024 * 1024 * 1024, checkPath: 'C:\\' }),
    ]);

    const fixedReport: DoctorReport = summarizeDoctorReport([
      evaluateFlutterSdkCheck({ found: true, sdkPath: 'C:\\src\\flutter', version: '3.29.0', syncedFolder: null }),
      evaluateStartupLockCheck({ sdkPath: 'C:\\src\\flutter', lockExists: false }),
      evaluateNodeNpmCheck({ nodeVersion: 'v20.18.0', npmVersion: '10.8.2' }),
      evaluateAndroidToolchainCheck({ androidSdkPath: 'C:\\Android\\Sdk', javaVersion: '17.0.10', adbVersion: '1.0.41' }),
      evaluateDiskSpaceCheck({ freeBytes: 20 * 1024 * 1024 * 1024, checkPath: 'C:\\' }),
    ]);

    let fixedKinds: string[] = [];
    let runCalls = 0;
    const root = createRoot(win.document.getElementById('root')!);
    try {
      await act(async () => {
        root.render(
          renderDoctorCard({
            initialReport,
            onRunDoctor: async () => {
              runCalls++;
              return fixedReport;
            },
            onFixCheck: async (fixKind) => {
              fixedKinds.push(fixKind);
              return { ok: true, fixKind, message: 'Cleared stale lock.', report: fixedReport };
            },
          }),
        );
      });

      assert.ok(win.document.querySelector('[data-testid="atomvs-doctor-card"]'));
      assert.ok(win.document.querySelector('[data-testid="doctor-check-flutter-sdk"]'));
      assert.ok(win.document.querySelector('[data-testid="doctor-check-startup-lock"]'));
      assert.ok(win.document.querySelector('[data-testid="doctor-check-node-npm"]'));
      assert.ok(win.document.querySelector('[data-testid="doctor-check-android-toolchain"]'));
      assert.ok(win.document.querySelector('[data-testid="doctor-check-disk-space"]'));

      const lockFixBtn = win.document.querySelector('[data-testid="doctor-fix-startup-lock"]') as HTMLElement | null;
      assert.ok(lockFixBtn, 'startup-lock fix button rendered');
      await act(async () => {
        lockFixBtn!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      });
      assert.deepEqual(fixedKinds, ['release-startup-lock']);
      assert.match(win.document.querySelector('[data-testid="doctor-feedback"]')?.textContent ?? '', /Cleared stale lock/);

      const runBtn = win.document.querySelector('[data-testid="doctor-run-btn"]') as HTMLElement | null;
      assert.ok(runBtn);
      await act(async () => {
        runBtn!.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
      });
      assert.equal(runCalls, 1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      for (const [key, value] of Object.entries(saved)) {
        if (key === 'navigator') Object.defineProperty(g, 'navigator', { value, configurable: true });
        else g[key] = value;
      }
      dom.window.close();
    }
  }

  // ── 3. i18n parity across en / ar / tr ─────────────────────────────────────
  console.log('  [doctor] Checking en / ar / tr localization parity...');
  {
    const localesDir = path.join(repoRoot, 'apps/desktop/src/renderer/src/i18n/locales');
    const en = JSON.parse(fs.readFileSync(path.join(localesDir, 'en.json'), 'utf8'));
    const ar = JSON.parse(fs.readFileSync(path.join(localesDir, 'ar.json'), 'utf8'));
    const tr = JSON.parse(fs.readFileSync(path.join(localesDir, 'tr.json'), 'utf8'));

    assert.ok(en.commands['peep.runDoctor'], 'en has commands["peep.runDoctor"]');
    assert.ok(ar.commands['peep.runDoctor'], 'ar has commands["peep.runDoctor"]');
    assert.ok(tr.commands['peep.runDoctor'], 'tr has commands["peep.runDoctor"]');
    assert.ok(en.preview.flutterEnv.openDoctor, 'en has preview.flutterEnv.openDoctor');
    assert.ok(ar.preview.flutterEnv.openDoctor, 'ar has preview.flutterEnv.openDoctor');
    assert.ok(tr.preview.flutterEnv.openDoctor, 'tr has preview.flutterEnv.openDoctor');

    const enDoctorKeys = flattenKeys(en.settings.doctor);
    const arDoctorKeys = flattenKeys(ar.settings.doctor);
    const trDoctorKeys = flattenKeys(tr.settings.doctor);
    assert.ok(enDoctorKeys.length >= 15, 'doctor translations present');
    assert.deepEqual(arDoctorKeys, enDoctorKeys, 'ar settings.doctor keys match en');
    assert.deepEqual(trDoctorKeys, enDoctorKeys, 'tr settings.doctor keys match en');
  }

  // ── 4. Sentry Scrubbing & Opt-Out ──────────────────────────────────────────
  console.log('  [sentry] Testing PII/token scrubbing and username replacement...');
  {
    const winMsg = 'Flutter failed to delete a directory at "C:\\Users\\Marco\\OneDrive\\Desktop\\flutter\\.pub-preload-cache"';
    const scrubbedWin = scrubPiiString(winMsg, { username: 'Marco' });
    assert.ok(!scrubbedWin.includes('Marco'), 'Windows username removed');
    assert.ok(
      scrubbedWin.includes('C:\\Users\\<user>\\OneDrive\\Desktop\\flutter\\.pub-preload-cache'),
      `diagnostic tail preserved: ${scrubbedWin}`,
    );

    const macPath = '/Users/elena.rossi/Desktop/flutter/bin/flutter';
    assert.equal(scrubPiiString(macPath), '/Users/<user>/Desktop/flutter/bin/flutter');

    const linuxPath = '/home/ahmet/projects/my_app/lib/main.dart';
    assert.equal(scrubPiiString(linuxPath), '/home/<user>/projects/my_app/lib/main.dart');

    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const secretLine =
      `Authorization: Bearer secret_tok_999 sessionToken=sess_abc123 `
      + `key=AIza${'A'.repeat(35)} openai=sk-${'B'.repeat(48)} `
      + `anth=sk-ant-api03-${'C'.repeat(93)} gh=ghp_${'D'.repeat(36)} jwt=${jwt}`;
    const scrubbedSecrets = scrubPiiString(secretLine);
    for (const secret of ['secret_tok_999', 'sess_abc123', 'AIza' + 'A'.repeat(35), 'sk-' + 'B'.repeat(48), 'sk-ant-api03-' + 'C'.repeat(93), 'ghp_' + 'D'.repeat(36), jwt]) {
      assert.ok(!scrubbedSecrets.includes(secret), `secret leaked: ${secret.slice(0, 12)}`);
    }

    const event = scrubSentryEvent(
      {
        message: 'Preview failed at C:\\Users\\Marco\\OneDrive\\Desktop\\flutter',
        request: {
          url: 'https://api.example.com?session_token=tok123',
          data: { password: 'super-secret-password' },
          cookies: 'sid=abc',
          headers: { Authorization: 'Bearer top_secret_token', 'User-Agent': 'Atomvs' },
        },
        user: { id: 'usr_1', email: 'marco@example.com', username: 'Marco', ip_address: '1.2.3.4' },
        exception: {
          values: [
            {
              value: 'Error in /Users/marco/app with sk-' + 'Z'.repeat(48),
              stacktrace: {
                frames: [
                  { filename: 'C:\\Users\\Marco\\OneDrive\\Desktop\\app\\main.dart', abs_path: 'C:\\Users\\Marco\\OneDrive\\Desktop\\app\\main.dart' },
                ],
              },
            },
          ],
        },
        breadcrumbs: [{ message: 'Opened /home/marco/app with Bearer tok_bc', data: { refreshToken: 'ref_123', path: 'C:\\Users\\Marco\\OneDrive\\flutter' } }],
        extra: { sessionToken: 'secret_sess', path: 'C:\\Users\\Marco\\OneDrive\\Desktop\\flutter' },
        tags: { sdk: 'C:\\Users\\Marco\\OneDrive\\Desktop\\flutter' },
      },
      { username: 'Marco' },
    );

    const serialized = JSON.stringify(event);
    for (const leaked of ['Marco', 'marco', 'top_secret_token', 'super-secret-password', 'tok123', 'tok_bc', 'ref_123', 'secret_sess', 'marco@example.com', '1.2.3.4', 'sk-' + 'Z'.repeat(48)]) {
      assert.ok(!serialized.includes(leaked), `event leaked "${leaked}"`);
    }
    assert.equal(event.request.data, undefined);
    assert.equal(event.request.cookies, undefined);
    assert.equal(event.request.headers.Authorization, '[REDACTED]');
    assert.equal(event.extra.sessionToken, '[REDACTED]');
    assert.ok(event.exception.values[0].stacktrace.frames[0].filename.includes('C:\\Users\\<user>\\OneDrive\\Desktop\\app\\main.dart'));

    const bc = scrubSentryBreadcrumb({ message: 'Ran at /Users/marco/app', data: { apiKey: 'raw_secret', path: '/Users/marco/app' } });
    assert.equal(bc.message, 'Ran at /Users/<user>/app');
    assert.equal(bc.data.apiKey, '[REDACTED]');
    assert.equal(bc.data.path, '/Users/<user>/app');

    // Verify opt-out wiring & live IPC sync in desktop main, ipc, and renderer
    const mainSrc = fs.readFileSync(path.join(repoRoot, 'apps/desktop/src/main/index.ts'), 'utf8');
    assert.match(mainSrc, /if \(!telemetryEnabled\) \{\s*return null;/);
    assert.match(mainSrc, /scrubSentryEvent\(event/);
    assert.match(mainSrc, /scrubSentryBreadcrumb\(breadcrumb/);
    const ipcSrc = fs.readFileSync(path.join(repoRoot, 'apps/desktop/src/main/ipc/index.ts'), 'utf8');
    assert.match(ipcSrc, /IPC_EVENTS\.SETTINGS_UPDATED/);
    const rendererMainSrc = fs.readFileSync(path.join(repoRoot, 'apps/desktop/src/renderer/src/main.tsx'), 'utf8');
    assert.match(rendererMainSrc, /onSettingsUpdated/);
    assert.match(rendererMainSrc, /if \(!rendererTelemetryEnabled\) \{\s*return null;/);
  }

  // ── 5. Failure-Classes Sweep (all 5 classes + guards) ──────────────────────
  console.log('  [failures] Testing all 5 failure classes, RenderFlex overflow & Expo peer-deps guard...');
  {
    // Clean returns null
    assert.equal(classifyFailure({ error: '', logs: 'Web Bundled 812ms index.js', layout: [], runtimeErrors: [] }), null);

    // Class 1: environment
    const envSync = classifyFailure({
      error: 'Flutter failed to delete a directory at "C:\\Users\\Marco\\OneDrive\\Desktop\\flutter\\.pub-preload-cache".',
    });
    assert.equal(envSync?.classId, 'environment');
    assert.equal(envSync?.subKind, 'sdk-in-synced-folder');
    assert.equal(envSync?.canAgentFixInCode, false);
    assert.equal(envSync?.doctorCheckId, 'flutter-sdk');

    const envLock = classifyFailure({ logs: 'Waiting for another flutter command to release the startup lock...' });
    assert.equal(envLock?.classId, 'environment');
    assert.equal(envLock?.subKind, 'startup-lock');
    assert.equal(envLock?.canAgentFixInCode, false);
    assert.equal(envLock?.doctorCheckId, 'startup-lock');

    const envDisk = classifyFailure({ error: 'ENOSPC: no space left on device, write' });
    assert.equal(envDisk?.classId, 'environment');
    assert.equal(envDisk?.subKind, 'disk-full');
    assert.equal(envDisk?.doctorCheckId, 'disk-space');

    // Class 2: platform-folders
    const plat = classifyFailure({
      logs: 'Build failed due to use of deleted Android v1 embedding (io.flutter.app.FlutterActivity).',
    });
    assert.equal(plat?.classId, 'platform-folders');
    assert.equal(plat?.canAgentFixInCode, true);

    // Class 3: dependency-peers
    const peers = classifyFailure({
      logs: 'npm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree',
    });
    assert.equal(peers?.classId, 'dependency-peers');
    assert.equal(peers?.canAgentFixInCode, true);
    assert.match(peers?.agentRule ?? '', /Never use --legacy-peer-deps or --force/);

    // Class 4: layout (including flutter-renderflex-overflow)
    const overflowMeasurement: FlutterLayoutMeasurement = {
      innerHeight: 874,
      insetTop: 62,
      insetBottom: 34,
      navItems: 4,
      overflowErrors: 2,
      texts: [{ top: 76, bottom: 104, appBar: true, nav: false, clipped: false }],
    };
    const overflowIssues = flutterLayoutIssues(overflowMeasurement);
    assert.deepEqual(overflowIssues.map((i) => i.kind), ['flutter-renderflex-overflow']);
    assert.match(overflowIssues[0].message, /2 RenderFlex overflow error/);

    // Self-contained serialization check
    const inPage = new Function(`return (${flutterLayoutIssues.toString()})`)() as typeof flutterLayoutIssues;
    assert.deepEqual(inPage(overflowMeasurement), overflowIssues);

    // Accepted by parsePreviewRuntimeReport
    const parsedRuntime = parsePreviewRuntimeReport({
      errors: [],
      rendered: true,
      textChars: 50,
      overlay: '',
      layout: overflowIssues,
    });
    assert.equal(parsedRuntime?.layout[0].kind, 'flutter-renderflex-overflow');

    const layoutClass = classifyFailure({ layout: overflowIssues });
    assert.equal(layoutClass?.classId, 'layout');
    assert.equal(layoutClass?.subKind, 'flutter-renderflex-overflow');
    assert.equal(layoutClass?.canAgentFixInCode, true);

    const layoutFromLog = classifyFailure({ logs: 'A RenderFlex overflowed by 42 pixels on the right.' });
    assert.equal(layoutFromLog?.classId, 'layout');
    assert.equal(layoutFromLog?.subKind, 'flutter-renderflex-overflow');

    // Preview entrypoint reports overflowErrors
    const entrySrc = previewEntrySource('demo_app', false);
    assert.match(entrySrc, /RenderFlex overflowed by/);
    assert.match(entrySrc, /'overflowErrors': overflowErrors/);

    // Class 5: permissions
    const perm = classifyFailure({ error: 'EACCES: permission denied, open /etc/secret' });
    assert.equal(perm?.classId, 'permissions');
    assert.equal(perm?.canAgentFixInCode, false);

    // formatPreviewReport appends classification only when non-null
    const session = { url: 'http://127.0.0.1:8081', processId: 1, status: 'running' as const };
    const cleanReport = formatPreviewReport(session, 'Web Bundled 200ms', {
      errors: [],
      rendered: true,
      textChars: 100,
      overlay: '',
      layout: [],
    });
    assert.doesNotMatch(cleanReport, /Detected failure class:/);

    const overflowReport = formatPreviewReport(session, 'Web Bundled 200ms', parsedRuntime);
    assert.match(overflowReport, /Detected failure class: \[layout\/flutter-renderflex-overflow\]/);
    assert.match(overflowReport, /Agent rule:/);

    // Expo peer-deps command guard
    assert.equal(checkExpoPeerDepsCommand('npm install foo --legacy-peer-deps', true).blocked, true);
    assert.equal(checkExpoPeerDepsCommand('npm i bar --force', true).blocked, true);
    assert.equal(checkExpoPeerDepsCommand('npx expo install baz --force', true).blocked, true);
    assert.equal(checkExpoPeerDepsCommand('npx expo install @react-navigation/native@^6', true).blocked, false);
    assert.equal(checkExpoPeerDepsCommand('npm install foo --legacy-peer-deps', false).blocked, false);

    // Diagnostics integration
    const envNormErr = classifyError('start_preview', 'Waiting for another flutter command to release the startup lock...');
    assert.equal(envNormErr.category, 'unrecoverable');
    const envStrat = selectRecoveryStrategy(envNormErr, 1);
    assert.equal(envStrat.isRecoverable, false);

    const peerNormErr = classifyError('run_command', 'npm ERR! ERESOLVE unable to resolve dependency tree');
    assert.equal(peerNormErr.category, 'missing_dependency');
    const peerStrat = selectRecoveryStrategy(peerNormErr, 1);
    assert.equal(peerStrat.isRecoverable, true);
    assert.match(peerStrat.actionHint, /--legacy-peer-deps/);

    // System prompt covers all 5 failure classes
    assert.match(FLUTTER_SYSTEM_PROMPT, /Atomvs Doctor/);
    assert.match(FLUTTER_SYSTEM_PROMPT, /RenderFlex overflowed by/);
    assert.match(FLUTTER_SYSTEM_PROMPT, /PERMISSIONS & SAFETY/);
  }

  console.log('  🟢 Atomvs Doctor, Sentry scrubbing & failure-classes tests passed.');
}
