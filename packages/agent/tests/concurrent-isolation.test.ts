// packages/agent/tests/concurrent-isolation.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DockerSandbox } from '../src/models/docker-sandbox.js';
import { requireSandbox } from './sandbox-requirements.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('\n--- ADVERSARIAL TEST: Concurrent User Isolation ---');

  // Skipped (or, with SYNKRO_RUN_SANDBOX_TESTS=1, failed) without the Linux build server: see sandbox-requirements.ts.
  await requireSandbox();

  

  const jobIdA = `adv-iso-A-${randomUUID().slice(0, 8)}`;
  const jobIdB = `adv-iso-B-${randomUUID().slice(0, 8)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-iso-'));
  const projectPathA = path.join(tmpDir, 'projectA');
  const projectPathB = path.join(tmpDir, 'projectB');
  await fs.mkdir(path.join(projectPathA, 'android'), { recursive: true });
  await fs.writeFile(path.join(projectPathA, 'package.json'), JSON.stringify({ name: 'adv-test', version: '1.0.0', private: true }));
  await fs.mkdir(path.join(projectPathB, 'android'), { recursive: true });
  await fs.writeFile(path.join(projectPathB, 'package.json'), JSON.stringify({ name: 'adv-test', version: '1.0.0', private: true }));

  const keystorePath = path.join(tmpDir, 'dummy.jks');
  await fs.writeFile(keystorePath, 'dummy keystore content');

  const scriptB = '#!/bin/sh\n' +
    'echo "[JOB_B] Starting target services..."\n' +
    'touch /tmp/jobB_marker.txt\n' +
    'python3 -m http.server 8000 &\n' +
    'HTTP_PID=$!\n' +
    'sleep 15\n' +
    'kill $HTTP_PID 2>/dev/null || true\n' +
    'echo "[JOB_B] Finished."\n';
  await fs.writeFile(path.join(projectPathB, 'android', 'gradlew'), scriptB, { mode: 0o777 });
  await fs.writeFile(path.join(projectPathB, 'android', 'gradle.properties'), '');

  const scriptA = '#!/bin/sh\n' +
    'echo "[JOB_A] Starting attack..."\n' +
    'echo "[JOB_A] Waiting for target IP to be injected..."\n' +
    'while [ ! -f /build/target_ip.txt ]; do sleep 0.5; done\n' +
    'TARGET_IP=$(cat /build/target_ip.txt)\n' +
    'echo "[JOB_A] Acquired target IP: $TARGET_IP"\n' +
    'echo "[JOB_A] Attempting network connection to $TARGET_IP:8000..."\n' +
    'curl -s -v -m 2 http://$TARGET_IP:8000/\n' +
    'CURL_EXIT=$?\n' +
    'if [ $CURL_EXIT -eq 0 ]; then\n' +
    '  echo "[ISOLATION_FAILED] Network isolated failed! Successfully connected to Job B."\n' +
    'else\n' +
    '  echo "[ISOLATION_SUCCESS] Network isolation passed. Failed to connect (code $CURL_EXIT)."\n' +
    'fi\n' +
    'echo "[JOB_A] Attempting filesystem crossover check..."\n' +
    'if [ -f /tmp/jobB_marker.txt ]; then\n' +
    '  echo "[FS_ISOLATION_FAILED] FS isolation failed! Job A can see Job B marker."\n' +
    'else\n' +
    '  echo "[FS_ISOLATION_SUCCESS] FS isolation passed. Job B marker not found."\n' +
    'fi\n' +
    'echo "[JOB_A] Finished."\n';
  await fs.writeFile(path.join(projectPathA, 'android', 'gradlew'), scriptA, { mode: 0o777 });
  await fs.writeFile(path.join(projectPathA, 'android', 'gradle.properties'), '');

  const timeoutMs = 30000;
  const sandboxB = new DockerSandbox({
    jobId: jobIdB,
    projectPath: projectPathB,
    framework: 'react-native',
    keystorePath,
    keystorePassword: 'dummy',
    keyAlias: 'dummy',
    keyPassword: 'dummy',
    timeoutMs,
  });
  const sandboxA = new DockerSandbox({
    jobId: jobIdA,
    projectPath: projectPathA,
    framework: 'react-native',
    keystorePath,
    keystorePassword: 'dummy',
    keyAlias: 'dummy',
    keyPassword: 'dummy',
    timeoutMs,
  });

  const containerNameA = sandboxA['containerName'];
  const containerNameB = sandboxB['containerName'];
  console.log(`  [ASSERT] Container A Name: ${containerNameA}`);
  console.log(`  [ASSERT] Container B Name: ${containerNameB}`);
  assert.notEqual(containerNameA, containerNameB, 'Container names must be uniquely isolated');

  console.log(`  [SETUP] Launching Job B (Target)...`);
  const logsB: string[] = [];
  const promiseB = sandboxB.runBuild((chunk) => {
    logsB.push(chunk.toString());
  });

  let ipB = '';
  console.log(`  [SETUP] Waiting for Job B container to receive an IP...`);
  for (let i = 0; i < 20; i++) {
    try {
      const { stdout } = await execFileAsync('docker', ['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', containerNameB]);
      const ip = stdout.trim();
      if (ip) {
        ipB = ip;
        break;
      }
    } catch (e) {
      // ignore until container exists
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!ipB) {
    throw new Error('Failed to obtain IP address for Job B container. Did it crash?');
  }

  console.log(`  [SETUP] Job B IP is ${ipB}. Injecting to Job A...`);
  await fs.writeFile(path.join(projectPathA, 'target_ip.txt'), ipB);

  console.log(`  [SETUP] Launching Job A (Attacker)...`);
  const logsA: string[] = [];
  const promiseA = sandboxA.runBuild((chunk) => {
    const text = chunk.toString();
    logsA.push(text);
    process.stdout.write(`    [Job A] > ${text}`);
  });

  await Promise.all([promiseA, promiseB]);

  const fullLogA = logsA.join('\n');

  console.log('\n--- TEST ASSERTIONS ---');
  assert.ok(fullLogA.includes('[ISOLATION_SUCCESS]'), 'Job A did not report network isolation success!');
  assert.ok(!fullLogA.includes('[ISOLATION_FAILED]'), 'Job A successfully connected to Job B! Network isolation broken.');
  console.log('PASS: Network isolation enforced between concurrent containers.');

  assert.ok(fullLogA.includes('[FS_ISOLATION_SUCCESS]'), 'Job A did not report FS isolation success!');
  assert.ok(!fullLogA.includes('[FS_ISOLATION_FAILED]'), 'Job A accessed Job B files! Filesystem isolation broken.');
  console.log('PASS: Filesystem overlay isolation strictly enforced.');

  console.log(`  [ASSERT] Checking for lingering containers...`);
  const { stdout: psA } = await execFileAsync('docker', ['ps', '-a', '--filter', `name=${containerNameA}`, '--format', '{{.Names}}']);
  assert.strictEqual(psA.trim(), '', `Container A (${containerNameA}) still exists on host!`);
  const { stdout: psB } = await execFileAsync('docker', ['ps', '-a', '--filter', `name=${containerNameB}`, '--format', '{{.Names}}']);
  assert.strictEqual(psB.trim(), '', `Container B (${containerNameB}) still exists on host!`);
  console.log('PASS: Both concurrent containers successfully eradicated from host.');

  console.log('\nPASS: Concurrent User Isolation strictly verified.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('concurrent-isolation.test.ts')) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export default run;
