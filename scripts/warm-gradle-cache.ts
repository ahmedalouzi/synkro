/**
 * Builds a template project in a real Cloud Build sandbox and copies Gradle's dependency cache (caches/modules-2) out
 * of it, for the shared read-only cache (DEC-08). Called by scripts/warm-gradle-cache.sh, which runs it as the
 * service user and then installs the result read-only; do not run it on its own.
 *
 *   npx tsx scripts/warm-gradle-cache.ts --framework react-native|flutter --out <dir that does not exist yet>
 *
 * The build runs exactly like a user's: same image, limits, restricted network and DNS allowlist (DockerSandbox),
 * except that it does not read the current read-only cache (gradleRoCache: false). Otherwise Gradle would take those
 * dependencies from it and not store them, and the new cache would miss them.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DockerSandbox, type BuildFramework } from '../packages/agent/src/models/docker-sandbox';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(__dirname, '..');

/** A fixed project ID: only used for the Flutter package name of this throwaway build. */
const WARM_PROJECT_ID = '00000000-0000-4000-8000-00000000a7a7';

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

/** The Atomvs Expo template, as ReactNativeManagedProvider.bootstrapProject writes it (no android/: prebuild runs). */
async function writeExpoProject(dir: string) {
  const pkg = JSON.parse(await fs.readFile(path.join(REPO, 'infra/docker/rn-template/package.json'), 'utf8'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'atomvs-warm', version: '1.0.0', private: true, dependencies: pkg.dependencies, devDependencies: pkg.devDependencies }, null, 2));
  await fs.writeFile(path.join(dir, 'app.json'), JSON.stringify({
    expo: {
      name: 'atomvs-warm', slug: 'atomvs-warm', version: '1.0.0', orientation: 'portrait', userInterfaceStyle: 'light',
      splash: { resizeMode: 'contain', backgroundColor: '#ffffff' },
    },
  }, null, 2));
  await fs.writeFile(path.join(dir, 'App.tsx'), "import { Text } from 'react-native';\nexport default function App() { return <Text>Atomvs</Text>; }\n");
}

/** A minimal Flutter app (the sandbox runs `flutter create` for the android/ part). */
async function writeFlutterProject(dir: string) {
  await fs.mkdir(path.join(dir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(dir, 'pubspec.yaml'), [
    'name: atomvs_warm', 'description: Gradle cache warm-up', "publish_to: 'none'", 'version: 1.0.0+1',
    'environment:', "  sdk: '>=3.0.0 <4.0.0'", 'dependencies:', '  flutter:', '    sdk: flutter', 'flutter:', '  uses-material-design: true', '',
  ].join('\n'));
  await fs.writeFile(path.join(dir, 'lib', 'main.dart'), [
    "import 'package:flutter/material.dart';",
    "void main() => runApp(const MaterialApp(home: Text('Atomvs')));", '',
  ].join('\n'));
}

async function main() {
  const framework = arg('framework') as BuildFramework;
  if (framework !== 'react-native' && framework !== 'flutter') throw new Error('--framework must be react-native or flutter');
  const out = path.resolve(arg('out'));

  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'atomvs-warm-'));
  const project = path.join(work, 'project');
  await fs.mkdir(project);
  await (framework === 'react-native' ? writeExpoProject(project) : writeFlutterProject(project));

  const jobId = `warm-${framework}-${randomUUID().slice(0, 8)}`;
  const sandbox = new DockerSandbox({
    jobId, projectPath: project, framework, projectId: WARM_PROJECT_ID,
    gradleRoCache: false, timeoutMs: 45 * 60 * 1000,
  });
  try {
    console.log(`[WARM] Building the ${framework} template in a sandbox (${jobId})...`);
    const ok = await sandbox.runBuild((chunk) => process.stdout.write(`${chunk}\n`));
    if (!ok) throw new Error('the template build failed (log above); the current cache is kept');
    // A successful build leaves the container stopped; copy Gradle's dependency cache out of it.
    await execFileAsync('docker', ['cp', `build_sandbox_${jobId}:/tmp/.gradle/caches/modules-2`, out], { maxBuffer: 16 * 1024 * 1024 });
    console.log(`[WARM] Copied caches/modules-2 to ${out}`);
  } finally {
    await sandbox.forceKill();
    await fs.rm(work, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(`[WARM] FAILED: ${err.message}`);
  process.exit(1);
});
