import assert from 'node:assert/strict';
import { BUILD_DISK_LIMIT_GB, DockerSandbox, OUT_OF_DISK_MESSAGE, formatDiskUsage } from '../src/models/docker-sandbox.js';

/** Per-build disk limits (DEC-07) and the disk-usage line at the end of every build. No Docker needed. */
export default async function run() {
  console.log('  [disk-limit] Limits: React Native / Expo 12G, Flutter 15G...');
  assert.deepEqual(BUILD_DISK_LIMIT_GB, { 'flutter': 15, 'react-native': 12 });

  const args = (framework: 'flutter' | 'react-native') =>
    new DockerSandbox({ jobId: 'job', projectPath: '/tmp/p', framework, projectId: '3f9a1c07-be42-4d11-9a0e-123456789abc' })
      .createContainerArgs('build-restricted').join(' ');
  assert.match(args('react-native'), / --storage-opt size=12G /);
  assert.match(args('flutter'), / --storage-opt size=15G /);
  console.log('    ✓ docker create gets --storage-opt size=12G (RN/Expo) and size=15G (Flutter)');

  console.log('  [disk-limit] The disk-usage line...');
  assert.equal(formatDiskUsage(7.4 * 1024 ** 3, 12), '[SYSTEM] Disk used: 7.4 GB of 12 GB');
  assert.equal(formatDiskUsage(12 * 1024 ** 3, 12), '[SYSTEM] Disk used: 12.0 GB of 12 GB');
  assert.equal(formatDiskUsage(300 * 1024 ** 2, 15), '[SYSTEM] Disk used: 0.3 GB of 15 GB');
  console.log('    ✓ "[SYSTEM] Disk used: 7.4 GB of 12 GB"');

  assert.equal(OUT_OF_DISK_MESSAGE, "[SYSTEM] The build ran out of disk space on our server; we've been notified.");
  console.log('  🟢 Disk limit tests passed.');
}
