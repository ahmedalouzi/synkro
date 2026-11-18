import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FLUTTER_ANDROID_FN, getBuildCommand } from '../src/models/docker-sandbox.js';
import { FLUTTER_SYSTEM_PROMPT } from '../src/prompts/flutter-system.js';
import { buildNotices } from '../../../apps/desktop/src/renderer/src/features/build/build-progress';

/**
 * `flutter_android` (docker-sandbox.ts): a Flutter project whose android/ folder uses the deleted v1 embedding failed
 * Cloud Build in 12 s ("Build failed due to use of deleted Android v1 embedding"), because the build only ran
 * `flutter create` when android/ was missing. Now an outdated or incomplete android/ is moved aside and generated
 * again; a current one is kept as is. Runs the real shell function on fixture projects with a fake `flutter`
 * (skipped where there is no sh). The same fixtures were checked against the real Flutter 3.44 in the sandbox image.
 */
function hasSh(): boolean {
  try {
    execFileSync('sh', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// From `flutter create` (Flutter 3.44): the parts the check reads.
const V2_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application
        android:label="app"
        android:name="\${applicationName}"
        android:icon="@mipmap/ic_launcher">
        <activity android:name=".MainActivity" android:exported="true">
            <meta-data
              android:name="io.flutter.embedding.android.NormalTheme"
              android:resource="@style/NormalTheme"
              />
        </activity>
        <!-- Don't delete the meta-data below.
             This is used by the Flutter tool to generate GeneratedPluginRegistrant.java -->
        <meta-data
            android:name="flutterEmbedding"
            android:value="2" />
    </application>
</manifest>
`;
const V2_ACTIVITY = 'package com.example.app\n\nimport io.flutter.embedding.android.FlutterActivity\n\nclass MainActivity : FlutterActivity()\n';
const MANIFEST = 'android/app/src/main/AndroidManifest.xml';
const ACTIVITY = 'android/app/src/main/kotlin/com/example/app/MainActivity.kt';

/** A current android/ project, then `change` applied to it. */
function v2Project(change: Record<string, string | null> = {}): Record<string, string | null> {
  return {
    'pubspec.yaml': 'name: app\n',
    'lib/main.dart': 'void main() {}\n',
    'android/settings.gradle.kts': 'plugins { id("dev.flutter.flutter-plugin-loader") version "1.0.0" }\n',
    'android/build.gradle.kts': '',
    'android/app/build.gradle.kts': 'plugins { id("dev.flutter.flutter-gradle-plugin") }\n',
    'android/gradlew': '#!/bin/sh\n',
    'android/USER_FILE': 'kept',
    [MANIFEST]: V2_MANIFEST,
    [ACTIVITY]: V2_ACTIVITY,
    ...change,
  };
}

export default async function run() {
  console.log('  [flutter-android] Flutter builds check android/ before building...');
  const cmd = getBuildCommand('flutter', '3f9a1c07-be42-4d11-9a0e-123456789abc');
  assert.ok(cmd.includes(FLUTTER_ANDROID_FN), 'flutter_android is defined in the command');
  assert.ok(cmd.includes('cd /build && flutter_android com.atomvs.p3f9a1c07be && step_done "flutter create"'));
  assert.ok(cmd.indexOf('flutter_android com.atomvs') < cmd.indexOf('flutter build apk'));

  console.log('  [flutter-android] The build screen tells the user, in plain words...');
  assert.deepEqual(buildNotices('[STEP] flutter create 0m21s'), []);
  assert.deepEqual(buildNotices(undefined), []);
  assert.deepEqual(buildNotices('x\n[SYSTEM] android/ was outdated (v1 embedding), regenerated it\n'), ['androidRegenerated']);
  assert.deepEqual(buildNotices('[SYSTEM] android/ was incomplete (no settings.gradle), regenerated it'), ['androidRegenerated']);
  const locales = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../../apps/desktop/src/renderer/src/i18n/locales');
  for (const lang of ['en', 'ar', 'tr']) {
    const text = JSON.parse(fs.readFileSync(path.join(locales, `${lang}.json`), 'utf8')).buildFlow.notice.androidRegenerated;
    assert.ok(typeof text === 'string' && text.includes('android/'), `${lang}: buildFlow.notice.androidRegenerated`);
  }

  console.log('  [flutter-android] The agent never writes a v1 android/ itself...');
  assert.match(FLUTTER_SYSTEM_PROMPT, /\*\*ANDROID FOLDER \(Flutter\)\*\*: Never write a Flutter project's android\/ folder by hand/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /<meta-data android:name="flutterEmbedding" android:value="2" \/>/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /MainActivity extends io\.flutter\.embedding\.android\.FlutterActivity \(never io\.flutter\.app\.FlutterActivity/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /never from apply from: \.\.\.\/flutter\.gradle/);

  if (!hasSh()) {
    console.log('  (skipped running flutter_android: no sh on this machine)');
    console.log('  🟢 Flutter android/ project tests passed.');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-android-'));
  try {
    // Fake flutter: records its arguments and writes a fresh android/ with a marker.
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'flutter'), [
      '#!/bin/sh',
      'echo "$*" >> "$CALLS"',
      'mkdir -p android/app/src/main && echo generated > android/GENERATED',
      '',
    ].join('\n'), { mode: 0o755 });

    const runCase = (files: Record<string, string | null>) => {
      const work = path.join(tmp, 'case');
      const project = path.join(work, 'build');
      fs.rmSync(work, { recursive: true, force: true });
      fs.mkdirSync(project, { recursive: true });
      for (const [rel, content] of Object.entries(files)) {
        if (content === null) continue;
        fs.mkdirSync(path.dirname(path.join(project, rel)), { recursive: true });
        fs.writeFileSync(path.join(project, rel), content);
      }
      const calls = path.join(work, 'calls');
      let out = '';
      let status = 0;
      try {
        out = execFileSync('sh', ['-c', `${FLUTTER_ANDROID_FN} flutter_android com.atomvs.ptest`], {
          cwd: project, encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, CALLS: calls, TMPDIR: work },
        });
      } catch (err: any) {
        status = err.status ?? 1;
        out = String(err.stdout ?? '');
      }
      return {
        status, out,
        flutterCalls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [],
        regenerated: fs.existsSync(path.join(project, 'android/GENERATED')),
        userFileKept: fs.existsSync(path.join(project, 'android/USER_FILE')),
        movedAside: fs.existsSync(path.join(work, 'android-outdated/USER_FILE')),
        libKept: fs.existsSync(path.join(project, 'lib/main.dart')),
      };
    };
    const CREATE = 'create --platforms=android --org com.atomvs.ptest .';
    const kept = (name: string, files: Record<string, string | null>) => {
      const r = runCase(files);
      assert.equal(r.status, 0, name);
      assert.deepEqual(r.flutterCalls, [], `${name}: flutter create not run`);
      assert.ok(r.userFileKept && !r.regenerated, `${name}: android/ kept as is`);
      assert.doesNotMatch(r.out, /regenerated/, name);
    };
    const regenerated = (name: string, files: Record<string, string | null>, line: RegExp) => {
      const r = runCase(files);
      assert.equal(r.status, 0, name);
      assert.deepEqual(r.flutterCalls, [CREATE], `${name}: flutter create run once, with our org`);
      assert.ok(r.regenerated && !r.userFileKept, `${name}: android/ generated again`);
      assert.ok(r.movedAside, `${name}: the old android/ moved aside (to $TMPDIR), not into the project`);
      assert.ok(r.libKept, `${name}: lib/ untouched`);
      assert.match(r.out, line, name);
    };
    const V1_LINE = /^\[SYSTEM\] android\/ was outdated \(v1 embedding\), regenerated it$/m;

    console.log('  [flutter-android] A current android/ is kept...');
    kept('valid v2 (flutter create 3.44)', v2Project());
    kept('valid v2, single quotes, value before name', v2Project({
      [MANIFEST]: "<manifest><application android:name='${applicationName}'><meta-data android:value='2' android:name='flutterEmbedding'/></application></manifest>",
    }));
    kept('valid v2 with Groovy files', v2Project({
      'android/settings.gradle.kts': null, 'android/settings.gradle': 'plugins { id "dev.flutter.flutter-plugin-loader" version "1.0.0" }\n',
      'android/app/build.gradle.kts': null, 'android/app/build.gradle': 'plugins { id "dev.flutter.flutter-gradle-plugin" }\n',
    }));
    kept('no gradlew (Flutter\'s .gitignore leaves it out; flutter build adds it)', v2Project({ 'android/gradlew': null }));
    kept('v2 using io.flutter.app.FlutterPlayStoreSplitApplication (still in v2)', v2Project({
      [ACTIVITY]: `${V2_ACTIVITY}// io.flutter.app.FlutterPlayStoreSplitApplication\n`,
    }));

    console.log('  [flutter-android] No android/: generated, as before...');
    const missing = runCase({ 'pubspec.yaml': 'name: app\n', 'lib/main.dart': '' });
    assert.deepEqual(missing.flutterCalls, [CREATE]);
    assert.ok(missing.regenerated && !missing.movedAside);
    assert.doesNotMatch(missing.out, /\[SYSTEM\]/, 'nothing to explain');

    console.log('  [flutter-android] A v1-embedding android/ is generated again...');
    regenerated('manifest without flutterEmbedding', v2Project({
      [MANIFEST]: V2_MANIFEST.replace(/<meta-data\s+android:name="flutterEmbedding"\s+android:value="2" \/>/, ''),
    }), V1_LINE);
    regenerated('flutterEmbedding value 1', v2Project({ [MANIFEST]: V2_MANIFEST.replace('android:value="2"', 'android:value="1"') }), V1_LINE);
    regenerated('io.flutter.app.FlutterApplication', v2Project({
      [MANIFEST]: V2_MANIFEST.replace('${applicationName}', 'io.flutter.app.FlutterApplication'),
    }), V1_LINE);
    regenerated('old MainActivity (Kotlin)', v2Project({
      [ACTIVITY]: 'package com.example.app\n\nimport io.flutter.app.FlutterActivity\n\nclass MainActivity : FlutterActivity()\n',
    }), V1_LINE);
    regenerated('old MainActivity (Java, FlutterFragmentActivity)', v2Project({
      [ACTIVITY]: null,
      'android/app/src/main/java/com/example/app/MainActivity.java': 'public class MainActivity extends io.flutter.app.FlutterFragmentActivity {}\n',
    }), V1_LINE);
    regenerated('no manifest', v2Project({ [MANIFEST]: null }),
      /^\[SYSTEM\] android\/ was outdated \(v1 embedding: no app\/src\/main\/AndroidManifest\.xml\), regenerated it$/m);

    console.log('  [flutter-android] Old Gradle setups and incomplete folders are generated again...');
    regenerated('flutter.gradle applied the old way', v2Project({
      'android/app/build.gradle.kts': null,
      'android/app/build.gradle': 'apply plugin: "com.android.application"\napply from: "$flutterRoot/packages/flutter_tools/gradle/flutter.gradle"\n',
    }), /\[SYSTEM\] android\/ was outdated \(old Flutter Gradle plugin setup\), regenerated it/);
    regenerated('app_plugin_loader.gradle applied the old way', v2Project({
      'android/settings.gradle.kts': null,
      'android/settings.gradle': 'include ":app"\napply from: "$flutterSdkPath/packages/flutter_tools/gradle/app_plugin_loader.gradle"\n',
    }), /old Flutter Gradle plugin setup/);
    regenerated('no settings.gradle', v2Project({ 'android/settings.gradle.kts': null }), /\[SYSTEM\] android\/ was incomplete \(no settings\.gradle\), regenerated it/);
    regenerated('no app/build.gradle', v2Project({ 'android/app/build.gradle.kts': null }), /incomplete \(no app\/build\.gradle\)/);

    console.log('  [flutter-android] A failed flutter create fails the build...');
    fs.writeFileSync(path.join(bin, 'flutter'), '#!/bin/sh\necho "$*" >> "$CALLS"\nexit 3\n', { mode: 0o755 });
    assert.equal(runCase(v2Project({ [MANIFEST]: null })).status, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  🟢 Flutter android/ project tests passed.');
}
