// packages/agent/tests/signing-keys-db.test.ts
// Release signing keys against the real Postgres: one key per project even when two first builds race,
// RLS isolation, and the keystore download endpoint (header-only token, password, 5 per hour).
// REQUIRES: Live Postgres with initDbSchema() already run.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import forge from 'node-forge';
import { db } from '../src/models/db.js';
import { AuthService } from '../src/models/auth.js';
import { getOrCreateSigningKey, readSigningKey } from '../src/models/signing-keys.js';
import { buildRouter } from '../../../apps/server/src/build-router';
import express from '../../../apps/server/node_modules/express';

async function withRole<T>(role: 'worker_user' | 'api_user', userId: string | null, fn: (c: any) => Promise<T>): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    if (userId) await c.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
}

export default async function run() {
  const saved = process.env.SYNKRO_SIGNING_ENC_KEY;
  process.env.SYNKRO_SIGNING_ENC_KEY = crypto.randomBytes(32).toString('base64');
  const auth = new AuthService();
  const password = 'correct-horse-9';
  const owner = await auth.signup(`signing-owner-${crypto.randomUUID()}@test.local`, password);
  const other = await auth.signup(`signing-other-${crypto.randomUUID()}@test.local`, password);
  const projectId = crypto.randomUUID();
  const server = (() => {
    const app = express();
    app.use(express.json());
    app.use('/api/build', buildRouter);
    return app.listen(0);
  })();
  const base = `http://127.0.0.1:${(server.address() as any).port}/api/build/signing`;

  try {
    // --- Two first builds racing: one key ---
    const [a, b] = await Promise.all([
      withRole('worker_user', null, (c) => getOrCreateSigningKey(c, owner.userId, projectId)),
      withRole('worker_user', null, (c) => getOrCreateSigningKey(c, owner.userId, projectId)),
    ]);
    assert.equal(a.certSha256, b.certSha256);
    assert.deepEqual(a.keystore, b.keystore);
    const rows = await db.query('SELECT count(*)::int AS n FROM signing_keys WHERE user_id = $1 AND project_id = $2', [owner.userId, projectId]);
    assert.equal(rows.rows[0].n, 1);
    // A later build of the same project: same key.
    const later = await withRole('worker_user', null, (c) => getOrCreateSigningKey(c, owner.userId, projectId));
    assert.equal(later.certSha256, a.certSha256);
    // Stored encrypted: no plaintext password or keystore in the row.
    const raw = (await db.query('SELECT * FROM signing_keys WHERE user_id = $1 AND project_id = $2', [owner.userId, projectId])).rows[0];
    assert.ok(!raw.store_password_enc.includes(Buffer.from(a.storePassword)));
    assert.ok(!raw.keystore_enc.includes(a.keystore.subarray(0, 64)));

    // --- RLS: only the owner reads it through api_user, and api_user cannot create keys ---
    assert.equal((await withRole('api_user', owner.userId, (c) => readSigningKey(c, owner.userId, projectId)))?.certSha256, a.certSha256);
    assert.equal(await withRole('api_user', other.userId, (c) => readSigningKey(c, owner.userId, projectId)), null);
    await assert.rejects(
      withRole('api_user', owner.userId, (c) => c.query(
        `INSERT INTO signing_keys (user_id, project_id, alias, keystore_enc, store_password_enc, key_password_enc, cert_sha256) VALUES ($1, $2, 'x', '\\x00', '\\x00', '\\x00', 'x')`,
        [owner.userId, crypto.randomUUID()],
      )),
      /permission denied/,
    );

    // --- Keystore download endpoint ---
    const post = (path: string, body: unknown, token?: string, query = '') => fetch(`${base}/${path}/keystore${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    // Token only in the Authorization header.
    assert.equal((await post(projectId, { password })).status, 401);
    assert.equal((await post(projectId, { password }, undefined, `?token=${owner.sessionToken}`)).status, 401);
    assert.equal((await post('not-a-uuid', { password }, owner.sessionToken)).status, 400);

    // Attempt 1: wrong password.
    assert.equal((await post(projectId, { password: 'wrong-password' }, owner.sessionToken)).status, 403);
    // Attempt 2: right password: the keystore, which opens with the returned password and alias.
    const ok = await post(projectId, { password }, owner.sessionToken);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const body = await ok.json();
    assert.equal(body.alias, 'synkro-upload');
    assert.equal(body.certSha256, a.certSha256);
    assert.equal(body.keystoreType, 'PKCS12');
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(Buffer.from(body.keystoreBase64, 'base64').toString('binary')), body.storePassword);
    assert.equal(p12.getBags({ friendlyName: 'synkro-upload' }).friendlyName!.length, 2, 'key + certificate under the alias');

    // Another user, with their own correct password, cannot get this project's key.
    assert.equal((await post(projectId, { password }, other.sessionToken)).status, 404);

    // Attempts 3-5 are allowed, the 6th in the hour is refused, even with the right password.
    for (let i = 3; i <= 5; i++) assert.equal((await post(projectId, { password: 'wrong-password' }, owner.sessionToken)).status, 403);
    const limited = await post(projectId, { password }, owner.sessionToken);
    assert.equal(limited.status, 429);
  } finally {
    server.close();
    await db.query('DELETE FROM signing_keys WHERE user_id = ANY($1::uuid[])', [[owner.userId, other.userId]]);
    await db.query('DELETE FROM rate_limits WHERE ip_or_email = ANY($1)', [[`keystore-download:${owner.userId}`, `keystore-download:${other.userId}`]]);
    if (saved === undefined) delete process.env.SYNKRO_SIGNING_ENC_KEY;
    else process.env.SYNKRO_SIGNING_ENC_KEY = saved;
  }
}
