// packages/agent/tests/fork-bomb.test.ts
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

async function getHostLoad() {
  const { stdout } = await execFileAsync('uptime');
  const match = stdout.match(/load average[s]?:\s+([0-9.]+)/);
  return match ? parseFloat(match[1]) : 0;
}

async function run() {
  console.log('\n--- ADVERSARIAL TEST: Fork Bomb (Process Exhaustion) ---');

  // Skipped (or, with SYNKRO_RUN_SANDBOX_TESTS=1, failed) without the Linux build server: see sandbox-requirements.ts.
  await requireSandbox();

  

  const loadBefore = await getHostLoad();
  console.log(`  [HOST] System 1-minute load average before attack: ${loadBefore}`);

  const jobId = `adv-fork-${randomUUID().slice(0, 8)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-fork-'));
  const projectPath = path.join(tmpDir, 'project');
  const androidDir = path.join(projectPath, 'android');
  await fs.mkdir(androidDir, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'adv-test', version: '1.0.0', private: true }));

  const gradlewPath = path.join(androidDir, 'gradlew');
  const attackScript = `#!/bin/sh
echo "[FORK] Starting linear process explosion payload..."
count=0
while [ $count -lt 500 ]; do
  sleep 60 &
  count=$((count + 1))
done
echo "[FORK] Finished spawn loop, attempting to run one more command..."
ls -l / > /dev/null 2>&1 || echo "[FORK_FAILED] Final command failed due to PID limits!"
sleep 15
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

  console.log(`  [SETUP] Running Sandbox Build with Fork Bomb Payload...`);
  const logs: string[] = [];
  let pidsObserved = -1;
  const containerName = sandbox['containerName'];

  const pidPoller = setInterval(async () => {
    try {
      const { stdout } = await execFileAsync('docker', ['stats', containerName, '--no-stream', '--format', '{{.PIDs}}']);
      const pids = parseInt(stdout.trim(), 10);
      if (!isNaN(pids)) {
        pidsObserved = Math.max(pidsObserved, pids);
      }
    } catch {
      // Container might not be up yet, or just exited.
    }
  }, 50);

  await sandbox.runBuild((chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      logs.push(text);
    }
  });

  clearInterval(pidPoller);

  const loadAfter = await getHostLoad();
  console.log(`  [HOST] System 1-minute load average after attack: ${loadAfter}`);

  const fullLog = logs.join('\n');
  console.log('\n--- FULL RAW BUILD LOG (debug) ---');
  console.log(fullLog);
  console.log('--- END RAW BUILD LOG ---\n');

  console.log('\n--- TEST ASSERTIONS ---');
  const loadDiff = Math.abs(loadAfter - loadBefore);
  console.log(`  [ASSERT] Host load average difference: ${loadDiff.toFixed(2)}`);
  assert.ok(loadDiff < 5.0, 'Host load average spiked significantly, indicating kernel struggle!');

  console.log(`  [ASSERT] Max PIDs observed via docker stats: ${pidsObserved}`);
  if (pidsObserved > 0) {
    assert.ok(pidsObserved <= 200, `Container exceeded PID limit! Reached ${pidsObserved}`);
  } else {
    console.log(`  [ASSERT] Polling missed PID capture (container failed too fast), skipping exact count assertion.`);
  }

  console.log(`  [ASSERT] Checking for fork failures in log...`);
  const hitLimits = fullLog.toLowerCase().includes('resource temporarily unavailable') ||
                    fullLog.toLowerCase().includes("can't fork") ||
                    fullLog.toLowerCase().includes("cannot fork") ||
                    fullLog.includes('[FORK_FAILED]');
  assert.ok(hitLimits, 'Container shell never reported fork failures (EAGAIN)');

  console.log(`  [ASSERT] Checking for lingering container: ${containerName}`);
  const { stdout } = await execFileAsync('docker', ['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}']);
  const lingering = stdout.trim();
  if (lingering === containerName) {
    console.error('\n❌ FAIL: Container survived completion/forceKill!');
    assert.fail('Container still exists on the host.');
  } else {
    console.log('✅ PASS: Container successfully eradicated from host.');
  }

  console.log('✅ PASS: Fork Bomb and Process Exhaustion strictly isolated.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('fork-bomb.test.ts')) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export default run;
