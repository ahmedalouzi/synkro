// packages/agent/tests/timeout-zombie.test.ts
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
  console.log('\n--- ADVERSARIAL TEST: Timeout & Zombie Process Isolation ---');

  // Skipped (or, with SYNKRO_RUN_SANDBOX_TESTS=1, failed) without the Linux build server: see sandbox-requirements.ts.
  await requireSandbox();

  

  const jobId = `adv-zombie-${randomUUID().slice(0, 8)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-zombie-'));
  const projectPath = path.join(tmpDir, 'project');
  const androidDir = path.join(projectPath, 'android');
  await fs.mkdir(androidDir, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'adv-test', version: '1.0.0', private: true }));

  const gradlewPath = path.join(androidDir, 'gradlew');
  const attackScript = `#!/bin/sh
echo "[ZOMBIE] Starting malicious payload..."
trap 'echo "[ZOMBIE] Caught SIGTERM! Refusing to die..."' TERM
echo "[ZOMBIE] Entering infinite sleep loop..."
while true; do
  sleep 1
done
`;
  await fs.writeFile(gradlewPath, attackScript, { mode: 0o777 });
  await fs.writeFile(path.join(androidDir, 'gradle.properties'), '');

  const keystorePath = path.join(tmpDir, 'dummy.jks');
  await fs.writeFile(keystorePath, 'dummy keystore content');

  const timeoutMs = 15000;
  const sandbox = new DockerSandbox({
    jobId,
    projectPath,
    framework: 'react-native',
    keystorePath,
    keystorePassword: 'dummy',
    keyAlias: 'dummy',
    keyPassword: 'dummy',
    timeoutMs,
  });

  console.log(`  [SETUP] Running Sandbox Build with Zombie Payload (Timeout: ${timeoutMs / 1000}s)...`);
  const logs: string[] = [];
  const startTime = Date.now();
  const success = await sandbox.runBuild((chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      logs.push(text);
      console.log(`    > ${text}`);
    }
  });

  const durationMs = Date.now() - startTime;

  console.log('\n--- TEST ASSERTIONS ---');
  console.log(`  [ASSERT] runBuild() returned ${success}`);
  assert.strictEqual(success, false, 'runBuild() should return false when timed out');

  console.log(`  [ASSERT] Elapsed time: ${durationMs}ms`);
  const minExpectedTime = timeoutMs - 2000;
  const maxExpectedTime = timeoutMs + 10000;
  assert.ok(durationMs >= minExpectedTime && durationMs <= maxExpectedTime, `Execution time ${durationMs}ms should be around ${timeoutMs}ms`);

  const containerName = sandbox['containerName'];
  console.log(`  [ASSERT] Checking for lingering container: ${containerName}`);
  const { stdout } = await execFileAsync('docker', ['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}']);
  const lingering = stdout.trim();
  if (lingering === containerName) {
    console.error('\n❌ FAIL: Zombie container survived forceKill()! Docker rm -f failed or was bypassed.');
    assert.fail('Container still exists on the host.');
  } else {
    console.log('✅ PASS: Container successfully eradicated from host.');
  }

  const fullLog = logs.join('\n');
  assert.ok(fullLog.includes('Terminating container...'), 'Missing timeout termination log entry');
  console.log('✅ PASS: Timeout and Zombie Process Isolation strictly enforced.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('timeout-zombie.test.ts')) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export default run;
