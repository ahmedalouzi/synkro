// packages/agent/tests/memory-exhaustion.test.ts
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

async function getHostFreeMemMB() {
  const { stdout } = await execFileAsync('free', ['-m']);
  const match = stdout.match(/Mem:\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

async function run() {
  console.log('\n--- ADVERSARIAL TEST: Memory Exhaustion (OOM) ---');

  // Skipped (or, with SYNKRO_RUN_SANDBOX_TESTS=1, failed) without the Linux build server: see sandbox-requirements.ts.
  await requireSandbox({ root: true });

  

  const memBefore = await getHostFreeMemMB();
  console.log(`  [HOST] System available memory before attack: ${memBefore} MB`);

  const jobId = `adv-oom-${randomUUID().slice(0, 8)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-oom-'));
  const projectPath = path.join(tmpDir, 'project');
  const androidDir = path.join(projectPath, 'android');
  await fs.mkdir(androidDir, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'adv-test', version: '1.0.0', private: true }));

  const gradlewPath = path.join(androidDir, 'gradlew');
  const attackScript = '#!/bin/sh\n' +
    'echo "[OOM] Starting memory exhaustion payload (Node.js Buffer allocation)..."\n' +
    'echo "[DEBUG] whoami: $(whoami)"\n' +
    'echo "[DEBUG] id: $(id)"\n' +
    'echo "[DEBUG] PATH: $PATH"\n' +
    'echo "[DEBUG] which node: $(which node || echo NOT_FOUND_ON_PATH)"\n' +
    'NODE_CMD="node"\n' +
    'if ! command -v node >/dev/null 2>&1; then\n' +
    '  if [ -x "/usr/local/bin/node" ]; then NODE_CMD="/usr/local/bin/node";\n' +
    '  elif [ -x "/usr/bin/node" ]; then NODE_CMD="/usr/bin/node";\n' +
    '  else echo "[ERROR] Could not find node anywhere!"; fi\n' +
    'fi\n' +
    'echo "[DEBUG] Using NODE_CMD: $NODE_CMD"\n' +
    'cat > /tmp/oom.js << "JSEOF"\n' +
    'let a = [];\n' +
    'while (true) {\n' +
    '  const b = Buffer.alloc(50 * 1024 * 1024);\n' +
    '  b.fill(1);\n' +
    '  a.push(b);\n' +
    '}\n' +
    'JSEOF\n' +
    'node /tmp/oom.js\n' +
    'NODE_EXIT=$?\n' +
    'if [ $NODE_EXIT -eq 137 ]; then\n' +
    '  echo "[OOM_EXIT] node was killed by OOM (exit 137)"\n' +
    '  exit 137\n' +
    'else\n' +
    '  echo "[OOM_FAILED] node exited with code $NODE_EXIT"\n' +
    '  exit 1\n' +
    'fi\n';
  await fs.writeFile(gradlewPath, attackScript, { mode: 0o777 });
  await fs.writeFile(path.join(androidDir, 'gradle.properties'), '');

  const keystorePath = path.join(tmpDir, 'dummy.jks');
  await fs.writeFile(keystorePath, 'dummy keystore content');

  const timeoutMs = 30000;
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

  console.log(`  [SETUP] Running Sandbox Build with OOM Payload (Timeout: ${timeoutMs / 1000}s)...`);
  const logs: string[] = [];
  const containerName = sandbox['containerName'];

  const { stdout: dmesgBefore } = await execFileAsync('dmesg');
  const dmesgLengthBefore = dmesgBefore.length;

  const success = await sandbox.runBuild((chunk) => {
    const text = chunk.toString();
    logs.push(text);
    process.stdout.write(text);
  });

  const memAfter = await getHostFreeMemMB();
  console.log(`  [HOST] System available memory after attack: ${memAfter} MB`);

  const fullLog = logs.join('');

  console.log('\n--- TEST ASSERTIONS ---');
  console.log(`  [ASSERT] runBuild() returned ${success}`);
  assert.strictEqual(success, false, 'runBuild() should return false when OOM killed');

  const memDiff = Math.abs(memBefore - memAfter);
  console.log(`  [ASSERT] Host available memory difference: ${memDiff} MB`);
  assert.ok(memDiff < 1000, `Host memory difference is suspiciously large (${memDiff} MB), possible leakage!`);

  console.log(`  [ASSERT] Checking for exit code 137 in log...`);
  const oomKilled = fullLog.includes('exited with code 137');
  const timedOut = fullLog.includes('Build timed out');

  assert.ok(oomKilled, timedOut
    ? 'Payload timed out WITHOUT triggering OOM (137) — inconclusive, memory limit may not be enforced or allocation was too slow'
    : 'Container did not exit with code 137 (OOM Kill)');
  assert.ok(!fullLog.includes('[OOM_FAILED]'), 'OOM payload completed without being killed!');

  console.log(`  [ASSERT] Checking host dmesg for cgroup OOM killer logs...`);
  const { stdout: dmesgAfter } = await execFileAsync('dmesg');
  const newDmesg = dmesgAfter.substring(dmesgLengthBefore);
  const hasOOM = newDmesg.toLowerCase().includes('out of memory') ||
    newDmesg.toLowerCase().includes('oom-kill') ||
    newDmesg.toLowerCase().includes('killed process');

  if (hasOOM) {
    console.log('✅ PASS: Found definitive OOM killer action in host dmesg.');
    const oomLines = newDmesg.split('\n').filter(l => l.toLowerCase().includes('oom') || l.toLowerCase().includes('killed process'));
    console.log('    Evidence:');
    oomLines.slice(0, 3).forEach(l => console.log(`      ${l.trim()}`));
  } else {
    console.warn('⚠️ WARNING: Did not find clear OOM log in dmesg. (Check if dmesg requires root or if logs go to journalctl instead)');
    assert.ok(oomKilled, 'Both dmesg AND exit code 137 missing. No proof of OOM.');
  }

  console.log(`  [ASSERT] Checking for lingering container: ${containerName}`);
  const { stdout } = await execFileAsync('docker', ['ps', '-a', '--filter', `name=${containerName}`, '--format', '{{.Names}}']);
  const lingering = stdout.trim();
  if (lingering === containerName) {
    console.error('\n❌ FAIL: Container survived completion/forceKill!');
    assert.fail('Container still exists on the host.');
  } else {
    console.log('✅ PASS: Container successfully eradicated from host.');
  }

  console.log('✅ PASS: Memory Exhaustion (OOM) strictly isolated.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('memory-exhaustion.test.ts')) {
  run().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export default run;
