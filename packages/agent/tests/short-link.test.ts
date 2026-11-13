import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import express from '../../../apps/server/node_modules/express';
import pino from '../../../apps/server/node_modules/pino/pino.js';
import {
  createShortLink,
  generateShortCode,
  hashShortCode,
  InMemoryShortLinkStore,
  resolvePublicBaseUrl,
  resolveShortLink,
  SHORT_LINK_TTL_MS,
} from '../../../apps/server/src/short-link';
import { createShortLinkRouter } from '../../../apps/server/src/build-router';

function dispatchGet(
  app: express.Express,
  urlPath: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req: any = new PassThrough();
    req.method = 'GET';
    req.url = urlPath;
    req.originalUrl = urlPath;
    req.headers = { 'user-agent': 'TestPhoneBrowser/1.0', ...headers };
    req.socket = { remoteAddress: '203.0.113.42' };
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
      resolve({ status: res.statusCode, headers: outHeaders, body: Buffer.concat(chunks) });
    };
    res.on('error', reject);
    app(req, res, (err: any) => {
      if (err) reject(err);
    });
  });
}

async function runTests() {
  console.log('\n  Running APK Short-Link Service & Route Tests...\n');

  // 1. Code generation (length & randomness)
  const code1 = generateShortCode();
  const code2 = generateShortCode();
  assert.ok(code1.length >= 22, `Expected >=22 chars, got ${code1.length}`);
  assert.notStrictEqual(code1, code2, 'Generated codes must be random and distinct');
  console.log('  ✓ [Test 1] Cryptographic opaque short code generation (>=22 base64url chars)');

  // 2. resolvePublicBaseUrl
  assert.strictEqual(
    resolvePublicBaseUrl({ PUBLIC_BASE_URL: 'https://builds.example.com/' } as any),
    'https://builds.example.com'
  );
  assert.strictEqual(
    resolvePublicBaseUrl({ NODE_ENV: 'development', PORT: '9090' } as any),
    'http://localhost:9090'
  );
  assert.throws(
    () => resolvePublicBaseUrl({ NODE_ENV: 'production' } as any),
    /PUBLIC_BASE_URL/
  );
  console.log('  ✓ [Test 2] resolvePublicBaseUrl validates, trims trailing slash, falls back in dev, throws in prod');

  // 3. Hash-only storage, 15m expiry, and superseding previous code
  const store = new InMemoryShortLinkStore();
  const jobId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const now = Date.now();

  const first = await createShortLink({
    jobId,
    userId,
    store,
    env: { PUBLIC_BASE_URL: 'https://builds.example.com' } as any,
    nowMs: now,
  });
  const firstCode = first.url.split('/d/')[1];
  assert.strictEqual(first.url, `https://builds.example.com/d/${firstCode}`);
  assert.strictEqual(first.expiresAt, now + SHORT_LINK_TTL_MS);

  const stored = await store.findByCodeHash(hashShortCode(firstCode));
  assert.ok(stored, 'Record must be stored by SHA-256 hash');
  assert.ok(!JSON.stringify(stored).includes(firstCode), 'Raw code must NEVER be stored');

  // Mint second code for same job -> supersedes first
  const second = await createShortLink({
    jobId,
    userId,
    store,
    env: { PUBLIC_BASE_URL: 'https://builds.example.com' } as any,
    nowMs: now + 1000,
  });
  const secondCode = second.url.split('/d/')[1];
  const resolvedFirst = await resolveShortLink({ code: firstCode, store, nowMs: now + 2000 });
  assert.strictEqual(resolvedFirst.ok, false, 'Superseded code must be rejected');
  const resolvedSecond = await resolveShortLink({ code: secondCode, store, nowMs: now + 2000 });
  assert.strictEqual(resolvedSecond.ok, true, 'New code must resolve');
  console.log('  ✓ [Test 3] Hash-only storage & superseding previous short link verified');

  // 4. Route integration tests: valid download, headers, reuse, expiry, wrong code, unfinished job, rate limit, audit log
  const tmpArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synkro-shortlink-'));
  const prevArtifactDir = process.env.ARTIFACT_DIR;
  process.env.ARTIFACT_DIR = tmpArtifactDir;

  const userDir = path.join(tmpArtifactDir, userId);
  fs.mkdirSync(userDir, { recursive: true });
  const apkBytes = Buffer.from('PK\x03\x04MOCK_APK_CONTENT_BYTES_1234567890');
  fs.writeFileSync(path.join(userDir, `${jobId}.apk`), apkBytes);

  const logLines: any[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      for (const line of chunk.toString('utf8').split('\n')) {
        if (line.trim()) logLines.push(JSON.parse(line));
      }
      cb();
    },
  });
  const testLogger = pino({ name: 'short-link-test' }, logStream);

  let jobStatus = 'success';
  const app = express();
  app.use(
    '/d',
    createShortLinkRouter({
      store,
      log: testLogger,
      rateLimitMax: 4,
      rateLimitWindowMs: 60_000,
      queryJob: async (jId, uId) => (jId === jobId && uId === userId ? { id: jId, status: jobStatus } : null),
    })
  );

  try {
    // 4a. Valid download + headers + bytes
    const res1 = await dispatchGet(app, `/d/${secondCode}`);
    assert.strictEqual(res1.status, 200);
    assert.strictEqual(res1.headers['content-type'], 'application/vnd.android.package-archive');
    assert.strictEqual(res1.headers['content-disposition'], 'attachment; filename="app-release.apk"');
    assert.strictEqual(res1.headers['content-length'], String(apkBytes.length));
    assert.strictEqual(res1.headers['cache-control'], 'no-store');
    assert.strictEqual(res1.headers['x-content-type-options'], 'nosniff');
    assert.strictEqual(res1.headers['referrer-policy'], 'no-referrer');
    assert.deepStrictEqual(res1.body, apkBytes);

    // 4b. Reusable within 15m window + usedCount incremented
    const res2 = await dispatchGet(app, `/d/${secondCode}`);
    assert.strictEqual(res2.status, 200);
    const updatedRec = await store.findByCodeHash(hashShortCode(secondCode));
    assert.strictEqual(updatedRec?.usedCount, 2, 'usedCount should increment on each download');
    console.log('  ✓ [Test 4] GET /d/:code streams APK with all security/attachment headers & increments usedCount');

    // 4c. Wrong / superseded code -> 404
    const resWrong = await dispatchGet(app, `/d/${firstCode}`);
    assert.strictEqual(resWrong.status, 404);

    // 4d. Unfinished job -> 404
    jobStatus = 'running';
    const resUnfinished = await dispatchGet(app, `/d/${secondCode}`);
    assert.strictEqual(resUnfinished.status, 404);
    jobStatus = 'success';
    console.log('  ✓ [Test 5] Superseded, wrong, and unfinished-job codes return generic 404');

    // 4e. Rate limiting -> 429 on 5th request
    const resRate = await dispatchGet(app, `/d/${secondCode}`);
    assert.strictEqual(resRate.status, 429);
    console.log('  ✓ [Test 6] Per-IP rate limiting returns 429 after limit');

    // 4f. Expired code check
    const expiredStore = new InMemoryShortLinkStore();
    await expiredStore.insert({
      id: '33333333-3333-4333-8333-333333333333',
      codeHash: hashShortCode('expiredCode1234567890ab'),
      jobId,
      userId,
      purpose: 'apk-download',
      expiresAt: Date.now() - 1000,
      createdAt: Date.now() - 16 * 60 * 1000,
      usedCount: 0,
    });
    const expOutcome = await resolveShortLink({ code: 'expiredCode1234567890ab', store: expiredStore });
    assert.strictEqual(expOutcome.ok, false);
    assert.strictEqual((expOutcome as any).reason, 'expired');
    console.log('  ✓ [Test 7] Expired short code rejected');

    // 4g. Audit log contains jobId, codeId, ip, userAgent, result, and NEVER raw code
    assert.ok(logLines.length >= 2, 'Pino audit logs must be emitted');
    const okLog = logLines.find((l) => l.result === 'ok');
    assert.ok(okLog?.jobId === jobId && okLog?.codeId && okLog?.ip && okLog?.userAgent, 'Audit log must include jobId, codeId, ip, userAgent, result');
    for (const l of logLines) {
      assert.ok(!JSON.stringify(l).includes(secondCode), 'Audit logs must NEVER contain raw short code');
    }
    console.log('  ✓ [Test 8] Pino audit logs contain jobId, codeId, ip, userAgent, result and never raw code');
  } finally {
    if (prevArtifactDir === undefined) delete process.env.ARTIFACT_DIR;
    else process.env.ARTIFACT_DIR = prevArtifactDir;
    fs.rmSync(tmpArtifactDir, { recursive: true, force: true });
  }

  console.log('\n  🟢 All 8 APK Short-Link tests passed!\n');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
