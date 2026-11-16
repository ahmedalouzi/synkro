import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { mock } from 'node:test';
import { JSDOM } from 'jsdom';
import React from 'react';
import { SpaceQrPopup, SPACE_QR_OPTIONS, formatSpaceCountdown } from '../src/renderer/src/features/build/SpaceQrPopup';
import en from '../src/renderer/src/i18n/locales/en.json';
import ar from '../src/renderer/src/i18n/locales/ar.json';
import tr from '../src/renderer/src/i18n/locales/tr.json';

async function runTests() {
  console.log('\n  Running Space-Themed Full-Screen QR Popup Tests...\n');

  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'http://localhost/' });
  (globalThis as any).React = React;
  (globalThis as any).window = dom.window;
  (globalThis as any).document = dom.window.document;
  (globalThis as any).HTMLElement = dom.window.HTMLElement;
  (globalThis as any).KeyboardEvent = dom.window.KeyboardEvent;
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

  // Mock matchMedia (reduced motion = false by default)
  let reducedMotion = false;
  (dom.window as any).matchMedia = (query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? reducedMotion : false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
  (globalThis as any).window.matchMedia = (dom.window as any).matchMedia;

  const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react');
  const jobId = 'a1234567-89ab-cdef-0123-456789abcdef';

  // Test 1: Loading -> renders only QR encoding short URL (never long token URL), no URL text, no Copy button, Esc & Close
  {
    let resolveMint!: (v: { url: string; expiresAt: number }) => void;
    const mintPromise = new Promise<{ url: string; expiresAt: number }>((r) => {
      resolveMint = r;
    });
    const encodedTargets: string[] = [];
    let closed = false;

    render(
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

    assert.ok(document.querySelector('#space-qr-loading'), 'Loading state must be shown while minting');

    const shortUrl = 'https://builds.synkro.dev/d/spaceCode1234567890ab';
    resolveMint({ url: shortUrl, expiresAt: Date.now() + 15 * 60 * 1000 });

    await waitFor(() => {
      assert.ok(document.querySelector('#space-qr-img'), 'QR image must render after mint');
    });

    assert.strictEqual(encodedTargets[0], shortUrl, 'QR must encode short URL');
    assert.ok(!encodedTargets[0].includes('?token='), 'QR must NOT encode long signed token URL');
    assert.strictEqual(SPACE_QR_OPTIONS.margin, 4);
    assert.strictEqual(SPACE_QR_OPTIONS.errorCorrectionLevel, 'M');

    const popupText = document.querySelector('#space-qr-popup')?.textContent || '';
    assert.ok(!popupText.includes('https://') && !popupText.includes('/d/') && !popupText.includes('?token='), 'Popup must NOT show URL text');
    assert.ok(!popupText.toLowerCase().includes('copy'), 'Popup must NOT have a Copy button');

    // Close via Close button (reducedMotion = true for immediate close, or wait 300ms)
    reducedMotion = true;
    fireEvent.click(document.querySelector('#space-qr-close-btn')!);
    assert.strictEqual(closed, true, 'Close button must close popup');

    cleanup();
    reducedMotion = false;
    console.log('  ✓ [Test 1] Loading, short URL encoding, no URL/Copy, and Close button verified');
  }

  // Test 2: Esc closes popup (with exit transition)
  {
    let closed = false;
    render(
      React.createElement(SpaceQrPopup, {
        jobId,
        onClose: () => {
          closed = true;
        },
        createShortLinkFn: async () => ({
          url: 'https://builds.synkro.dev/d/escTestCode1234567890',
          expiresAt: Date.now() + 15 * 60 * 1000,
        }),
        generateQrDataUrl: async () => 'data:image/png;base64,ESCQR',
      })
    );

    await waitFor(() => {
      assert.ok(document.querySelector('#space-qr-img'));
    });

    fireEvent.keyDown(window, { key: 'Escape' });
    assert.ok(document.querySelector('#space-qr-popup')?.classList.contains('is-exiting'), 'Overlay should enter exit animation on Esc');
    await waitFor(() => {
      assert.strictEqual(closed, true, 'Esc must close popup after exit animation');
    });

    cleanup();
    console.log('  ✓ [Test 2] Esc triggers exit transition and closes popup');
  }

  // Test 3: Error -> Retry flow
  {
    let attempt = 0;
    render(
      React.createElement(SpaceQrPopup, {
        jobId,
        onClose: () => {},
        createShortLinkFn: async () => {
          attempt += 1;
          if (attempt === 1) throw new Error('Mint failed');
          return {
            url: 'https://builds.synkro.dev/d/retrySpaceCode1234567',
            expiresAt: Date.now() + 15 * 60 * 1000,
          };
        },
        generateQrDataUrl: async () => 'data:image/png;base64,RETRYSPACEQR',
      })
    );

    await waitFor(() => {
      assert.ok(document.querySelector('#space-qr-error'), 'Error state must appear on failure');
    });

    fireEvent.click(document.querySelector('#space-qr-retry-btn')!);

    await waitFor(() => {
      assert.ok(document.querySelector('#space-qr-img'), 'Retry must mint short link and show QR');
    });
    assert.strictEqual(attempt, 2);

    cleanup();
    console.log('  ✓ [Test 3] Error and Retry flow verified');
  }

  // Test 4: Countdown expiry (fake timers) -> Expired overlay -> Refresh flow
  {
    mock.timers.enable({ apis: ['Date', 'setInterval'] });
    try {
      let mintCount = 0;
      render(
        React.createElement(SpaceQrPopup, {
          jobId,
          onClose: () => {},
          createShortLinkFn: async () => {
            mintCount += 1;
            return {
              url: `https://builds.synkro.dev/d/timedSpace${mintCount}0000000000`,
              expiresAt: Date.now() + 15 * 60 * 1000,
            };
          },
          generateQrDataUrl: async () => 'data:image/png;base64,TIMEDSPACEQR',
        })
      );

      await waitFor(() => {
        assert.ok(document.querySelector('#space-qr-img'));
      });

      assert.strictEqual(formatSpaceCountdown(15 * 60), '15:00');
      mock.timers.tick(15 * 60 * 1000 + 1000);

      await waitFor(() => {
        assert.ok(document.querySelector('#space-qr-expired-overlay'), 'Expired overlay must appear at 0:00');
      });

      fireEvent.click(document.querySelector('#space-qr-expired-refresh-btn')!);

      await waitFor(() => {
        assert.ok(!document.querySelector('#space-qr-expired-overlay'), 'Refresh must clear expired overlay');
      });
      assert.strictEqual(mintCount, 2, 'Refresh must mint a new code');

      cleanup();
    } finally {
      mock.timers.reset();
    }
    console.log('  ✓ [Test 4] Countdown expiry (fake timers) and Refresh flow verified');
  }

  // Test 5: prefers-reduced-motion disables warp, shooting stars, and pulse
  {
    const cssPath = path.resolve(__dirname, '../src/renderer/src/features/build/SpaceQrPopup.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'SpaceQrPopup.css must support prefers-reduced-motion');
    assert.ok(css.includes('.space-qr-shooting-star') && css.includes('.space-qr-glow') && css.includes('.space-qr-orbit-ring'));
    assert.ok(css.includes('animation: none !important'), 'Reduced motion must disable shooting stars, pulse, and orbit');
    console.log('  ✓ [Test 5] prefers-reduced-motion disables warp, shooting stars, and pulse');
    // The close button sits below the title bar, clear of the native window controls / macOS traffic lights.
    const closeRule = /\.space-qr-close-btn \{[^}]*\}/.exec(css)?.[0] ?? '';
    assert.ok(closeRule.includes('top: calc(env(titlebar-area-height, 35px) + 12px)'), 'Close button must sit below the title bar');
    assert.ok(closeRule.includes('inset-inline-end: 20px'), 'Close button keeps its logical (RTL-aware) side');
  }

  // Test 6: i18n keys exist in en, ar, tr
  {
    const requiredKeys = [
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
    console.log('  ✓ [Test 6] All required i18n keys exist in en, ar, and tr');
  }

  console.log('\n  🟢 All 6 Space-Themed Full-Screen QR Popup tests passed!\n');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});

