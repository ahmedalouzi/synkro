import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The Preview pane's own box for a Flutter installation problem (SDK inside OneDrive, startup lock held outside
 * Atomvs): explanation, path, "Choose Flutter location" / Retry, and no Auto-Fix (the agent cannot fix it in code and
 * must not stop the user's processes). The detection itself is tested in flutter-sdk-environment.test.ts.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');

export default async function run() {
  console.log('  [flutter-env-ui] The pane shows installation problems without Auto-Fix, in en/ar/tr...');
  const pane = fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/src/layout/PreviewPane.tsx'), 'utf8');
  const box = pane.slice(pane.indexOf('{flutterEnvProblem ? ('), pane.indexOf(") : session?.status === 'error' && isFlutterSdkMissing"));
  assert.ok(box.includes('preview.flutterEnv.syncedBody') && box.includes('handleOpenSdkSettings') && box.includes('handleStart'));
  assert.ok(!box.includes('handleAutoHeal'), 'no Auto-Fix for an installation problem');
  for (const lang of ['en', 'ar', 'tr']) {
    const env = JSON.parse(fs.readFileSync(path.join(root, `apps/desktop/src/renderer/src/i18n/locales/${lang}.json`), 'utf8')).preview.flutterEnv;
    for (const key of ['syncedTitle', 'syncedBody', 'lockTitle', 'lockBody', 'lockSynced', 'notCode', 'openSettings', 'retry']) {
      assert.ok(typeof env[key] === 'string' && env[key].length > 0, `${lang}: preview.flutterEnv.${key}`);
    }
    assert.ok(env.syncedBody.includes('{folder}') && env.syncedBody.includes('C:\\src\\flutter'), `${lang}: syncedBody`);
  }

  console.log('  🟢 Flutter environment box tests passed.');
}
