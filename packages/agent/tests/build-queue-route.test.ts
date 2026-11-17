import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { Pool } from 'pg';
import { AuthService } from '../src/models/auth';

// The server's own express (the agent package does not depend on it).
const express = createRequire(new URL('../../../apps/server/src/index.ts', import.meta.url))('express') as typeof import('express');

const DB_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/peep_test';

/**
 * GET /api/build/:jobId on a real database: a queued build gets its queue position and an ETA, counted over
 * everyone's builds through build_queue_info(), while api_user still sees only its own jobs (RLS) and the function
 * answers only for the caller's own queued job.
 */
export default async function run() {
  const { buildRouter } = await import('../../../apps/server/src/build-router');
  const pool = new Pool({ connectionString: DB_URL });
  const auth = new AuthService();
  const app = express();
  app.use('/api/build', buildRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/build`;

  const suffix = crypto.randomBytes(4).toString('hex');
  const me = await auth.signup(`queue-me-${suffix}@example.com`, 'queue-test-password-1');
  const other = await auth.signup(`queue-other-${suffix}@example.com`, 'queue-test-password-2');
  const insert = async (userId: string, status: string, framework: string, extra = '') => (await pool.query(
    `INSERT INTO build_jobs (user_id, project_id, status, framework, source_path${extra ? ', build_duration_ms, completed_at' : ''})
     VALUES ($1, $2, $3, $4, 'x.zip'${extra}) RETURNING id`,
    [userId, crypto.randomUUID(), status, framework],
  )).rows[0].id as string;
  const get = async (id: string, token: string) => {
    const res = await fetch(`${base}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };

  try {
    // Someone else's build queued before mine, and some history so there is an average.
    await insert(other.userId, 'success', 'react-native', ', 600000, now()');
    const theirs = await insert(other.userId, 'queued', 'react-native');
    const mine = await insert(me.userId, 'queued', 'react-native');

    // What the position must be, counted directly (other suites may have left queued jobs behind).
    const { rows: [{ ahead }] } = await pool.query(
      `SELECT count(*)::int AS ahead FROM build_jobs q, build_jobs m WHERE m.id = $1 AND q.status = 'queued' AND (q.created_at, q.id) < (m.created_at, m.id)`,
      [mine],
    );

    console.log("  [queue-route] My queued build shows its place in everyone's queue...");
    const r = await get(mine, me.sessionToken);
    assert.equal(r.status, 200);
    assert.equal(r.body.queuePosition, ahead + 1);
    assert.ok(r.body.queuePosition >= 2, "the other user's earlier build is ahead of mine");
    assert.ok(r.body.queueEtaSeconds === null || (Number.isInteger(r.body.queueEtaSeconds) && r.body.queueEtaSeconds > 0));

    console.log("  [queue-route] Another user's job is still invisible (RLS), and the function answers nothing for it...");
    assert.equal((await get(theirs, me.sessionToken)).status, 404);
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE api_user');
      await c.query('SELECT set_config($1, $2, true)', ['app.current_user_id', me.userId]);
      assert.equal((await c.query('SELECT * FROM build_queue_info($1)', [theirs])).rows.length, 0, "no row for someone else's job");
      const own = await c.query('SELECT * FROM build_queue_info($1)', [mine]);
      assert.deepEqual(Object.keys(own.rows[0]).sort(), [
        'ahead_flutter', 'ahead_react_native', 'avg_flutter_ms', 'avg_react_native_ms', 'own_framework', 'running_elapsed_ms', 'running_framework',
      ], 'only numbers and framework names: no IDs, users or projects');
      assert.equal((await c.query('SELECT count(*)::int AS n FROM build_jobs WHERE id = $1', [theirs])).rows[0].n, 0, 'RLS still hides it from api_user');
      await c.query('COMMIT');
    } finally {
      c.release();
    }

    console.log('  [queue-route] SECURITY DEFINER hardening: fixed search_path, EXECUTE only for api_user...');
    const { rows: [fn] } = await pool.query(`
      SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE p.proname = 'build_queue_info' AND n.nspname = 'public'`);
    assert.equal(fn.prosecdef, true, 'SECURITY DEFINER');
    assert.deepEqual(fn.proconfig, ['search_path=pg_catalog, public'], 'search_path is fixed, pg_catalog first');
    const { rows: grants } = await pool.query(`
      SELECT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee
      FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.proname = 'build_queue_info' AND a.privilege_type = 'EXECUTE'`);
    const executors = grants.map((g: { grantee: string }) => g.grantee).filter((g: string) => g !== fn.owner).sort();
    assert.deepEqual(executors, ['api_user'], `EXECUTE only for api_user (and the owner), got ${executors.join(', ')}`);
    for (const role of ['worker_user', 'public']) {
      const { rows: [{ can }] } = await pool.query(`SELECT has_function_privilege($1, 'build_queue_info(uuid)', 'EXECUTE') AS can`, [role]);
      assert.equal(can, false, `${role} cannot execute it`);
    }

    console.log('  [queue-route] Not queued any more: no queue fields...');
    await pool.query(`UPDATE build_jobs SET status = 'running', started_at = now() WHERE id = $1`, [mine]);
    const running = await get(mine, me.sessionToken);
    assert.equal(running.body.queuePosition, undefined);
    assert.equal(running.body.queueEtaSeconds, undefined);

    console.log('  🟢 Queue route passed.');
  } finally {
    server.close();
    await pool.query('DELETE FROM build_jobs WHERE user_id = ANY($1::uuid[])', [[me.userId, other.userId]]).catch(() => {});
    await pool.end();
  }
}
