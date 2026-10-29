import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import AdmZip from 'adm-zip';
import { setDbPool } from '../src/models/db';
import { validateZipBuffer } from '../src/models/zip-validator';
import { cleanupBuildTempFiles, extractZipSafely } from '../src/models/build-worker';
import {
  billingRouter,
  setBillingDbPool,
  verifyLemonSqueezySignature,
  verifyStripeSignature,
} from '../../../apps/server/src/billing-router';
import { buildRouter } from '../../../apps/server/src/build-router';
import express from '../../../apps/server/node_modules/express';

function createInMemoryMockPool() {
  const users = new Map<string, { id: string; email: string; plan: string; customerId?: string; subscriptionId?: string; status?: string }>();
  const sessions = new Map<string, { userId: string; expiresAt: Date }>();
  const processedEvents = new Set<string>();
  const buildJobs: any[] = [];

  const testUserId = '11111111-2222-3333-4444-555555555555';
  users.set(testUserId, {
    id: testUserId,
    email: 'builder@synkro.com',
    plan: 'free',
  });
  sessions.set('valid_test_token', {
    userId: testUserId,
    expiresAt: new Date(Date.now() + 3600_000),
  });

  const query = async (sql: string, params: any[] = []) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();

    if (
      normalized.startsWith('BEGIN') ||
      normalized.startsWith('COMMIT') ||
      normalized.startsWith('ROLLBACK') ||
      normalized.startsWith('SET LOCAL ROLE') ||
      normalized.startsWith('SELECT set_config')
    ) {
      return { rows: [] };
    }

    if (normalized.includes('FROM sessions s') && normalized.includes('JOIN users u')) {
      const token = params[0];
      const sess = sessions.get(token);
      if (!sess) return { rows: [] };
      const u = users.get(sess.userId);
      if (!u) return { rows: [] };
      return {
        rows: [
          {
            user_id: u.id,
            expires_at: sess.expiresAt,
            email: u.email,
            plan: u.plan,
          },
        ],
      };
    }

    if (normalized.includes('FROM billing_webhook_events WHERE event_id = $1')) {
      const eventId = params[0];
      return {
        rows: processedEvents.has(eventId) ? [{ event_id: eventId }] : [],
      };
    }

    if (normalized.includes('INSERT INTO billing_webhook_events')) {
      processedEvents.add(params[0]);
      return { rows: [] };
    }

    if (normalized.includes('SELECT id FROM users WHERE id = $1')) {
      const u = users.get(params[0]);
      return { rows: u ? [{ id: u.id }] : [] };
    }

    if (normalized.includes('SELECT id FROM users WHERE LOWER(email) = LOWER($1)')) {
      const email = String(params[0] || '').toLowerCase();
      for (const u of users.values()) {
        if (u.email.toLowerCase() === email) return { rows: [{ id: u.id }] };
      }
      return { rows: [] };
    }

    if (normalized.includes('SELECT id FROM users WHERE billing_subscription_id = $1')) {
      const subId = params[0];
      for (const u of users.values()) {
        if (u.subscriptionId === subId) return { rows: [{ id: u.id }] };
      }
      return { rows: [] };
    }

    if (normalized.includes('UPDATE users SET plan = $1')) {
      const [plan, customerId, subscriptionId, status, userId] = params;
      const u = users.get(userId);
      if (u) {
        u.plan = plan;
        if (customerId) u.customerId = customerId;
        if (subscriptionId) u.subscriptionId = subscriptionId;
        u.status = status;
      }
      return { rows: [] };
    }

    if (normalized.includes('SELECT COUNT(*) as count FROM build_jobs')) {
      return { rows: [{ count: String(buildJobs.length) }] };
    }

    if (normalized.includes('INSERT INTO build_jobs')) {
      const job = {
        id: `job-${buildJobs.length + 1}`,
        user_id: params[0],
        project_id: params[1],
        source_path: params[2],
        framework: params[3],
        target: params[4],
        status: 'queued',
      };
      buildJobs.push(job);
      return { rows: [{ id: job.id, status: job.status }] };
    }

    return { rows: [] };
  };

  return {
    query,
    connect: async () => ({
      query,
      release: () => {},
    }),
    users,
    buildJobs,
    testUserId,
  };
}

export default async function runPhase4BillingAndBuildTests() {
  const { Pool } = await import('pg');
  const mockPool = createInMemoryMockPool();
  setDbPool(mockPool as any);
  setBillingDbPool(mockPool);
  process.env.LEMONSQUEEZY_WEBHOOK_SECRET = 'ls_test_secret_123';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_secret_456';

  try {
    // 1. Verify HMAC signatures
    const body = Buffer.from(JSON.stringify({ hello: 'synkro' }), 'utf8');
    const lsSig = crypto.createHmac('sha256', 'ls_test_secret_123').update(body).digest('hex');
    assert.strictEqual(verifyLemonSqueezySignature(body, lsSig, 'ls_test_secret_123'), true);
    assert.strictEqual(verifyLemonSqueezySignature(body, 'deadbeef', 'ls_test_secret_123'), false);

    const ts = '1700000000';
    const stripeHmac = crypto
      .createHmac('sha256', 'whsec_test_secret_456')
      .update(`${ts}.${body.toString('utf8')}`)
      .digest('hex');
    assert.strictEqual(verifyStripeSignature(body, `t=${ts},v1=${stripeHmac}`, 'whsec_test_secret_456'), true);
    assert.strictEqual(verifyStripeSignature(body, `t=${ts},v1=invalid`, 'whsec_test_secret_456'), false);

    // 2. Billing webhook route (upgrade, idempotency, downgrade)
    const billingApp = express();
    billingApp.use(
      express.json({
        verify: (req: any, _res: any, buf: Buffer) => {
          req.rawBody = buf;
        },
      }),
    );
    billingApp.use('/v1/billing', billingRouter);

    const billingServer = billingApp.listen(0);
    const billingPort = (billingServer.address() as any).port;

    try {
      const badRes = await fetch(`http://127.0.0.1:${billingPort}/v1/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Signature': 'invalid_signature' },
        body: JSON.stringify({ meta: { event_name: 'subscription_created' } }),
      });
      assert.strictEqual(badRes.status, 401);

      const upgradePayload = {
        meta: { event_name: 'subscription_created', webhook_id: 'evt_ls_upgrade_001' },
        data: {
          id: 'sub_999',
          attributes: { user_email: 'builder@synkro.com', customer_id: 'cust_888', status: 'active' },
        },
      };
      const rawUpgrade = Buffer.from(JSON.stringify(upgradePayload), 'utf8');
      const sigUpgrade = crypto.createHmac('sha256', process.env.LEMONSQUEEZY_WEBHOOK_SECRET!).update(rawUpgrade).digest('hex');

      const okRes = await fetch(`http://127.0.0.1:${billingPort}/v1/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Signature': sigUpgrade },
        body: rawUpgrade,
      });
      assert.strictEqual(okRes.status, 200);
      const okJson = await okRes.json();
      assert.strictEqual(okJson.updated, true);
      assert.strictEqual(okJson.plan, 'pro');
      assert.strictEqual(mockPool.users.get(mockPool.testUserId)?.plan, 'pro');

      // Duplicate event idempotency
      const dupRes = await fetch(`http://127.0.0.1:${billingPort}/v1/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Signature': sigUpgrade },
        body: rawUpgrade,
      });
      assert.strictEqual(dupRes.status, 200);
      const dupJson = await dupRes.json();
      assert.strictEqual(dupJson.duplicate, true);

      // Downgrade on subscription_expired
      const expirePayload = {
        meta: { event_name: 'subscription_expired', webhook_id: 'evt_ls_expire_002' },
        data: { id: 'sub_999', attributes: { status: 'expired' } },
      };
      const rawExpire = Buffer.from(JSON.stringify(expirePayload), 'utf8');
      const sigExpire = crypto.createHmac('sha256', process.env.LEMONSQUEEZY_WEBHOOK_SECRET!).update(rawExpire).digest('hex');

      const expRes = await fetch(`http://127.0.0.1:${billingPort}/v1/billing/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Signature': sigExpire },
        body: rawExpire,
      });
      assert.strictEqual(expRes.status, 200);
      assert.strictEqual(mockPool.users.get(mockPool.testUserId)?.plan, 'free');
    } finally {
      billingServer.close();
    }

    // 3. ZIP validation & upload validation
    assert.strictEqual(validateZipBuffer(Buffer.from('not a zip', 'utf8')).valid, false);
    const goodZip = new AdmZip();
    goodZip.addFile('pubspec.yaml', Buffer.from('name: demo\n', 'utf8'));
    const zipBuf = goodZip.toBuffer();
    assert.strictEqual(validateZipBuffer(zipBuf).valid, true);

    const buildApp = express();
    buildApp.use('/api/build', buildRouter);
    const buildServer = buildApp.listen(0);
    const buildPort = (buildServer.address() as any).port;

    try {
      const form1 = new FormData();
      form1.append('project', new Blob([zipBuf]), 'project.zip');
      form1.append('framework', 'ionic');
      form1.append('target', 'apk');
      const res1 = await fetch(`http://127.0.0.1:${buildPort}/api/build/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_test_token' },
        body: form1 as any,
      });
      assert.strictEqual(res1.status, 400);

      const form2 = new FormData();
      form2.append('project', new Blob([zipBuf]), 'project.zip');
      form2.append('framework', 'flutter');
      form2.append('target', 'exe');
      const res2 = await fetch(`http://127.0.0.1:${buildPort}/api/build/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_test_token' },
        body: form2 as any,
      });
      assert.strictEqual(res2.status, 400);

      const form3 = new FormData();
      form3.append('project', new Blob([Buffer.from('not a zip')]), 'project.zip');
      form3.append('framework', 'flutter');
      form3.append('target', 'apk');
      const res3 = await fetch(`http://127.0.0.1:${buildPort}/api/build/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_test_token' },
        body: form3 as any,
      });
      assert.strictEqual(res3.status, 400);

      const form4 = new FormData();
      form4.append('project', new Blob([zipBuf]), 'project.zip');
      form4.append('framework', 'flutter');
      form4.append('target', 'apk');
      const res4 = await fetch(`http://127.0.0.1:${buildPort}/api/build/upload`, {
        method: 'POST',
        headers: { Authorization: 'Bearer valid_test_token' },
        body: form4 as any,
      });
      assert.strictEqual(res4.status, 202);
      assert.strictEqual(mockPool.buildJobs.length, 1);

      await cleanupBuildTempFiles({ sourceZipPath: mockPool.buildJobs[0].source_path });
    } finally {
      buildServer.close();
    }

    // 4. Temp file cleanup verification
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'synkro-cleanup-test-'));
    const extractPath = path.join(tmpRoot, 'job_extracted');
    const localApkPath = path.join(tmpRoot, 'job.apk');
    const sourceZipPath = path.join(tmpRoot, 'upload.zip');

    await fs.writeFile(sourceZipPath, zipBuf);
    await fs.writeFile(localApkPath, Buffer.from('mock apk bytes', 'utf8'));
    await extractZipSafely(sourceZipPath, extractPath);

    await cleanupBuildTempFiles({ extractPath, localApkPath, sourceZipPath });

    let extractExists = true;
    let apkExists = true;
    let zipExists = true;
    try { await fs.stat(extractPath); } catch { extractExists = false; }
    try { await fs.stat(localApkPath); } catch { apkExists = false; }
    try { await fs.stat(sourceZipPath); } catch { zipExists = false; }

    assert.strictEqual(extractExists, false);
    assert.strictEqual(apkExists, false);
    assert.strictEqual(zipExists, false);

    await fs.rm(tmpRoot, { recursive: true, force: true });
  } finally {
    setBillingDbPool(null);
    // Restore real pg Pool so subsequent suites in test-runner.ts use DATABASE_URL
    setDbPool(new Pool({ connectionString: process.env.DATABASE_URL }));
  }
}
