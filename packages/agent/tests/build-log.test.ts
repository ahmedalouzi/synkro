import assert from 'node:assert/strict';
import { BuildLogLines, formatBuildLogLine } from '../src/models/build-log.js';

/** The Cloud Build log: only real errors are [ERROR], stderr warnings stay plain, download dots become one line. */
export default async function run() {
  console.log('  [build-log] Warnings and notes on stderr are plain lines...');
  for (const line of [
    'npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.',
    'Note: Some input files use or override a deprecated API.',
    'w: file:///build/node_modules/expo/android/src/Foo.kt:12:5 \'bar\' is deprecated.',
    'Deprecated Gradle features were used in this build, making it incompatible with Gradle 9.0.',
    '> Task :app:createBundleReleaseJsAndAssets',
    '[SYSTEM] WARNING: conflicting peer dependencies (ERESOLVE).',
  ]) {
    assert.equal(formatBuildLogLine(line), line, line);
  }

  console.log('  [build-log] Real errors are [ERROR]...');
  for (const line of [
    'npm error code ERESOLVE',
    'npm ERR! code ELIFECYCLE',
    'FAILURE: Build failed with an exception.',
    '* What went wrong:',
    "Execution failed for task ':expo-modules-core:generateReleaseLintModel'.",
    'BUILD FAILED in 15m 49s',
    'e: file:///build/android/app/src/main/java/com/x/MainActivity.kt:3:8 Unresolved reference: Foo',
    '/build/android/app/src/main/java/com/x/A.java:10: error: cannot find symbol',
    'Error: Unable to resolve module ./missing from /build/App.js',
  ]) {
    assert.equal(formatBuildLogLine(line), `[ERROR] ${line}`, line);
  }

  console.log('  [build-log] Gradle download dots collapse into one line...');
  assert.equal(formatBuildLogLine('.........10%..........20%..........30%.........100%'), 'Download progress: 100%');
  assert.equal(formatBuildLogLine('..........'), 'Download progress: done');
  assert.equal(formatBuildLogLine('...'), 'Download progress: done');
  assert.equal(formatBuildLogLine(''), '');

  console.log('  [build-log] Chunks split mid-line are joined per stream...');
  const out: string[] = [];
  const lines = new BuildLogLines((text) => out.push(text));
  lines.push('stdout', 'Downloading https://services.gradle.org/distributions/gradle-8.8-bin.zip\n.....10%....');
  lines.push('stderr', 'npm warn depre');
  lines.push('stdout', '.....50%.....100%\r\n> Task :app:preBuild\n');
  lines.push('stderr', 'cated glob@7.2.3\nnpm error code ERESOLVE\n');
  lines.push('stdout', 'BUILD FAILED in 1s');
  lines.flush();
  assert.deepEqual(out.join('\n').split('\n'), [
    'Downloading https://services.gradle.org/distributions/gradle-8.8-bin.zip',
    'Download progress: 100%',
    '> Task :app:preBuild',
    'npm warn deprecated glob@7.2.3',
    '[ERROR] npm error code ERESOLVE',
    '[ERROR] BUILD FAILED in 1s',
  ]);
  assert.ok(out.every((text) => !text.endsWith('\n')), 'the worker adds the newline after each call');

  console.log('  v Build log tests passed.');
}
