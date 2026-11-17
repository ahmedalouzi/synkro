// packages/agent/tests/gradle-ro-cache-sandbox.test.ts
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DockerSandbox } from '../src/models/docker-sandbox.js';
import { requireSandbox } from './sandbox-requirements.js';

/**
 * The shared Gradle cache (DEC-08) in a real sandbox: the build can read it and sees GRADLE_RO_DEP_CACHE, and can
 * neither write, delete nor create anything in it. The host directory is made world-writable on purpose, so only the
 * read-only mount itself can stop the writes. Skipped without the Linux build server (sandbox-requirements.ts).
 */
async function run() {
  console.log('\n--- SANDBOX: the shared Gradle cache is read-only ---');
  await requireSandbox();

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ro-cache-sbx-'));
  const saved = process.env.SYNKRO_GRADLE_RO_CACHE_DIR;
  const cacheRoot = path.join(tmp, 'cache');
  const modules = path.join(cacheRoot, 'react-native', 'modules-2');
  await fs.mkdir(modules, { recursive: true });
  await fs.writeFile(path.join(modules, 'probe.txt'), 'CACHED');
  for (const dir of [cacheRoot, path.join(cacheRoot, 'react-native'), modules]) await fs.chmod(dir, 0o777);
  await fs.chmod(path.join(modules, 'probe.txt'), 0o666);
  process.env.SYNKRO_GRADLE_RO_CACHE_DIR = cacheRoot;

  const project = path.join(tmp, 'project');
  await fs.mkdir(path.join(project, 'android'), { recursive: true });
  await fs.writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'ro-test', version: '1.0.0', private: true }));
  await fs.writeFile(path.join(project, 'android', 'gradle.properties'), '');
  await fs.writeFile(path.join(project, 'android', 'gradlew'), [
    '#!/bin/sh',
    'echo "[RO_ENV] $GRADLE_RO_DEP_CACHE"',
    'grep -q CACHED /opt/gradle-ro-cache/modules-2/probe.txt && echo "[RO_READ_OK]"',
    'if echo x >> /opt/gradle-ro-cache/modules-2/probe.txt 2>/dev/null; then echo "[RO_WRITE_ALLOWED]"; else echo "[RO_WRITE_BLOCKED]"; fi',
    'if touch /opt/gradle-ro-cache/modules-2/new 2>/dev/null; then echo "[RO_CREATE_ALLOWED]"; else echo "[RO_CREATE_BLOCKED]"; fi',
    'if rm -f /opt/gradle-ro-cache/modules-2/probe.txt 2>/dev/null && [ ! -e /opt/gradle-ro-cache/modules-2/probe.txt ]; then echo "[RO_DELETE_ALLOWED]"; else echo "[RO_DELETE_BLOCKED]"; fi',
    'exit 0',
    '',
  ].join('\n'), { mode: 0o777 });

  const sandbox = new DockerSandbox({ jobId: `ro-cache-${randomUUID().slice(0, 8)}`, projectPath: project, framework: 'react-native', timeoutMs: 180_000 });
  let log = '';
  try {
    const ok = await sandbox.runBuild((chunk) => {
      log += `${chunk}\n`;
      process.stdout.write(`    > ${chunk}\n`);
    });
    assert.ok(ok, 'the probe build failed (log above)');
    assert.match(log, /Using the shared Gradle dependency cache \(read-only\)/);
    assert.match(log, /\[RO_ENV\] \/opt\/gradle-ro-cache/);
    assert.match(log, /\[RO_READ_OK\]/);
    for (const blocked of ['WRITE', 'CREATE', 'DELETE']) {
      assert.match(log, new RegExp(`\\[RO_${blocked}_BLOCKED\\]`), `${blocked} must be blocked`);
      assert.doesNotMatch(log, new RegExp(`\\[RO_${blocked}_ALLOWED\\]`));
    }
    assert.equal(await fs.readFile(path.join(modules, 'probe.txt'), 'utf8'), 'CACHED', 'the host file is unchanged');
    await assert.rejects(fs.stat(path.join(modules, 'new')), 'nothing was created on the host');
    console.log('PASS: the sandbox reads the cache and cannot write, create or delete anything in it.');
  } finally {
    await sandbox.forceKill();
    if (saved === undefined) delete process.env.SYNKRO_GRADLE_RO_CACHE_DIR;
    else process.env.SYNKRO_GRADLE_RO_CACHE_DIR = saved;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export default run;
