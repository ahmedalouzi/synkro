import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILD_TIMEOUT_MS, getBuildCommand } from '../src/models/docker-sandbox.js';

/** Checks the React Native build steps; the real build runs in expo-android-build.test.ts on Linux. */
export default async function run() {
  const signing = ['echo "MYAPP_UPLOAD_STORE_FILE=/build/release.jks" >> /build/android/gradle.properties'];
  const cmd = getBuildCommand('react-native', signing);
  const at = (part: string) => {
    const i = cmd.indexOf(part);
    assert.ok(i >= 0, `missing: ${part}`);
    return i;
  };

  // android/ is generated only when gradlew is missing.
  assert.ok(cmd.includes('[ -f android/gradlew ] ||'));
  // Dependencies first (prebuild needs the local expo package), then the config fix-ups, prebuild, signing, Gradle.
  assert.ok(at('npm install') < at('node /tmp/prepare-expo-config.js'));
  assert.ok(at('node /tmp/prepare-expo-config.js') < at('npx expo prebuild --platform android --no-install'));
  assert.ok(at('npx expo prebuild') < at(signing[0]));
  assert.ok(at(signing[0]) < at('chmod +x android/gradlew'));
  assert.ok(at('chmod +x android/gradlew') < at('./gradlew assembleRelease'));
  // Prebuild must not prompt or call Expo's servers.
  assert.ok(cmd.includes('CI=1 EXPO_NO_TELEMETRY=1 npx expo prebuild'));
  // Phone architectures only, and a plain .apk, not an .aab (see the NOTE in docker-sandbox.ts).
  assert.ok(cmd.includes('./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a'));
  assert.ok(!cmd.includes('bundleRelease'));

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
      android: { adaptiveIcon: { backgroundColor: '#ffffff' }, package: 'com.synkro.app2myapp' },
      web: {},
      plugins: ['expo-router'],
      extra: { remoteLogo: 'https://example.com/logo.png' },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // Temporary React Native timeout; the reconciler in build-worker.ts runs at 50 minutes.
  assert.equal(BUILD_TIMEOUT_MS['react-native'], 45 * 60 * 1000);
  assert.equal(BUILD_TIMEOUT_MS.flutter, 15 * 60 * 1000);

  // Flutter is unchanged.
  assert.equal(
    getBuildCommand('flutter'),
    'cd /build && ( [ -d android ] || flutter create --platforms=android . ) && flutter build apk --release',
  );
}
