import assert from 'node:assert/strict';
import { ProductionAIGateway } from '../src/models/production-gateway.js';
import { redactUrl, requestLogLine, authLogLine } from '../../../apps/server/src/log-redact';
import express from '../../../apps/server/node_modules/express';

/** Requests that carry a session token must not put it in the logs (desktop gateway and server request log). */
export default async function run() {
  const token = 'tok_SECRET_9f2c41d7e0';
  const logged: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  const originalFetch = global.fetch;
  console.log = capture;
  console.warn = capture;
  console.error = capture;

  try {
    // --- Desktop gateway: a generate call with the session token ---
    global.fetch = (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ content: 'ok' }),
    })) as any;
    const gateway = new ProductionAIGateway({ baseUrl: 'http://127.0.0.1:1', sessionToken: token });
    await gateway.generate({ tier: 'fast', messages: [{ role: 'user', content: 'hello' }] } as any);
    global.fetch = originalFetch;
    assert.ok(logged.some((l) => l.includes('[HTTP_TRACE] Headers:') && l.includes('Session=***')), 'gateway trace line is still logged, masked');

    // --- Server request log: a real HTTP request with the token in the URL and both headers ---
    const app = express();
    app.use((req, res) => {
      console.log(requestLogLine(req));
      console.log(authLogLine(req));
      res.end();
    });
    const server = app.listen(0);
    try {
      const port = (server.address() as any).port;
      await fetch(`http://127.0.0.1:${port}/api/build/abc/download?token=${token}&x=1`, {
        headers: { Authorization: `Bearer ${token}`, session: token },
      });
    } finally {
      server.close();
    }
    assert.ok(logged.includes('[REQUEST ARRIVED] GET /api/build/abc/download?token=***&x=1'), 'URL logged with the token masked');
    assert.ok(logged.includes('Authorization: present  Session: present'), 'only the presence of credentials is logged');
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
    global.fetch = originalFetch;
  }

  const leaks = logged.filter((l) => l.includes(token));
  assert.deepEqual(leaks, [], 'the session token appeared in the logs');

  // --- redactUrl cases ---
  assert.equal(redactUrl('/x?token=abc'), '/x?token=***');
  assert.equal(redactUrl('/x?a=1&TOKEN=abc&b=2'), '/x?a=1&TOKEN=***&b=2');
  assert.equal(redactUrl('/x?session=abc#frag'), '/x?session=***#frag');
  assert.equal(redactUrl('/x?access_token=a&refresh_token=b'), '/x?access_token=***&refresh_token=***');
  assert.equal(redactUrl('/x?mytoken=keep&tokens=keep'), '/x?mytoken=keep&tokens=keep');
  assert.equal(redactUrl('/api/build/history'), '/api/build/history');
  assert.equal(authLogLine({ headers: {} } as any), 'Authorization: none  Session: none');
}
