import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILD_TIMEOUT_MS, NPM_INSTALL_FN, flutterOrg, getBuildCommand } from '../src/models/docker-sandbox.js';

/** Runs `npm_install <mode>` in sh with a fake npm that fails as `fake` says; returns npm's calls and the output. */
function runNpmInstall(mode: 'ci' | 'install', fake: 'ok' | 'eresolve' | 'eusage' | 'e404', withLock: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-install-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npm'), [
      '#!/bin/sh',
      'echo "$*" >> "$CALLS"',
      'case "$*" in *--legacy-peer-deps*) exit 0;; esac',
      'case "$FAKE" in',
      '  eresolve) echo "npm error code ERESOLVE"; exit 1;;',
      '  eusage) [ "$1" = ci ] && { echo "npm error code EUSAGE"; exit 1; }; exit 0;;',
      '  e404) echo "npm error code E404"; exit 1;;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    const project = path.join(dir, 'app');
    fs.mkdirSync(project);
    if (withLock) fs.writeFileSync(path.join(project, 'package-lock.json'), '{}');
    const calls = path.join(dir, 'calls.txt');
    let status = 0;
    let output = '';
    try {
      output = execFileSync('sh', ['-c', `${NPM_INSTALL_FN} npm_install ${mode}`], {
        cwd: project, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CALLS: calls, FAKE: fake },
      });
    } catch (err: any) {
      status = err.status ?? 1;
      output = String(err.stdout ?? '');
    }
    const npmCalls = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
    return { status, output, npmCalls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function hasSh(): boolean {
  try {
    execFileSync('sh', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** Checks the React Native build steps; the real build runs in expo-android-build.test.ts on Linux. */
export default async function run() {
  const cmd = getBuildCommand('react-native');
  const at = (part: string) => {
    const i = cmd.indexOf(part);
    assert.ok(i >= 0, `missing: ${part}`);
    return i;
  };

  // android/ is generated only when gradlew is missing.
  assert.ok(cmd.includes('[ -f android/gradlew ] ||'));
  // Dependencies first (prebuild needs the local expo package), then the config fix-ups, prebuild, Gradle.
  assert.ok(at('npm_install ci') < at('node /tmp/prepare-expo-config.js'));
  assert.ok(at('npx expo prebuild') < cmd.lastIndexOf('npm_install install'));
  assert.ok(cmd.startsWith(NPM_INSTALL_FN));
  assert.ok(at('node /tmp/prepare-expo-config.js') < at('npx expo prebuild --platform android --no-install'));
  assert.ok(at('npx expo prebuild') < at('chmod +x android/gradlew'));
  assert.ok(at('chmod +x android/gradlew') < at('./gradlew assembleRelease'));
  // Signing is injected through GRADLE_USER_HOME (createSigningArchive), never in the command.
  assert.ok(!/MYAPP_UPLOAD|key\.properties|release\.jks/.test(cmd));
  // Prebuild must not prompt or call Expo's servers.
  assert.ok(cmd.includes('CI=1 EXPO_NO_TELEMETRY=1 npx expo prebuild'));
  // Phone architectures only, and a plain .apk, not an .aab (see the NOTE in docker-sandbox.ts).
  assert.ok(cmd.includes('./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a'));
  assert.ok(!cmd.includes('bundleRelease'));
  // The JS bundle step needs NODE_ENV; set on Gradle only (npm ci with it would skip devDependencies).
  assert.ok(cmd.includes('NODE_ENV=production ./gradlew assembleRelease'));
  assert.equal(cmd.split('NODE_ENV').length - 1, 1, 'NODE_ENV appears only on the Gradle step');

  // The config script: run it on an app.json from the old Synkro template (images that do not exist).
  const script = Buffer.from(/echo (\S+) \| base64 -d/.exec(cmd)![1], 'base64').toString('utf8');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-config-'));
  try {
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'icon.png'), 'png');
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({
      expo: {
        name: 'My App 2', slug: '2-my-app', icon: './assets/icon.png',
        splash: { image: './assets/splash.png', resizeMode: 'contain', backgroundColor: '#ffffff' },
        android: { adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#ffffff' } },
        web: { favicon: './assets/favicon.png' },
        plugins: ['expo-router'],
        extra: { remoteLogo: 'https://example.com/logo.png' },
      },
    }));
    fs.writeFileSync(path.join(dir, 'prepare.js'), script);
    execFileSync(process.execPath, ['prepare.js'], { cwd: dir });
    const { expo } = JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8'));
    assert.deepEqual(expo, {
      name: 'My App 2', slug: '2-my-app', icon: './assets/icon.png',
      splash: { resizeMode: 'contain', backgroundColor: '#ffffff' },
      android: { adaptiveIcon: { backgroundColor: '#ffffff' }, package: 'com.atomvs.app2myapp' },
      web: {},
      plugins: ['expo-router'],
      extra: { remoteLogo: 'https://example.com/logo.png' },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Installing like Expo: npm ci from the lockfile, one --legacy-peer-deps retry on ERESOLVE, nothing else retried.
  if (hasSh()) {
    const base = '--no-audit --no-fund';
    const eresolve = runNpmInstall('ci', 'eresolve', true);
    assert.equal(eresolve.status, 0);
    assert.deepEqual(eresolve.npmCalls, [`ci ${base}`, `ci ${base} --legacy-peer-deps`]);
    assert.match(eresolve.output, /\[SYSTEM\] WARNING: conflicting peer dependencies \(ERESOLVE\)/);
    assert.deepEqual(runNpmInstall('ci', 'ok', false).npmCalls, [`install ${base}`], 'no lockfile: npm install');
    assert.deepEqual(runNpmInstall('ci', 'ok', true).npmCalls, [`ci ${base}`]);
    const stale = runNpmInstall('ci', 'eusage', true);
    assert.equal(stale.status, 0);
    assert.deepEqual(stale.npmCalls, [`ci ${base}`, `install ${base}`], 'lockfile out of step: npm install');
    assert.match(stale.output, /package-lock\.json does not match/);
    assert.deepEqual(runNpmInstall('install', 'ok', true).npmCalls, [`install ${base}`], 'after prebuild: npm install');
    const e404 = runNpmInstall('ci', 'e404', true);
    assert.notEqual(e404.status, 0);
    assert.deepEqual(e404.npmCalls, [`ci ${base}`], 'other errors are not retried');
  } else {
    console.log('  (skipped the npm_install run: no sh on this machine)');
  }

  // Temporary React Native timeout; the reconciler in build-worker.ts runs at 40 minutes.
  assert.equal(BUILD_TIMEOUT_MS['react-native'], 35 * 60 * 1000);
  assert.equal(BUILD_TIMEOUT_MS.flutter, 15 * 60 * 1000);

  // Flutter: stable package from the project ID (not com.example) and only the ARM ABIs.
  assert.equal(
    getBuildCommand('flutter', '3F9A1C07-BE42-4d11-9a0e-123456789abc'),
    'cd /build && ( [ -d android ] || flutter create --platforms=android --org com.atomvs.p3f9a1c07be . )'
      + ' && flutter build apk --release --target-platform android-arm,android-arm64',
  );
  assert.equal(flutterOrg('00000000-0000-4000-8000-000000000000'), 'com.atomvs.p0000000000');
  assert.throws(() => getBuildCommand('flutter'), /project ID/);
  assert.throws(() => flutterOrg('not-a-uuid'), /project ID/);
}
