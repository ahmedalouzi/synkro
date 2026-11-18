import assert from 'node:assert/strict';
import { estimateQueue, type QueueInfoRow } from '../../../apps/server/src/build-queue';

/** Queue position and ETA from build_queue_info() numbers. No database. */
const row = (r: Partial<QueueInfoRow>): QueueInfoRow => ({
  own_framework: 'react-native',
  ahead_react_native: 0,
  ahead_flutter: 0,
  running_framework: null,
  running_elapsed_ms: null,
  avg_react_native_ms: 600_000,
  avg_flutter_ms: 300_000,
  ...r,
});

export default async function run() {
  console.log('  [queue] Next in line, nothing running: own average...');
  assert.deepEqual(estimateQueue(row({})), { position: 1, etaSeconds: 600 });

  console.log('  [queue] A running RN build, one RN build ahead, own Flutter build...');
  // (600s - 200s left) + 600s ahead + 300s own = 1300s
  assert.deepEqual(
    estimateQueue(row({ own_framework: 'flutter', ahead_react_native: 1, running_framework: 'react-native', running_elapsed_ms: '200000' })),
    { position: 2, etaSeconds: 1300 },
  );

  console.log('  [queue] Mixed builds ahead use each framework average...');
  assert.deepEqual(estimateQueue(row({ ahead_react_native: 2, ahead_flutter: 1 })), { position: 4, etaSeconds: 600 * 2 + 300 + 600 });

  console.log('  [queue] An overdue running build still counts at least a minute...');
  assert.deepEqual(estimateQueue(row({ running_framework: 'react-native', running_elapsed_ms: 900_000 })), { position: 1, etaSeconds: 60 + 600 });

  console.log('  [queue] No history for a needed framework: position only, no made-up ETA...');
  assert.deepEqual(estimateQueue(row({ avg_react_native_ms: null })), { position: 1, etaSeconds: null });
  assert.deepEqual(estimateQueue(row({ ahead_flutter: 1, avg_flutter_ms: null })), { position: 2, etaSeconds: null });
  // A framework that is not needed may have no history.
  assert.deepEqual(estimateQueue(row({ avg_flutter_ms: null })), { position: 1, etaSeconds: 600 });

  console.log('  [queue] BIGINT strings from pg are numbers...');
  assert.deepEqual(estimateQueue(row({ avg_react_native_ms: '480000' })), { position: 1, etaSeconds: 480 });

  console.log('  🟢 Queue estimate tests passed.');
}
