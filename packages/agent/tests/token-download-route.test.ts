import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { Pool } from 'pg';

// The server's own express (the agent package does not depend on it).
const express = createRequire(new URL('../../../apps/server/src/index.ts', import.meta.url))('express') as typeof import('express');

const DB_URL = process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/peep_test';

/**
 * The download route against a real database: a valid link for someone else's build, a build that has not
 * finished, and a session token in the URL are all refused; the owner's link downloads.
 */
export default async function run() {
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'artifacts-'));
  process.env.ARTIFACT_DIR = artifactDir;
  const { buildRouter, createDownloadToken } = await import('../../../apps/server/src/build-router');

  const pool = new Pool({ connectionString: DB_URL });
  const owner = crypto.randomUUID();
  const other = crypto.randomUUID();
  const app = express();
  app.use('/api/build', buildRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/build`;

  try {
    await pool.query(
      `INSERT INTO users (id, email, password_hash, plan) VALUES ($1, $2, 'x', 'pro'), ($3, $4, 'x', 'pro') ON CONFLICT (id) DO NOTHING`,
      [owner, `owner-${owner}@example.com`, other, `other-${other}@example.com`],
    );
    const insert = async (status: string) => (await pool.query(
      `INSERT INTO build_jobs (user_id, project_id, status, source_path, artifact_url) VALUES ($1, $2, $3, 'x.zip', $4) RETURNING id`,
      [owner, crypto.randomUUID(), status, status === 'success' ? '/artifact' : null],
    )).rows[0].id as string;
    const done = await insert('success');
    const running = await insert('running');
    fs.mkdirSync(path.join(artifactDir, owner), { recursive: true });
    fs.writeFileSync(path.join(artifactDir, owner, `${done}.apk`), 'APK-BYTES');

    console.log("  [download-route] The owner's link downloads the APK...");
    const mine = await fetch(`${base}/${done}/download?token=${createDownloadToken(done, owner).token}`);
    if (mine.status !== 200 || (await mine.text()) !== 'APK-BYTES') throw new Error(`owner download: ${mine.status}`);

    console.log("  [download-route] A valid link naming another user is refused (the job is not theirs)...");
    const theirs = await fetch(`${base}/${done}/download?token=${createDownloadToken(done, other).token}`);
    if (theirs.status !== 404) throw new Error(`another user's job: ${theirs.status}`);

    console.log('  [download-route] An unfinished build is refused...');
    const notDone = await fetch(`${base}/${running}/download?token=${createDownloadToken(running, owner).token}`);
    if (notDone.status !== 400) throw new Error(`running job: ${notDone.status}`);

    console.log('  [download-route] A session token is not accepted in place of a download link...');
    const asSession = await fetch(`${base}/${done}/download`, { headers: { Authorization: 'Bearer some-session-token' } });
    if (asSession.status !== 401) throw new Error(`session header on download: ${asSession.status}`);

    console.log('  [download-route] No session token in the URL on authenticated routes...');
    const inUrl = await fetch(`${base}/history?token=some-session-token`);
    const body = await inUrl.json() as { error?: string };
    if (inUrl.status !== 401 || !/Missing session token/.test(body.error ?? '')) {
      throw new Error(`?token= on /history was read: ${inUrl.status} ${body.error}`);
    }
  } finally {
    server.close();
    await pool.query('DELETE FROM build_jobs WHERE user_id = $1', [owner]).catch(() => {});
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [[owner, other]]).catch(() => {});
    await pool.end();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
  console.log('  v Download route tests passed.');
}
