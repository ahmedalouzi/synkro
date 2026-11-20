import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DOCTOR_FIX_URLS, DOCTOR_MAIN_FIXES, evaluateDoctor, type DoctorCheck, type DoctorProbes } from '@peep/shared';
import { parseRegDword, runDoctor, doctorHosts } from '../../../apps/desktop/src/main/services/doctor-service';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const GB = 1024 ** 3;

const healthy: DoctorProbes = {
  platform: 'win32',
  flutter: { version: '3.24.3', sdkPath: 'C:\\src\\flutter' },
  git: 'git version 2.46.0.windows.1',
  node: 'v20.17.0',
  developerMode: true,
  longPathsEnabled: true,
  homeDir: 'C:\\Users\\sam',
  pubCacheSet: false,
  freeBytes: 120 * GB,
  network: { 'pub.dev': true, 'registry.npmjs.org': true, 'api.atomvs.com': true },
  project: { path: 'C:\\dev\\shop', framework: 'flutter', depsInstalled: true },
  env: {},
};
const byId = (checks: DoctorCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

export default async function runTest() {
  console.log('  [doctor] A healthy Windows machine: every check OK...');
  const ok = evaluateDoctor(healthy);
  assert.deepEqual(ok.map((c) => c.status), Array(ok.length).fill('ok'), JSON.stringify(ok));
  assert.equal(ok.length, 11);

  console.log('  [doctor] The common new-user problems, each with its safe fix...');
  const bad = byId(evaluateDoctor({
    ...healthy,
    flutter: { version: '3.24.3', sdkPath: 'C:\\Users\\Sam Lee\\OneDrive\\flutter' },
    git: null,
    node: 'v16.20.0',
    developerMode: false,
    longPathsEnabled: false,
    homeDir: 'C:\\Users\\Sam Lee',
    freeBytes: 3.2 * GB,
    network: { 'pub.dev': false, 'registry.npmjs.org': true, 'api.atomvs.com': false },
    project: { path: 'C:\\Users\\Sam Lee\\OneDrive\\shop', framework: 'react-native', depsInstalled: false },
  }));
  assert.deepEqual(bad['flutter-sdk-location'], { id: 'flutter-sdk-location', status: 'warn', params: { reason: 'synced', folder: 'OneDrive', path: 'C:\\Users\\Sam Lee\\OneDrive\\flutter' }, fix: 'open-sdk-settings' });
  assert.deepEqual(bad.git, { id: 'git', status: 'fail', fix: 'install-git' });
  assert.deepEqual(bad.node, { id: 'node', status: 'fail', params: { version: 'v16.20.0' }, fix: 'install-node' });
  assert.equal(bad['windows-developer-mode'].fix, 'open-developer-settings');
  assert.equal(bad['windows-long-paths'].fix, 'long-paths-guide');
  assert.deepEqual(bad['home-path'], { id: 'home-path', status: 'warn', params: { path: 'C:\\Users\\Sam Lee' } });
  assert.deepEqual(bad['disk-space'], { id: 'disk-space', status: 'fail', params: { gb: 3.2 } });
  assert.deepEqual(bad.network, { id: 'network', status: 'fail', params: { hosts: 'pub.dev, api.atomvs.com' }, fix: 'retry' });
  assert.deepEqual(bad['project-location'], { id: 'project-location', status: 'warn', params: { folder: 'OneDrive' } });
  assert.deepEqual(bad['project-deps'], { id: 'project-deps', status: 'warn', params: { framework: 'react-native' }, fix: 'install-project-deps' });

  console.log('  [doctor] Flutter vs Expo: a missing tool fails only for the project that needs it...');
  const expoOnly = byId(evaluateDoctor({ ...healthy, flutter: null, project: { path: 'C:\\dev\\a', framework: 'react-native', depsInstalled: true } }));
  assert.equal(expoOnly['flutter-sdk'].status, 'warn');
  assert.equal(expoOnly['flutter-sdk-location'].status, 'skip');
  assert.equal(byId(evaluateDoctor({ ...healthy, flutter: null }))['flutter-sdk'].status, 'fail', 'a Flutter project without Flutter');
  assert.equal(byId(evaluateDoctor({ ...healthy, node: null }))['node'].status, 'warn', 'Node only matters to Expo');
  assert.deepEqual(byId(evaluateDoctor({ ...healthy, node: null, project: { path: 'C:\\a', framework: 'react-native', depsInstalled: true } })).node,
    { id: 'node', status: 'fail', fix: 'install-node' });
  assert.equal(byId(evaluateDoctor({ ...healthy, flutter: { version: '3.24.3', sdkPath: 'C:\\Program Files\\flutter' } }))['flutter-sdk-location'].params?.reason, 'characters');
  assert.equal(byId(evaluateDoctor({ ...healthy, homeDir: 'C:\\Users\\Sam Lee', pubCacheSet: true }))['home-path'].status, 'ok', 'PUB_CACHE moves the cache');
  assert.equal(byId(evaluateDoctor({ ...healthy, freeBytes: 8 * GB }))['disk-space'].status, 'warn');

  console.log('  [doctor] Not Windows, no project: the Windows and project checks are skipped...');
  const mac = byId(evaluateDoctor({ ...healthy, platform: 'darwin', developerMode: null, longPathsEnabled: null, homeDir: '/Users/sam lee', project: null }));
  for (const id of ['windows-developer-mode', 'windows-long-paths', 'home-path', 'project-location', 'project-deps']) assert.equal(mac[id].status, 'skip', id);

  console.log('  [doctor] Gathering: read-only commands, no shell, two registry values, the open project...');
  assert.equal(parseRegDword('\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\...\r\n    LongPathsEnabled    REG_DWORD    0x1\r\n', 'LongPathsEnabled'), true);
  assert.equal(parseRegDword('    LongPathsEnabled    REG_DWORD    0x0', 'LongPathsEnabled'), false);
  assert.equal(parseRegDword('ERROR: The system was unable to find the specified registry key or value.', 'AllowDevelopmentWithoutDevLicense'), false);
  assert.equal(parseRegDword(null, 'LongPathsEnabled'), null);
  assert.deepEqual(Object.keys(doctorHosts('https://api.atomvs.com')), ['pub.dev', 'registry.npmjs.org', 'api.atomvs.com']);
  assert.deepEqual(Object.keys(doctorHosts('')), ['pub.dev', 'registry.npmjs.org']);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-'));
  try {
    fs.writeFileSync(path.join(tmp, 'pubspec.yaml'), 'name: x\n');
    const calls: string[] = [];
    const pinged: string[] = [];
    const report = await runDoctor({
      detectFlutter: async () => ({ version: '3.24.3', path: 'PATH' }),
      gatewayUrl: 'https://api.atomvs.com',
      projectPath: tmp,
      platform: 'win32',
      env: { PUB_CACHE: 'C:\\pub-cache' },
      run: async (file, args) => {
        calls.push([file, ...args].join(' '));
        if (file === 'git') return 'git version 2.46.0.windows.1';
        if (file === 'node') return null;
        if (args.includes('LongPathsEnabled')) return '    LongPathsEnabled    REG_DWORD    0x0';
        return '    AllowDevelopmentWithoutDevLicense    REG_DWORD    0x1';
      },
      ping: async (url) => { pinged.push(url); return true; },
    });
    const r = byId(report.checks);
    assert.deepEqual(calls.sort(), [
      'git --version',
      'node --version',
      'reg query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock /v AllowDevelopmentWithoutDevLicense',
      'reg query HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem /v LongPathsEnabled',
    ], 'only version and read-only registry queries');
    assert.deepEqual(pinged.sort(), ['https://api.atomvs.com/', 'https://pub.dev/', 'https://registry.npmjs.org/']);
    assert.equal(r['flutter-sdk-location'].status, 'skip', 'Flutter from PATH: no folder to check');
    assert.equal(r['windows-developer-mode'].status, 'ok');
    assert.equal(r['windows-long-paths'].status, 'warn');
    assert.equal(r['home-path'].status, 'ok', 'PUB_CACHE set');
    assert.equal(r['project-deps'].status, 'warn', 'no .dart_tool yet');
    assert.equal(r['project-deps'].params?.framework, 'flutter');
    assert.equal(typeof r['disk-space'].params?.gb, 'number');
    fs.mkdirSync(path.join(tmp, '.dart_tool'));
    fs.writeFileSync(path.join(tmp, '.dart_tool', 'package_config.json'), '{}');
    const unset = byId((await runDoctor({
      detectFlutter: async () => null, gatewayUrl: '', projectPath: null, platform: 'win32', env: {},
      run: async (file) => (file === 'reg' ? null : 'x 1.0'), ping: async () => true,
    })).checks);
    assert.equal(unset['windows-developer-mode'].status, 'warn', 'value not set (reg fails) = off');
    assert.equal(unset['windows-developer-mode'].fix, 'open-developer-settings');
    const after = byId((await runDoctor({ detectFlutter: async () => null, gatewayUrl: '', projectPath: tmp, platform: 'linux', run: async () => null, ping: async () => false })).checks);
    assert.equal(after['project-deps'].status, 'ok');
    assert.equal(after.network.status, 'fail');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const service = read('apps/desktop/src/main/services/doctor-service.ts');
  assert.doesNotMatch(service, /shell:\s*true|(?<!\.)\bexec\(|execSync|spawn\(/, 'execFile only, never a shell');
  assert.doesNotMatch(service, /reg', \['(add|delete)/, 'the registry is only read');

  console.log('  [doctor] Fixes: an allow-list of ids, actions fixed in the main process, no admin, no killing...');
  assert.deepEqual([...DOCTOR_MAIN_FIXES].sort(), ['install-git', 'install-node', 'install-project-deps', 'long-paths-guide', 'open-developer-settings']);
  for (const url of Object.values(DOCTOR_FIX_URLS)) assert.match(url, /^https:\/\/(git-scm\.com|nodejs\.org|learn\.microsoft\.com)\//);
  const ipc = read('apps/desktop/src/main/ipc/index.ts');
  const handler = ipc.slice(ipc.indexOf('IPC_CHANNELS.DOCTOR_FIX'), ipc.indexOf('IPC_CHANNELS.DOCTOR_FIX') + 1600);
  assert.match(handler, /if \(!DOCTOR_MAIN_FIXES\.includes\(fix\)\) throw new Error\('Unknown Doctor fix'\);/);
  assert.match(handler, /shell\.openExternal\('ms-settings:developers'\)/);
  assert.match(handler, /const project = openProject\(projectPath \?\? ''\);/, 'only the open project');
  assert.match(handler, /openExternalSafely\(DOCTOR_FIX_URLS\[fix\]\)/);
  assert.doesNotMatch(handler, /taskkill|kill\(|runas|reg add|Start-Process|-Verb/i);
  assert.match(ipc, /IPC_CHANNELS\.DOCTOR_RUN, async \(_event, projectPath\?: string\) => runDoctor\(\{[\s\S]{0,200}projectPath: projectPath \? openProject\(projectPath\) : null/);

  console.log('  [doctor] Every message in en / ar / tr, for every check, status and fix...');
  const produced = new Set<string>();
  const variants: DoctorProbes[] = [
    healthy,
    { ...healthy, flutter: null, git: null, node: null, developerMode: false, longPathsEnabled: false, homeDir: 'C:\\Users\\A B', freeBytes: GB, network: { x: false }, project: { path: 'C:\\OneDrive\\p', framework: 'flutter', depsInstalled: false } },
    { ...healthy, flutter: { version: '1', sdkPath: 'C:\\OneDrive\\f' }, node: 'v16.0.0', freeBytes: 7 * GB, project: { path: 'C:\\p', framework: 'react-native', depsInstalled: false } },
    { ...healthy, flutter: { version: '1', sdkPath: 'C:\\Program Files\\f' }, node: null, project: { path: 'C:\\p', framework: 'react-native', depsInstalled: true } },
    { ...healthy, platform: 'linux', developerMode: null, longPathsEnabled: null, freeBytes: null, project: null },
  ];
  const fixes = new Set<string>(['open-sdk-settings', 'retry', ...DOCTOR_MAIN_FIXES]);
  for (const v of variants) {
    for (const c of evaluateDoctor(v)) {
      const variant = c.params?.reason ? `${c.status}_${c.params.reason}` : c.id === 'node' && c.status === 'fail' && !c.params?.version ? 'fail_missing' : c.status;
      produced.add(`${c.id}.${variant}`);
      if (c.fix) assert.ok(fixes.has(c.fix), c.fix);
    }
  }
  const section = read('apps/desktop/src/renderer/src/features/settings/DoctorSection.tsx');
  assert.ok(section.includes("c.params?.reason ? `${c.status}_${c.params.reason}` : c.id === 'node' && c.status === 'fail' && !c.params?.version ? 'fail_missing' : c.status"),
    'the window picks the message the same way as this test');
  for (const lang of ['en', 'ar', 'tr']) {
    const d = JSON.parse(read(`apps/desktop/src/renderer/src/i18n/locales/${lang}.json`)).settings;
    assert.ok(d.sections.doctor, `${lang}: nav label`);
    for (const key of ['title', 'intro', 'run', 'running', 'fixing', 'fixFailed']) assert.ok(d.doctor[key], `${lang}: doctor.${key}`);
    for (const s of ['ok', 'warn', 'fail', 'skip']) assert.ok(d.doctor.status[s], `${lang}: status.${s}`);
    for (const f of fixes) assert.ok(d.doctor.fix[f], `${lang}: fix.${f}`);
    for (const key of produced) {
      const [id, variant] = key.split('.');
      if (variant === 'skip' && !d.doctor.checks[id]?.skip) assert.fail(`${lang}: checks.${id}.skip`);
      assert.ok(d.doctor.checks[id]?.title, `${lang}: checks.${id}.title`);
      assert.ok(d.doctor.checks[id]?.[variant], `${lang}: checks.${key}`);
    }
  }
  console.log('  🟢 Passed');
}
