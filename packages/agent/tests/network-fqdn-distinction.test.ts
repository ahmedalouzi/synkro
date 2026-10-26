// packages/agent/tests/network-fqdn-distinction.test.ts
/*
 * Run this test directly on the Linux worker host (requires root for tcpdump/iptables):
 *   cd /opt/peep/packages/agent
 *   sudo npx tsx tests/network-fqdn-distinction.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import dns from 'node:dns/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DockerSandbox } from '../src/models/docker-sandbox.js';

const execFileAsync = promisify(execFile);

async function run() {
  console.log('\n--- ADVERSARIAL TEST: FQDN-Based Allowlist Distinction ---');

  if (process.platform !== 'linux') {
    console.log('  SKIPPED: This test must be run on a Linux host with Docker.');
    return;
  }

  

  const jobId = `adv-net-${randomUUID().slice(0, 8)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adv-net-'));
  const projectPath = path.join(tmpDir, 'project');
  const androidDir = path.join(projectPath, 'android');
  await fs.mkdir(androidDir, { recursive: true });
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'adv-test', version: '1.0.0', private: true }));

  console.log('  [SETUP] Verifying host can reach target TCP/80 (93.184.216.34)...');
  try {
    await execFileAsync('curl', ['-s', '--max-time', '5', 'http://93.184.216.34/']);
    console.log('  [SETUP] Host TCP/80 is reachable.');
  } catch (err) {
    assert.fail('Host cannot reach 93.184.216.34:80. Test environment is broken.');
  }

  const npmIps = await dns.resolve4('registry.npmjs.org');
  const npmIp = npmIps[0];
  console.log(`  [SETUP] Resolved registry.npmjs.org to ${npmIp}`);

  const probePyPath = path.join(androidDir, 'probe.py');
  const probePyCode = `import sys, socket

def probe_udp():
    try:
        s = socket.socket(2, 2)
        s.settimeout(3)
        q = bytes.fromhex('aabb0100000100000000000006676f6f676c6503636f6d0000010001')
        s.sendto(q, ('8.8.8.8', 53))
        s.recvfrom(512)
        print('[ADV_EVIDENCE_UDP_BAD] LEAKED')
    except socket.timeout:
        print('[ADV_EVIDENCE_UDP_BAD] blocked')
    except Exception as e:
        print(f'[ADV_EVIDENCE_UDP_BAD] ERROR {e}')

def probe_tcp80():
    try:
        s = socket.create_connection(('93.184.216.34', 80), 3)
        print('[ADV_EVIDENCE_TCP80_BAD] LEAKED')
    except (socket.timeout, ConnectionRefusedError):
        print('[ADV_EVIDENCE_TCP80_BAD] blocked')
    except OSError as e:
        if getattr(e, 'errno', 0) in (101, 113, 111, 110):
            print('[ADV_EVIDENCE_TCP80_BAD] blocked')
        else:
            print(f'[ADV_EVIDENCE_TCP80_BAD] ERROR {e}')
    except Exception as e:
        print(f'[ADV_EVIDENCE_TCP80_BAD] ERROR {e}')

if len(sys.argv) > 1:
    if sys.argv[1] == 'udp': probe_udp()
    elif sys.argv[1] == 'tcp80': probe_tcp80()
`;
  await fs.writeFile(probePyPath, probePyCode);

  const gradlewPath = path.join(androidDir, 'gradlew');
  const attackScript = `#!/bin/sh
echo "[ADV_EVIDENCE_START] Executing malicious payload inside sandbox..."
echo "[ADV_EVIDENCE_DNS_GOOD]" $(nslookup registry.npmjs.org 172.30.0.1 2>&1 | grep Address | tail -n 1)
echo "[ADV_EVIDENCE_DNS_BAD]" $(nslookup attacker.workers.dev 172.30.0.1 2>&1 | grep -i "can't find\\|nxdomain" || echo "NXDOMAIN")
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://registry.npmjs.org/)
echo "[ADV_EVIDENCE_CURL_GOOD] HTTP $HTTP_CODE"
HARDCODED_CODE=$(curl -s -o /dev/null -w "%{http_code} exit:%{exitcode}" --max-time 10 --resolve "attacker.workers.dev:443:${npmIp}" https://attacker.workers.dev/ || echo "exit:$?")
echo "[ADV_EVIDENCE_CURL_BAD] $HARDCODED_CODE"
echo "[ADV_EVIDENCE_TOOLS] $(command -v ping nslookup python3 curl || true)"
python3 /build/android/probe.py udp
python3 /build/android/probe.py tcp80
echo "[ADV_EVIDENCE_END]"
exit 0
`;
  await fs.writeFile(gradlewPath, attackScript, { mode: 0o777 });
  await fs.writeFile(path.join(androidDir, 'gradle.properties'), '');

  const keystorePath = path.join(tmpDir, 'dummy.jks');
  await fs.writeFile(keystorePath, 'dummy keystore content');

  const sandbox = new DockerSandbox({
    jobId,
    projectPath,
    framework: 'react-native',
    keystorePath,
    keystorePassword: 'dummy',
    keyAlias: 'dummy',
    keyPassword: 'dummy'
  });

  const pcapPath = `/tmp/${jobId}.pcap`;
  console.log(`  [SETUP] Starting tcpdump on interface build0...`);
  const tcpdumpProc = spawn('tcpdump', [
    '-i', 'build0',
    '-c', '10',
    '--immediate-mode',
    '-w', pcapPath,
    `dst host ${npmIp} and port 443 and not src host 172.30.0.1`
  ]);

  await new Promise(r => setTimeout(r, 1500));

  console.log(`  [SETUP] Running Sandbox Build with Malicious Payload...`);
  const logs: string[] = [];
  await sandbox.runBuild((chunk) => {
    logs.push(chunk.toString());
  });

  await new Promise(r => setTimeout(r, 1000));
  tcpdumpProc.kill('SIGTERM');

  const fullLog = logs.join('\n');

  console.log('\n--- FULL RAW BUILD LOG (debug) ---');
  console.log(fullLog);
  console.log('--- END RAW BUILD LOG ---\n');

  const extractEvidence = (marker: string) => {
    const line = fullLog.split('\n').find(l => l.includes(marker));
    return line ? line.trim() : `NOT FOUND (${marker})`;
  };

  console.log('\n--- RAW EVIDENCE ---');
  console.log(extractEvidence('[ADV_EVIDENCE_DNS_GOOD]'));
  console.log(extractEvidence('[ADV_EVIDENCE_DNS_BAD]'));
  console.log(extractEvidence('[ADV_EVIDENCE_CURL_GOOD]'));
  console.log(extractEvidence('[ADV_EVIDENCE_CURL_BAD]'));
  console.log(extractEvidence('[ADV_EVIDENCE_TOOLS]'));
  console.log(extractEvidence('[ADV_EVIDENCE_UDP_BAD]'));
  console.log(extractEvidence('[ADV_EVIDENCE_TCP80_BAD]'));

  let pcapOutput = '';
  try {
    const { stdout } = await execFileAsync('tcpdump', ['-r', pcapPath, '-n']);
    pcapOutput = stdout;
  } catch (err: any) {
    pcapOutput = err.stdout || '';
  }
  const packetLines = pcapOutput.trim().split('\n').filter(l => l.includes('443'));
  console.log(`\n[ADV_EVIDENCE_TCPDUMP] Captured ${packetLines.length} packets to ${npmIp}:443 during attack phase.`);
  if (packetLines.length > 0) {
    console.log('Raw packets:\n' + packetLines.join('\n'));
  }

  console.log('\n--- TEST ASSERTIONS ---');
  if (!fullLog.includes('[ADV_EVIDENCE_END]')) {
    console.error('\n❌ FAIL: Attack payload never executed — sandbox build likely failed before reaching the malicious script. Cannot conclude network isolation is safe.');
    assert.fail('Payload execution failed');
  }

  const dnsBadLine = extractEvidence('[ADV_EVIDENCE_DNS_BAD]').toLowerCase();
  assert.ok(dnsBadLine.includes('nxdomain') || dnsBadLine.includes('can\'t find'), 'DNS BAD did not return NXDOMAIN as expected');

  const curlGoodLine = extractEvidence('[ADV_EVIDENCE_CURL_GOOD]');
  assert.ok(curlGoodLine.includes('HTTP 200') || curlGoodLine.includes('HTTP 301') || curlGoodLine.includes('HTTP 302'), 'CURL GOOD failed');

  const curlBadLine = extractEvidence('[ADV_EVIDENCE_CURL_BAD]');
  assert.ok(!curlBadLine.includes(' 200'), 'CURL BAD unexpectedly succeeded and returned 200 OK');

  const toolsLine = extractEvidence('[ADV_EVIDENCE_TOOLS]');
  assert.ok(toolsLine.includes('python3'), 'python3 is missing, tests invalid');

  const udpBadLine = extractEvidence('[ADV_EVIDENCE_UDP_BAD]');
  assert.ok(udpBadLine.endsWith(' blocked'), `UDP BAD was not explicitly blocked: ${udpBadLine}`);

  const tcp80BadLine = extractEvidence('[ADV_EVIDENCE_TCP80_BAD]');
  assert.ok(tcp80BadLine.endsWith(' blocked'), `TCP 80 BAD was not explicitly blocked: ${tcp80BadLine}`);

  console.log('✅ PASS: Network FQDN distinction enforced correctly.');
  console.log('✅ PASS: Real DockerSandbox encapsulation tested and proven secure.');
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1].endsWith('network-fqdn-distinction.test.ts')) {
  run().catch(err => {
      console.error(err);
      process.exit(1);
    });
}

export default run;
