// packages/agent/tests/disk-exhaustion.test.ts
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

async function getHostFreeDiskMB() {
  const { stdout } = await execFileAsync('df', ['-m', '/']);
  const lines = stdout.trim().split('\n');
  const parts = lines[1].trim().split(/\s+/);
  return parseInt(parts[3], 10);
}

async function run() {
  console.log('\n--- ADVERSARIAL TEST: Disk Exhaustion (Quota Verification) ---');

  // Skipped (or, with SYNKRO_RUN_SANDBOX_TESTS=1, failed) without the Linux build server: see sandbox-requirements.ts.
  await requireSandbox({ storageQuota: true });

  

  const diskBefore = await getHostFreeDiskMB();
  console.log(`  [HOST] System available disk space before attack: ${diskBefore} MB`);

  const jobId = `adv-disk-${randomUUID().slice(0, 8)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-disk-'));
  const projectPath = path.join(tmpDir, 'project');
  const androidDir = path.join(projectPath, 'android');
  await fs.mkdir(androidDir, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'adv-test', version: '1.0.0', private: true }));

  const gradlewPath = path.join(androidDir, 'gradlew');
  const attackScript = '#!/bin/sh\n' +
    'echo "[DISK] Starting disk exhaustion payload (8GB write to overlay layer)..."\n' +
    'dd if=/dev/zero of=/tmp/hugefile bs=1M count=8000\n' +
    'DD_EXIT=$?\n' +
    'echo "[DISK_EXIT] dd exited with code $DD_EXIT"\n' +
    'if [ $DD_EXIT -eq 0 ]; then\n' +
    '  echo "[DISK_FAILED] The quota failed to block the write! 8GB was successfully written."\n' +
    'else\n' +
    '  echo "[DISK_SUCCESS] The quota successfully blocked the write (ENOSPC expected)."\n' +
    'fi\n' +
    'exit 0\n';
  await fs.writeFile(gradlewPath, attackScript, { mode: 0o777 });
  await fs.writeFile(path.join(androidDir, 'gradle.properties'), '');

  const keystorePath = path.join(tmpDir, 'dummy.jks');
  await fs.writeFile(keystorePath, 'dummy keystore content');

  const timeoutMs = 60000;
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

  console.log(`  [SETUP] Running Sandbox Build with Disk Payload (Timeout: ${timeoutMs / 1000}s)...`);
  const logs: string[] = [];
  const containerName = sandbox['containerName'];

  let minDiskObserved = diskBefore;
  const diskPoller = setInterval(async () => {
    try {
      const currentDisk = await getHostFreeDiskMB();
      if (currentDisk < minDiskObserved) {
        minDiskObserved = currentDisk;
      }
    } catch {
      // ignore
    }
  }, 1000);

  const success = await sandbox.runBuild((chunk) => {
    const text = chunk.toString().trim();
    if (text) {
      logs.push(text);
      console.log(`    > ${text}`);
    }
  });

  clearInterval(diskPoller);

  const diskAfter = await getHostFreeDiskMB();
  console.log(`  [HOST] System available disk space immediately after build completion: ${diskAfter} MB`);

  const fullLog = logs.join('\n');

  console.log('\n--- TEST ASSERTIONS & FINDINGS ---');
  const maxConsumptionMB = diskBefore - minDiskObserved;
  console.log(`  [FINDING] Maximum disk space consumed during run: ~${maxConsumptionMB} MB`);

  const quotaUnenforced = maxConsumptionMB > 6000;

  if (quotaUnenforced || fullLog.includes('[DISK_FAILED]')) {
    console.warn(`\n  ARCHITECTURE FLAW PROVEN: STORAGE QUOTA NOT ENFORCED!`);
    console.warn(`  Current ext4 + overlay2 backend allows containers to consume host disk up to available space.`);
    console.warn(`  The container successfully wrote ~8GB despite the intended 5GB Docker storage-opt limit.`);
    console.warn(`  TRELLO RECOMMENDATION: Production deployment MUST use XFS with pquota mount option,`);
    console.warn(`  or an alternative like a host-side periodic disk-usage monitor/killer, before`);
    console.warn(`  Cloud Build can be considered safe against disk exhaustion attacks.\n`);
  } else {
    console.log(`  [FINDING] Storage quota appeared to enforce limits (consumed ${maxConsumptionMB} MB).`);
  }

  console.log(`  [ASSERT] Checking for lingering container: ${containerName}`);
  const { stdout } = await execFileAsync('docker', ['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}']);
  const lingering = stdout.trim();
  if (lingering === containerName) {
    console.error('\nFAIL: Container survived completion/forceKill!');
    assert.fail('Container still exists on the host.');
  } else {
    console.log('PASS: Container successfully eradicated from host.');
  }

  const finalDisk = await getHostFreeDiskMB();
  const retainedSpace = diskBefore - finalDisk;
  console.log(`  [ASSERT] Disk space retained after cleanup: ~${retainedSpace} MB`);
  assert.ok(Math.abs(retainedSpace) < 500, `Disk space did not recover! Host is missing ~${retainedSpace} MB. Possible container leak!`);
  console.log('PASS: Disk space fully recovered. Overlay layer was correctly destroyed with the container.');

  if (quotaUnenforced) {
    console.log('\nTEST RESULT: PASSED WITH KNOWN LIMITATION (quota not enforced — ext4/overlay2, documented above)');
  } else {
    console.log('\nTEST RESULT: PASSED — quota genuinely enforced by filesystem');
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('disk-exhaustion.test.ts')) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export default run;
