import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DockerSandbox,
  GRADLE_RO_CACHE_MOUNT,
  SANDBOX_RESOURCES,
  STEP_FN,
  formatStepDuration,
  getBuildCommand,
  gradleRoCacheSource,
} from '../src/models/docker-sandbox.js';
import { formatBuildLogLine } from '../src/models/build-log.js';

/**
 * Cloud Build speed (DEC-08), without Docker: resources while builds are serial, the shared read-only Gradle cache
 * mount, and the [STEP] timing lines. The real read-only check runs in gradle-ro-cache-sandbox.test.ts on Linux.
 */
const PROJECT_ID = '3f9a1c07-be42-4d11-9a0e-123456789abc';

function args(framework: 'react-native' | 'flutter', extra: { gradleRoCache?: boolean } = {}): string[] {
  return new DockerSandbox({ jobId: 'job', projectPath: '/tmp/p', framework, projectId: PROJECT_ID, ...extra }).createContainerArgs('build-restricted');
}

function hasSh(): boolean {
  try {
    execFileSync('sh', ['-c', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export default async function run() {
  const saved = process.env.SYNKRO_GRADLE_RO_CACHE_DIR;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ro-cache-'));
  try {
    console.log('  [speed] Resources: 3.5 CPUs, 5g memory; the other limits unchanged...');
    assert.deepEqual(SANDBOX_RESOURCES, { cpus: '3.5', memory: '5g', gradleWorkers: 3, gradleHeap: '2g' });
    process.env.SYNKRO_GRADLE_RO_CACHE_DIR = path.join(tmp, 'missing');
    const rn = args('react-native');
    for (const a of ['--cpus=3.5', '--memory=5g', '--memory-swap=5g', '--pids-limit=384', '--cap-drop=ALL', 'no-new-privileges', '--user=1000:1000', 'size=12G']) {
      assert.ok(rn.includes(a), `missing ${a}`);
    }
    assert.ok(args('flutter').includes('size=15G'));
    const rnCmd = getBuildCommand('react-native');
    assert.ok(rnCmd.includes('org.gradle.workers.max=3'));
    assert.ok(rnCmd.includes('org.gradle.jvmargs=-Xmx2g'));
    assert.ok(!/workers\.max=2|Xmx1g/.test(rnCmd));
    console.log('    ✓ --cpus=3.5 --memory=5g; pids 384, cap-drop, no-new-privileges, uid 1000, disk 12G/15G; Gradle workers 3, -Xmx2g');

    console.log('  [speed] No read-only cache: the build runs exactly as before...');
    // The -e argument and the mount, not the build script (cache_report mentions $GRADLE_RO_DEP_CACHE).
    assert.ok(!rn.some((a) => a.startsWith('GRADLE_RO_DEP_CACHE=') || a === '--mount' || a.includes(`target=${GRADLE_RO_CACHE_MOUNT}`)), 'no cache dir: no mount');
    fs.mkdirSync(path.join(tmp, 'empty', 'react-native'), { recursive: true });
    assert.equal(gradleRoCacheSource('react-native', path.join(tmp, 'empty')), null, 'a framework dir without modules-2 is not used');
    console.log('    ✓ Missing or empty cache: no mount, no GRADLE_RO_DEP_CACHE');

    console.log('  [speed] With a cache: mounted read-only, GRADLE_RO_DEP_CACHE set...');
    const versionDir = path.join(tmp, 'cache', '.versions', 'react-native-1');
    fs.mkdirSync(path.join(versionDir, 'modules-2'), { recursive: true });
    let linked = true;
    try {
      fs.symlinkSync(path.join('.versions', 'react-native-1'), path.join(tmp, 'cache', 'react-native'), 'dir');
    } catch {
      // Windows without symlink rights: a plain directory exercises the same mount.
      linked = false;
      fs.mkdirSync(path.join(tmp, 'cache', 'react-native', 'modules-2'), { recursive: true });
    }
    process.env.SYNKRO_GRADLE_RO_CACHE_DIR = path.join(tmp, 'cache');
    const expected = fs.realpathSync(path.join(tmp, 'cache', 'react-native'));
    if (linked) assert.equal(expected, fs.realpathSync(versionDir), 'the symlink is resolved: a build keeps its version');
    assert.equal(gradleRoCacheSource('react-native'), expected);
    const withCache = args('react-native');
    const m = withCache.indexOf('--mount');
    assert.ok(m > 0, 'mounted');
    assert.equal(withCache[m + 1], `type=bind,source=${expected},target=${GRADLE_RO_CACHE_MOUNT},readonly`);
    assert.ok(withCache.includes(`GRADLE_RO_DEP_CACHE=${GRADLE_RO_CACHE_MOUNT}`));
    assert.ok(m < withCache.indexOf('synkro/rn-sandbox:1'), 'options come before the image');
    assert.equal(withCache.filter((a) => a === '--mount' || a === '-v' || a === '--volume').length, 1, 'the cache is the only mount');
    assert.ok(!args('react-native', { gradleRoCache: false }).includes('--mount'), 'the warm-up build does not read the old cache');
    assert.equal(gradleRoCacheSource('flutter'), null, 'per framework: no Flutter cache yet');
    console.log(`    ✓ --mount ...,readonly + GRADLE_RO_DEP_CACHE${linked ? '; symlink resolved to the version' : ''}; off for the warm-up build`);

    console.log('  [speed] The cache bind mount survives a reboot (fstab, after the Docker volume)...');
    const setup = fs.readFileSync(new URL('../../../scripts/setup-production-server.sh', import.meta.url), 'utf8');
    assert.match(setup, /FSTAB_LINE="\$\{GRADLE_RO_CACHE_STORE\} \$\{GRADLE_RO_CACHE_DIR\} none bind,nofail,x-systemd\.requires-mounts-for=\/var\/lib\/docker 0 0"/);
    assert.match(setup, /GRADLE_RO_CACHE_DIR="\/var\/lib\/synkro\/gradle-ro-cache"/);
    assert.match(setup, /GRADLE_RO_CACHE_STORE="\/var\/lib\/docker\/synkro-cache\/gradle-ro"/);
    assert.match(setup, />> \/etc\/fstab/);
    console.log('    ✓ fstab bind,nofail,x-systemd.requires-mounts-for=/var/lib/docker');

    console.log('  [speed] [STEP] lines...');
    assert.equal(formatStepDuration(102_000), '1m42s');
    assert.equal(formatStepDuration(5_000), '0m05s');
    assert.equal(formatStepDuration(1_026_000), '17m06s');
    assert.equal(formatBuildLogLine('[STEP] npm install 1m42s'), '[STEP] npm install 1m42s', 'never [ERROR]');
    const order = ['npm_install ci', 'step_done "npm install"', 'npx expo prebuild', 'step_done "expo prebuild"', './gradlew assembleRelease', 'step_done "gradle"'];
    order.reduce((prev, part) => {
      const i = rnCmd.indexOf(part, prev);
      assert.ok(i > prev, `step order: ${part}`);
      return i;
    }, -1);
    const flutterCmd = getBuildCommand('flutter', PROJECT_ID);
    assert.ok(flutterCmd.indexOf('step_done "flutter create"') < flutterCmd.indexOf('flutter build apk'));
    assert.ok(flutterCmd.indexOf('step_done "gradle (flutter build apk)"') < flutterCmd.indexOf('(cache_report build || true)'));
    if (hasSh()) {
      const out = execFileSync('sh', ['-c', `${STEP_FN} step_done "npm install"`], { encoding: 'utf8' });
      assert.match(out, /^\[STEP\] npm install 0m0[0-2]s\n$/);
      console.log('    ✓ step_done prints "[STEP] npm install 0m00s"; steps in order for RN and Flutter');
    } else {
      console.log('    ✓ steps in order for RN and Flutter (no sh here: step_done itself not run)');
    }
  } finally {
    if (saved === undefined) delete process.env.SYNKRO_GRADLE_RO_CACHE_DIR;
    else process.env.SYNKRO_GRADLE_RO_CACHE_DIR = saved;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('  🟢 Build speed tests passed.');
}
