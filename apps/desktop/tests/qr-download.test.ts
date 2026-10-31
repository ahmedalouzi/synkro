import assert from 'assert';
import { JSDOM } from 'jsdom';
import QRCode from 'qrcode';
import { createDownloadToken, verifyDownloadToken } from '../../server/src/build-router';
import { renderBuildPanel } from '../src/renderer/src/features/build/BuildPanel';
import type { CloudBuildJob } from '@peep/shared';

function makeDoc(): Document {
  return new JSDOM('<!DOCTYPE html><html><body></body></html>').window.document;
}

function makeJob(overrides: Partial<CloudBuildJob> = {}): CloudBuildJob {
  return {
    id: 'b1234567-89ab-cdef-0123-456789abcdef',
    userId: 'u1234567-89ab-cdef-0123-456789abcdef',
    projectId: 'p1234567-89ab-cdef-0123-456789abcdef',
    framework: 'flutter',
    target: 'apk',
    status: 'queued',
    createdAt: new Date(),
    ...overrides,
  };
}

async function runTests() {
  console.log('\n  Running QR Code & Signed Download Token Tests...\n');

  // Test 1: Generate valid 15m signed token
  const jobId = 'a1234567-89ab-cdef-0123-456789abcdef';
  const userId = 'u1234567-89ab-cdef-0123-456789abcdef';
  const { token, expiresAt } = createDownloadToken(jobId, userId);

  assert.ok(token.includes('.'), 'Token must be dot-separated payload and HMAC signature');
  assert.ok(expiresAt > Date.now(), 'Token expiration must be in the future');
  assert.ok(expiresAt <= Date.now() + 15 * 60 * 1000 + 1000, 'Token TTL must be ~15 minutes');
  console.log('  ✓ [Test 1] Short-lived job-bound token minted with 15m TTL');

  // Test 2: Verify valid token
  const verified = verifyDownloadToken(token, jobId);
  assert.strictEqual(verified.valid, true);
  assert.strictEqual(verified.payload?.jobId, jobId);
  assert.strictEqual(verified.payload?.userId, userId);
  assert.strictEqual(verified.payload?.purpose, 'apk-download');
  console.log('  ✓ [Test 2] Token verifies signature and job binding');

  // Test 3: Token bound to specific jobId — reject mismatch
  const wrongJobVerified = verifyDownloadToken(token, 'different-job-id-12345678');
  assert.strictEqual(wrongJobVerified.valid, false);
  assert.strictEqual(wrongJobVerified.reason, 'Token is not bound to this job');
  console.log('  ✓ [Test 3] Token rejected when used for a different jobId');

  // Test 4: Tampered signature rejection
  const tamperedToken = token.slice(0, -4) + 'abcd';
  const tamperedVerified = verifyDownloadToken(tamperedToken, jobId);
  assert.strictEqual(tamperedVerified.valid, false);
  assert.strictEqual(tamperedVerified.reason, 'Invalid signature');
  console.log('  ✓ [Test 4] Tampered token signature rejected');

  // Test 5: Expired token rejection
  const expiredPayload = {
    jobId,
    userId,
    purpose: 'apk-download',
    exp: Date.now() - 5000, // expired 5 seconds ago
    tokenId: 'expired-test',
  };
  const data = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');
  const secret = process.env.DOWNLOAD_TOKEN_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || 'synkro-download-secret-fallback-key-32b';
  const crypto = await import('node:crypto');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const expiredToken = `${data}.${sig}`;

  const expiredVerified = verifyDownloadToken(expiredToken, jobId);
  assert.strictEqual(expiredVerified.valid, false);
  assert.strictEqual(expiredVerified.reason, 'Download token has expired');
  console.log('  ✓ [Test 5] Expired token correctly rejected');

  // Test 6: QR Code generation produces valid image data URL
  const downloadUrl = `https://builds.synkro.dev/api/build/${jobId}/download?token=${token}`;
  const qrDataUrl = await QRCode.toDataURL(downloadUrl, { width: 140, margin: 1 });
  assert.ok(qrDataUrl.startsWith('data:image/png;base64,'), 'QR must produce data:image/png;base64');
  console.log('  ✓ [Test 6] QR Code encodes signed URL to valid data URL');

  // Test 7: BuildPanel DOM renders QR banner on SUCCESS with artifactUrl
  const doc = makeDoc();
  const successJob = makeJob({ status: 'success', artifactUrl: downloadUrl });
  const root = renderBuildPanel({ currentBuild: successJob }, doc);
  const qrBanner = root.querySelector('#build-qr-banner');
  assert.ok(qrBanner, 'BuildPanel must render #build-qr-banner on success with artifactUrl');
  const downloadBtn = root.querySelector('#build-download-btn');
  assert.ok(downloadBtn, 'BuildPanel must render #build-download-btn');
  console.log('  ✓ [Test 7] BuildPanel DOM renders QR banner on build success');

  // Test 8: BuildPanel DOM does NOT render QR banner when queued/running/failed
  const queuedRoot = renderBuildPanel({ currentBuild: makeJob({ status: 'queued' }) }, doc);
  assert.ok(!queuedRoot.querySelector('#build-qr-banner'), 'Queued build must NOT render QR banner');

  const runningRoot = renderBuildPanel({ currentBuild: makeJob({ status: 'running' }) }, doc);
  assert.ok(!runningRoot.querySelector('#build-qr-banner'), 'Running build must NOT render QR banner');

  const failedRoot = renderBuildPanel({ currentBuild: makeJob({ status: 'failed', errorLog: 'Build failed' }) }, doc);
  assert.ok(!failedRoot.querySelector('#build-qr-banner'), 'Failed build must NOT render QR banner');
  console.log('  ✓ [Test 8] Non-success builds do not render QR banner');

  console.log('\n  🟢 All 8 QR Code & Download Token tests passed!\n');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

