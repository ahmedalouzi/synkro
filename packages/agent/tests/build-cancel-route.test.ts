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
 * POST /api/build/:jobId/cancel against a real database, through the real route: it runs as api_user (SET LOCAL ROLE)
 * with RLS, and its UPDATE assigns status and updated_at. In production it failed with "permission denied for table
 * build_jobs" because api_user could only update status (db.ts grants). An earlier test copied the query without
 * updated_at, so it never saw that.
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
  const owner = await auth.signup(`cancel-owner-${suffix}@example.com`, 'cancel-test-password-1');
  const other = await auth.signup(`cancel-other-${suffix}@example.com`, 'cancel-test-password-2');
  await pool.query('UPDATE users SET email_verified = TRUE WHERE id = ANY($1::uuid[])', [[owner.userId, other.userId]]);
  const cancel = (jobId: string, token?: string) =>
    fetch(`${base}/${jobId}/cancel`, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const insertJob = async (status: string) => (await pool.query(
    `INSERT INTO build_jobs (user_id, project_id, status, source_path, updated_at)
     VALUES ($1, $2, $3, 'x.zip', now() - interval '1 hour') RETURNING id`,
    [owner.userId, crypto.randomUUID(), status],
  )).rows[0].id as string;
  const jobRow = async (id: string) => (await pool.query('SELECT status::text AS status, updated_at FROM build_jobs WHERE id = $1', [id])).rows[0];

  try {
    console.log('  [cancel-route] The owner cancels a queued build...');
    const queued = await insertJob('queued');
    const before = (await jobRow(queued)).updated_at as Date;
    let res = await cancel(queued, owner.sessionToken);
    assert.equal(res.status, 200, `cancel queued: HTTP ${res.status} ${await res.text()}`);
    const after = await jobRow(queued);
    assert.equal(after.status, 'cancelled');
    assert.ok(after.updated_at > before, 'updated_at moves forward on cancel');

    console.log('  [cancel-route] The owner cancels a running build...');
    const running = await insertJob('running');
    res = await cancel(running, owner.sessionToken);
    assert.equal(res.status, 200, `cancel running: HTTP ${res.status}`);
    assert.equal((await jobRow(running)).status, 'cancelled');

    console.log("  [cancel-route] Another user cannot cancel the owner's build (RLS)...");
    const mine = await insertJob('queued');
    res = await cancel(mine, other.sessionToken);
    assert.equal(res.status, 404, `another user's cancel: HTTP ${res.status}`);
    assert.equal((await jobRow(mine)).status, 'queued');

    console.log('  [cancel-route] A finished build cannot be cancelled...');
    const done = await insertJob('success');
    res = await cancel(done, owner.sessionToken);
    assert.equal(res.status, 404, `finished build: HTTP ${res.status}`);
    assert.equal((await jobRow(done)).status, 'success');

    console.log('  [cancel-route] No session: 401...');
    res = await cancel(mine);
    assert.equal(res.status, 401);

    console.log('  🟢 Cancel route passed (api_user, RLS, status + updated_at).');
  } finally {
    server.close();
    await pool.query('DELETE FROM build_jobs WHERE user_id = ANY($1::uuid[])', [[owner.userId, other.userId]]).catch(() => {});
    await pool.end();
  }
}
