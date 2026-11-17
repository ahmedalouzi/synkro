import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GRADLE_BUILD_FN, getBuildCommand } from '../src/models/docker-sandbox.js';

/**
 * `gradle_build` (docker-sandbox.ts, DEC-10): when Gradle fails because an entry of the image's build cache cannot be
 * read, the build runs once more with --no-build-cache; any other failure is not retried. Runs the real shell
 * function against a fake gradlew (Linux/CI; skipped where there is no sh).
 */
function hasSh(): boolean {
  try {
    execFileSync('sh', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export default async function run() {
  console.log('  [gradle-retry] Real RN builds run Gradle through gradle_build...');
  const cmd = getBuildCommand('react-native');
  assert.ok(cmd.includes(GRADLE_BUILD_FN), 'gradle_build is defined in the command');
  assert.ok(cmd.includes('(cd android && gradle_build env NODE_ENV=production ./gradlew assembleRelease '), 'Gradle runs through gradle_build');

  if (!hasSh()) {
    console.log('  (skipped running gradle_build: no sh on this machine)');
    console.log('  🟢 Gradle build-cache retry tests passed.');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gradle-retry-'));
  try {
    // Fake gradlew: records its arguments; fails as told by MODE unless run with --no-build-cache.
    const fake = path.join(tmp, 'gradlew');
    const calls = path.join(tmp, 'calls');
    fs.writeFileSync(fake, [
      '#!/bin/sh',
      `echo "$*" >> "${calls.replace(/\\/g, '/')}"`,
      'case " $* " in *" --no-build-cache "*) echo "BUILD SUCCESSFUL"; exit 0;; esac',
      'case "$MODE" in',
      '  ok) echo "BUILD SUCCESSFUL"; exit 0;;',
      '  transform) echo "     > Failed to load cache entry e855 for ClasspathEntrySnapshotTransform: /x/groovy.jar: Could not load from local cache: null"; echo "BUILD FAILED"; exit 1;;',
      "  task) echo \"Could not load entry 1a2b for task ':app:compileReleaseKotlin' from local build cache\"; echo 'BUILD FAILED'; exit 1;;",
      '  code) echo "e: App.kt: Unresolved reference: foo"; echo "BUILD FAILED"; exit 1;;',
      'esac',
    ].join('\n'), { mode: 0o755 });

    const runBuild = (mode: string) => {
      fs.rmSync(calls, { force: true });
      let out = '';
      let status = 0;
      try {
        out = execFileSync('sh', ['-c', `${GRADLE_BUILD_FN} gradle_build env MODE=${mode} sh ./gradlew assembleRelease -Px=1`], {
          cwd: tmp, encoding: 'utf8', env: { ...process.env, TMPDIR: tmp },
        });
      } catch (err: any) {
        out = String(err.stdout ?? '');
        status = err.status;
      }
      const ran = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : [];
      return { out, status, ran };
    };

    console.log('  [gradle-retry] Success: runs once, no retry...');
    let r = runBuild('ok');
    assert.equal(r.status, 0);
    assert.deepEqual(r.ran, ['assembleRelease -Px=1']);
    assert.doesNotMatch(r.out, /retrying/);

    for (const mode of ['transform', 'task']) {
      console.log(`  [gradle-retry] Unreadable build cache (${mode}): one retry with --no-build-cache...`);
      r = runBuild(mode);
      assert.equal(r.status, 0, 'the retry succeeds');
      assert.deepEqual(r.ran, ['assembleRelease -Px=1', 'assembleRelease -Px=1 --no-build-cache']);
      assert.match(r.out, /^\[SYSTEM\] Build cache unreadable, retrying without it$/m);
      assert.match(r.out, /Could not load/, 'the first run streamed its output');
    }

    console.log('  [gradle-retry] Any other failure: no retry, the build fails...');
    r = runBuild('code');
    assert.equal(r.status, 1);
    assert.deepEqual(r.ran, ['assembleRelease -Px=1']);
    assert.doesNotMatch(r.out, /retrying/);
    assert.match(r.out, /Unresolved reference/);

    assert.ok(!fs.existsSync(path.join(tmp, 'gradle-build.log')) && !fs.existsSync(path.join(tmp, 'gradle-status')), 'temporary files removed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('  🟢 Gradle build-cache retry tests passed.');
}
