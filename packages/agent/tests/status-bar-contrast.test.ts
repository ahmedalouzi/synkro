import assert from 'node:assert';
import {
  toneForLuminance,
  HYSTERESIS_LOW,
  HYSTERESIS_HIGH,
  LUMINANCE_THRESHOLD
} from '../../../apps/desktop/src/renderer/src/features/preview/usePreviewSafeArea';
import {
  rewriteSafeAreaEnv,
  isSafeAreaMessage
} from '../../../apps/desktop/src/preload/preview-safe-area';

export default async function runStatusBarContrastTests() {
  console.log('  Running Preview Status-Bar Contrast & Safe-Area unit tests...');

  // 1. WCAG extremes
  assert.strictEqual(toneForLuminance(0.0), 'light', 'Black underlay (l=0.0) must yield white icons (light tone)');
  assert.strictEqual(toneForLuminance(1.0), 'dark', 'White background (l=1.0) must yield dark grey icons (dark tone)');

  // 2. Clear thresholds without previous tone
  assert.strictEqual(toneForLuminance(0.10), 'light', 'Low luminance (< 0.2045) must be light tone');
  assert.strictEqual(toneForLuminance(0.35), 'dark', 'High luminance (> 0.2045) must be dark tone');

  // 3. Contrast threshold constant
  assert.strictEqual(LUMINANCE_THRESHOLD, 0.2045, 'Threshold constant matches WCAG relative luminance boundary');

  // 4. Hysteresis deadband retention (0.175 to 0.235)
  // Inside deadband (e.g. 0.20), should retain previous tone
  assert.strictEqual(toneForLuminance(0.20, 'light'), 'light', 'Should latch to light tone within hysteresis deadband');
  assert.strictEqual(toneForLuminance(0.20, 'dark'), 'dark', 'Should latch to dark tone within hysteresis deadband');

  // 5. Hysteresis transitions outside deadband
  assert.strictEqual(
    toneForLuminance(HYSTERESIS_HIGH + 0.01, 'light'),
    'dark',
    'Must switch to dark tone when luminance rises above HYSTERESIS_HIGH'
  );
  assert.strictEqual(
    toneForLuminance(HYSTERESIS_LOW - 0.01, 'dark'),
    'light',
    'Must switch to light tone when luminance falls below HYSTERESIS_LOW'
  );

  // 6. Safe area CSS env rewriting shim
  const cssInput = 'padding-top: env(safe-area-inset-top); margin-bottom: constant(safe-area-inset-bottom, 16px);';
  const expectedRewritten = 'padding-top: var(--atomvs-safe-area-inset-top, 0px); margin-bottom: var(--atomvs-safe-area-inset-bottom, 16px);';
  assert.strictEqual(
    rewriteSafeAreaEnv(cssInput),
    expectedRewritten,
    'CSS safe-area-inset env() and constant() must rewrite to Atomvs CSS variables'
  );

  // 7. PostMessage safe-area inset contract validation
  const validMessage = {
    type: 'atomvs:safe-area',
    insets: { top: 36, right: 0, bottom: 24, left: 0 }
  };
  assert.strictEqual(isSafeAreaMessage(validMessage), true, 'Valid safe-area message must pass validation');

  assert.strictEqual(isSafeAreaMessage(null), false, 'Null data must be rejected');
  assert.strictEqual(isSafeAreaMessage({ type: 'atomvs:other' }), false, 'Different type must be rejected');
  assert.strictEqual(
    isSafeAreaMessage({ type: 'atomvs:safe-area', insets: { top: -5, right: 0, bottom: 0, left: 0 } }),
    false,
    'Negative insets must be rejected'
  );
  assert.strictEqual(
    isSafeAreaMessage({ type: 'atomvs:safe-area', insets: { top: 250, right: 0, bottom: 0, left: 0 } }),
    false,
    'Insets over 200 must be rejected'
  );
  assert.strictEqual(
    isSafeAreaMessage({ type: 'atomvs:safe-area', insets: { top: '36', right: 0, bottom: 0, left: 0 } }),
    false,
    'Non-number insets must be rejected'
  );

  console.log('    ✓ All status-bar contrast, hysteresis, and safe-area tests passed.');
}
