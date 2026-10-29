// packages/agent/tests/expo-android-build.test.ts
/*
 * Builds a Synkro-style Expo project (no android/ folder) into an APK inside the real sandbox,
 * with the network allowlist active. Run it on the Linux worker host (requires root for iptables/dnsmasq):
 *   cd /opt/peep/packages/agent
 *   sudo npx tsx tests/expo-android-build.test.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { DockerSandbox } from '../src/models/docker-sandbox.js';

/** Same files as ReactNativeManagedProvider.bootstrapProject (no android/, no android.package, no assets). */
async function writeExpoProject(dir: string) {
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({
    name: 'synkro-expo-app',
    version: '1.0.0',
    dependencies: {
      expo: '~51.0.0',
      'expo-status-bar': '~1.12.1',
      react: '18.2.0',
      'react-dom': '18.2.0',
      'react-native': '0.74.1',
      'react-native-web': '~0.19.10',
      '@expo/metro-runtime': '~3.2.1',
    },
    devDependencies: { '@babel/core': '^7.20.0', '@types/react': '~18.2.45', typescript: '^5.1.3' },
    private: true,
  }, null, 2));
  await fs.writeFile(path.join(dir, 'app.json'), JSON.stringify({
    expo: { name: 'synkro-expo-app', slug: 'synkro-expo-app', version: '1.0.0', orientation: 'portrait' },
  }, null, 2));
  await fs.writeFile(path.join(dir, 'App.tsx'), [
    "import { Text, View } from 'react-native';",
    'export default function App() {',
    "  return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text>Synkro</Text></View>;",
    '}',
    '',
  ].join('\n'));
}

async function run() {
  console.log('\n--- E2E: Expo project without android/ builds to an APK behind the allowlist ---');

  if (process.platform !== 'linux') {
    console.log('  SKIPPED: This test must be run on a Linux host with Docker.');
    return;
  }

  const jobId = `expo-e2e-${randomUUID().slice(0, 8)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'expo-e2e-'));
  const projectDir = path.join(tmpDir, 'project');
  const apkPath = path.join(tmpDir, 'app-release.apk');
  await writeExpoProject(projectDir);

  const sandbox = new DockerSandbox({ jobId, projectPath: projectDir, framework: 'react-native' });
  let logs = '';
  try {
    const ok = await sandbox.runBuild((chunk) => {
      logs += chunk;
      process.stdout.write(chunk);
    });
    assert.ok(ok, 'build failed (see the log above)');
    assert.match(logs, /android\.package is not set, using com\.synkro\.synkroexpoapp/);
    assert.ok(await sandbox.extractArtifact(apkPath), 'APK extraction failed');

    // An APK is a zip: starts with "PK".
    const head = Buffer.alloc(2);
    const fh = await fs.open(apkPath, 'r');
    await fh.read(head, 0, 2, 0);
    await fh.close();
    assert.equal(head.toString('latin1'), 'PK');
    const { size } = await fs.stat(apkPath);
    console.log(`  APK: ${(size / 1_000_000).toFixed(1)} MB`);
  } finally {
    await sandbox.forceKill();
    await fs.rm(tmpDir, { recursive: true, force: true });
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
