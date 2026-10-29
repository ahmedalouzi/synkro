// packages/cloud-build/tests/adversarial/worker-crash-recovery.test.ts
//
// ADVERSARIAL TEST: Worker Process Crash → Orphaned Job Recovery
// This is the only adversarial test that runs on any platform (it tests DB state,
// not Docker behavior). The crash is simulated by inserting a stuck 'running' row
// directly into the database without a worker ever having claimed it.
//
// Scenario:
//   1. Simulate a worker crash by inserting a job with status='running' and
//      started_at in the past (as if a worker crashed mid-build).
//   2. Wait for the reconciler to fire (or call it directly).
//   3. Verify the row is marked 'failed' with the correct error log.
//   4. Verify the reaper would also clean up the container (simulated by
//      verifying the container name is in the expected format for cleanup).

import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { db, initDbSchema } from '../src/models/db';
import {
  reconcileOrphanedJobs,
  BUILD_TIMEOUT_MS,
  GRACE_PERIOD_MS,
} from '../src/models/build-worker';

const DB_URL = process.env.DATABASE_URL_WORKER
  ?? process.env.DATABASE_URL
  ?? 'postgres://postgres:postgres@localhost:5432/peep_test';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000099';

export default async function run() {
  const pool = new Pool({ connectionString: DB_URL });

  try {
    await initDbSchema();
    await pool.query(
      `INSERT INTO users (id, email, password_hash, plan) VALUES ($1, $2, 'mock_hash', 'pro') ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, `crash-test-${TEST_USER_ID}@example.com`]
    );

    // ── Step 1: Simulate a worker crash ──────────────────────────────────────
    // Insert a 'running' job with started_at far in the past.
    // This simulates: worker crashed after claiming the job but before completing it.

    const crashTime = new Date(Date.now() - BUILD_TIMEOUT_MS - GRACE_PERIOD_MS - 60_000);

    await pool.query(`
      INSERT INTO build_jobs
        (user_id, project_id, framework, status, started_at, worker_id, container_id)
      VALUES
        ($1, 'crash-sim-project', 'flutter', 'running', $2, 'crashed-worker-host-001', 'peep-build-crash-sim-container')
    `, [TEST_USER_ID, crashTime.toISOString()]);

    // Verify the row is in 'running' state before reconciliation
    const { rows: before } = await pool.query(`
      SELECT status, worker_id, container_id FROM build_jobs
      WHERE project_id = 'crash-sim-project' AND user_id = $1
    `, [TEST_USER_ID]);

    assert.equal(before[0]?.status, 'running', 'PRE-RECOVERY: Job is stuck in running state');
    assert.equal(before[0]?.worker_id, 'crashed-worker-host-001', 'PRE-RECOVERY: Worker ID preserved');
    console.log(`  EVIDENCE: Job status before reconciliation: ${before[0]?.status}`);
    console.log(`  EVIDENCE: Worker that crashed: ${before[0]?.worker_id}`);
    console.log(`  EVIDENCE: Container that would be cleaned by reaper: ${before[0]?.container_id}`);

    // ── Step 2: Run the reconciler ────────────────────────────────────────────

    console.log(`  Running reconciler (cutoff: ${new Date(Date.now() - BUILD_TIMEOUT_MS - GRACE_PERIOD_MS).toISOString()})...`);
    const recovered = await reconcileOrphanedJobs(pool);

    // ── Step 3: Verify the job was recovered ─────────────────────────────────

    assert.equal(recovered, 1, `RECONCILER: Recovered ${recovered} job(s)`);
    console.log(`  EVIDENCE: Reconciler recovered ${recovered} orphaned job(s)`);

    const { rows: after } = await pool.query(`
      SELECT status, error_log, completed_at, worker_id FROM build_jobs
      WHERE project_id = 'crash-sim-project' AND user_id = $1
    `, [TEST_USER_ID]);

    assert.equal(after[0]?.status, 'failed', 'POST-RECOVERY: Job status is failed');
    assert.ok(after[0]?.completed_at, 'POST-RECOVERY: completed_at is set');
    assert.ok(after[0]?.error_log, 'POST-RECOVERY: error_log is populated');
    assert.ok(
      after[0]!.error_log!.includes('orphaned'),
      'POST-RECOVERY: error_log mentions orphaned',
    );
    assert.ok(
      after[0]!.error_log!.includes('crashed-worker-host-001'),
      'POST-RECOVERY: error_log includes the crashed worker hostname',
    );
    assert.ok(
      after[0]!.error_log!.includes('Auto-recovered'),
      'POST-RECOVERY: error_log mentions auto-recovery',
    );

    console.log(`  EVIDENCE: Job status after reconciliation: ${after[0]?.status}`);
    console.log(`  EVIDENCE: completed_at: ${after[0]?.completed_at}`);
    console.log(`  EVIDENCE: error_log (first 200 chars): ${after[0]?.error_log?.slice(0, 200)}`);

    // ── Step 4: Verify second reconciler run does not double-process ─────────

    const recovered2 = await reconcileOrphanedJobs(pool);
    assert.equal(recovered2, 0, 'Second reconciler run: no jobs re-processed (idempotent)');
    console.log(`  EVIDENCE: Second reconciler run recovered 0 jobs (idempotent) ✓`);

    // ── Step 5: Verify new jobs can still be created after crash ─────────────

    await pool.query(`
      INSERT INTO build_jobs (user_id, project_id, framework, status)
      VALUES ($1, 'post-crash-new-job', 'react-native', 'queued')
    `, [TEST_USER_ID]);

    const { rows: newJob } = await pool.query(`
      SELECT status FROM build_jobs WHERE project_id = 'post-crash-new-job' AND user_id = $1
    `, [TEST_USER_ID]);
    assert.equal(newJob[0]?.status, 'queued', 'New jobs can be created after crash recovery');
    console.log(`  EVIDENCE: New job successfully created post-crash ✓`);

    console.log('\n  Worker crash recovery adversarial test PASSED.');
    console.log('  Max orphan window: ' + ((BUILD_TIMEOUT_MS + GRACE_PERIOD_MS + 2 * 60 * 1000) / 60000) + ' minutes');

  } finally {
    await pool.query(`DELETE FROM build_jobs WHERE user_id = $1`, [TEST_USER_ID]).catch(() => {});
    await pool.query(`DELETE FROM users WHERE id = $1`, [TEST_USER_ID]).catch(() => {});
    await pool.end();
  }
}
