import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { IPC_EVENTS } from '@peep/shared';
import { alwaysAllowKeyOf, classifyCommand, isSafeCommand, packagesAdded, staysInProject } from '../src/tools/safety';
import { runAgentLoop } from '../src/orchestrator';
import { MockAIGateway } from '../src/models/mock-gateway';
import type { AgentTimelineActivity } from '@peep/shared';
import { ApprovalService, ApprovalStore } from '../../../apps/desktop/src/main/services/approval-service';
import { TerminalService } from '../../../apps/desktop/src/main/services/terminal-service';

/**
 * Approvals: in v0.1.x main sent agent:confirm-command and nothing in the window listened, so every command off the
 * safe list (and every delete_file) waited 60 s and was then refused. Now: everyday mobile-dev commands run without
 * asking; the rest ask in an approval card until the user answers (no timeout); blocked ones never ask; both
 * permission layers make the same decision. The window round-trip is in approval-ipc.test.ts.
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');

export default async function run() {
  console.log('  [approval] Everyday mobile-dev commands run without asking...');
  const scripts = { start: 'expo start', test: 'jest', lint: 'eslint .', build: 'tsc', android: 'expo run:android', nuke: 'rm -rf node_modules', kill: 'taskkill /IM node.exe /F', gen: 'node scripts/gen.js' };
  for (const command of [
    'flutter pub get', 'flutter pub add http', 'flutter pub upgrade', 'flutter analyze', 'flutter test', 'flutter build apk', 'flutter run -d chrome',
    'flutter clean', 'flutter doctor', 'flutter --version', 'dart format .', 'dart fix --apply', 'dart pub get', 'dart analyze',
    'npm install', 'npm i axios', 'npm ci', 'npm uninstall left-pad', 'npm ls --depth=0', 'pnpm add zod', 'yarn add zod', 'yarn',
    'npx expo install expo-router', 'npx expo install --check', 'npx expo start --web', 'npx expo-doctor', 'npx tsc --noEmit',
    'npm run lint', 'npm test', 'npm start', 'npm run android', 'pnpm build', 'yarn start',
    'git status', 'git diff', 'git log --oneline -5', 'git add .', 'git commit -m "fix: shutdown dialog"', 'git branch feature/x', 'git stash',
    'ls', 'dir', 'pwd', 'echo hello', 'mkdir lib/screens', 'adb devices', 'emulator -list-avds', 'pod install',
  ]) {
    assert.equal(classifyCommand(command, { scripts }).level, 'safe', command);
  }

  console.log('  [approval] ...the rest asks, with "always allow" only where it is not risky...');
  const asks: [string, string | null][] = [
    ['npm install --legacy-peer-deps', null], ['npm i -g eas-cli', null], ['npm install --force', null],
    ['git push', null], ['git checkout -- .', null], ['git branch -D old', null], ['git stash drop', null], ['git reset --hard', null],
    ['rm -rf build', null], ['del /q /s build', null], ['Remove-Item -Recurse build', null],
    ['node scripts/gen.js', null], ['python tool.py', null], ['cmd /c dir', null], ['powershell -c ls', null], ['npx some-package', null],
    ['npm run nuke', null], ['npm run gen', null],
    ['flutter pub get && flutter test', null], ['echo x > lib/a.dart', null],
    ['taskkill /PID 4242 /F', null],
    ['git checkout main', 'git checkout'], ['git merge dev', 'git merge'], ['adb install app.apk', 'adb install'],
    ['./gradlew assembleDebug', 'gradlew assembleDebug'], ['flutter pub run build_runner build', 'flutter pub run'],
    ['dart run build_runner build', 'dart run build_runner'], ['npm run missing-script', 'npm run missing-script'],
    ['cp a.txt b.txt', 'cp'], ['eas build -p android', 'eas build'],
  ];
  for (const [command, key] of asks) {
    const r = classifyCommand(command, { scripts, ownPids: new Set([4242]) });
    assert.equal(r.level, 'dangerous', command);
    assert.equal(r.alwaysAllowKey, key, `always-allow key: ${command}`);
    assert.ok(r.reason && r.reason.length > 10, `a reason: ${command}`);
  }
  assert.equal(classifyCommand('git checkout main', { alwaysAllowed: new Set(['git checkout']) }).level, 'safe', 'always allowed in this project');
  assert.equal(classifyCommand('git checkout main', { alwaysAllowed: new Set(['git merge']) }).level, 'dangerous');
  assert.equal(classifyCommand('git checkout -- .', { alwaysAllowed: new Set(['git checkout']) }).level, 'dangerous', 'destructive forms still ask');
  assert.equal(classifyCommand('git checkout main && rm -rf .', { alwaysAllowed: new Set(['git checkout']) }).level, 'dangerous', 'chaining still asks');

  console.log('  [approval] ...and blocked never asks (no card)...');
  for (const command of ['taskkill /F /IM dart.exe', 'cmd /c "taskkill /F /IM flutter.exe /IM dart.exe 2>NUL & exit 0"', 'shutdown /s /t 0',
    'format c:', 'flutter pub get; shutdown /r', 'npm run kill', 'pkill dart']) {
    assert.equal(classifyCommand(command, { scripts }).level, 'blocked', command);
  }
  assert.match(classifyCommand('npm run kill', { scripts }).reason!, /The "kill" script runs: taskkill/);
  assert.ok(!isSafeCommand('flutter pub get & del x'), 'operators are never safe');
  assert.equal(alwaysAllowKeyOf('npx expo install x'), null, 'npx can run any package');

  console.log('  [approval] Read-only commands are safe only inside the project; a path outside asks...');
  for (const command of ['type C:\\Users\\x\\.ssh\\id_rsa', 'cat ~/.ssh/id_rsa', 'cat ../secrets.env', 'type ..\\..\\.env',
    'type %USERPROFILE%\\.npmrc', 'cat $HOME/.bashrc', 'type $env:APPDATA\\x', 'ls /etc', 'cat /a', 'dir \\\\server\\share',
    'dir C:\\', 'ls lib/../..', 'cat --file=../x', 'echo %PATH%', 'mkdir ..\\outside', 'tree D:\\']) {
    const r = classifyCommand(command);
    assert.equal(r.level, 'dangerous', `a card: ${command}`);
    assert.equal(staysInProject('C:\\x'), false);
  }
  for (const command of ['dir', 'dir /s /b', 'dir lib /s', 'ls -la', 'ls lib', 'cat lib/main.dart', 'type lib\\main.dart', 'tree lib',
    'mkdir lib/screens', 'echo hello', 'cat "lib/a b.dart"', 'cat pubspec.yaml', 'pwd']) {
    assert.equal(classifyCommand(command).level, 'safe', `no card: ${command}`);
  }
  assert.equal(staysInProject('/s', 'dir'), true, 'a dir switch');
  assert.equal(staysInProject('/s', 'cat'), false, 'for cat, /s is a path');

  console.log('  [approval] New packages need no card, but the chat lists each one...');
  assert.deepEqual(packagesAdded('npm install axios zod@3'), ['axios', 'zod@3']);
  assert.deepEqual(packagesAdded('npm i -D @types/node'), ['@types/node']);
  assert.deepEqual(packagesAdded('pnpm add react-native-svg'), ['react-native-svg']);
  assert.deepEqual(packagesAdded('yarn add lodash'), ['lodash']);
  assert.deepEqual(packagesAdded('flutter pub add http dev:build_runner'), ['http', 'dev:build_runner']);
  assert.deepEqual(packagesAdded('dart pub add provider'), ['provider']);
  assert.deepEqual(packagesAdded('npx expo install expo-camera expo-image'), ['expo-camera', 'expo-image']);
  for (const command of ['npm install', 'npm ci', 'flutter pub get', 'npx expo install --check', 'npx expo install --fix', 'npm uninstall x', 'npm install a && rm -rf .']) {
    assert.deepEqual(packagesAdded(command), [], command);
  }
  for (const command of ['npm install axios', 'flutter pub add http', 'npx expo install expo-camera']) {
    assert.equal(classifyCommand(command).level, 'safe', command);
  }
  {
    const gateway = new MockAIGateway();
    gateway.setCustomToolCall({ id: 'p1', name: 'run_command', arguments: JSON.stringify({ command: 'npx expo install expo-camera expo-image' }) });
    const activities: AgentTimelineActivity[] = [];
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'tok', gateway }, 'sys', [{ role: 'user', content: 'add the camera' }],
      { execute: async () => { gateway.setScenario('success'); return 'Command exited with code 0.\nOutput:\n› Installing 2 SDK 51.0.0 compatible native modules'; } },
      { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {}, onTimelineActivity: (a) => activities.push(a) },
      new AbortController().signal,
    );
    const done = activities.find((a) => a.type === 'running' && a.status === 'completed');
    assert.deepEqual(done?.packages, ['expo-camera', 'expo-image'], 'the chat step gets the names');
    const failed: AgentTimelineActivity[] = [];
    const gateway2 = new MockAIGateway();
    gateway2.setCustomToolCall({ id: 'p2', name: 'run_command', arguments: JSON.stringify({ command: 'npm install no-such-pkg' }) });
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'tok', gateway: gateway2 }, 'sys', [{ role: 'user', content: 'x' }],
      { execute: async () => { gateway2.setScenario('success'); return 'Command exited with code 1.\nOutput:\nnpm error 404'; } },
      { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {}, onTimelineActivity: (a) => failed.push(a) },
      new AbortController().signal,
    );
    assert.ok(failed.every((a) => !a.packages), 'nothing listed when the install failed');
  }
  // The chat step (AgentRun since the Live Demo design) lists them.
  const agentRun = fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/src/features/agent-run/AgentRun.tsx'), 'utf8');
  assert.match(agentRun, /a\.packages\?\.map\(\(name\) => [\s\S]*?t\('approval\.addedPackage', \{ name \}\)/);
  for (const lang of ['en', 'ar', 'tr']) {
    const text = JSON.parse(fs.readFileSync(path.join(root, `apps/desktop/src/renderer/src/i18n/locales/${lang}.json`), 'utf8')).approval.addedPackage;
    assert.ok(text.includes('{name}'), `${lang}: approval.addedPackage`);
  }

  console.log('  [approval] ApprovalService: waits for the answer, no timeout; Stop or a new message = no answer...');
  const sent: [string, any][] = [];
  const notified: string[] = [];
  const approvals = new ApprovalService((channel, payload) => sent.push([channel, payload]), (r) => notified.push(r.subject));
  const a = approvals.request({ kind: 'command', subject: 'git checkout main', reason: 'r', alwaysAllowKey: 'git checkout' });
  assert.equal(sent[0][0], IPC_EVENTS.AGENT_APPROVAL_REQUEST);
  assert.equal(notified[0], 'git checkout main');
  const id = sent[0][1].id;
  assert.equal(approvals.pending().length, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(approvals.pending().length, 1, 'still waiting');
  assert.equal(approvals.respond(id, 'always'), true);
  assert.equal(await a, 'always');
  assert.deepEqual(sent[1], [IPC_EVENTS.AGENT_APPROVAL_RESOLVED, { id, outcome: 'always' }]);
  assert.equal(approvals.respond(id, 'reject'), false, 'answered once only');
  const del = approvals.request({ kind: 'delete-file', subject: 'lib/a.dart', reason: '', alwaysAllowKey: null });
  const delId = approvals.pending()[0].id;
  assert.equal(approvals.respond(delId, 'always'), false, '"always" is refused where it is not offered');
  assert.equal(approvals.respond(delId, 'yes' as any), false);
  approvals.cancelAll();
  assert.equal(await del, 'no-answer');
  assert.equal(approvals.pending().length, 0);

  console.log('  [approval] "Always allow" is kept per project, outside the project...');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'approvals-'));
  try {
    const file = path.join(tmp, 'userData', 'command-approvals.json');
    const store = new ApprovalStore(file);
    const projectA = path.join(tmp, 'ProjA');
    const projectB = path.join(tmp, 'projB');
    store.allow(projectA, 'git checkout');
    store.allow(projectA, 'adb install');
    store.allow(projectA, 'git checkout');
    assert.deepEqual([...new ApprovalStore(file).allowed(projectA)].sort(), ['adb install', 'git checkout'], 'saved, once');
    assert.deepEqual([...store.allowed(projectB)], [], 'another project is not affected');
    if (process.platform === 'win32') assert.ok(store.allowed(projectA.toUpperCase()).has('git checkout'), 'Windows paths ignore case');
    fs.writeFileSync(file, '{"x": "not a list", "y": [1, "ok"]}');
    assert.deepEqual([...new ApprovalStore(file).allowed('y')], [], 'malformed entries ignored');
    fs.writeFileSync(file, 'not json');
    assert.deepEqual([...store.allowed(projectA)], []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  [approval] One decision: TerminalService runs what the agent may run, and only that...');
  const terminal = new TerminalService();
  terminal.setOwnedPidsProvider(() => [4242]);
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-term-'));
  try {
    fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts }));
    assert.equal(terminal.isCommandAllowed('npx expo install expo-router', { cwd: proj }), true, 'safe: no approval needed (was refused in v0.1.x)');
    assert.equal(terminal.isCommandAllowed('npm run lint', { cwd: proj }), true);
    assert.equal(terminal.isCommandAllowed('git checkout main', { cwd: proj }), false, 'asks first');
    assert.equal(terminal.isCommandAllowed('git checkout main', { cwd: proj, approved: true }), true, 'after the user allowed it');
    assert.equal(terminal.isCommandAllowed('taskkill /F /IM dart.exe', { cwd: proj, approved: true }), false, 'blocked even if "approved"');
    assert.equal(terminal.isCommandAllowed('npm run kill', { cwd: proj, approved: true }), false, 'a script that stops processes by name');
    assert.match(terminal.commandRejection('git checkout main', { cwd: proj })!, /needs the user's approval/);
    await assert.rejects(terminal.runCommand('git checkout main', proj), /Command not allowed: needs the user's approval/, 'the window\'s RUN_COMMAND cannot approve');
  } finally {
    fs.rmSync(proj, { recursive: true, force: true });
  }

  console.log('  [approval] The agent asks through the approval card, and nothing waits on the old dead channel...');
  const agent = fs.readFileSync(path.join(root, 'apps/desktop/src/main/services/agent-service.ts'), 'utf8');
  assert.doesNotMatch(agent, /agent:confirm-command/, 'the channel nobody listened to is gone');
  assert.doesNotMatch(agent, /setTimeout\(\(\) => resolve\((false|'timeout')\), 60000\)/, 'no silent 60 s timeout');
  assert.match(agent, /this\.approvals\?\.cancelAll\(\);/, 'Stop / a new message ends the wait');
  assert.match(agent, /kind: 'delete-file',[\s\S]*?alwaysAllowKey: null,[\s\S]*?reversible: this\.checkpoints\.recording/);
  assert.match(agent, /streamCommand\(sessionId, cmd, projectPath, \{ approved: cmd === commandStr \}\)/);
  assert.match(agent, /`Not run: the user did not answer the approval request/);
  const ipc = fs.readFileSync(path.join(root, 'apps/desktop/src/main/ipc/index.ts'), 'utf8');
  assert.match(ipc, /registerApprovalIpc\(ipcMain, approvals\)/);
  assert.match(ipc, /new ApprovalStore\(path\.join\(app\.getPath\('userData'\), 'command-approvals\.json'\)\)/);

  console.log('  🟢 Command approval tests passed.');
}
