// packages/agent/tests/dns-allowlist.test.ts
/*
 * The sandbox's DNS resolver must answer only allowlisted names; everything else is NXDOMAIN and never
 * forwarded (so a build cannot leak data inside DNS queries).
 * The config checks run everywhere. The in-sandbox check runs on the Linux worker host (requires root):
 *   cd /opt/peep/packages/agent
 *   sudo npx tsx tests/dns-allowlist.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ALLOWLISTED_FQDNS, IPSET_NAME, UPSTREAM_RESOLVERS, generateDnsmasqConfig } from '../src/models/network-setup.js';
import { DockerSandbox } from '../src/models/docker-sandbox.js';

function checkConfig() {
  const lines = generateDnsmasqConfig().split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

  assert.ok(lines.includes('no-resolv'), 'must ignore the host resolv.conf');
  // A server= line without a /domain/ forwards every name upstream and defeats the allowlist.
  assert.deepEqual(lines.filter((l) => l.startsWith('server=') && !l.startsWith('server=/')), [], 'no global server= line');
  for (const fqdn of ALLOWLISTED_FQDNS) {
    for (const upstream of UPSTREAM_RESOLVERS) {
      assert.ok(lines.includes(`server=/${fqdn}/${upstream}`), `missing server=/${fqdn}/${upstream}`);
    }
    assert.ok(lines.includes(`ipset=/${fqdn}/${IPSET_NAME}`), `missing ipset for ${fqdn}`);
  }
  // Only allowlisted domains have an upstream.
  const forwarded = new Set(lines.filter((l) => l.startsWith('server=/')).map((l) => l.split('/')[1]));
  assert.deepEqual([...forwarded].sort(), [...ALLOWLISTED_FQDNS].sort());
  assert.equal(lines[lines.length - 1], 'address=/#/', 'catch-all NXDOMAIN must be last');
}

async function checkInsideSandbox() {
  const jobId = `dns-allow-${randomUUID().slice(0, 8)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dns-allow-'));
  const projectPath = path.join(tmpDir, 'project');
  await fs.mkdir(path.join(projectPath, 'android'), { recursive: true });
  await fs.writeFile(path.join(projectPath, 'package.json'), JSON.stringify({ name: 'dns-test', version: '1.0.0', private: true }));
  // The React Native build ends with ./gradlew; this one only resolves names. getent exits 2 on NXDOMAIN.
  await fs.writeFile(path.join(projectPath, 'android', 'gradlew'), [
    '#!/bin/sh',
    'for name in registry.npmjs.org dl.google.com example.com leak-1234.attacker.example.net; do',
    '  if getent hosts "$name" >/dev/null; then echo "[DNS] $name RESOLVED"; else echo "[DNS] $name NXDOMAIN"; fi',
    'done',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 });

  const sandbox = new DockerSandbox({ jobId, projectPath, framework: 'react-native', timeoutMs: 5 * 60 * 1000 });
  let logs = '';
  try {
    await sandbox.runBuild((chunk) => { logs += chunk; });
  } finally {
    await sandbox.forceKill();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
  const result = (name: string) => new RegExp(`\\[DNS\\] ${name.replace(/\./g, '\\.')} (RESOLVED|NXDOMAIN)`).exec(logs)?.[1];
  console.log(logs.split('\n').filter((l) => l.includes('[DNS]')).join('\n'));
  assert.equal(result('registry.npmjs.org'), 'RESOLVED');
  assert.equal(result('dl.google.com'), 'RESOLVED');
  assert.equal(result('example.com'), 'NXDOMAIN');
  assert.equal(result('leak-1234.attacker.example.net'), 'NXDOMAIN');
}

async function run() {
  console.log('\n--- DNS allowlist: only allowlisted names resolve ---');
  checkConfig();
  if (process.platform !== 'linux') {
    console.log('  Config checks passed. In-sandbox check SKIPPED: must run on a Linux host with Docker (root).');
    return;
  }
  await checkInsideSandbox();
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export default run;
