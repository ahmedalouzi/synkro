import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  failureFingerprint, failureTags, reportFailure, scrubEvent, scrubString, setFailureReporter, type FailureReport,
} from '@peep/shared';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

export default async function runTest() {
  console.log('  [errors] Scrubbing: secrets, e-mails and local paths never leave the machine...');
  const cases: Array<[string, RegExp, string]> = [
    ['Error at C:\\Users\\Sam Lee\\AppData\\Local\\Atomvs\\shop\\lib\\main.dart:12', /Sam|Lee|shop|AppData/, '[REDACTED]/main.dart:12'],
    ["ENOENT: open '/Users/sam/dev/shop/pubspec.yaml'", /sam|shop/, '[REDACTED]/pubspec.yaml'],
    ['/home/synkro/secrets/keys/keystore.jks failed to load', /synkro|secrets/, '[REDACTED]/keystore.jks'],
    ['fetch https://user:hunter2@api.example.com/v1?token=abc123&x=1 failed', /hunter2|abc123/, 'https://[REDACTED]@'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.abcdefghijkl', /eyJ/, 'Bearer [REDACTED]'],
    ['Cookie: session_token=abcd1234efgh5678', /abcd1234/, 'session_token=[REDACTED]'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3OCJ9.abcdefghijkl here', /eyJ/, '[REDACTED_JWT]'],
    ['key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa end', /sk-ant/, '[REDACTED_API_KEY]'],
    ['key sk-abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234 end', /sk-abcd/, '[REDACTED_API_KEY]'],
    ['Gemini AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p67', /AIza/, '[REDACTED_API_KEY]'],
    ['push ghp_abcdefghijklmnopqrstuvwxyz0123456789 denied', /ghp_/, '[REDACTED_TOKEN]'],
    ['stripe sk_live_abcdefghijklmnop', /sk_live/, '[REDACTED_API_KEY]'],
    ['aws AKIAABCDEFGHIJKLMNOP', /AKIAA/, '[REDACTED_KEY_ID]'],
    ['contact sam@example.com', /sam@/, '[EMAIL]'],
    ['{"password": "s3cret!", "name": "ok"}', /s3cret/, '"password": "[REDACTED]'],
    ['SENTRY_DSN=https://abc@o1.ingest.sentry.io/2', /abc@/, 'SENTRY_DSN=[REDACTED]'],
    ['-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----', /MIIEv/, '[REDACTED_PRIVATE_KEY]'],
  ];
  for (const [input, gone, kept] of cases) {
    const out = scrubString(input);
    assert.doesNotMatch(out, gone, `${input} → ${out}`);
    assert.ok(out.includes(kept), `${input} → ${out} (expected ${kept})`);
  }
  // What helps fix a failure stays readable.
  for (const plain of [
    'Gradle task :app:compileReleaseKotlin FAILED (exit 1) in lib/screens/home.dart',
    'see https://docs.flutter.dev/get-started/install/windows',
  ]) assert.equal(scrubString(plain), plain);
  assert.equal(scrubString(''), '');
  assert.equal(scrubString(undefined), undefined);

  console.log('  [errors] A whole event: request body, cookies, auth headers, user and machine name removed...');
  const event: any = scrubEvent({
    server_name: 'SAMS-PC',
    user: { id: 7, email: 'a@b.co', ip_address: '1.2.3.4' },
    request: { url: 'https://api.atomvs.com/v1/x?session=1', query_string: 'session=1', headers: { authorization: 'Bearer x', Cookie: 'a=b', 'content-type': 'json' }, data: '{"code":"…"}', cookies: { a: 'b' } },
    exception: { values: [{ value: 'at C:\\Users\\Bob\\x\\y.ts', stacktrace: { frames: [{ filename: 'C:\\Users\\Bob\\app\\main.js', abs_path: '/home/bob/app/main.js', vars: { secret: 1 } }] } }] },
    breadcrumbs: [{ message: 'open /Users/bob/p/a.ts', data: { nested: { token: 'token=zzz' } } }],
    extra: { log: 'api_key: zzz123' },
    contexts: { os: { name: 'Windows', build: 'C:\\Users\\Bob\\thing\\x.exe' } },
  });
  const json = JSON.stringify(event);
  for (const gone of ['SAMS-PC', 'a@b.co', '1.2.3.4', 'Bearer x', 'a=b', 'code', 'Bob', 'bob', 'zzz', 'session=1', '"vars"']) {
    assert.ok(!json.includes(gone), `${gone} left in ${json}`);
  }
  assert.equal(event.user, undefined);
  assert.equal(event.request.headers['content-type'], 'json');
  assert.equal(event.request.url, 'https://api.atomvs.com/v1/x');
  assert.equal(event.exception.values[0].stacktrace.frames[0].filename, '[REDACTED]/main.js');

  console.log('  [errors] Reports: fixed tags and grouping; no reporter or a failing one never throws...');
  const report: FailureReport = { category: 'cloud-build', title: 'Build failed', framework: 'flutter', stage: 'gradle' };
  assert.deepEqual(failureTags(report, { appVersion: '0.1.3', os: 'win32 10.0.26200 x64' }), {
    category: 'cloud-build', framework: 'flutter', stage: 'gradle', app_version: '0.1.3', os: 'win32 10.0.26200 x64',
  });
  assert.deepEqual(failureFingerprint({ category: 'agent-tool', title: 'Tool crashed' }), ['agent-tool', 'none', 'none', 'Tool crashed']);
  setFailureReporter(null);
  reportFailure(report);
  const seen: FailureReport[] = [];
  setFailureReporter((r) => { seen.push(r); throw new Error('reporter down'); });
  assert.doesNotThrow(() => reportFailure(report));
  assert.equal(seen.length, 1);
  setFailureReporter(null);

  console.log('  [errors] A failed Cloud Build reports its last step and first error line, never the log...');
  const { buildFailureFacts } = await import('../src/models/build-worker');
  const log = [
    '[STEP] npm install 1m42s',
    '[STEP] expo prebuild 0m31s',
    '> Task :app:compileReleaseKotlin FAILED',
    'e: /build/android/app/src/main/java/com/sam/shop/MainActivity.kt: Unresolved reference',
    'FAILURE: Build failed with an exception. token=abc123 at /home/sam/secret/x.gradle',
    'secret source line',
  ].join('\n');
  const facts = buildFailureFacts(log);
  assert.equal(facts.lastStep, 'expo prebuild');
  assert.match(facts.errorLine, /^FAILURE: Build failed with an exception\./);
  assert.doesNotMatch(facts.errorLine, /abc123|sam|secret/);
  assert.deepEqual(buildFailureFacts(''), { lastStep: 'none', errorLine: '' });
  assert.ok(buildFailureFacts(`error: ${'x'.repeat(500)}`).errorLine.length <= 200);

  console.log('  [errors] Wiring: desktop and server send reports through the shared scrubber, and only when allowed...');
  const main = read('apps/desktop/src/main/index.ts');
  assert.match(main, /beforeSend\(event[^)]*\)\s*{\s*if \(!telemetryEnabled\) return null;\s*return scrubEvent\(event/);
  assert.match(main, /setFailureReporter\(/);
  // Off stops ALL sending: a gate on the transport (sessions, minidumps and window envelopes skip beforeSend), no disk
  // queue that would send old events at the next start, and an older version's queue deleted.
  assert.match(main, /send: \(envelope\) => \(telemetryEnabled \? net\.send\(envelope\) : Promise\.resolve\(\{\}\)\)/);
  assert.match(main, /Sentry\.makeElectronTransport\(options\)/);
  assert.doesNotMatch(main, /makeElectronOfflineTransport/);
  assert.match(main, /rmSync\(join\(app\.getPath\('userData'\), 'sentry', 'queue'\)/);
  // The DSN comes from the environment or the build config, never from the repo.
  assert.match(main, /dsn: resolveSentryDsn\(\)/);
  assert.match(read('apps/desktop/src/main/build-config.ts'), /return process\.env\.SENTRY_DSN \|\| BAKED_SENTRY_DSN;/);
  for (const rel of ['apps/desktop/src/main/index.ts', 'apps/desktop/src/main/build-config.ts', 'apps/desktop/electron.vite.config.ts', 'apps/server/src/index.ts', '.env.example', 'apps/desktop/.env.production.example']) {
    assert.doesNotMatch(read(rel), /https?:\/\/[0-9a-f]{16,}@[\w.-]*sentry\.io/, `${rel}: no DSN in the repo`);
  }
  const renderer = read('apps/desktop/src/renderer/src/main.tsx');
  assert.match(renderer, /beforeSend: \(event[^)]*\) => scrubEvent\(event/);
  const server = read('apps/server/src/index.ts');
  assert.match(server, /beforeSend: \(event\) => scrubEvent\(event\)/);
  assert.match(server, /setFailureReporter\(/);
  assert.doesNotMatch(read('packages/agent/src/models/backend-gateway.ts'), /@sentry\/electron/, 'the server never loads the Electron SDK');
  const worker = read('packages/agent/src/models/build-worker.ts');
  for (const stage of ['extract', 'signing-key', 'signing-check', 'upload', 'artifact', 'build']) {
    assert.match(worker, new RegExp(`stage: '${stage}'`), `a failed build at ${stage} is reported`);
  }
  assert.match(read('apps/desktop/src/main/services/preview-manager.ts'), /reportFailure\(\{ category: 'preview'/);
  assert.match(read('packages/agent/src/orchestrator.ts'), /reportFailure\(\{ category: 'agent-tool'/);

  console.log('  [errors] Settings and the onboarding consent in en / ar / tr: what is sent, what never is, the policy...');
  for (const lang of ['en', 'ar', 'tr']) {
    const t = JSON.parse(read(`apps/desktop/src/renderer/src/i18n/locales/${lang}.json`));
    assert.ok(t.settings.privacy.title && t.settings.privacy.desc && t.settings.privacy.learnMore, `${lang}: privacy strings`);
    for (const k of ['consentTitle', 'consentSends', 'consentNever', 'consentPolicy', 'consentAllow', 'consentNotNow']) {
      assert.ok(t.onboarding[k], `${lang}: onboarding.${k}`);
    }
    assert.match(t.onboarding.consentPolicy, /atomvs\.com\/privacy/);
    assert.equal(t.onboarding.enableAnalyticsDesc, undefined, `${lang}: the old "stored locally only" text is gone`);
  }
  // No dark pattern: Allow and Not now are the same button, nothing is preselected, reports start off.
  const wizard = read('apps/desktop/src/renderer/src/features/onboarding/OnboardingWizard.tsx');
  const choices = [...wizard.matchAll(/<button type="button" className="([^"]+)" onClick=\{\(\) => \{ setTelemetryChoice\((true|false)\); setStep\('done'\); \}\}>/g)];
  assert.deepEqual(choices.map((m) => m[2]), ['true', 'false']);
  assert.equal(choices[0][1], choices[1][1], 'Allow and Not now share one style');
  assert.match(wizard, /useState<boolean \| null>\(null\)/, 'nothing preselected');
  assert.match(wizard, /openWebPage\('privacy'\)/);
  assert.match(read('apps/desktop/src/main/services/telemetry-service.ts'), /disabled by default/);
  console.log('  🟢 Passed');
}
