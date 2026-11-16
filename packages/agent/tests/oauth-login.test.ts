import assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { newDb } from 'pg-mem';
import express from '../../../apps/server/node_modules/express';
import { oauthRouter } from '../../../apps/server/src/oauth-router';
import { setDbPool, db } from '../src/models/db';

function dispatchRequest(
  app: express.Express,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {},
  body?: any
): Promise<{ status: number; headers: Record<string, string>; body: any }> {
  return new Promise((resolve, reject) => {
    const req: any = new PassThrough();
    req.method = method;
    req.url = urlPath;
    req.originalUrl = urlPath;
    req.headers = { 'user-agent': 'TestRunner/1.0', ...headers };
    req.socket = { remoteAddress: '127.0.0.1' };
    req.connection = req.socket;

    const chunks: Buffer[] = [];
    const outHeaders: Record<string, string> = {};
    const res: any = new PassThrough();
    res.statusCode = 200;
    res.headersSent = false;
    res.setHeader = (k: string, v: string | string[]) => {
      outHeaders[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    };
    res.getHeader = (k: string) => outHeaders[k.toLowerCase()];
    res.removeHeader = (k: string) => {
      delete outHeaders[k.toLowerCase()];
    };
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (obj: unknown) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(obj));
      return res;
    };
    res.redirect = (statusCodeOrUrl: number | string, maybeUrl?: string) => {
      let code = 302;
      let targetUrl = '';
      if (typeof statusCodeOrUrl === 'number') {
        code = statusCodeOrUrl;
        targetUrl = maybeUrl || '';
      } else {
        targetUrl = statusCodeOrUrl;
      }
      res.statusCode = code;
      res.setHeader('location', targetUrl);
      res.end();
      return res;
    };
    res.write = (chunk: any) => {
      res.headersSent = true;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    res.end = (chunk?: any) => {
      res.headersSent = true;
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString('utf-8');
      let parsedBody: any = raw;
      if (outHeaders['content-type']?.includes('application/json')) {
        try {
          parsedBody = JSON.parse(raw);
        } catch {
          parsedBody = raw;
        }
      }
      resolve({ status: res.statusCode, headers: outHeaders, body: parsedBody });
    };
    res.on('error', reject);

    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      req.headers['content-type'] ??= 'application/json';
      req.headers['content-length'] = Buffer.byteLength(payload).toString();
      req.push(payload);
      req.push(null);
    } else {
      req.push(null);
    }

    app(req, res, (err: any) => {
      if (err) reject(err);
    });
  });
}

export default async function runTests() {
  console.log('\n  Running OAuth Login End-to-End & Route Tests...\n');

  // 1. Setup pg-mem database
  const mem = newDb();

  mem.public.none(`
    CREATE TABLE users (
      id UUID PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      plan VARCHAR(50) DEFAULT 'free'
    );
    CREATE TABLE sessions (
      session_token VARCHAR(255) PRIMARY KEY,
      refresh_token VARCHAR(255) UNIQUE NOT NULL,
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMP NOT NULL
    );
    CREATE TABLE oauth_identities (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider VARCHAR(50) NOT NULL,
      provider_user_id VARCHAR(255) NOT NULL,
      email VARCHAR(255),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_oauth_identities_provider_user UNIQUE (provider, provider_user_id)
    );
    CREATE TABLE oauth_states (
      state VARCHAR(128) PRIMARY KEY,
      provider VARCHAR(50) NOT NULL,
      code_verifier VARCHAR(255) NOT NULL,
      client_return_url TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE oauth_exchange_codes (
      code VARCHAR(128) PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_token VARCHAR(255) NOT NULL,
      refresh_token VARCHAR(255) NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();
  setDbPool(pool as any);

  // Setup express test app
  const app = express();
  app.use(express.json());
  app.use('/v1/auth/oauth', oauthRouter);

  // Preserve original env vars
  const origGoogleId = process.env.GOOGLE_CLIENT_ID;
  const origGoogleSecret = process.env.GOOGLE_CLIENT_SECRET;
  const origGithubId = process.env.GITHUB_CLIENT_ID;
  const origGithubSecret = process.env.GITHUB_CLIENT_SECRET;
  const origCallbackBase = process.env.OAUTH_CALLBACK_BASE_URL;
  const origFetch = globalThis.fetch;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Missing OAuth configuration returns 503
    // -------------------------------------------------------------------------
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GITHUB_CLIENT_ID;
    delete process.env.GITHUB_CLIENT_SECRET;

    const resUnconf = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/google/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    assert.strictEqual(resUnconf.status, 503, 'Expected 503 when OAuth not configured');
    assert.strictEqual(resUnconf.body?.code, 'OAUTH_NOT_CONFIGURED');
    console.log('  ✓ [Test 1] Missing OAuth credentials return 503 (OAUTH_NOT_CONFIGURED)');

    // -------------------------------------------------------------------------
    // TEST 2: Unknown provider returns 404
    // -------------------------------------------------------------------------
    const resNotFound = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/unknown-provider/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    assert.strictEqual(resNotFound.status, 404, 'Expected 404 for unknown provider');
    assert.strictEqual(resNotFound.body?.code, 'UNKNOWN_PROVIDER');
    console.log('  ✓ [Test 2] Unknown provider returns 404 (UNKNOWN_PROVIDER)');

    // -------------------------------------------------------------------------
    // Configure mock env vars for subsequent tests
    // -------------------------------------------------------------------------
    process.env.GOOGLE_CLIENT_ID = 'mock-google-client-id';
    process.env.GOOGLE_CLIENT_SECRET = 'mock-google-client-secret';
    process.env.GITHUB_CLIENT_ID = 'mock-github-client-id';
    process.env.GITHUB_CLIENT_SECRET = 'mock-github-client-secret';
    process.env.OAUTH_CALLBACK_BASE_URL = 'http://localhost:3000';

    // -------------------------------------------------------------------------
    // TEST 3: Return URL validation rejects external/invalid ports/schemes
    // -------------------------------------------------------------------------
    const invalidReturnUrls = [
      '',
      'javascript:alert(1)',
      'https://google.com/callback',
      'http://attacker.com:54321/callback',
      'http://127.0.0.1:80/callback', // privileged port < 1024
      'http://127.0.0.1:70000/callback', // port > 65535
      'http://127.0.0.1:54321/other-path', // must be /callback
    ];

    for (const badUrl of invalidReturnUrls) {
      const resBad = await dispatchRequest(
        app,
        'GET',
        `/v1/auth/oauth/google/start?client_return_url=${encodeURIComponent(badUrl)}`
      );
      assert.strictEqual(
        resBad.status,
        400,
        `Expected 400 for invalid return_url: ${badUrl}`
      );
      assert.strictEqual(resBad.body?.code, 'INVALID_RETURN_URL');
    }
    console.log('  ✓ [Test 3] Return URL validation strictly enforces http://127.0.0.1:<port>/callback');

    // -------------------------------------------------------------------------
    // TEST 4: Valid /start generates state, PKCE verifier, and 302 redirect
    // -------------------------------------------------------------------------
    const resStart = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/google/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    assert.strictEqual(resStart.status, 302, 'Expected 302 redirect to provider');
    const redirectLocation = resStart.headers['location'];
    assert.ok(redirectLocation, 'Expected Location header on redirect');
    const redirectUrl = new URL(redirectLocation);
    assert.strictEqual(redirectUrl.origin, 'https://accounts.google.com');
    assert.strictEqual(redirectUrl.pathname, '/o/oauth2/v2/auth');
    assert.strictEqual(redirectUrl.searchParams.get('client_id'), 'mock-google-client-id');
    assert.strictEqual(redirectUrl.searchParams.get('response_type'), 'code');
    assert.strictEqual(redirectUrl.searchParams.get('code_challenge_method'), 'S256');

    const generatedState = redirectUrl.searchParams.get('state');
    assert.ok(generatedState, 'Expected state query parameter');
    const challenge = redirectUrl.searchParams.get('code_challenge');
    assert.ok(challenge, 'Expected code_challenge query parameter');

    // Verify stored state in DB
    const stateRow = (await pool.query('SELECT * FROM oauth_states WHERE state = $1', [generatedState])).rows[0];
    assert.ok(stateRow, 'State was not recorded in oauth_states table');
    assert.strictEqual(stateRow.provider, 'google');
    assert.strictEqual(stateRow.client_return_url, 'http://127.0.0.1:54321/callback');
    assert.ok(stateRow.code_verifier, 'code_verifier must be stored');
    console.log('  ✓ [Test 4] /start issues 302 with PKCE challenge and stores state');

    // -------------------------------------------------------------------------
    // TEST 5: Missing or unknown state in /callback returns 400
    // -------------------------------------------------------------------------
    const resNoState = await dispatchRequest(app, 'GET', '/v1/auth/oauth/google/callback?code=abc');
    assert.strictEqual(resNoState.status, 400);
    assert.strictEqual(resNoState.body?.code, 'INVALID_STATE');

    const resFakeState = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/google/callback?state=nonexistent_state&code=abc'
    );
    assert.strictEqual(resFakeState.status, 400);
    assert.strictEqual(resFakeState.body?.code, 'INVALID_STATE');
    console.log('  ✓ [Test 5] Missing or unknown state returns 400');

    // -------------------------------------------------------------------------
    // TEST 6: Provider error redirect back to desktop client
    // -------------------------------------------------------------------------
    // Start a new flow to get a clean state
    const resStartErr = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/google/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    const errState = new URL(resStartErr.headers['location']).searchParams.get('state');

    const resProviderErr = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/google/callback?state=${errState}&error=access_denied&error_description=User+declined`
    );
    assert.strictEqual(resProviderErr.status, 302);
    const errClientLoc = new URL(resProviderErr.headers['location']);
    assert.strictEqual(errClientLoc.origin, 'http://127.0.0.1:54321');
    assert.strictEqual(errClientLoc.searchParams.get('error'), 'User declined');
    console.log('  ✓ [Test 6] Provider error redirects cleanly to loopback client');

    // -------------------------------------------------------------------------
    // TEST 7: Single-use state enforcement
    // -------------------------------------------------------------------------
    // The previous errState should have been consumed / deleted
    const resReusedState = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/google/callback?state=${errState}&code=abc`
    );
    assert.strictEqual(resReusedState.status, 400);
    assert.strictEqual(resReusedState.body?.code, 'INVALID_STATE');
    console.log('  ✓ [Test 7] OAuth states are strictly single-use');

    // -------------------------------------------------------------------------
    // TEST 8: Successful Google Login (new user + PKCE exchange)
    // -------------------------------------------------------------------------
    // Mock globalThis.fetch for Google token & userinfo
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(
          JSON.stringify({
            access_token: 'mock-google-access-token',
            token_type: 'Bearer',
            expires_in: 3600
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(
          JSON.stringify({
            sub: 'google-uid-1001',
            email: 'alice.google@example.com',
            email_verified: true,
            name: 'Alice Google'
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return origFetch(input, init);
    };

    const resStartG = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/google/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    const stateG = new URL(resStartG.headers['location']).searchParams.get('state');

    const resCallbackG = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/google/callback?state=${stateG}&code=mock-google-auth-code`
    );
    assert.strictEqual(resCallbackG.status, 302);
    const clientRedirect = new URL(resCallbackG.headers['location']);
    assert.strictEqual(clientRedirect.origin, 'http://127.0.0.1:54321');
    const exchangeCode = clientRedirect.searchParams.get('code');
    assert.ok(exchangeCode, 'Expected exchange code in client redirect');

    // Verify user and identity created in database
    const userRow = (await pool.query('SELECT * FROM users WHERE email = $1', ['alice.google@example.com'])).rows[0];
    assert.ok(userRow, 'User was not created');
    assert.ok(userRow.password_hash.startsWith('oauth:locked:'), 'Password hash must be locked');

    const identityRow = (await pool.query('SELECT * FROM oauth_identities WHERE user_id = $1', [userRow.id])).rows[0];
    assert.ok(identityRow, 'OAuth identity not linked');
    assert.strictEqual(identityRow.provider, 'google');
    assert.strictEqual(identityRow.provider_user_id, 'google-uid-1001');

    console.log('  ✓ [Test 8] Google OAuth creates user with locked password and links identity');

    // -------------------------------------------------------------------------
    // TEST 9: Exchange code for session tokens (POST /exchange)
    // -------------------------------------------------------------------------
    const resExchange = await dispatchRequest(app, 'POST', '/v1/auth/oauth/exchange', {}, {
      code: exchangeCode
    });
    assert.strictEqual(resExchange.status, 200);
    assert.ok(resExchange.body?.sessionToken, 'Expected sessionToken');
    assert.ok(resExchange.body?.refreshToken, 'Expected refreshToken');
    assert.strictEqual(resExchange.body?.email, 'alice.google@example.com');

    // Test single-use of exchange code
    const resReusedExchange = await dispatchRequest(app, 'POST', '/v1/auth/oauth/exchange', {}, {
      code: exchangeCode
    });
    assert.strictEqual(resReusedExchange.status, 401);
    assert.strictEqual(resReusedExchange.body?.code, 'INVALID_CODE');
    console.log('  ✓ [Test 9] POST /exchange returns valid session and destroys one-time code');

    // -------------------------------------------------------------------------
    // TEST 10: Reject unverified email from Google
    // -------------------------------------------------------------------------
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'mock-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(
          JSON.stringify({
            sub: 'unverified-uid',
            email: 'unverified@example.com',
            email_verified: false
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return origFetch(input, init);
    };

    const resStartUnver = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/google/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    const stateUnver = new URL(resStartUnver.headers['location']).searchParams.get('state');

    const resCbUnver = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/google/callback?state=${stateUnver}&code=mock-code`
    );
    assert.strictEqual(resCbUnver.status, 302);
    const unverLoc = new URL(resCbUnver.headers['location']);
    assert.strictEqual(unverLoc.searchParams.get('error'), 'Google account email is not verified.');

    // Verify user was NOT created
    const noUser = (await pool.query('SELECT * FROM users WHERE email = $1', ['unverified@example.com'])).rows[0];
    assert.strictEqual(noUser, undefined, 'Unverified email must not create a user');
    console.log('  ✓ [Test 10] Unverified email is rejected and does not link or create user');

    // -------------------------------------------------------------------------
    // TEST 11: GitHub OAuth with verified primary email resolution
    // -------------------------------------------------------------------------
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'mock-gh-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: 8888, login: 'octocat' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://api.github.com/user/emails') {
        return new Response(
          JSON.stringify([
            { email: 'secondary@github.com', primary: false, verified: true },
            { email: 'unverified-primary@github.com', primary: true, verified: false },
            { email: 'verified-primary@github.com', primary: true, verified: true }
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return origFetch(input, init);
    };

    const resStartGH = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/github/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    const stateGH = new URL(resStartGH.headers['location']).searchParams.get('state');

    const resCbGH = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/github/callback?state=${stateGH}&code=mock-gh-code`
    );
    assert.strictEqual(resCbGH.status, 302);
    const ghCode = new URL(resCbGH.headers['location']).searchParams.get('code');
    assert.ok(ghCode);

    const ghUser = (await pool.query('SELECT * FROM users WHERE email = $1', ['verified-primary@github.com'])).rows[0];
    assert.ok(ghUser, 'GitHub user should be created with primary verified email');
    console.log('  ✓ [Test 11] GitHub OAuth fetches and selects verified primary email');

    // -------------------------------------------------------------------------
    // TEST 12: Account linking to existing password account with same email
    // -------------------------------------------------------------------------
    // Pre-create an existing user with an email and real password
    const existingUserId = '11111111-1111-1111-1111-111111111111';
    await pool.query(
      'INSERT INTO users (id, email, password_hash, plan) VALUES ($1, $2, $3, $4)',
      [existingUserId, 'existing.user@example.com', 'scrypt:salt:hash', 'pro']
    );

    // Now user logs in with Google using that same email
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'mock-google-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(
          JSON.stringify({
            sub: 'google-sub-existing',
            email: 'existing.user@example.com',
            email_verified: true
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return origFetch(input, init);
    };

    const resStartLink = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/google/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    const stateLink = new URL(resStartLink.headers['location']).searchParams.get('state');

    const resCbLink = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/google/callback?state=${stateLink}&code=mock-code`
    );
    assert.strictEqual(resCbLink.status, 302);
    const linkCode = new URL(resCbLink.headers['location']).searchParams.get('code');

    // Verify identity linked to existing user
    const linkedIdentity = (await pool.query(
      'SELECT * FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2',
      ['google', 'google-sub-existing']
    )).rows[0];
    assert.ok(linkedIdentity);
    assert.strictEqual(linkedIdentity.user_id, existingUserId, 'Identity must link to existing user ID');

    // Verify existing password was NOT modified
    const checkUser = (await pool.query('SELECT * FROM users WHERE id = $1', [existingUserId])).rows[0];
    assert.strictEqual(checkUser.password_hash, 'scrypt:salt:hash', 'Existing password must not be overwritten');

    // Exchange and verify session
    const resExchLink = await dispatchRequest(app, 'POST', '/v1/auth/oauth/exchange', {}, {
      code: linkCode
    });
    assert.strictEqual(resExchLink.status, 200);
    assert.strictEqual(resExchLink.body?.userId, existingUserId);
    console.log('  ✓ [Test 12] OAuth links seamlessly to existing verified email without overwriting password');

    console.log('\n  🎉 All 12 OAuth Login test cases passed successfully!\n');
  } finally {
    // Restore environment and fetch
    if (origGoogleId !== undefined) process.env.GOOGLE_CLIENT_ID = origGoogleId;
    else delete process.env.GOOGLE_CLIENT_ID;

    if (origGoogleSecret !== undefined) process.env.GOOGLE_CLIENT_SECRET = origGoogleSecret;
    else delete process.env.GOOGLE_CLIENT_SECRET;

    if (origGithubId !== undefined) process.env.GITHUB_CLIENT_ID = origGithubId;
    else delete process.env.GITHUB_CLIENT_ID;

    if (origGithubSecret !== undefined) process.env.GITHUB_CLIENT_SECRET = origGithubSecret;
    else delete process.env.GITHUB_CLIENT_SECRET;

    if (origCallbackBase !== undefined) process.env.OAUTH_CALLBACK_BASE_URL = origCallbackBase;
    else delete process.env.OAUTH_CALLBACK_BASE_URL;

    globalThis.fetch = origFetch;
    setDbPool(null);
  }
}
