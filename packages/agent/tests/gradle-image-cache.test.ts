import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ABI_INIT_SCRIPT,
  CACHE_INIT_SCRIPT,
  createGradleHomeArchive,
  getBuildCommand,
} from '../src/models/docker-sandbox.js';

/**
 * The Gradle build cache baked into synkro/rn-sandbox (DEC-10). Cache hits need the image's warm-up build to use
 * exactly what real builds use; these checks keep Dockerfile.rn-sandbox and docker-sandbox.ts in step, and check that
 * the warm-up only runs our template and leaves no signing material or secrets in the image. No Docker needed.
 */
const read = (p: string) => fs.readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

export default async function run() {
  const dockerfile = read('infra/docker/Dockerfile.rn-sandbox');
  const warm = dockerfile.slice(dockerfile.indexOf('# 4. Pre-warm Gradle'));
  assert.ok(warm.length > 100, 'the warm-up step exists');

  console.log('  [image-cache] The warm-up uses the same init script and Gradle settings as real builds...');
  assert.equal(read('infra/docker/rn-template/atomvs-abi.gradle'), ABI_INIT_SCRIPT, 'atomvs-abi.gradle is ABI_INIT_SCRIPT');
  const cmd = getBuildCommand('react-native');
  const props = [...cmd.matchAll(/printf "\\?n?([a-zA-Z.]+=[^\\"]+)\\n" >> android\/gradle\.properties/g)].map((m) => m[1]);
  assert.ok(props.includes('org.gradle.caching=true'), 'real builds read the build cache');
  assert.ok(props.length >= 6, `found the gradle.properties lines of a real build: ${props.join(', ')}`);
  for (const line of props) assert.ok(warm.includes(`${line}\\n" >> android/gradle.properties`), `the warm-up sets ${line}`);
  const arch = /-PreactNativeArchitectures=([\w,-]+)/.exec(cmd)![1];
  assert.ok(warm.includes(`./gradlew assembleRelease -PreactNativeArchitectures=${arch})`), 'same Gradle task and ABIs');
  assert.ok(warm.includes('NODE_ENV=production ./gradlew'), 'same NODE_ENV for the JS bundle');

  console.log('  [image-cache] Only our template, as the sandbox user, in /build like a real build...');
  const userLine = dockerfile.lastIndexOf('USER 1000:1000', dockerfile.indexOf('# 4. Pre-warm Gradle'));
  assert.ok(userLine > 0, 'runs as uid 1000');
  const copies = [...warm.matchAll(/^COPY .*$/gm)].map((m) => m[0]);
  assert.ok(copies.length > 0 && copies.every((c) => /^COPY --chown=1000:1000 (rn-template\/\S+ )+\S+$/.test(c)), `only rn-template/ files: ${copies.join(' | ')}`);
  assert.match(warm, /RUN cd \/build /);

  console.log('  [image-cache] Nothing secret or user-specific is left in the image...');
  for (const removed of ['/build/*', '/tmp/.gradle/caches/modules-2', '/tmp/.gradle/init.d/atomvs-abi.gradle', '/tmp/.gradle/gradle.properties']) {
    assert.ok(warm.includes(removed), `removes ${removed}`);
  }
  // Everything else in /tmp goes (the extracted Expo template with its debug.keystore, ~/.android, ~/.expo, logs).
  assert.ok(warm.includes('find /tmp -mindepth 1 -maxdepth 1 ! -name .gradle ! -name .npm-cache -exec rm -rf {} +'), 'allowlist cleanup of /tmp');
  assert.ok(/! find \/tmp \/build -xdev .*keystore/.test(warm), 'the image build fails if a keystore is left behind');
  assert.ok(warm.includes('! find /tmp/.gradle/caches/build-cache-1 -type f -empty ! -name gc.properties | grep .'), 'the image build fails on an empty cache entry');
  assert.doesNotMatch(dockerfile, /^\s*(ARG|ENV)\s+\S*(TOKEN|SECRET|PASSWORD|KEY)\S*/im, 'no secret build args or env');
  const allCopies = [...dockerfile.matchAll(/^(COPY|ADD) .*$/gm)].map((m) => m[0]);
  assert.ok(allCopies.every((c) => !/\.(jks|p12|keystore|pem)\b|gradle\.properties|\.npmrc/.test(c)), 'no keystore, credentials or properties copied in');
  assert.doesNotMatch(warm, /signing/i, 'the warm-up is not signed with any real key');

  console.log('  [image-cache] Real builds read the cache and never write it; no cache cleanup...');
  assert.match(CACHE_INIT_SCRIPT, /local \{ push = false \}/);
  assert.match(CACHE_INIT_SCRIPT, /Cleanup\.DISABLED/);
  assert.match(CACHE_INIT_SCRIPT, /GradleVersion\.version\('8\.0'\)/, 'only on Gradle 8+, where the setting exists');
  assert.equal((CACHE_INIT_SCRIPT.match(/try \{/g) ?? []).length, 2, 'each part guarded: an older Gradle builds as before');
  for (const archive of [createGradleHomeArchive(), createGradleHomeArchive({ keystore: Buffer.from('k'), storePassword: 's', keyPassword: 'k', alias: 'a' })]) {
    assert.ok(archive.includes(Buffer.from('init.d/atomvs-cache.gradle')), 'every build gets the cache init script');
    assert.ok(archive.includes(Buffer.from('push = false')));
  }

  console.log('  🟢 Image build cache tests passed.');
}
