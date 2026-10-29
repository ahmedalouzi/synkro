import { performThreadMigration, activeMigrations } from '../../../apps/desktop/src/main/ipc/thread-migration';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default async function run() {
  console.log('  Running Task 12 Chat Threads tests...');
  
  const testDir = join(__dirname, '.test-threads-' + randomUUID());
  const projectPath = join(testDir, 'project');
  const peepDir = join(projectPath, '.peep');
  
  await mkdir(peepDir, { recursive: true });

  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      passed++;
    } else {
      console.error(`    ❌ FAILED: ${msg}`);
      failed++;
    }
  }

  // MOCK fetch
  const originalFetch = (global as any).fetch;
  const mockSavedThreads: any[] = [];
  let fetchError = false;
  
  (global as any).fetch = async (url: string, options: any) => {
    if (fetchError) {
      return { ok: false };
    }
    if (options && options.method === 'POST') {
      const body = JSON.parse(options.body);
      mockSavedThreads.push({ url, body });
      return { ok: true };
    }
    return { ok: true, json: async () => ({ threads: [] }) };
  };

  try {
    const chatJsonPath = join(peepDir, 'chat.json');
    const migratedChatJsonPath = join(peepDir, 'chat.json.migrated');
    
    // 1. Test Deterministic Migration
    await writeFile(chatJsonPath, JSON.stringify({ messages: [{ id: '1' }] }));
    
    const threads = await performThreadMigration(projectPath, { sessionToken: 'abc' }, 'https://api.synkro.com', []);
    
    assert(mockSavedThreads.length === 1, 'Migration successfully saved to backend');
    assert(existsSync(migratedChatJsonPath), 'Migrated file was renamed to .migrated');
    assert(!existsSync(chatJsonPath), 'Original chat.json was removed');
    
    // 2. Idempotent Migration
    // Clear mock
    mockSavedThreads.length = 0;
    
    // Running again shouldn't do anything because chat.json does not exist
    await performThreadMigration(projectPath, { sessionToken: 'abc' }, 'https://api.synkro.com', []);
    assert(mockSavedThreads.length === 0, 'Migration is idempotent when chat.json is missing');

    // 3. Retryable Failure
    // Restore file
    await rename(migratedChatJsonPath, chatJsonPath).catch(() => {});
    fetchError = true;
    
    try {
      await performThreadMigration(projectPath, { sessionToken: 'abc' }, 'https://api.synkro.com', []);
    } catch (e) {} // it might swallow or throw inside
    
    assert(!existsSync(migratedChatJsonPath), 'Migrated file NOT renamed if backend fails');
    assert(existsSync(chatJsonPath), 'Original chat.json remains if backend fails');
    
    // 4. Duplicate prevention (In-process Promise.all concurrency lock)
    fetchError = false;
    
    // Fire two migrations concurrently
    const p1 = performThreadMigration(projectPath, { sessionToken: 'abc' }, 'https://api.synkro.com', []);
    const p2 = performThreadMigration(projectPath, { sessionToken: 'abc' }, 'https://api.synkro.com', []);
    
    await Promise.all([p1, p2]);
    
    assert(mockSavedThreads.length === 1, 'Only one migration was performed concurrently (In-process JS lock verified)');
    assert(existsSync(migratedChatJsonPath), 'Migrated file was renamed after concurrent migration');

    // 5. Task 13: Deterministic Legacy Run ID Migration & Grouping Rule
    await rename(migratedChatJsonPath, chatJsonPath).catch(() => {});
    mockSavedThreads.length = 0;
    
    // Create a history file with timelineActivities but NO runId
    // Test grouping rules:
    // act1 -> act2 (4 min gap) -> SAME RUN (Run A)
    // act2 -> act3 (6 min gap) -> SEPARATE RUN (Run B)
    // act3 -> act4 (completed) -> SAME RUN (Run B)
    // act4 -> act5 (10s gap) -> SEPARATE RUN (Run C)
    await writeFile(chatJsonPath, JSON.stringify({ 
      messages: [{ id: '1' }],
      timelineActivities: [
        { id: 'act-1', type: 'understanding', status: 'in_progress', timestamp: '2023-01-01T00:00:00Z' },
        { id: 'act-2', type: 'exploring', status: 'in_progress', timestamp: '2023-01-01T00:04:00Z' }, // 4 mins
        { id: 'act-3', type: 'generating', status: 'in_progress', timestamp: '2023-01-01T00:10:00Z' }, // 6 mins
        { id: 'act-4', type: 'completed', status: 'completed', timestamp: '2023-01-01T00:10:10Z' }, // 10s
        { id: 'act-5', type: 'understanding', status: 'in_progress', timestamp: '2023-01-01T00:10:20Z' } // 10s after completed
      ]
    }));
    
    await performThreadMigration(projectPath, { sessionToken: 'abc' }, 'https://api.synkro.com', []);
    
    assert(mockSavedThreads.length === 1, 'Legacy migration triggered successfully');
    const migratedPayload = mockSavedThreads[0].body;
    assert(Array.isArray(migratedPayload.runs), 'Runs were generated during migration');
    
    // We expect exactly 3 runs based on the grouping rules
    assert(migratedPayload.runs.length === 3, `Expected exactly 3 runs, got ${migratedPayload.runs.length}`);
    
    const runA = migratedPayload.runs[0];
    const runB = migratedPayload.runs[1];
    const runC = migratedPayload.runs[2];
    
    assert(runA.timeline_activities.length === 2, 'Run A should have 2 activities (4-min gap)');
    assert(runB.timeline_activities.length === 2, 'Run B should have 2 activities (6-min gap boundary)');
    assert(runC.timeline_activities.length === 1, 'Run C should have 1 activity (completed boundary)');
    
    const legacyRunId = runA.run_id;
    assert(legacyRunId.startsWith('run:legacy:'), 'Run ID uses legacy prefix');
    
    // Run it again on a fresh project to prove determinism
    await rename(migratedChatJsonPath, chatJsonPath).catch(() => {});
    mockSavedThreads.length = 0;
    await performThreadMigration(projectPath, { sessionToken: 'abc' }, 'https://api.synkro.com', []);
    
    assert(mockSavedThreads[0].body.runs[0].run_id === legacyRunId, 'Legacy migration ID determinism (repeat run)');

  } catch (err) {
    console.error('Test error:', err);
    failed++;
  } finally {
    (global as any).fetch = originalFetch;
    await rm(testDir, { recursive: true, force: true }).catch(() => {});
  }

  if (failed > 0) {
    throw new Error(`Chat threads tests failed: ${failed} failed, ${passed} passed`);
  }
  
  console.log(`    ✅ Chat threads tests passed (${passed}/${passed})`);
}
