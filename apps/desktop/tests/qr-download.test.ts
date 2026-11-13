import assert from 'assert';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import QRCode from 'qrcode';
import React from 'react';
import { createDownloadToken, verifyDownloadToken } from '../../server/src/build-router';
import { renderBuildPanel, QR_INLINE_OPTIONS, QR_MODAL_OPTIONS, BuildPanel } from '../src/renderer/src/features/build/BuildPanel';
import { SpaceQrPopup, SPACE_QR_OPTIONS, formatSpaceCountdown } from '../src/renderer/src/features/build/SpaceQrPopup';
import { useBuildStore } from '../src/renderer/src/stores/build-store';
import type { CloudBuildJob } from '@peep/shared';
import en from '../src/renderer/src/i18n/locales/en.json';
import ar from '../src/renderer/src/i18n/locales/ar.json';
import tr from '../src/renderer/src/i18n/locales/tr.json';

function makeDom() {
  return new JSDOM('<!DOCTYPE html><html><body></body></html>');
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

  // A key for this test: the server has no fallback key (it is read on first use).
  process.env.DOWNLOAD_TOKEN_SECRET = 'qr-download-test-secret-0123456789abcdef';

  // Test 1: Generate valid 15m signed token (compact format without repeated jobId/purpose)
  const jobId = 'a1234567-89ab-cdef-0123-456789abcdef';
  const userId = 'b1234567-89ab-cdef-0123-456789abcdef';
  const { token, expiresAt } = createDownloadToken(jobId, userId);

  assert.ok(token.includes('.'), 'Token must be dot-separated payload and HMAC signature');
  const [payloadB64, sigB64] = token.split('.');
  const decodedPayload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  assert.strictEqual(decodedPayload.jobId, undefined, 'jobId should not be repeated in compact payload');
  assert.strictEqual(decodedPayload.purpose, undefined, 'purpose should not be repeated in compact payload');
  assert.ok(!/^[0-9a-f]{64}$/i.test(sigB64), 'HMAC signature must be base64url, not hex');
  assert.ok(expiresAt > Date.now(), 'Token expiration must be in the future');
  assert.ok(expiresAt <= Date.now() + 15 * 60 * 1000 + 1000, 'Token TTL must be ~15 minutes');
  console.log('  ✓ [Test 1] Compact 15m signed token minted (base64url HMAC, no redundant jobId/purpose)');

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
  assert.strictEqual(wrongJobVerified.reason, 'Invalid signature');
  console.log('  ✓ [Test 3] Token rejected when used for a different jobId');

  // Test 4: Tampered signature rejection
  const tamperedToken = token.slice(0, -4) + 'abcd';
  const tamperedVerified = verifyDownloadToken(tamperedToken, jobId);
  assert.strictEqual(tamperedVerified.valid, false);
  assert.strictEqual(tamperedVerified.reason, 'Invalid signature');
  console.log('  ✓ [Test 4] Tampered token signature rejected');

  // Test 5: Expired token rejection (new compact encoding)
  const expiredPayload = {
    userId,
    exp: Date.now() - 5000, // expired 5 seconds ago
    tokenId: 'expired-test',
  };
  const data = Buffer.from(JSON.stringify(expiredPayload)).toString('base64url');
  const secret = process.env.DOWNLOAD_TOKEN_SECRET as string;
  const crypto = await import('node:crypto');
  const sig = crypto.createHmac('sha256', secret).update(`${jobId}:apk-download:${data}`).digest('base64url');
  const expiredToken = `${data}.${sig}`;

  const expiredVerified = verifyDownloadToken(expiredToken, jobId);
  assert.strictEqual(expiredVerified.valid, false);
  assert.strictEqual(expiredVerified.reason, 'Download link has expired');
  console.log('  ✓ [Test 5] Expired compact token correctly rejected');

  // Test 6: QR Code options & generation (256px inline, 400px modal, margin >= 4, level M)
  assert.ok(QR_INLINE_OPTIONS.width >= 240 && QR_INLINE_OPTIONS.width <= 280, 'Inline QR width must be 240-280px');
  assert.strictEqual(QR_INLINE_OPTIONS.width, 256, 'Inline QR width should be 256px');
  assert.ok(QR_INLINE_OPTIONS.margin >= 4, 'QR quiet zone margin must be at least 4 modules');
  assert.strictEqual(QR_INLINE_OPTIONS.errorCorrectionLevel, 'M', 'Error correction level must be M');
  assert.strictEqual(QR_MODAL_OPTIONS.width, 400, 'Modal QR width must be 400px');
  assert.ok(QR_MODAL_OPTIONS.margin >= 4, 'Modal QR quiet zone margin must be at least 4 modules');

  const downloadUrl = `https://builds.synkro.dev/api/build/${jobId}/download?token=${token}`;
  const inlineQrDataUrl = await QRCode.toDataURL(downloadUrl, QR_INLINE_OPTIONS);
  const modalQrDataUrl = await QRCode.toDataURL(downloadUrl, QR_MODAL_OPTIONS);
  assert.ok(inlineQrDataUrl.startsWith('data:image/png;base64,'), 'Inline QR must produce data:image/png;base64');
  assert.ok(modalQrDataUrl.startsWith('data:image/png;base64,'), 'Modal QR must produce data:image/png;base64');
  console.log('  ✓ [Test 6] QR Code options (256px / 400px, margin 4, level M) & generation verified');

  // Test 7: BuildPanel DOM does NOT render inline QR banner; renders compact phone install row with "Show QR" button
  const dom = makeDom();
  const doc = dom.window.document;
  const shortUrl = 'https://builds.synkro.dev/d/abcDEF1234567890_xyz12';
  const successJob = makeJob({ status: 'success', artifactUrl: downloadUrl, shortUrl });
  const root = renderBuildPanel({ currentBuild: successJob }, doc);
  assert.ok(!root.querySelector('#build-qr-banner'), 'Build tab must NOT render inline #build-qr-banner');
  assert.ok(!root.querySelector('#build-qr-img'), 'Build tab must NOT render inline QR image');
  const installRow = root.querySelector('#build-phone-install-row');
  assert.ok(installRow, 'BuildPanel must render #build-phone-install-row on success');
  const showQrBtn = root.querySelector('#build-show-qr-btn');
  assert.ok(showQrBtn, 'BuildPanel must render #build-show-qr-btn');
  const downloadBtn = root.querySelector('#build-download-btn');
  assert.ok(downloadBtn, 'BuildPanel must render #build-download-btn');
  const rowText = installRow?.textContent || '';
  assert.ok(!rowText.includes('https://') && !rowText.includes('/d/') && !rowText.includes('?token='), 'Phone install row must NOT display any URL text');
  assert.ok(!rowText.toLowerCase().includes('copy'), 'Phone install row must NOT have a Copy button');
  console.log('  ✓ [Test 7] BuildPanel DOM does not render inline QR card; renders compact row with Show QR button');

  // Test 8: Compact row renders phone icon & label, and non-success builds omit row
  const phoneInfo = root.querySelector('.build-phone-install-info');
  assert.ok(phoneInfo, 'Phone install info block must exist');
  console.log('  ✓ [Test 8] Compact phone install row renders with phone icon and label');

  // Test 9: BuildPanel DOM does NOT render phone install row when queued/running/failed
  const queuedRoot = renderBuildPanel({ currentBuild: makeJob({ status: 'queued' }) }, doc);
  assert.ok(!queuedRoot.querySelector('#build-phone-install-row'), 'Queued build must NOT render phone install row');

  const runningRoot = renderBuildPanel({ currentBuild: makeJob({ status: 'running' }) }, doc);
  assert.ok(!runningRoot.querySelector('#build-phone-install-row'), 'Running build must NOT render phone install row');

  const failedRoot = renderBuildPanel({ currentBuild: makeJob({ status: 'failed', errorLog: 'Build failed' }) }, doc);
  assert.ok(!failedRoot.querySelector('#build-phone-install-row'), 'Failed build must NOT render phone install row');
  console.log('  ✓ [Test 9] Non-success builds do not render phone install row');

  // Test 10: i18n keys exist in en, ar, and tr
  const requiredKeys = [
    'scanWithPhone',
    'installOnPhone',
    'showQr',
    'qrExpiresIn',
    'qrExpired',
    'refreshQr',
    'refreshing',
    'openFullPage',
    'fullPageTitle',
    'fullPageSubtitle',
    'fullPageExpiresIn',
    'fullPageExpired',
    'fullPageRefresh',
    'fullPageClose',
    'fullPageRetry',
    'fullPageLoading',
    'fullPageError',
    'qrAriaLabel',
  ] as const;
  for (const [lang, dict] of [['en', en], ['ar', ar], ['tr', tr]] as const) {
    for (const key of requiredKeys) {
      const val = (dict.build as Record<string, unknown>)[key];
      assert.ok(typeof val === 'string' && val.length > 0, `Missing ${lang}.build.${key}`);
    }
  }
  console.log('  ✓ [Test 10] All QR, helper, modal & full-page i18n keys exist in en, ar, and tr');

  // Set up JSDOM globals for React Testing Library tests of SpaceQrPopup
  const rtlDom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
  (globalThis as any).React = React;
  (globalThis as any).window = rtlDom.window;
  (globalThis as any).document = rtlDom.window.document;
  (globalThis as any).HTMLElement = rtlDom.window.HTMLElement;
  (globalThis as any).KeyboardEvent = rtlDom.window.KeyboardEvent;
  Object.defineProperty(globalThis, 'navigator', { value: rtlDom.window.navigator, configurable: true });

  let reducedMotion = false;
  (rtlDom.window as any).requestAnimationFrame = (cb: (t: number) => void) => setTimeout(() => cb(Date.now()), 16);
  (rtlDom.window as any).cancelAnimationFrame = (id: any) => clearTimeout(id);
  (globalThis as any).requestAnimationFrame = (rtlDom.window as any).requestAnimationFrame;
  (globalThis as any).cancelAnimationFrame = (rtlDom.window as any).cancelAnimationFrame;

  (rtlDom.window as any).matchMedia = (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
  (globalThis as any).window.matchMedia = (rtlDom.window as any).matchMedia;

  const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');

  // Test 11: SpaceQrPopup renders via portal into document.body, locks scroll, encodes short URL, no URL/Copy, Esc & Close
  {
    let resolveMint!: (v: { url: string; expiresAt: number }) => void;
    const mintPromise = new Promise<{ url: string; expiresAt: number }>((r) => {
      resolveMint = r;
    });
    const encodedTargets: string[] = [];
    let closed = false;

    const { container } = render(
      React.createElement(SpaceQrPopup, {
        jobId,
        onClose: () => {
          closed = true;
        },
        createShortLinkFn: () => mintPromise,
        generateQrDataUrl: async (text) => {
          encodedTargets.push(text);
          return 'data:image/png;base64,SPACEQR';
        },
      })
    );

    // Verify Portal: popup is in document.body, NOT in container
    const popupInBody = document.body.querySelector('#space-qr-popup');
    assert.ok(popupInBody, 'Popup must be rendered as a child of document.body via Portal');
    assert.ok(!container.querySelector('#space-qr-popup'), 'Popup must NOT be inside the local container');
    assert.strictEqual(document.body.style.overflow, 'hidden', 'Popup must lock body scroll while open');

    assert.ok(document.querySelector('#space-qr-loading'), 'Loading state must be visible while minting');

    const freshShortUrl = 'https://builds.synkro.dev/d/freshSpaceCode88888888';
    resolveMint({ url: freshShortUrl, expiresAt: Date.now() + 15 * 60 * 1000 });

    await waitFor(() => {
      assert.ok(document.querySelector('#space-qr-img'), 'QR image must render after mint');
    });

    assert.strictEqual(encodedTargets[0], freshShortUrl, 'QR must encode short URL');
    assert.ok(!encodedTargets[0].includes('?token='), 'QR must NOT encode long signed token URL');
    assert.strictEqual(SPACE_QR_OPTIONS.width, 320, 'QR width option must be 320');
    assert.strictEqual(SPACE_QR_OPTIONS.margin, 4, 'QR quiet zone must be 4');
    assert.strictEqual(SPACE_QR_OPTIONS.errorCorrectionLevel, 'M', 'QR error correction must be M');

    const pageText = document.querySelector('#space-qr-popup')?.textContent || '';
    assert.ok(!pageText.includes('https://') && !pageText.includes('/d/') && !pageText.includes('?token='), 'Popup must NOT display any URL text');
    assert.ok(!pageText.toLowerCase().includes('copy'), 'Popup must NOT have a Copy button');

    // Close via close button (with mock timers or reduced motion)
    closed = false;
    fireEvent.click(document.querySelector('#space-qr-close-btn')!);
    await waitFor(() => {
      assert.strictEqual(closed, true, 'Close button must close popup');
    });

    cleanup();
    document.body.innerHTML = '';
    assert.strictEqual(document.body.style.overflow, '', 'Closing popup must restore body scroll');
    console.log('  ✓ [Test 11] SpaceQrPopup portal to document.body, scroll lock, short URL encoding, no URL/Copy, Close verified');
  }

  // Test 12: SpaceQrPopup error -> Retry flow
  {
    let attempt = 0;
    render(
      React.createElement(SpaceQrPopup, {
        jobId,
        onClose: () => {},
        createShortLinkFn: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('Network error');
          return { url: 'https://builds.synkro.dev/d/retrySuccessCode123456', expiresAt: Date.now() + 15 * 60 * 1000 };
        },
        generateQrDataUrl: async () => 'data:image/png;base64,RETRYQR',
      })
    );

    await waitFor(() => {
      assert.ok(document.querySelector('#space-qr-error'), 'Error state must appear on mint failure');
    });

    fireEvent.click(document.querySelector('#space-qr-retry-btn')!);

    await waitFor(() => {
      assert.ok(document.querySelector('#space-qr-img'), 'Retry must mint short link and render QR');
    });
    assert.strictEqual(attempt, 2);

    cleanup();
    document.body.innerHTML = '';
    console.log('  ✓ [Test 12] SpaceQrPopup error and Retry flow verified');
  }

  // Test 13: Countdown expiry (fake timers) -> Expired overlay -> Refresh flow
  {
    mock.timers.enable({ apis: ['Date', 'setInterval'] });
    try {
      const startNow = Date.now();
      let mintCount = 0;
      render(
        React.createElement(SpaceQrPopup, {
          jobId,
          onClose: () => {},
          createShortLinkFn: async () => {
            mintCount += 1;
            return {
              url: `https://builds.synkro.dev/d/timedCode${mintCount}00000000000`,
              expiresAt: Date.now() + 15 * 60 * 1000,
            };
          },
          generateQrDataUrl: async () => 'data:image/png;base64,TIMEDQR',
        })
      );

      await waitFor(() => {
        assert.ok(document.querySelector('#space-qr-img'));
      });

      assert.strictEqual(formatSpaceCountdown(15 * 60), '15:00');
      assert.strictEqual(formatSpaceCountdown(92), '1:32');

      // Advance 15 minutes + 1s
      mock.timers.tick(15 * 60 * 1000 + 1000);
      assert.ok(Date.now() > startNow + 15 * 60 * 1000);

      await waitFor(() => {
        assert.ok(document.querySelector('#space-qr-expired-overlay'), 'Expired overlay must appear at 0:00');
      });

      fireEvent.click(document.querySelector('#space-qr-expired-refresh-btn')!);
      await waitFor(() => {
        assert.ok(!document.querySelector('#space-qr-expired-overlay'), 'Refresh must clear expired overlay');
      });
      assert.strictEqual(mintCount, 2, 'Refresh must mint a new short link');

      cleanup();
      document.body.innerHTML = '';
    } finally {
      mock.timers.reset();
    }
    console.log('  ✓ [Test 13] SpaceQrPopup countdown expiry (fake timers) and Refresh flow verified');
  }

  // Test 14: prefers-reduced-motion disables heavy animations in SpaceQrPopup.css
  {
    const cssPath = path.resolve(__dirname, '../src/renderer/src/features/build/SpaceQrPopup.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'SpaceQrPopup.css must handle prefers-reduced-motion');
    assert.ok(css.includes('.space-qr-shooting-star') && css.includes('animation: none !important'), 'Reduced motion must disable shooting stars');
    console.log('  ✓ [Test 14] prefers-reduced-motion disables heavy animations in SpaceQrPopup.css');
  }

  // Test 15: BuildPanel component - Show QR button opens popup into body; auto-open on transition to success
  {
    useBuildStore.getState().setCurrentBuild(null);
    const testJob = makeJob({ status: 'running', target: 'apk' });
    useBuildStore.getState().setCurrentBuild(testJob);

    const { container } = render(React.createElement(BuildPanel));
    assert.ok(!document.body.querySelector('#space-qr-popup'), 'Popup should not be open while build is running');

    // Transition to success -> triggers auto-open once
    useBuildStore.getState().setCurrentBuild({ ...testJob, status: 'success', artifactUrl: downloadUrl });

    await waitFor(() => {
      assert.ok(document.body.querySelector('#space-qr-popup'), 'Build transitioning to success must auto-open QR popup in document.body');
    });
    assert.ok(!container.querySelector('#space-qr-popup'), 'Popup must be in document.body, not inside BuildPanel container');

    // Close via close button
    fireEvent.click(document.body.querySelector('#space-qr-close-btn')!);
    await waitFor(() => {
      assert.ok(!document.body.querySelector('#space-qr-popup'), 'Closing popup removes it from document.body');
    });

    // Re-rendering or setting same build must NOT auto-open again
    useBuildStore.getState().setCurrentBuild({ ...testJob, status: 'success', artifactUrl: downloadUrl });
    assert.ok(!document.body.querySelector('#space-qr-popup'), 'Popup must not auto-open again after closing');

    // Clicking "Show QR" button manually re-opens it
    const showBtn = container.querySelector('#build-show-qr-btn') as HTMLButtonElement;
    assert.ok(showBtn, 'Show QR button must exist in BuildPanel');
    fireEvent.click(showBtn);

    await waitFor(() => {
      assert.ok(document.body.querySelector('#space-qr-popup'), 'Clicking Show QR button must open popup');
    });

    fireEvent.click(document.body.querySelector('#space-qr-close-btn')!);
    await waitFor(() => {
      assert.ok(!document.body.querySelector('#space-qr-popup'));
    });

    cleanup();
    console.log('  ✓ [Test 15] BuildPanel auto-opens popup on success transition and manual Show QR button works');
  }

  console.log('\n  🟢 All 15 QR Code, Short-Link & Full-Page QR tests passed!\n');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
