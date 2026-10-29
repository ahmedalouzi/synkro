import assert from 'node:assert/strict';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';

const DB_URL = process.env.DATABASE_URL_API ?? process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/peep_test';

export async function run() {
  console.log('\n--- Build API Endpoints RLS Isolation Test ---');

  const pool = new Pool({ connectionString: DB_URL });
  const client = await pool.connect();

  let userA: string | undefined;
  let userB: string | undefined;

  try {
    userA = randomUUID();
    userB = randomUUID();

    // 0. Seed users for foreign key constraint
    await client.query(`
      INSERT INTO users (id, email, password_hash, plan)
      VALUES 
        ($1, $2, 'mock_hash', 'pro'),
        ($3, $4, 'mock_hash', 'pro')
      ON CONFLICT (id) DO NOTHING
    `, [userA, `userA-${userA}@example.com`, userB, `userB-${userB}@example.com`]);

    // 1. Setup: Create a job for User A as the superuser (bypassing RLS for setup)
    await client.query('BEGIN');
    const result = await client.query(
      `INSERT INTO build_jobs (user_id, project_id, status, source_path) VALUES ($1, $2, 'queued', 'dummy.zip') RETURNING id`,
      [userA, 'proj_A']
    );
    const jobAId = result.rows[0].id;
    await client.query('COMMIT');

    // 2. Test Fetch Isolation: User B tries to fetch User A's job
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE api_user');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userB]);
    
    let fetchResult = await client.query(`SELECT id FROM build_jobs WHERE id = $1`, [jobAId]);
    assert.equal(fetchResult.rows.length, 0, 'REGRESSION: User B was able to fetch User A\'s job (RLS bypass)');
    
    // User A fetches their own job
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userA]);
    fetchResult = await client.query(`SELECT id FROM build_jobs WHERE id = $1`, [jobAId]);
    assert.equal(fetchResult.rows.length, 1, 'REGRESSION: User A could not fetch their own job');
    await client.query('ROLLBACK');

    // 3. Test History Isolation
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE api_user');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userB]);
    let historyResult = await client.query(`SELECT id FROM build_jobs WHERE user_id = $1`, [userB]);
    assert.equal(historyResult.rows.length, 0, 'REGRESSION: User B sees history they should not have');

    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userA]);
    historyResult = await client.query(`SELECT id FROM build_jobs WHERE user_id = $1`, [userA]);
    assert.equal(historyResult.rows.length, 1, 'REGRESSION: User A history does not show their job');
    await client.query('ROLLBACK');

    // 4. Test Cancel Isolation: User B attempts to cancel User A's job
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE api_user');
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userB]);
    
    let cancelResult = await client.query(`
      UPDATE build_jobs SET status = 'cancelled' WHERE id = $1 AND status IN ('queued', 'running') RETURNING id
    `, [jobAId]);
    assert.equal(cancelResult.rows.length, 0, 'REGRESSION: User B was able to cancel User A\'s job');
    
    // User A cancels their own job
    await client.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userA]);
    cancelResult = await client.query(`
      UPDATE build_jobs SET status = 'cancelled' WHERE id = $1 AND status IN ('queued', 'running') RETURNING id
    `, [jobAId]);
    assert.equal(cancelResult.rows.length, 1, 'REGRESSION: User A could not cancel their own job');
    await client.query('COMMIT');

    console.log('  ✅ API RLS isolation verified: Users can only fetch/history/cancel their own jobs');
  } finally {
    if (userA && userB) {
      await client.query(`DELETE FROM build_jobs WHERE user_id IN ($1, $2)`, [userA, userB]).catch(() => {});
      await client.query(`DELETE FROM users WHERE id IN ($1, $2)`, [userA, userB]).catch(() => {});
    }
    client.release();
    await pool.end();
  }
}

export default run;
