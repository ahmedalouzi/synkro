process.env.DATABASE_URL_WORKER = process.env.DATABASE_URL_WORKER || process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/peep_test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startBuildWorker, stopBuildWorker } from '../src/models/build-worker';
import { DockerSandbox } from '../src/models/docker-sandbox';
import { db } from '../src/models/db';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function run() {
  console.log('\n--- Worker Cancellation Polling & Race Condition Test ---');

  const client = await db.connect();

  // Mock DockerSandbox
  const originalRunBuild = DockerSandbox.prototype.runBuild;
  const originalForceKill = DockerSandbox.prototype.forceKill;
  const originalExtractArtifact = DockerSandbox.prototype.extractArtifact;

  let forceKillCalled = false;
  let finishBuildMidway: (() => void) | null = null;
  let forceKillCallback: (() => void) | null = null;

  DockerSandbox.prototype.runBuild = async function (onLog) {
    return new Promise((resolve) => {
      onLog('Mock log line 1');
      onLog('Mock log line 2');
      
      // Keep it hanging until we explicitly finish it or it's force killed
      finishBuildMidway = () => {
        resolve(true); // Natural success
      };

      forceKillCallback = () => {
        resolve(false); // Killed
      };
    });
  };

  DockerSandbox.prototype.forceKill = function () {
    forceKillCalled = true;
    if (forceKillCallback) forceKillCallback();
  };

  DockerSandbox.prototype.extractArtifact = async function () {
    return true; // Mock extraction success
  };

  let testUserId = randomUUID();

  try {
    await client.query(
      `INSERT INTO users (id, email, password_hash, plan) VALUES ($1, $2, 'mock_hash', 'pro') ON CONFLICT (id) DO NOTHING`,
      [testUserId, `cancel-test-${testUserId}@example.com`]
    );

    // =========================================================
    // TEST 1: Mid-build cancellation polling
    // =========================================================
    await client.query('BEGIN');
    await client.query(`DELETE FROM build_jobs WHERE status = 'queued'`);
    const result1 = await client.query(
      `INSERT INTO build_jobs (user_id, project_id, status, source_path) VALUES ($1, $2, 'queued', NULL) RETURNING id`,
      [testUserId, 'proj_cancel_1']
    );
    const jobId1 = result1.rows[0].id;
    await client.query('COMMIT');

    console.log(`  [Test 1] Created job ${jobId1}, starting worker...`);
    
    // Start worker in background
    startBuildWorker().catch(() => {});

    // Wait for it to pick up the job and transition to 'running'
    let isRunning = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const res = await client.query(`SELECT status FROM build_jobs WHERE id = $1`, [jobId1]);
      if (res.rows[0]?.status === 'running') {
        isRunning = true;
        break;
      }
    }
    
    assert.equal(isRunning, true, 'REGRESSION: Worker did not pick up Test 1 job');
    console.log(`  [Test 1] Job is running. Simulating user cancellation...`);

    // Cancel the job via DB
    await client.query(`UPDATE build_jobs SET status = 'cancelled' WHERE id = $1`, [jobId1]);

    // Polling interval is 15s. Wait up to 16s.
    console.log(`  [Test 1] Waiting for worker polling to fire...`);
    await sleep(16000);

    assert.equal(forceKillCalled, true, 'REGRESSION: sandbox.forceKill() was not called by worker polling check');

    const finalRes1 = await client.query(`SELECT status FROM build_jobs WHERE id = $1`, [jobId1]);
    assert.equal(finalRes1.rows[0]?.status, 'cancelled', `REGRESSION: Final status is '${finalRes1.rows[0]?.status}', expected 'cancelled'`);
    console.log(`  ✅ Test 1 Passed: Polling loop killed sandbox and did not overwrite status.`);

    // =========================================================
    // TEST 2: Race Condition (Success finishing exact moment as cancel)
    // =========================================================
    forceKillCalled = false;
    finishBuildMidway = null;
    forceKillCallback = null;

    await client.query('BEGIN');
    const result2 = await client.query(
      `INSERT INTO build_jobs (user_id, project_id, status, source_path) VALUES ($1, $2, 'queued', NULL) RETURNING id`,
      [testUserId, 'proj_cancel_2']
    );
    const jobId2 = result2.rows[0].id;
    await client.query('COMMIT');

    console.log(`\n  [Test 2] Created job ${jobId2}. Waiting for 'running'...`);
    
    isRunning = false;
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      const res = await client.query(`SELECT status FROM build_jobs WHERE id = $1`, [jobId2]);
      if (res.rows[0]?.status === 'running') {
        isRunning = true;
        break;
      }
    }
    assert.equal(isRunning, true, 'REGRESSION: Worker did not pick up Test 2 job');

    console.log(`  [Test 2] Forcing natural sandbox success and simultaneous cancellation DB update...`);
    
    // Simulate user cancelling at the exact millisecond the sandbox finishes
    await client.query(`UPDATE build_jobs SET status = 'cancelled' WHERE id = $1`, [jobId2]);
    if (finishBuildMidway) finishBuildMidway();

    // Wait a couple seconds for worker loop to try to write success status
    await sleep(3000);

    const finalRes2 = await client.query(`SELECT status FROM build_jobs WHERE id = $1`, [jobId2]);
    assert.equal(finalRes2.rows[0]?.status, 'cancelled', `REGRESSION: Worker silently clobbered 'cancelled' with 'success' / 'failed'`);
    console.log(`  ✅ Test 2 Passed: WHERE status != 'cancelled' prevented race condition.`);
  } finally {
    stopBuildWorker();
    await client.query(`DELETE FROM build_jobs WHERE user_id = $1`, [testUserId]).catch(() => {});
    await client.query(`DELETE FROM users WHERE id = $1`, [testUserId]).catch(() => {});

    // Restore mocks
    DockerSandbox.prototype.runBuild = originalRunBuild;
    DockerSandbox.prototype.forceKill = originalForceKill;
    DockerSandbox.prototype.extractArtifact = originalExtractArtifact;
    
    (client as any).release();
  }
}

export default run;
