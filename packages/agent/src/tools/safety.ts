/**
 * Command Safety Layer
 *
 * Classifies terminal commands as:
 * - SAFE: auto-execute without confirmation (normal dev commands)
 * - DANGEROUS: require explicit user confirmation
 * - BLOCKED: never allow
 */

export type SafetyLevel = 'safe' | 'dangerous' | 'blocked';

export interface CommandSafetyResult {
  level: SafetyLevel;
  reason?: string;
}

/** Patterns that are always blocked — never execute */
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//, // rm -rf on root
  /format\s+[a-z]:/i, // Windows disk format
  /mkfs\./,
  /dd\s+if=/,
  /shutdown/i,
  /reboot/i,
  /halt/i,
];

/** Patterns that require explicit user confirmation */
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/i,
  /del\s+\/[sq]/i,          // Windows: del /s or /q
  /rmdir\s+\/s/i,            // Windows: rmdir /s
  /git\s+push\s+.*--force/i,
  /git\s+reset\s+--hard/i,
  /git\s+clean\s+-fd/i,
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /truncate/i,
  /sudo\s+rm/i,
  /sudo\s+chmod/i,
  /sudo\s+chown/i,
  /\/etc\//,                  // any write to /etc
  /passwd/i,
  /curl.*\|\s*(sh|bash)/i,   // curl pipe to shell
  /wget.*\|\s*(sh|bash)/i,
  /chmod\s+777/,
];

/** Safe dev commands — always auto-execute */
const SAFE_PREFIXES = [
  'flutter pub get',
  'flutter pub upgrade',
  'flutter analyze',
  'flutter test',
  'flutter build',
  'flutter run',
  'flutter clean',
  'flutter create',
  'flutter doctor',
  'dart pub get',
  'dart analyze',
  'dart test',
  'dart format',
  'npm install',
  'npm run',
  'npm test',
  'npm build',
  'npx',
  'pnpm install',
  'pnpm run',
  'pnpm test',
  'pnpm build',
  'pnpm typecheck',
  'pnpm add',
  'pnpm remove',
  'yarn install',
  'yarn run',
  'yarn add',
  'yarn remove',
  'git status',
  'git log',
  'git diff',
  'git add',
  'git commit',
  'git fetch',
  'git pull',
  'git branch',
  'git checkout',
  'git stash',
  'git merge',
  'cat ',
  'ls ',
  'dir ',
  'echo ',
  'pwd',
  'mkdir',
  'touch',
  'cp ',
  'mv ',
  'node ',
  'python ',
  'pip install',
  'gem install',
  'pod install',
  'adb ',
  'emulator ',
  'xcrun ',
];

/** A command that stops processes: by name (any process with that name on the PC) and/or by PID. */
export interface ProcessKill {
  byName: boolean;
  pids: number[];
}

// One command of a line: `a & b`, `a && b`, `a; b`, `a | b`, `$(b)` and `(b)` are separate commands.
const SEGMENT_SPLIT = /&&|\|\||[;&|\n\r]|\$\(|`|\(/;
// Wrappers in front of the real command: cmd /c, powershell -Command, sudo, start /b, quotes.
const WRAPPER = /^(?:["'\s]|cmd(?:\.exe)?\s+\/[a-z]\b|powershell(?:\.exe)?(?:\s+-\w+)*\s+|pwsh(?:\.exe)?(?:\s+-\w+)*\s+|sudo\s+|start\s+(?:\/\w+\s+)*|call\s+|exec\s+|nohup\s+)+/i;

/**
 * Finds process-stopping commands anywhere in `command` (also after `&`, `;`, `|` or inside `cmd /c "..."`), or
 * null if there are none. By name: taskkill /IM or /FI, tskill, pkill, killall, Stop-Process -Name (or piped
 * processes), wmic / Win32_Process terminate, `kill $(pgrep ...)`, `xargs kill`. These reach every process with
 * that name on the user's PC, also outside Atomvs. By PID: taskkill /PID n, Stop-Process -Id n, kill n. Exported
 * for tests.
 */
export function findProcessKill(command: string): ProcessKill | null {
  let byName = false;
  let found = false;
  const pids: number[] = [];
  const addPids = (text: string) => {
    for (const n of text.match(/\d+/g) ?? []) pids.push(Number(n));
  };
  // Anything that pipes processes into a killer, or terminates through WMI, is by name.
  if (/\|\s*(?:stop-process|spps|kill)\b|\bxargs\s+(?:-\S+\s+)*kill\b|\bwmic\b[^\n]*\bprocess\b[^\n]*\b(?:delete|terminate)\b|win32_process[^\n]*terminate|terminate[^\n]*win32_process/i.test(command)) {
    return { byName: true, pids: [] };
  }
  const segments = command.split(SEGMENT_SPLIT);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i].replace(WRAPPER, '').trim();
    // The program, also given as a path ("C:\Windows\System32\taskkill.exe", /usr/bin/pkill).
    const program = /^"([^"]+)"|^(\S+)/.exec(seg);
    if (!program) continue;
    const word = (program[1] ?? program[2]).replace(/["']/g, '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
    const rest = seg.slice(program[0].length);
    if (word === 'taskkill') {
      found = true;
      if (/\/(?:im|fi)\b/i.test(rest) || !/\/pid\b/i.test(rest)) byName = true;
      for (const m of rest.matchAll(/\/pid\s+(\d+)/gi)) pids.push(Number(m[1]));
    } else if (word === 'pkill' || word === 'killall' || word === 'tskill' || /^(?:kill-port|fkill(?:-cli)?)$/.test(word)
      || (word === 'fuser' && /\s-\w*k/.test(rest))
      // npx kill-port 3000 / pnpm dlx fkill: stop whatever holds a port or has a name, whoever started it.
      || (/^(?:npx|pnpx|bunx)$/.test(word) && /^(?:\s+-\S+)*\s+(?:kill-port|fkill(?:-cli)?)\b/.test(rest))
      || (/^(?:pnpm|yarn)$/.test(word) && /^\s+dlx(?:\s+-\S+)*\s+(?:kill-port|fkill(?:-cli)?)\b/.test(rest))) {
      found = true;
      byName = true;
    } else if (word === 'stop-process' || word === 'spps') {
      found = true;
      const id = /-id\s+([\d,\s]+)/i.exec(rest);
      if (id && !/-(?:name|processname|inputobject)\b/i.test(rest)) addPids(id[1]);
      else byName = true;
    } else if (word === 'kill') {
      found = true;
      // kill [-9|-KILL|-s SIG] pid...; a substitution (`kill $(pgrep x)`) was split off above: its PIDs are unknown.
      const args = rest.replace(/\s-(?:s\s+)?\w+/g, ' ').trim();
      if (/^\d+(?:\s+\d+)*$/.test(args)) addPids(args);
      else byName = true;
    }
  }
  return found ? { byName, pids } : null;
}

export interface ProcessKillPolicy {
  allowed: boolean;
  reason?: string;
}

/**
 * Whether a command may stop processes: never by name (that also stops the user's own Flutter, Dart, Node or other
 * processes outside Atomvs), and by PID only when every PID is one Atomvs started (`ownPids`). Commands that stop
 * nothing are allowed here (other checks still apply). Exported for tests.
 */
export function processKillPolicy(command: string, ownPids: ReadonlySet<number> = new Set()): ProcessKillPolicy {
  const kill = findProcessKill(command);
  if (!kill) return { allowed: true };
  if (kill.byName) {
    return {
      allowed: false,
      reason: 'Stopping processes by name (taskkill /IM, pkill, killall, Stop-Process -Name) would also stop them outside Atomvs, '
        + "in the user's other projects and tools, so it is never run. To restart the app use restart_preview: Atomvs stops "
        + 'the processes it started itself.',
    };
  }
  const foreign = kill.pids.filter((pid) => !ownPids.has(pid));
  if (kill.pids.length === 0 || foreign.length > 0) {
    return {
      allowed: false,
      reason: `Only processes Atomvs started can be stopped${foreign.length ? ` (not PID ${foreign.join(', ')})` : ''}. `
        + 'To restart the app use restart_preview.',
    };
  }
  return { allowed: true };
}

export interface ClassifyOptions {
  /** PIDs of processes Atomvs started (preview, dev servers, agent commands): the only ones a command may stop. */
  ownPids?: ReadonlySet<number>;
}

export function classifyCommand(command: string, options: ClassifyOptions = {}): CommandSafetyResult {
  const normalized = command.trim().toLowerCase();

  // Stopping processes: never by name, by PID only Atomvs's own (and then with the user's confirmation).
  const kill = processKillPolicy(command, options.ownPids);
  if (!kill.allowed) return { level: 'blocked', reason: kill.reason };
  if (findProcessKill(command)) {
    return { level: 'dangerous', reason: 'This command stops a process Atomvs started and requires your confirmation.' };
  }

  // Check blocked first
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        level: 'blocked',
        reason: `This command matches a blocked pattern and will never be executed: \`${pattern}\``,
      };
    }
  }

  // Check dangerous
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        level: 'dangerous',
        reason: `This command requires your explicit confirmation before execution.`,
      };
    }
  }

  // Check safe prefixes
  for (const prefix of SAFE_PREFIXES) {
    if (normalized.startsWith(prefix.toLowerCase())) {
      return { level: 'safe' };
    }
  }

  // Unknown commands are treated as dangerous (require confirmation)
  return {
    level: 'dangerous',
    reason: `This command is not in the known-safe list and requires your confirmation before execution.`,
  };
}
