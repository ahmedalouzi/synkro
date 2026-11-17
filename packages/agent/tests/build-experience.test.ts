import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  BUILD_STAGES,
  buildStage,
  completedSteps,
  estimateProgress,
  failureKind,
  type BuildStage,
} from '../../../apps/desktop/src/renderer/src/features/build/build-progress';

/**
 * The full-screen build experience's logic (apps/desktop/.../build-progress.ts): friendly stages from the "[STEP]"
 * lines, a progress estimate that never goes backwards or stands still, the failure explanations, and the texts in
 * every language. No React, no DOM.
 */
const running = { status: 'running' as const };
const log = (...lines: string[]) => lines.join('\n') + '\n';

export default async function run() {
  console.log('  [experience] [STEP] lines are read...');
  assert.deepEqual(completedSteps(log('noise', '[STEP] npm install 1m42s', '[SYSTEM] x', '[STEP] gradle (flutter build apk) 12m05s')), ['npm install', 'gradle (flutter build apk)']);
  assert.deepEqual(completedSteps(undefined), []);
  assert.deepEqual(completedSteps('[STEP] npm install'), [], 'only finished steps (with a time) count');

  console.log('  [experience] Stages follow the build, React Native and Flutter...');
  assert.equal(buildStage({ status: 'queued' }, undefined), 'preparing', 'queued: preparing, no queue number');
  assert.equal(buildStage(running, ''), 'installing');
  assert.equal(buildStage(running, log('[STEP] npm install 0m41s')), 'installing');
  assert.equal(buildStage(running, log('[STEP] npm install 0m41s', '[STEP] expo prebuild 0m38s')), 'compiling');
  assert.equal(buildStage(running, log('[STEP] expo prebuild 0m38s', '> Task :app:packageRelease')), 'signing');
  assert.equal(buildStage(running, log('[STEP] expo prebuild 0m38s', '[STEP] gradle 5m12s')), 'signing');
  assert.equal(buildStage(running, log('[STEP] gradle 5m12s', '[STEP] total 6m44s')), 'finishing');
  assert.equal(buildStage(running, log('[STEP] flutter create 0m20s')), 'compiling');
  assert.equal(buildStage(running, log('[STEP] flutter create 0m20s', '[STEP] gradle (flutter build apk) 9m00s')), 'signing');

  console.log('  [experience] Progress never goes backwards, never stands still, stays under 100% until success...');
  const at = (stage: BuildStage, seconds: number, previous = 0, queueEtaSeconds?: number | null) =>
    estimateProgress({ stage, stageElapsedSeconds: seconds, framework: 'react-native', previous, queueEtaSeconds });
  let prev = 0;
  for (const stage of BUILD_STAGES) {
    for (const s of [0, 5, 30, 120, 600, 3600]) {
      const p = at(stage, s, prev);
      assert.ok(p >= prev, `${stage} @${s}s went backwards`);
      assert.ok(p <= 0.99, `${stage} @${s}s reached 100% before success`);
      prev = p;
    }
  }
  // A compile that runs far longer than usual still creeps forward.
  assert.ok(at('compiling', 1210) > at('compiling', 1200), 'never stuck');
  // A stage never fills the next stage's share before that stage starts.
  assert.ok(at('installing', 100_000) < at('compiling', 0) + 1e-9);
  // A slow earlier estimate is not undone by a new stage that starts lower.
  assert.equal(at('compiling', 0, 0.5), 0.5);
  // Queued: a longer wait (server ETA) fills the first slice more slowly.
  assert.ok(at('preparing', 60, 0, 30 * 60) < at('preparing', 60, 0, null));

  console.log('  [experience] A failed build gets a short human explanation...');
  assert.equal(failureKind("[SYSTEM] The build ran out of disk space on our server; we've been notified."), 'disk');
  assert.equal(failureKind('npm error code ERESOLVE'), 'dependencies');
  assert.equal(failureKind('[SYSTEM] Build timed out after 2100s. Terminating container...'), 'timeout');
  assert.equal(failureKind('[ERROR] FAILURE: Build failed with an exception.'), 'generic');
  assert.equal(failureKind(undefined), 'generic');

  console.log('  [experience] Every text exists in en, ar and tr...');
  const keys = [
    ...BUILD_STAGES.map((s) => `stage.${s}`),
    ...(['generic', 'disk', 'dependencies', 'timeout'] as const).map((k) => `failed.${k}`),
    'stepsLabel', 'hint', 'continueWorking', 'reopen', 'cancel', 'cancelConfirm', 'cancelYes', 'cancelNo',
    'successTitle', 'successSubtitle', 'failedTitle', 'viewDetails', 'hideDetails', 'copy', 'copied', 'close',
  ];
  for (const lang of ['en', 'ar', 'tr']) {
    const dict = JSON.parse(fs.readFileSync(new URL(`../../../apps/desktop/src/renderer/src/i18n/locales/${lang}.json`, import.meta.url), 'utf8'));
    for (const key of keys) {
      const value = key.split('.').reduce((o: any, k) => o?.[k], dict.buildFlow);
      assert.equal(typeof value, 'string', `${lang}: buildFlow.${key} is missing`);
      assert.ok(!/#\{?position|in the queue/i.test(value), `${lang}: no queue position is shown`);
    }
    assert.equal(dict.build.queuePosition, undefined, `${lang}: the old "#N in the queue" text is gone`);
  }

  console.log('  🟢 Build experience tests passed.');
}
