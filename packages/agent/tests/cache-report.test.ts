import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CACHE_REPORT_FN, PACKAGED_ABIS, getBuildCommand } from '../src/models/docker-sandbox.js';

/**
 * `cache_report` (docker-sandbox.ts): after Gradle, the build log says how many dependencies were downloaded because
 * the shared read-only cache did not have them, and where the disk went. Runs the real shell function on a fake
 * Gradle home (Linux/CI; skipped where there is no sh). Also: 64-bit only (DEC-09).
 */
function hasSh(): boolean {
  try {
    execFileSync('sh', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function file(p: string, kb: number) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(kb * 1024));
}

export default async function run() {
  console.log('  [cache-report] 64-bit ARM only (DEC-09)...');
  assert.deepEqual(PACKAGED_ABIS, ['arm64-v8a']);
  const rn = getBuildCommand('react-native');
  const flutter = getBuildCommand('flutter', '3f9a1c07-be42-4d11-9a0e-123456789abc');
  for (const cmd of [rn, flutter]) {
    assert.ok(!cmd.includes('armeabi-v7a') && !cmd.includes('android-arm,'), 'no 32-bit ARM');
    assert.ok(cmd.includes(CACHE_REPORT_FN), 'cache_report is defined in the command');
  }
  assert.ok(rn.indexOf('step_done "gradle"') < rn.indexOf('(cache_report android || true)'), 'RN: reported after Gradle');
  assert.ok(flutter.includes('--target-platform android-arm64 '), 'Flutter: android-arm64 only');

  if (!hasSh()) {
    console.log('  (skipped running cache_report: no sh on this machine)');
    console.log('  🟢 Cache report tests passed.');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-report-'));
  try {
    const gh = path.join(tmp, 'gradle-home');
    const ro = path.join(tmp, 'ro-cache');
    const work = path.join(tmp, 'build');
    // Two dependencies downloaded during the build, one transform, a node_modules and an android/ folder.
    file(path.join(gh, 'caches/modules-2/files-2.1/com.example/a/1.0/hash/a-1.0.jar'), 300);
    file(path.join(gh, 'caches/modules-2/files-2.1/com.example/b/1.0/hash/b-1.0.aar'), 200);
    file(path.join(gh, 'caches/transforms-4/x/out.jar'), 100);
    file(path.join(ro, 'modules-2/files-2.1/org.x/y/1/h/y.jar'), 10);
    file(path.join(ro, 'modules-2/files-2.1/org.x/z/1/h/z.jar'), 10);
    file(path.join(ro, 'modules-2/files-2.1/org.x/w/1/h/w.jar'), 10);
    file(path.join(work, 'node_modules/pkg/index.js'), 50);
    file(path.join(work, 'android/app/build/out.bin'), 50);

    const report = (env: Record<string, string>) => execFileSync('sh', ['-c', `${CACHE_REPORT_FN} cache_report android`], {
      cwd: work, encoding: 'utf8', env: { ...process.env, ...env },
    });

    console.log('  [cache-report] Counts what Gradle downloaded and what the shared cache offers...');
    const out = report({ GRADLE_USER_HOME: gh, GRADLE_RO_DEP_CACHE: ro });
    assert.match(out, /^\[CACHE\] Downloaded during this build \(not in the shared read-only cache\): 2 dependency files, \d+ MB$/m);
    assert.match(out, /^\[CACHE\] Shared read-only cache: 3 dependency files available$/m);
    assert.match(out, /^\[CACHE\] Disk: Gradle caches \d+ MB \(transforms \d+ MB\), node_modules \d+ MB, android\/ \d+ MB$/m);
    assert.ok(out.split('\n').every((l) => !l || l.startsWith('[CACHE] ')), 'only [CACHE] lines, never [ERROR]');

    console.log('  [cache-report] Without the cache mount, or with nothing downloaded...');
    const none = report({ GRADLE_USER_HOME: path.join(tmp, 'empty-home'), GRADLE_RO_DEP_CACHE: '' });
    assert.match(none, /: 0 dependency files, 0 MB$/m);
    assert.match(none, /Shared read-only cache: not mounted/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('  🟢 Cache report tests passed.');
}
