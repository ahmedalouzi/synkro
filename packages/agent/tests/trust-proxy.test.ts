import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { applyTrustProxy, TRUST_PROXY } from '../../../apps/server/src/trust-proxy';
import { ipRateLimiter } from '../../../apps/server/src/rate-limiter';

// The server's own express (the agent package does not depend on it).
const express = createRequire(new URL('../../../apps/server/src/index.ts', import.meta.url))('express') as typeof import('express');

/**
 * The server behind Caddy on the same host: requests arrive from 127.0.0.1 with X-Forwarded-For. req.ip must be the
 * real client (so each user has their own rate-limit key), a client cannot choose its key by writing its own
 * X-Forwarded-For, and express-rate-limit must not report a proxy misconfiguration. No database needed.
 */
async function serve(trust: boolean, limit: number) {
  const app = express();
  if (trust) applyTrustProxy(app);
  app.use(ipRateLimiter(limit));
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ip`;
  // What Caddy sends: the client's own X-Forwarded-For (if any) with the address Caddy saw appended.
  const get = (forwardedFor?: string) => fetch(url, { headers: forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {} });
  return { server, get };
}

export default async function run() {
  console.log('  Running trust proxy / client IP tests...');
  assert.equal(TRUST_PROXY, 'loopback', 'only the local Caddy is trusted, never `true`');

  const logged: string[] = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };
  console.warn = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); };

  const { server, get } = await serve(true, 2);
  try {
    // 1. req.ip is the client Caddy saw.
    let res = await get('203.0.113.7');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ip, '203.0.113.7');
    console.log('    ✓ req.ip is the client address from Caddy, not 127.0.0.1');

    // 2. A client that writes its own X-Forwarded-For does not get to pick its address: Caddy appends the real one,
    //    and Express stops at the first address from the right that is not loopback.
    res = await get('6.6.6.6, 203.0.113.8');
    assert.equal((await res.json()).ip, '203.0.113.8');
    console.log('    ✓ A spoofed X-Forwarded-For entry is ignored');

    // 3. Each client has its own rate-limit key (limit 2 per minute here; 203.0.113.7 already used 1).
    assert.equal((await get('203.0.113.7')).status, 200);
    assert.equal((await get('203.0.113.7')).status, 429, 'the third request of one client is limited');
    assert.equal((await get('203.0.113.9')).status, 200, 'another client is not limited by the first one');
    console.log('    ✓ Rate limits are per client, not shared by everyone behind Caddy');

    // 4. Without a proxy header (a direct local call) req.ip is the socket address.
    assert.match((await (await get()).json()).ip, /^(::ffff:)?127\.0\.0\.1$/);
    console.log('    ✓ Direct local requests keep the socket address');
  } finally {
    server.close();
    console.error = origError;
    console.warn = origWarn;
  }
  const rateLimitWarnings = logged.filter((l) => /ERR_ERL_|trust proxy|X-Forwarded-For/i.test(l));
  assert.deepEqual(rateLimitWarnings, [], 'express-rate-limit reports no proxy misconfiguration with trust proxy set');
  console.log('    ✓ express-rate-limit reports no proxy misconfiguration');

  // The bug this fixes: without trust proxy every request through Caddy is 127.0.0.1, one key for everyone.
  console.error = () => {}; // express-rate-limit's expected ERR_ERL_UNEXPECTED_X_FORWARDED_FOR for this old setup
  const old = await serve(false, 1000);
  try {
    assert.match((await (await old.get('203.0.113.7')).json()).ip, /^(::ffff:)?127\.0\.0\.1$/);
    console.log('    ✓ (Before the fix: every client through Caddy was 127.0.0.1)');
  } finally {
    old.server.close();
    console.error = origError;
  }
  console.log('  🟢 Trust proxy tests passed.');
}
