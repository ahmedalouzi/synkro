import { describe, it } from 'node:test';
import assert from 'node:assert';
import { JSDOM } from 'jsdom';

// Set up mock DOM BEFORE importing i18n
const dom = new JSDOM('<!DOCTYPE html><html lang="en"><head></head><body><div id="root"></div></body></html>', {
  url: 'http://localhost'
});
(global as any).window = dom.window;
(global as any).document = dom.window.document;
(global as any).localStorage = dom.window.localStorage;

async function runTests() {
  const { t, setLocale, getLocale, SUPPORTED_LOCALES } = await import('../src/renderer/src/i18n');

  console.log('\n  Running i18n layer unit tests...\n');

  // Test 1: Default locale and fallback
  assert.strictEqual(getLocale(), 'en');
  assert.strictEqual(document.documentElement.lang, 'en');
  assert.strictEqual(document.documentElement.dir, 'ltr');
  assert.strictEqual(document.body.dir, 'ltr');
  assert.strictEqual(t('login.signIn'), 'Sign in');
  assert.strictEqual(t('nonexistent.key'), 'nonexistent.key');
  console.log('  ✓ [Test 1] Default English locale and fallback');

  // Test 2: Parameter interpolation
  assert.strictEqual(
    t('onboarding.sdkDetected', { version: '3.24.0' }),
    'Flutter 3.24.0 detected'
  );
  console.log('  ✓ [Test 2] Parameter interpolation');

  // Test 3: Switch to Turkish
  setLocale('tr', false);
  assert.strictEqual(getLocale(), 'tr');
  assert.strictEqual(document.documentElement.lang, 'tr');
  assert.strictEqual(document.documentElement.dir, 'ltr');
  assert.strictEqual(t('login.signIn'), 'Giriş yap');
  assert.strictEqual(t('build.buildApk'), 'APK Derle');
  console.log('  ✓ [Test 3] Turkish language switching and LTR direction');

  // Test 4: Switch to Arabic and RTL
  setLocale('ar', false);
  assert.strictEqual(getLocale(), 'ar');
  assert.strictEqual(document.documentElement.lang, 'ar');
  assert.strictEqual(document.documentElement.dir, 'rtl');
  assert.strictEqual(document.body.dir, 'rtl');
  assert.strictEqual(t('login.signIn'), 'تسجيل الدخول');
  assert.strictEqual(t('build.noActiveBuild'), 'لا توجد عملية بناء نشطة.');
  console.log('  ✓ [Test 4] Arabic language switching and RTL direction');

  // Test 5: Supported locales list
  assert.strictEqual(SUPPORTED_LOCALES.length, 3);
  assert.deepStrictEqual(SUPPORTED_LOCALES.map((l) => l.code), ['en', 'ar', 'tr']);
  console.log('  ✓ [Test 5] Supported locales definition');

  // Test 6: Dropdown commands & Welcome screen localization
  setLocale('en', false);
  assert.strictEqual(t('commands.workbench.action.files.newUntitledFile'), 'New Text File');
  assert.strictEqual(t('welcome.openProject'), 'Open project');
  assert.strictEqual(t('welcome.tryNewWindow'), 'Try a new window to work on several apps in parallel');

  setLocale('tr', false);
  assert.strictEqual(t('commands.workbench.action.files.newUntitledFile'), 'Yeni Metin Dosyası');
  assert.strictEqual(t('commands.workbench.action.toggleAutoSave'), 'Otomatik Kaydet');
  assert.strictEqual(t('welcome.openProject'), 'Proje aç');

  setLocale('ar', false);
  assert.strictEqual(t('commands.workbench.action.files.newUntitledFile'), 'ملف نصي جديد');
  assert.strictEqual(t('commands.peep.newProject'), 'مشروع جديد...');
  assert.strictEqual(t('commands.workbench.action.toggleAutoSave'), 'حفظ تلقائي');
  assert.strictEqual(t('commands.workbench.action.quit'), 'خروج');
  assert.strictEqual(t('welcome.openProject'), 'فتح مشروع');
  assert.strictEqual(t('welcome.recentProjects'), 'المشاريع الأخيرة');
  assert.strictEqual(t('welcome.tryNewWindow'), 'جرّب نافذة جديدة للعمل على عدة تطبيقات بالتوازي');
  console.log('  ✓ [Test 6] Dropdown commands & Welcome screen translations');

  console.log('\n  All i18n layer tests passed! (6/6)\n');
}

runTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
