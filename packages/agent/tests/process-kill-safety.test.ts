import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyCommand, findProcessKill, processKillPolicy } from '../src/tools/safety';
import { FLUTTER_SYSTEM_PROMPT } from '../src/prompts/flutter-system';
import { NOT_RUN, runAgentLoop } from '../src/orchestrator';
import { MockAIGateway } from '../src/models/mock-gateway';
import type { AgentTimelineActivity } from '@peep/shared';
import { TerminalService } from '../../../apps/desktop/src/main/services/terminal-service';
import { ProcessRegistry, leftoverPids, stopLeftoverProcesses } from '../../../apps/desktop/src/main/services/process-registry';

/**
 * A user's agent ran `cmd /c "taskkill /F /IM flutter.exe /IM dart.exe 2>NUL & exit 0"`: that stops every Flutter and
 * Dart process on the PC, also outside Atomvs. Commands that stop processes by name are blocked in both permission
 * layers (classifyCommand for the agent, TerminalService for every command it runs); by PID only processes Atomvs
 * started may be stopped. Atomvs's own startup no longer runs `taskkill /f /im dart.exe`: it stops only the
 * processes it recorded (process-registry.ts).
 */
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..');
const USER_COMMAND = 'cmd /c "taskkill /F /IM flutter.exe /IM dart.exe 2>NUL & exit 0"';

export default async function run() {
  console.log('  [kill-safety] Stopping processes by name is found anywhere in a command...');
  const byName = [
    USER_COMMAND,
    'taskkill /F /IM dart.exe',
    'TASKKILL /im node.exe /t',
    'taskkill /F /FI "IMAGENAME eq dart.exe"',
    '"C:\\Windows\\System32\\taskkill.exe" /im node.exe',
    'flutter --version & taskkill /F /IM dart.exe', // an allowed prefix, then a kill
    'flutter pub get && taskkill /im dart.exe',
    'dart --version; pkill -f flutter',
    'echo x | taskkill /im dart.exe',
    'pkill dart', '/usr/bin/pkill -9 node', 'killall -9 dart', 'sudo killall node', 'tskill dart',
    'kill $(pgrep dart)', 'kill `pgrep dart`', 'ps aux | grep dart | awk \'{print $2}\' | xargs kill -9',
    'Stop-Process -Name dart -Force', 'powershell -Command "Get-Process dart | Stop-Process -Force"',
    'Get-Process -Name flutter | kill', 'spps -Name node',
    'wmic process where name="dart.exe" delete', 'wmic process where "name=\'dart.exe\'" call terminate',
    'powershell "Get-CimInstance Win32_Process -Filter \\"Name=\'dart.exe\'\\" | Invoke-CimMethod -MethodName Terminate"',
    'npx kill-port 8081', 'npx -y kill-port 3000', 'pnpm dlx fkill dart', 'fuser -k 8081/tcp',
  ];
  for (const command of byName) {
    assert.equal(findProcessKill(command)?.byName, true, `by name: ${command}`);
    const c = classifyCommand(command, { ownPids: new Set([1, 2, 3]) });
    assert.equal(c.level, 'blocked', `blocked: ${command}`);
    assert.match(c.reason!, /by name .* outside Atomvs.*restart_preview/s);
  }

  console.log('  [kill-safety] ...by PID, only processes Atomvs started, and with confirmation...');
  assert.deepEqual(findProcessKill('taskkill /PID 4242 /T /F'), { byName: false, pids: [4242] });
  assert.deepEqual(findProcessKill('kill -9 10 11'), { byName: false, pids: [10, 11] });
  assert.deepEqual(findProcessKill('Stop-Process -Id 7,8 -Force'), { byName: false, pids: [7, 8] });
  const own = new Set([4242, 7, 8]);
  assert.equal(classifyCommand('taskkill /PID 4242 /T /F', { ownPids: own }).level, 'dangerous', 'Atomvs\'s own: ask the user');
  assert.equal(classifyCommand('Stop-Process -Id 7,8 -Force', { ownPids: own }).level, 'dangerous');
  const foreign = classifyCommand('taskkill /PID 4242 /PID 999 /F', { ownPids: own });
  assert.equal(foreign.level, 'blocked', 'one PID Atomvs did not start blocks the command');
  assert.match(foreign.reason!, /not PID 999/);
  assert.equal(classifyCommand('taskkill /PID 4242 /F').level, 'blocked', 'no PIDs known: blocked');
  assert.equal(processKillPolicy('kill 5', new Set([5])).allowed, true);

  console.log('  [kill-safety] ...and ordinary commands are not affected...');
  for (const command of ['flutter pub get', 'flutter run -d chrome', 'dart pub get && flutter test', 'npm run kill-port',
    'git log --grep kill', 'echo killall', 'flutter run --no-kill', 'npx expo install expo-router', 'tasklist /FI "IMAGENAME eq dart.exe"']) {
    assert.equal(findProcessKill(command), null, command);
  }
  assert.equal(classifyCommand('flutter pub get').level, 'safe');

  console.log('  [kill-safety] TerminalService refuses them too (the second layer), also after an allowed prefix...');
  const terminal = new TerminalService();
  terminal.setOwnedPidsProvider(() => [4242]);
  for (const command of [USER_COMMAND, 'flutter --version & taskkill /F /IM dart.exe', 'dart --version; pkill dart', 'flutter --version & taskkill /PID 999 /F']) {
    assert.equal(terminal.isCommandAllowed(command), false, command);
    await assert.rejects(terminal.streamCommand('t1', command, os.tmpdir()), /Command not allowed: .*(outside Atomvs|Only processes Atomvs started)/, command);
    await assert.rejects(terminal.runCommand(command, os.tmpdir()), /Command not allowed/, command);
  }
  assert.equal(terminal.isCommandAllowed('flutter --version & taskkill /PID 4242 /F'), true, 'a PID Atomvs started');
  assert.equal(terminal.isCommandAllowed('flutter pub get'), true);
  assert.equal(terminal.isCommandAllowed('cmd /c dir'), false, 'the prefix allowlist still applies');

  console.log('  [kill-safety] The agent passes the PIDs Atomvs started; the prompt says why...');
  const agentService = fs.readFileSync(path.join(root, 'apps/desktop/src/main/services/agent-service.ts'), 'utf8');
  assert.match(agentService, /classifyCommand\(commandStr, \{ ownPids: new Set\(this\.ownedPids\(\)\) \}\)/);
  const ipc = fs.readFileSync(path.join(root, 'apps/desktop/src/main/ipc/index.ts'), 'utf8');
  assert.match(ipc, /agentService\.setOwnedPidsProvider\(\(\) => \[\.\.\.processManager\.pids\(\), \.\.\.terminalService\.pids\(\)\]\)/);
  assert.match(ipc, /terminalService\.setOwnedPidsProvider\(\(\) => processManager\.pids\(\)\)/);
  assert.match(FLUTTER_SYSTEM_PROMPT, /Never stop processes by name \(taskkill \/IM, pkill, killall, Stop-Process -Name, npx kill-port\)/);

  console.log('  [kill-safety] The chat shows a refused command as "Blocked", never "Ran" (Auto-Fix -> agent -> run_command)...');
  {
    const gateway = new MockAIGateway();
    gateway.setCustomToolCall({ id: 'kill1', name: 'run_command', arguments: JSON.stringify({ command: USER_COMMAND }) });
    const activities: AgentTimelineActivity[] = [];
    const results: string[] = [];
    await runAgentLoop(
      { capabilityTier: 'fast', sessionToken: 'tok', gateway },
      'sys',
      [{ role: 'user', content: 'The application build failed to compile or run. Please fix it.' }],
      {
        // As agent-service does: classifyCommand first; a blocked command is never run.
        execute: async (_name, args) => {
          gateway.setScenario('success');
          const safety = classifyCommand(String(args.command), { ownPids: new Set() });
          const out = safety.level === 'blocked' ? `BLOCKED: ${safety.reason}` : 'ran';
          results.push(out);
          return out;
        },
      },
      { onStatus: () => {}, onDelta: () => {}, onError: () => {}, onDone: () => {}, onTimelineActivity: (a) => activities.push(a) },
      new AbortController().signal,
    );
    assert.match(results[0], /^BLOCKED: Stopping processes by name/);
    const resolved = activities.filter((a) => a.command === USER_COMMAND && a.status !== 'in_progress');
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].status, 'blocked');
    assert.match(resolved[0].message, /^Blocked: Stopping processes by name/);
    for (const text of ['BLOCKED: x', "Not run: this command needs the user's confirmation and none came within 60 s: x",
      'Command was rejected by user: x', 'File deletion rejected by user: a.txt', 'Command error: Command not allowed: x']) {
      assert.ok(NOT_RUN.test(text), text);
    }
    assert.ok(!NOT_RUN.test('Command exited with code 1.\nOutput:\nBLOCKED: inside the output'), 'only the start of a result');
    const chat = fs.readFileSync(path.join(root, 'apps/desktop/src/renderer/src/layout/ChatPane.tsx'), 'utf8');
    assert.match(chat, /if \(a\.status === 'blocked'\) return \{ verb: 'Blocked', target \};/);
    const agent = fs.readFileSync(path.join(root, 'apps/desktop/src/main/services/agent-service.ts'), 'utf8');
    assert.match(agent, /if \(confirmed === 'timeout'\) \{\s*return `Not run: this command needs the user's confirmation and none came within 60 s/,
      'no confirmation is not "rejected by user"');
  }

  console.log('  [kill-safety] Atomvs\'s own code never stops processes by name...');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []);
  for (const file of walk(path.join(root, 'apps/desktop/src'))) {
    const text = fs.readFileSync(file, 'utf8');
    // In a string that is run: 'taskkill /f /im dart.exe', `pkill ...`, "killall ...".
    assert.doesNotMatch(text, /['"`]\s*(?:taskkill[^'"`\n]*\/(?:im|fi)\b|pkill\s|killall\s)/i, `${path.relative(root, file)} stops processes by name`);
  }
  const main = fs.readFileSync(path.join(root, 'apps/desktop/src/main/index.ts'), 'utf8');
  assert.match(main, /stopLeftoverProcesses\(processRegistry\(\)\)/, 'startup stops only the recorded processes');

  console.log('  [kill-safety] Leftover processes: the recorded ones only, and not a reused PID...');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'process-registry-'));
  try {
    const registry = new ProcessRegistry(path.join(tmp, 'sub', 'atomvs-processes.json'));
    assert.deepEqual(registry.read(), [], 'no file yet');
    const a = { pid: 100, startedAt: 1_700_000_000_000, command: 'flutter run -d web-server' };
    const b = { pid: 200, startedAt: 1_700_000_100_000, command: 'npx expo start --web' };
    registry.add(a);
    registry.add(b);
    assert.deepEqual(registry.read(), [a, b]);
    const running = new Map([[100, a.startedAt + 1_500], [200, b.startedAt + 3_600_000], [300, 1]]);
    assert.deepEqual(leftoverPids(registry.read(), running), [100],
      '100 is the same process; 200 now belongs to a program started an hour later; 300 was never ours');
    assert.deepEqual(leftoverPids(registry.read(), new Map()), [], 'nothing running');
    const c = { pid: 300, startedAt: 1_700_000_200_000, command: 'flutter run' };
    const seen = registry.read();
    registry.add(c); // started while the leftovers were being stopped
    registry.remove(seen);
    assert.deepEqual(registry.read(), [c], 'only the handled entries are removed');
    fs.writeFileSync(path.join(tmp, 'sub', 'atomvs-processes.json'), '[{"pid":"1; rm -rf /","startedAt":1,"command":"x"}, {"pid":5,"startedAt":2,"command":"ok"}]');
    assert.deepEqual(registry.read(), [{ pid: 5, startedAt: 2, command: 'ok' }], 'malformed entries are ignored');
    fs.writeFileSync(path.join(tmp, 'sub', 'atomvs-processes.json'), 'not json');
    assert.deepEqual(registry.read(), []);

    if (process.platform === 'win32') {
      console.log('  [kill-safety] Windows: at startup only the recorded process is stopped, a reused PID is not...');
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      const ours = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      try {
        const leftovers = new ProcessRegistry(path.join(tmp, 'leftovers.json'));
        leftovers.add({ pid: ours.pid!, startedAt: Date.now(), command: 'node (ours)' });
        // Same PID as a process that is running, but recorded an hour earlier: Windows reused the PID.
        leftovers.add({ pid: stranger.pid!, startedAt: Date.now() - 3_600_000, command: 'node (old)' });
        assert.deepEqual(await stopLeftoverProcesses(leftovers), [ours.pid]);
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(alive(ours.pid!), false, 'the recorded process was stopped');
        assert.equal(alive(stranger.pid!), true, 'a process that only shares a recorded PID was not');
        assert.deepEqual(leftovers.read(), [], 'the list is emptied');
      } finally {
        ours.kill();
        stranger.kill();
      }
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  🟢 Process kill safety tests passed.');
}
