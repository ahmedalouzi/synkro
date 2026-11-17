import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: resolve(__dirname, '../../../.env') });

import express from '../../../apps/server/node_modules/express';
import { AuthService, isDisposableEmail, OTP_TTL_MS, OTP_MAX_ATTEMPTS, OTP_RESEND_COOLDOWN_MS } from '../src/models/auth';
import { BackendAIGateway, MockOpenAIAdapter } from '../src/models/backend-gateway';
import { db, initDbSchema } from '../src/models/db';
import { buildRouter } from '../../../apps/server/src/build-router';

export default async function runEmailVerificationTests() {
  console.log('  Running Email Verification & Anti-Abuse Test Suite...');

  await initDbSchema();

  const auth = new AuthService();
  let capturedOtp: string | null = null;
  auth.emailSender = async (_email: string, otp: string) => {
    capturedOtp = otp;
  };

  const gateway = new BackendAIGateway();
  (gateway as any).adapters.set('google', new MockOpenAIAdapter());
  (gateway as any).adapters.set('openai', new MockOpenAIAdapter());
  (gateway as any).adapters.set('anthropic', new MockOpenAIAdapter());
  (gateway.authService as any).productionProvider.emailSender = async (_email: string, otp: string) => {
    capturedOtp = otp;
  };

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 1: Database Schema, Unverified Signup State & Hashed OTP Storage
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('  ✓ [Test 1] Schema, unverified signup state and hashed OTP storage');
  {
    const email = `test1_${crypto.randomUUID()}@legitimate-startup.io`;
    const password = 'StrongPassword123!';
    capturedOtp = null;

    const session = await auth.signup(email, password);

    assert.strictEqual(session.emailVerified, false, 'Signup session should have emailVerified=false');
    assert.strictEqual(session.verificationRequired, true, 'Signup session should have verificationRequired=true');
    assert.ok(capturedOtp, 'Expected verification OTP to be generated on signup');
    assert.match(capturedOtp!, /^\d{6}$/, 'OTP must be 6 digits');

    // Verify database row in users
    const userRes = await db.query('SELECT email_verified FROM users WHERE id = $1', [session.userId]);
    assert.strictEqual(userRes.rows[0].email_verified, false, 'Database users.email_verified must be false');

    // Verify database row in email_verification_codes
    const codeRes = await db.query(
      'SELECT code_hash, attempts, max_attempts, expires_at, used_at FROM email_verification_codes WHERE user_id = $1',
      [session.userId]
    );
    assert.strictEqual(codeRes.rows.length, 1, 'Expected 1 verification code row');
    const codeRow = codeRes.rows[0];

    assert.strictEqual(codeRow.attempts, 0, 'Initial attempts must be 0');
    assert.strictEqual(codeRow.max_attempts, OTP_MAX_ATTEMPTS, 'Max attempts must match config (5)');
    assert.strictEqual(codeRow.used_at, null, 'used_at must be null initially');

    // Ensure hash is stored, never plaintext OTP
    assert.notStrictEqual(codeRow.code_hash, capturedOtp, 'Stored code must not be raw plaintext OTP');
    const expectedHash = crypto.createHash('sha256').update(capturedOtp!).digest('hex');
    assert.strictEqual(codeRow.code_hash, expectedHash, 'Stored code must match SHA-256 hex hash');

    // Expiry check (~15 mins)
    const expiresAt = new Date(codeRow.expires_at).getTime();
    const now = Date.now();
    const diff = expiresAt - now;
    assert.ok(diff > 14 * 60 * 1000 && diff <= 15 * 60 * 1000 + 5000, 'Expiration should be ~15 mins');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 2: Disposable Email Domain & Subdomain Blocking
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('  ✓ [Test 2] Disposable email domain and subdomain blocking');
  {
    assert.strictEqual(isDisposableEmail('test@mailinator.com'), true);
    assert.strictEqual(isDisposableEmail('alice@subdomain.mailinator.com'), true);
    assert.strictEqual(isDisposableEmail('bob@10minutemail.com'), true);
    assert.strictEqual(isDisposableEmail('charlie@guerrillamail.com'), true);
    assert.strictEqual(isDisposableEmail('dave@tempmail.com'), true);
    assert.strictEqual(isDisposableEmail('eve@yopmail.com'), true);
    assert.strictEqual(isDisposableEmail('frank@trashmail.com'), true);
    assert.strictEqual(isDisposableEmail('grace@sharklasers.com'), true);
    assert.strictEqual(isDisposableEmail('heidi@maildrop.cc'), true);

    // Legitimate domains must pass
    assert.strictEqual(isDisposableEmail('user@gmail.com'), false);
    assert.strictEqual(isDisposableEmail('user@outlook.com'), false);
    assert.strictEqual(isDisposableEmail('founder@synkro.dev'), false);

    // Rejection on AuthService.signup
    await assert.rejects(
      async () => {
        await auth.signup(`fake_${crypto.randomUUID()}@mailinator.com`, 'Pass123456');
      },
      /disposable/i,
      'AuthService.signup must reject disposable emails'
    );

    // Rejection on Gateway POST /v1/auth/signup
    const signupRes = await gateway.handleRequest(
      'POST',
      '/v1/auth/signup',
      {},
      { email: `abuse_${crypto.randomUUID()}@10minutemail.com`, password: 'Password123!' }
    );
    assert.strictEqual(signupRes.status, 400, 'Gateway signup must return 400 for disposable emails');
    assert.match(signupRes.body.message, /disposable/i);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 3: Unverified User Rejection on AI Gateway & Cloud Build Routes
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('  ✓ [Test 3] Unverified user rejection (403 EMAIL_NOT_VERIFIED)');
  {
    const email = `unverified_${crypto.randomUUID()}@company.org`;
    const password = 'SecuredPassword99!';
    const session = await gateway.authService.signup(email, password);

    const headers = {
      authorization: `Bearer ${session.sessionToken}`,
      'x-request-id': `test-unverified-${Date.now()}`
    };

    // Account status reflects unverified state
    const statusRes = await gateway.handleRequest('POST', '/v1/account/status', headers, {});
    assert.strictEqual(statusRes.status, 200);
    assert.strictEqual(statusRes.body.emailVerified, false, 'Account status should report emailVerified=false');

    // /v1/ai/generate blocked
    const genRes = await gateway.handleRequest(
      'POST',
      '/v1/ai/generate',
      headers,
      { tier: 'fast', messages: [{ role: 'user', content: 'hello' }] }
    );
    assert.strictEqual(genRes.status, 403, 'AI generate must return 403 for unverified user');
    assert.strictEqual(genRes.body.code, 'EMAIL_NOT_VERIFIED');

    // /v1/ai/stream blocked
    const streamRes = await gateway.handleRequest(
      'POST',
      '/v1/ai/stream',
      headers,
      { tier: 'fast', messages: [{ role: 'user', content: 'hello' }] }
    );
    assert.strictEqual(streamRes.status, 403, 'AI stream must return 403 for unverified user');
    assert.strictEqual(streamRes.body.code, 'EMAIL_NOT_VERIFIED');

    // /v1/ai/estimate-cost blocked
    const costRes = await gateway.handleRequest(
      'POST',
      '/v1/ai/estimate-cost',
      headers,
      { tier: 'fast', messages: [{ role: 'user', content: 'hello' }] }
    );
    assert.strictEqual(costRes.status, 403, 'AI estimate-cost must return 403 for unverified user');
    assert.strictEqual(costRes.body.code, 'EMAIL_NOT_VERIFIED');

    // Cloud Build Express Router blocked
    const app = express();
    app.use(express.json());
    app.use('/api/build', buildRouter);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const buildBase = `http://127.0.0.1:${port}/api/build`;

    try {
      // Build start/upload route blocked
      const uploadRes = await fetch(`${buildBase}/upload`, {
        method: 'POST',
        headers: { authorization: `Bearer ${session.sessionToken}` }
      });
      assert.strictEqual(uploadRes.status, 403, 'Cloud build upload must reject unverified user with 403');
      const uploadJson = await uploadRes.json();
      assert.strictEqual(uploadJson.code, 'EMAIL_NOT_VERIFIED');

      // Keystore download blocked
      const dummyProjectId = crypto.randomUUID();
      const keystoreRes = await fetch(`${buildBase}/signing/${dummyProjectId}/keystore`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${session.sessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ password })
      });
      assert.strictEqual(keystoreRes.status, 403, 'Keystore download must reject unverified user with 403');
      const keystoreJson = await keystoreRes.json();
      assert.strictEqual(keystoreJson.code, 'EMAIL_NOT_VERIFIED');
    } finally {
      server.close();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 4: Full OTP Lifecycle (TTL, Resend Cooldown, Verification & Replay)
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('  ✓ [Test 4] Full OTP lifecycle: TTL expiry, cooldown, invalidation and verification');
  {
    const email = `lifecycle_${crypto.randomUUID()}@enterprise.com`;
    const password = 'StrongPassword!88';
    capturedOtp = null;
    const session = await auth.signup(email, password);
    const firstOtp = capturedOtp!;

    // 4a. 60-second cooldown enforcement
    await assert.rejects(
      async () => {
        await auth.sendVerificationCode(session.userId, email, { enforceCooldown: true });
      },
      /wait 60 seconds/i,
      'Resend within 60s cooldown must throw'
    );

    // 4b. Invalidation of prior unused code on resend
    capturedOtp = null;
    await auth.sendVerificationCode(session.userId, email, { enforceCooldown: false });
    const secondOtp = capturedOtp!;
    assert.notStrictEqual(firstOtp, secondOtp, 'New OTP should be generated on resend');

    // First code must now be marked used_at IS NOT NULL
    const firstCodeCheck = await db.query(
      'SELECT used_at FROM email_verification_codes WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1',
      [session.userId]
    );
    assert.ok(firstCodeCheck.rows[0].used_at !== null, 'Prior code must be marked as used on resend');

    // Attempting to verify first code fails
    await assert.rejects(
      async () => {
        await auth.verifyEmailOtp(session.userId, firstOtp);
      },
      /invalid verification code/i
    );

    // 4c. Expiration check: force expiry in database
    await db.query(
      `UPDATE email_verification_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1 AND used_at IS NULL`,
      [session.userId]
    );
    await assert.rejects(
      async () => {
        await auth.verifyEmailOtp(session.userId, secondOtp);
      },
      /expired/i,
      'Expired code must be rejected'
    );

    // 4d. Fresh code and successful verification via Gateway endpoint
    capturedOtp = null;
    const resendReq = await gateway.handleRequest(
      'POST',
      '/v1/auth/resend-verification',
      { authorization: `Bearer ${session.sessionToken}` },
      {}
    );
    assert.strictEqual(resendReq.status, 200, 'Gateway resend-verification must succeed');
    const validOtp = capturedOtp!;
    assert.ok(validOtp, 'Expected new OTP on gateway resend');

    // Verify via Gateway POST /v1/auth/verify-email
    const verifyReq = await gateway.handleRequest(
      'POST',
      '/v1/auth/verify-email',
      { authorization: `Bearer ${session.sessionToken}` },
      { code: validOtp }
    );
    assert.strictEqual(verifyReq.status, 200, 'Gateway verify-email must return 200');
    assert.strictEqual(verifyReq.body.emailVerified, true);

    // Check user in database is now email_verified = true
    const userCheck = await db.query('SELECT email_verified FROM users WHERE id = $1', [session.userId]);
    assert.strictEqual(userCheck.rows[0].email_verified, true, 'User must now be verified in database');

    // Now AI services succeed!
    const genRes = await gateway.handleRequest(
      'POST',
      '/v1/ai/generate',
      { authorization: `Bearer ${session.sessionToken}`, 'x-request-id': 'after-verified' },
      { tier: 'fast', messages: [{ role: 'user', content: 'test generation' }] }
    );
    assert.strictEqual(genRes.status, 200, 'AI generate must now succeed after verification');

    // 4e. Replay attack rejection
    await assert.rejects(
      async () => {
        await auth.verifyEmailOtp(session.userId, validOtp);
      },
      /no pending verification code/i,
      'Used code cannot be replayed'
    );
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // TEST 5: Brute-Force Lockout After 5 Failed Attempts
  // ─────────────────────────────────────────────────────────────────────────────
  console.log('  ✓ [Test 5] Brute-force lockout after 5 failed attempts (transactional counter persistence)');
  {
    const email = `lockout_${crypto.randomUUID()}@defense.gov`;
    const password = 'PasswordSecure123#';
    capturedOtp = null;
    const session = await auth.signup(email, password);
    const validOtp = capturedOtp!;

    // 5 wrong attempts
    for (let i = 1; i <= 4; i++) {
      await assert.rejects(
        async () => {
          await auth.verifyEmailOtp(session.userId, '000000');
        },
        new RegExp(`${5 - i} attempts? remaining`, 'i'),
        `Attempt ${i} must show ${5 - i} remaining`
      );

      // Verify attempts counter persisted in database
      const countRes = await db.query(
        'SELECT attempts FROM email_verification_codes WHERE user_id = $1 AND used_at IS NULL',
        [session.userId]
      );
      assert.strictEqual(countRes.rows[0].attempts, i, `Database attempts must be committed as ${i}`);
    }

    // 5th attempt locks out
    await assert.rejects(
      async () => {
        await auth.verifyEmailOtp(session.userId, '000000');
      },
      /too many failed attempts.*locked/i,
      '5th failed attempt must report locked out'
    );

    const lockedRes = await db.query(
      'SELECT attempts FROM email_verification_codes WHERE user_id = $1 AND used_at IS NULL',
      [session.userId]
    );
    assert.strictEqual(lockedRes.rows[0].attempts, 5, 'Database attempts must be 5');

    // 6th attempt with the CORRECT code must still be rejected due to lockout!
    await assert.rejects(
      async () => {
        await auth.verifyEmailOtp(session.userId, validOtp);
      },
      /too many failed attempts.*locked/i,
      'Locked code must reject even the valid OTP'
    );

    // User must remain unverified
    const finalUserCheck = await db.query('SELECT email_verified FROM users WHERE id = $1', [session.userId]);
    assert.strictEqual(finalUserCheck.rows[0].email_verified, false, 'User must remain unverified');
  }

  console.log('  🟢 All Email Verification & Anti-Abuse tests passed successfully!\n');
}

if (process.argv[1]?.includes('email-verification.test.ts')) {
  runEmailVerificationTests().then(() => process.exit(0)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
