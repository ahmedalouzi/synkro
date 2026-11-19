import assert from 'node:assert';
import crypto from 'node:crypto';
import { PassThrough } from 'node:stream';
import express from '../../../apps/server/node_modules/express';
import { oauthRouter } from '../../../apps/server/src/oauth-router';
import { db, initDbSchema } from '../src/models/db';
import { BackendAIGateway, MockOpenAIAdapter } from '../src/models/backend-gateway';

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
  console.log('\n  Running OAuth Login End-to-End & Security Hardening Tests...\n');

  await initDbSchema();

  const suffix = crypto.randomBytes(6).toString('hex');
  const createdEmails: string[] = [];
  const createdStates: string[] = [];

  // Setup express test app
  const app = express();
  app.use(express.json());
  app.use('/v1/auth/oauth', oauthRouter);

  // Preserve original env vars and global fetch
  const envKeys = [
    'GOOGLE_OAUTH_CLIENT_ID',
    'GOOGLE_OAUTH_CLIENT_SECRET',
    'GITHUB_OAUTH_CLIENT_ID',
    'GITHUB_OAUTH_CLIENT_SECRET',
    'GOOGLE_CLIENT_ID',
    'GOOGLE_CLIENT_SECRET',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'OAUTH_CALLBACK_BASE_URL',
  ] as const;
  const origEnv: Record<string, string | undefined> = {};
  for (const k of envKeys) {
    origEnv[k] = process.env[k];
  }
  const origFetch = globalThis.fetch;

  try {
    // -------------------------------------------------------------------------
    // TEST 1: Missing OAuth configuration returns 503
    // -------------------------------------------------------------------------
    for (const k of envKeys) {
      delete process.env[k];
    }

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
    process.env.GOOGLE_OAUTH_CLIENT_ID = 'mock-google-client-id';
    process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'mock-google-client-secret';
    process.env.GITHUB_OAUTH_CLIENT_ID = 'mock-github-client-id';
    process.env.GITHUB_OAUTH_CLIENT_SECRET = 'mock-github-client-secret';
    process.env.OAUTH_CALLBACK_BASE_URL = 'http://localhost:3000';

    // -------------------------------------------------------------------------
    // TEST 3: Return URL validation rejects external/invalid ports/schemes
    // -------------------------------------------------------------------------
    const invalidReturnUrls = [
      '',
      'javascript:alert(1)',
      'https://google.com/callback',
      'http://attacker.com:54321/callback',
      'http://user:pass@127.0.0.1:54321/callback',
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
    createdStates.push(generatedState!);
    const challenge = redirectUrl.searchParams.get('code_challenge');
    assert.ok(challenge, 'Expected code_challenge query parameter');

    // Verify stored state in DB
    const stateRow = (await db.query('SELECT * FROM oauth_states WHERE state = $1', [generatedState])).rows[0];
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
    const resStartErr = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/google/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    const errState = new URL(resStartErr.headers['location']).searchParams.get('state');
    if (errState) createdStates.push(errState);

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
    const resReusedState = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/google/callback?state=${errState}&code=abc`
    );
    assert.strictEqual(resReusedState.status, 400);
    assert.strictEqual(resReusedState.body?.code, 'INVALID_STATE');
    console.log('  ✓ [Test 7] OAuth states are strictly single-use');

    // -------------------------------------------------------------------------
    // TEST 8: Successful Google Login (new user + email_verified + 350 credits)
    // -------------------------------------------------------------------------
    const googleEmail = `alice.google.${suffix}@example.com`;
    createdEmails.push(googleEmail);
    const googleSub = `google-uid-${suffix}`;

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
            sub: googleSub,
            email: googleEmail,
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
    if (stateG) createdStates.push(stateG);

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

    // Verify user, verified status, welcome+monthly credits (350), and identity created in database
    const userRow = (await db.query('SELECT * FROM users WHERE email = $1', [googleEmail])).rows[0];
    assert.ok(userRow, 'User was not created');
    assert.ok(userRow.password_hash.startsWith('oauth:locked:'), 'Password hash must be locked');
    assert.strictEqual(userRow.email_verified, true, 'New OAuth user must have email_verified === true');
    assert.strictEqual(Number(userRow.credit_balance), 350, 'New OAuth user must receive 250 welcome + 100 monthly credits (350)');

    const identityRow = (await db.query('SELECT * FROM oauth_identities WHERE user_id = $1', [userRow.id])).rows[0];
    assert.ok(identityRow, 'OAuth identity not linked');
    assert.strictEqual(identityRow.provider, 'google');
    assert.strictEqual(identityRow.provider_user_id, googleSub);
    console.log('  ✓ [Test 8] Google OAuth creates verified user (email_verified=true, credit_balance=350) and links identity');

    // -------------------------------------------------------------------------
    // TEST 9: Exchange code for session tokens + /v1/ai/generate returns 200 OK
    // -------------------------------------------------------------------------
    const resExchange = await dispatchRequest(app, 'POST', '/v1/auth/oauth/exchange', {}, {
      code: exchangeCode
    });
    assert.strictEqual(resExchange.status, 200);
    assert.ok(resExchange.body?.sessionToken, 'Expected sessionToken');
    assert.ok(resExchange.body?.refreshToken, 'Expected refreshToken');
    assert.strictEqual(resExchange.body?.email, googleEmail);
    assert.strictEqual(resExchange.body?.emailVerified, true, 'Exchange must return emailVerified: true');
    assert.strictEqual(resExchange.body?.verificationRequired, false, 'Exchange must return verificationRequired: false');

    // Verify single-use of exchange code
    const resReusedExchange = await dispatchRequest(app, 'POST', '/v1/auth/oauth/exchange', {}, {
      code: exchangeCode
    });
    assert.strictEqual(resReusedExchange.status, 401);
    assert.strictEqual(resReusedExchange.body?.code, 'INVALID_CODE');

    // Verify new OAuth user can immediately call /v1/ai/generate with 200 OK
    const gateway = new BackendAIGateway();
    (gateway as any).adapters.set('google', new MockOpenAIAdapter());
    (gateway as any).adapters.set('openai', new MockOpenAIAdapter());
    (gateway as any).adapters.set('anthropic', new MockOpenAIAdapter());

    const aiRes = await gateway.handleRequest(
      'POST',
      '/v1/ai/generate',
      { authorization: `Bearer ${resExchange.body.sessionToken}` },
      { messages: [{ role: 'user', content: 'Hello from OAuth user' }], tier: 'fast' }
    );
    assert.strictEqual(aiRes.status, 200, `Expected 200 OK on /v1/ai/generate for OAuth user, got ${aiRes.status}: ${JSON.stringify(aiRes.body)}`);
    console.log('  ✓ [Test 9] POST /exchange returns verified session, destroys one-time code, and /v1/ai/generate returns 200 OK');

    // -------------------------------------------------------------------------
    // TEST 10: Reject unverified email from Google
    // -------------------------------------------------------------------------
    const unverifiedEmail = `unverified.${suffix}@example.com`;
    createdEmails.push(unverifiedEmail);

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'mock-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(
          JSON.stringify({
            sub: `unverified-uid-${suffix}`,
            email: unverifiedEmail,
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
    if (stateUnver) createdStates.push(stateUnver);

    const resCbUnver = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/google/callback?state=${stateUnver}&code=mock-code`
    );
    assert.strictEqual(resCbUnver.status, 302);
    const unverLoc = new URL(resCbUnver.headers['location']);
    assert.strictEqual(unverLoc.searchParams.get('error'), 'Google account email is not verified.');

    const noUser = (await db.query('SELECT * FROM users WHERE email = $1', [unverifiedEmail])).rows[0];
    assert.strictEqual(noUser, undefined, 'Unverified email must not create a user');
    console.log('  ✓ [Test 10] Unverified email is rejected and does not link or create user');

    // -------------------------------------------------------------------------
    // TEST 11: GitHub OAuth with verified primary email resolution + 350 credits
    // -------------------------------------------------------------------------
    const ghPrimaryEmail = `verified-primary-${suffix}@github.com`;
    createdEmails.push(ghPrimaryEmail);
    const ghUserIdNum = 888800 + parseInt(suffix.slice(0, 4), 16);

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'mock-gh-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: ghUserIdNum, login: 'octocat' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://api.github.com/user/emails') {
        return new Response(
          JSON.stringify([
            { email: `secondary-${suffix}@github.com`, primary: false, verified: true },
            { email: `unverified-primary-${suffix}@github.com`, primary: true, verified: false },
            { email: ghPrimaryEmail, primary: true, verified: true }
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
    if (stateGH) createdStates.push(stateGH);

    const resCbGH = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/github/callback?state=${stateGH}&code=mock-gh-code`
    );
    assert.strictEqual(resCbGH.status, 302);
    const ghCode = new URL(resCbGH.headers['location']).searchParams.get('code');
    assert.ok(ghCode);

    const ghUser = (await db.query('SELECT * FROM users WHERE email = $1', [ghPrimaryEmail])).rows[0];
    assert.ok(ghUser, 'GitHub user should be created with primary verified email');
    assert.strictEqual(ghUser.email_verified, true, 'GitHub OAuth user must have email_verified === true');
    assert.strictEqual(Number(ghUser.credit_balance), 350, 'GitHub OAuth user must have 350 credits');
    console.log('  ✓ [Test 11] GitHub OAuth selects verified primary email, sets email_verified=true and grants 350 credits');

    // -------------------------------------------------------------------------
    // TEST 12: Linking existing UNVERIFIED password account upgrades email_verified & preserves plan
    // -------------------------------------------------------------------------
    const existingUserId = crypto.randomUUID();
    const existingEmail = `existing.user.${suffix}@example.com`;
    createdEmails.push(existingEmail);
    const existingGoogleSub = `google-sub-existing-${suffix}`;

    await db.query(
      'INSERT INTO users (id, email, password_hash, plan, email_verified) VALUES ($1, $2, $3, $4, FALSE)',
      [existingUserId, existingEmail, 'scrypt:salt:hash', 'pro']
    );

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'mock-google-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://www.googleapis.com/oauth2/v3/userinfo') {
        return new Response(
          JSON.stringify({
            sub: existingGoogleSub,
            email: existingEmail,
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
    if (stateLink) createdStates.push(stateLink);

    const resCbLink = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/google/callback?state=${stateLink}&code=mock-code`
    );
    assert.strictEqual(resCbLink.status, 302);
    const linkCode = new URL(resCbLink.headers['location']).searchParams.get('code');

    const linkedIdentity = (await db.query(
      'SELECT * FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2',
      ['google', existingGoogleSub]
    )).rows[0];
    assert.ok(linkedIdentity);
    assert.strictEqual(linkedIdentity.user_id, existingUserId, 'Identity must link to existing user ID');

    const checkUser = (await db.query('SELECT * FROM users WHERE id = $1', [existingUserId])).rows[0];
    assert.strictEqual(checkUser.password_hash, 'scrypt:salt:hash', 'Existing password must not be overwritten');
    assert.strictEqual(checkUser.email_verified, true, 'Existing unverified password user must be upgraded to email_verified=true');
    assert.strictEqual(checkUser.plan, 'pro', 'Existing plan must be preserved');
    assert.strictEqual(Number(checkUser.credit_balance), 4250, 'Existing pro user should receive 250 welcome + 4000 pro monthly credits');

    const resExchLink = await dispatchRequest(app, 'POST', '/v1/auth/oauth/exchange', {}, {
      code: linkCode
    });
    assert.strictEqual(resExchLink.status, 200);
    assert.strictEqual(resExchLink.body?.userId, existingUserId);
    console.log('  ✓ [Test 12] Linking unverified password account upgrades email_verified=true, preserves password/plan, and grants plan credits');

    // -------------------------------------------------------------------------
    // TEST 13: Disposable email on GitHub OAuth is blocked with 0 credits granted
    // -------------------------------------------------------------------------
    const disposableEmail = `attacker-${suffix}@mailinator.com`;
    createdEmails.push(disposableEmail);

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === 'https://github.com/login/oauth/access_token') {
        return new Response(JSON.stringify({ access_token: 'mock-gh-disposable-token' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: ghUserIdNum + 1, login: 'throwaway' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url === 'https://api.github.com/user/emails') {
        return new Response(
          JSON.stringify([
            { email: disposableEmail, primary: true, verified: true }
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return origFetch(input, init);
    };

    const resStartDisp = await dispatchRequest(
      app,
      'GET',
      '/v1/auth/oauth/github/start?client_return_url=http://127.0.0.1:54321/callback'
    );
    const stateDisp = new URL(resStartDisp.headers['location']).searchParams.get('state');
    if (stateDisp) createdStates.push(stateDisp);

    const resCbDisp = await dispatchRequest(
      app,
      'GET',
      `/v1/auth/oauth/github/callback?state=${stateDisp}&code=mock-gh-disp-code`
    );
    assert.strictEqual(resCbDisp.status, 302);
    const dispLoc = new URL(resCbDisp.headers['location']);
    assert.strictEqual(dispLoc.searchParams.get('error'), 'Disposable email addresses are not allowed.');
    assert.strictEqual(dispLoc.searchParams.get('code'), null, 'No exchange code must be issued for disposable email');

    const dispUser = (await db.query('SELECT * FROM users WHERE email = $1', [disposableEmail])).rows[0];
    assert.strictEqual(dispUser, undefined, 'Disposable email must not create a user or grant credits');
    console.log('  ✓ [Test 13] Disposable email on GitHub OAuth is blocked with 0 users created and 0 credits granted');

    console.log('\n  🎉 All 13 OAuth Login & Hardening test cases passed successfully!\n');
  } finally {
    // Cleanup test database rows
    try {
      if (createdEmails.length > 0) {
        await db.query('DELETE FROM users WHERE email = ANY($1::text[])', [createdEmails]);
      }
      if (createdStates.length > 0) {
        await db.query('DELETE FROM oauth_states WHERE state = ANY($1::text[])', [createdStates]);
      }
    } catch (cleanupErr) {
      console.warn('  [OAuth Test Cleanup Warning]', (cleanupErr as Error)?.message);
    }

    // Restore environment variables and global fetch
    for (const k of envKeys) {
      if (origEnv[k] !== undefined) process.env[k] = origEnv[k];
      else delete process.env[k];
    }
    globalThis.fetch = origFetch;
  }
}
