/**
 * Command Safety Layer: one decision for every command the agent runs, used by both permission layers (the agent's
 * run_command and TerminalService).
 *
 * - safe: runs without asking. Only a whole command that is a known, harmless mobile-dev tool (SAFE_COMMANDS),
 *   with no shell operators (& | ; > < ` $( ), so nothing can be chained after it.
 * - dangerous: the user is asked first (the approval card). `alwaysAllowKey` says whether "Always allow in this
 *   project" may be offered: never for destructive commands, stopping processes, system-wide changes, shells and
 *   interpreters (they can run anything), or a line with shell operators.
 * - blocked: never runs, and no card is shown (e.g. stopping processes by name).
 */

export type SafetyLevel = 'safe' | 'dangerous' | 'blocked';

export interface CommandSafetyResult {
  level: SafetyLevel;
  reason?: string;
  /**
   * For a dangerous command: the program and subcommand that "Always allow in this project" remembers (e.g.
   * "flutter pub run", "git checkout"), or null when it must be asked every time.
   */
  alwaysAllowKey?: string | null;
}

/** Programs that, when run, wipe a disk or stop the machine: never. Matched where a command starts. */
const BLOCKED_PROGRAMS = /^(shutdown|reboot|halt|poweroff|mkfs(\.\w+)?|format|diskpart|bcdedit)$/i;
const BLOCKED_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+\/(\s|$|\*)/i, // rm -rf /
  /\bdd\s+if=/,
];

/** Asked every time, never "always allow": they destroy work or change the system. */
const DESTRUCTIVE_PATTERNS = [
  /\brm\s+-[a-z]*[rf]/i,
  /\b(del|erase)\s+.*\/[sq]\b/i,
  /\b(rmdir|rd)\s+.*\/s\b/i,
  /\bremove-item\b/i,
  /\bgit\s+push\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\b/i,
  /\bgit\s+(checkout|restore)\s+(--\s|\.|-f\b)/i,
  /\bgit\s+branch\s+.*-[dD]\b/i,
  /\bgit\s+stash\s+(drop|clear)\b/i,
  /\bgit\s+rebase\b/i,
  /\bDROP\s+(TABLE|DATABASE)\b/i,
  /\btruncate\b/i,
  /\bsudo\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\/etc\//,
  /\bpasswd\b/i,
  /\b(curl|wget|iwr|invoke-webrequest)\b.*\|\s*(sh|bash|iex|invoke-expression)\b/i,
  /\b(reg|setx|netsh|sc|icacls|takeown|bcdedit|schtasks)(\.exe)?\s/i,
  /\b(npm|pnpm|yarn)\s+(publish|unpublish|login|logout|adduser)\b/i,
  /\s(-g|--global|--location[= ]global)\b/i,
  /\s--force\b/i,
  /--legacy-peer-deps\b/i,
];

/** Shells and interpreters: whatever they are given can do anything, so they are asked every time. */
const INTERPRETERS = /^(node|nodejs|python\d*|py|ruby|perl|php|bash|sh|zsh|cmd|powershell|pwsh|wsl|deno|bun|osascript|npx|pnpx|bunx|dlx)$/i;

/** & | ; > < ` $( or a newline: the line is more than one plain command. */
const SHELL_OPERATORS = /[&|;<>`\r\n]|\$\(/;

/** The program (without path, quotes or .exe/.cmd/.bat) and its arguments. */
function words(command: string): { program: string; args: string[] } {
  const parts = command.trim().split(/\s+/);
  const program = (parts[0] ?? '').replace(/["']/g, '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  return { program, args: parts.slice(1) };
}

/** First argument that is not a flag. */
function subcommand(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith('-'));
}

export interface CommandContext {
  /** package.json "scripts" of the project, to judge `npm run x` / `npm test` / `pnpm x` by what x runs. */
  scripts?: Record<string, string>;
}

const PACKAGE_MANAGERS = /^(npm|pnpm|yarn)$/;
// Subcommands that only install or remove packages of this project (flags like -g / --force are destructive above).
const INSTALL_SUBCOMMANDS = /^(install|i|ci|add|remove|uninstall|un|rm|r|update|up|upgrade)$/;
const READ_SUBCOMMANDS = /^(ls|list|outdated|view|info|why|explain|doctor|-v|--version)$/;
// A package manager running a project script: npm run x, npm test, npm start, pnpm x, yarn x.
const SCRIPT_SUBCOMMANDS = /^(run|run-script|test|t|start)$/;

/**
 * Harmless commands of mobile development: run without asking. Each rule gets the program and arguments of a
 * command with no shell operators. Exported for tests (and shown to the user as the list).
 */
export const SAFE_COMMANDS: { label: string; test: (program: string, args: string[], ctx: CommandContext) => boolean }[] = [
  {
    label: 'flutter pub get/add/remove/upgrade/outdated/deps, analyze, test, build, run, clean, create, doctor, devices, gen-l10n, --version',
    test: (p, a) => p === 'flutter' && (
      (a[0] === 'pub' && /^(get|add|remove|upgrade|outdated|deps)$/.test(a[1] ?? ''))
      || /^(analyze|test|build|run|clean|create|doctor|devices|gen-l10n|--version|-v|precache)$/.test(a[0] ?? '')),
  },
  {
    label: 'dart pub get/add/remove/upgrade/outdated/deps, analyze, test, format, fix, --version',
    test: (p, a) => p === 'dart' && (
      (a[0] === 'pub' && /^(get|add|remove|upgrade|outdated|deps)$/.test(a[1] ?? ''))
      || /^(analyze|test|format|fix|--version)$/.test(a[0] ?? '')),
  },
  {
    label: 'npm / pnpm / yarn: install, ci, add, remove, update (not -g, --force, --legacy-peer-deps), ls, outdated, view',
    test: (p, a) => PACKAGE_MANAGERS.test(p) && (a.length === 0 ? p !== 'npm' : INSTALL_SUBCOMMANDS.test(a[0]) || READ_SUBCOMMANDS.test(a[0])),
  },
  {
    label: 'npm run / npm test / npm start / pnpm x / yarn x: when the package.json script itself is on this list',
    test: (p, a, ctx) => {
      if (!PACKAGE_MANAGERS.test(p) || !ctx.scripts) return false;
      const sub = a[0] ?? '';
      const name = SCRIPT_SUBCOMMANDS.test(sub) ? (sub === 'run' || sub === 'run-script' ? a[1] : sub === 't' ? 'test' : sub) : p !== 'npm' ? sub : undefined;
      const body = name ? ctx.scripts[name] : undefined;
      // The script's own command, judged without scripts (no recursion).
      return !!body && classifyCommand(body).level === 'safe';
    },
  },
  {
    label: 'npx expo install/start/doctor/config/export/prebuild/run:android/run:ios, npx expo-doctor, npx tsc/eslint/prettier/jest',
    test: (p, a) => /^(npx|pnpx)$/.test(p) && (
      (a[0] === 'expo' && /^(install|start|doctor|config|export|prebuild|run:android|run:ios|customize|--version)$/.test(a[1] ?? ''))
      || /^(expo-doctor|tsc|eslint|prettier|jest|vitest)$/.test(a[0] ?? '')),
  },
  {
    label: 'expo start/install/run:android/run:ios, react-native start/run-android/run-ios/info, tsc, eslint, prettier, jest (as package.json scripts run them)',
    test: (p, a) => (p === 'expo' && /^(start|install|doctor|export|prebuild|run:android|run:ios)$/.test(a[0] ?? ''))
      || (p === 'react-native' && /^(start|run-android|run-ios|info|doctor)$/.test(a[0] ?? ''))
      || /^(tsc|eslint|prettier|jest|vitest|expo-doctor)$/.test(p),
  },
  {
    label: 'git status, log, diff, show, add, commit, fetch, branch (list/create), stash (save/list/show)',
    test: (p, a) => p === 'git' && /^(status|log|diff|show|add|commit|fetch|branch|stash)$/.test(a[0] ?? '')
      && !(a[0] === 'stash' && /^(drop|clear|pop|apply)$/.test(a[1] ?? ''))
      && !(a[0] === 'branch' && a.some((x) => /^-[a-zA-Z]*[dDmM]/.test(x) || x === '--delete' || x === '--move')),
  },
  {
    label: 'ls, dir, pwd, echo, cat, type, mkdir, where, which, tree: only with paths inside the project',
    test: (p, a) => /^(ls|dir|pwd|echo|cat|type|mkdir|md|where|which|tree)$/.test(p) && a.every((x) => staysInProject(x, p)),
  },
  {
    label: 'adb devices / logcat, emulator -list-avds, xcrun simctl list, pod install',
    test: (p, a) => (p === 'adb' && /^(devices|logcat|version)$/.test(a[0] ?? ''))
      || (p === 'emulator' && a[0] === '-list-avds')
      || (p === 'xcrun' && a[0] === 'simctl' && a[1] === 'list')
      || (p === 'pod' && a[0] === 'install'),
  },
];

/**
 * An argument of a read-only command that cannot reach outside the project folder (commands run in it): a flag, or a
 * relative path without "..". Absolute paths (C:\, \\server, /), the home folder (~) and variables (%USERPROFILE%,
 * $HOME, $env:X) can point anywhere, e.g. `type C:\Users\x\.ssh\id_rsa`: those ask. Exported for tests.
 */
export function staysInProject(arg: string, program = ''): boolean {
  const a = arg.replace(/^["']|["']$/g, '');
  // A flag (-la, --all; for dir / tree / where also /s /b /a:h); its value may still be a path: --file=../x.
  if (/^-{1,2}[\w-]+(=.*)?$/.test(a) || (/^(dir|tree|where)$/.test(program) && /^\/[a-z?](:[\w-]*)?$/i.test(a))) {
    const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
    return !value || staysInProject(value, program);
  }
  if (/^[a-z]:/i.test(a) || /^[\\/]/.test(a) || a.startsWith('~')) return false;
  if (/[%$]/.test(a)) return false;
  return !a.split(/[\\/]+/).includes('..');
}

/**
 * The new packages a command adds to the project (npm/pnpm/yarn add or install <name>, flutter/dart pub add <name>,
 * npx expo install <name>), as written, e.g. ["axios@1.7", "http"]. These run without a card; the chat step lists
 * them ("Added package: axios") so the user sees what came in. Exported for tests.
 */
export function packagesAdded(command: string): string[] {
  if (!command.trim() || SHELL_OPERATORS.test(command)) return [];
  const { program, args } = words(command);
  const names = (list: string[]) => list.filter((a) => a && !a.startsWith('-')).map((a) => a.replace(/^["']|["']$/g, ''));
  if (PACKAGE_MANAGERS.test(program) && /^(install|i|add)$/.test(args[0] ?? '')) return names(args.slice(1));
  if (/^(flutter|dart)$/.test(program) && args[0] === 'pub' && args[1] === 'add') return names(args.slice(2));
  if (/^(npx|pnpx)$/.test(program) && args[0] === 'expo' && args[1] === 'install') return names(args.slice(2));
  return [];
}

/** Whether `command` is on the safe list (and has no shell operators). Exported for tests. */
export function isSafeCommand(command: string, ctx: CommandContext = {}): boolean {
  if (!command.trim() || SHELL_OPERATORS.test(command)) return false;
  const { program, args } = words(command);
  return SAFE_COMMANDS.some((rule) => rule.test(program, args, ctx));
}

/**
 * What "Always allow in this project" remembers for a dangerous command, or null when it must be asked every time.
 * Exported for tests.
 */
export function alwaysAllowKeyOf(command: string): string | null {
  if (!command.trim() || SHELL_OPERATORS.test(command)) return null;
  if (DESTRUCTIVE_PATTERNS.some((p) => p.test(command)) || findProcessKill(command)) return null;
  const { program, args } = words(command);
  if (!program || INTERPRETERS.test(program)) return null;
  // cp, mv, ...: the program. git checkout, adb install, gradlew assembleDebug: with its subcommand.
  if (!TOOLS_WITH_SUBCOMMANDS.test(program)) return program;
  const sub = subcommand(args);
  // flutter pub run, dart run build_runner, npm run build: the tool name after "pub" / "run" is part of what is allowed.
  const third = sub && /^(pub|run|run-script|exec)$/.test(sub) ? subcommand(args.slice(args.indexOf(sub) + 1)) : undefined;
  return [program, sub, third].filter(Boolean).join(' ');
}

const TOOLS_WITH_SUBCOMMANDS = /^(flutter|dart|npm|pnpm|yarn|git|adb|gradlew|gradle|xcrun|pod|expo|eas|react-native|firebase|docker|emulator|avdmanager|sdkmanager|keytool|bundle|fastlane|java|cargo|go|dotnet)$/;

/** The package.json script a package-manager command runs (npm run x, npm test, pnpm x), if any. */
function scriptOf(command: string, scripts: Record<string, string> | undefined): { name: string; body: string } | null {
  if (!scripts || SHELL_OPERATORS.test(command)) return null;
  const { program: p, args: a } = words(command);
  if (!PACKAGE_MANAGERS.test(p)) return null;
  const sub = a[0] ?? '';
  const name = SCRIPT_SUBCOMMANDS.test(sub) ? (sub === 'run' || sub === 'run-script' ? a[1] : sub === 't' ? 'test' : sub) : p !== 'npm' ? sub : undefined;
  return name && typeof scripts[name] === 'string' ? { name, body: scripts[name] } : null;
}

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

export interface ClassifyOptions extends CommandContext {
  /** PIDs of processes Atomvs started (preview, dev servers, agent commands): the only ones a command may stop. */
  ownPids?: ReadonlySet<number>;
  /** "Always allow in this project" keys the user chose (see alwaysAllowKeyOf). */
  alwaysAllowed?: ReadonlySet<string>;
}

export function classifyCommand(command: string, options: ClassifyOptions = {}): CommandSafetyResult {
  // Stopping processes: never by name, by PID only Atomvs's own (and then with the user's confirmation, every time).
  const kill = processKillPolicy(command, options.ownPids);
  if (!kill.allowed) return { level: 'blocked', reason: kill.reason };
  if (findProcessKill(command)) {
    return { level: 'dangerous', reason: 'This command stops a process Atomvs started.', alwaysAllowKey: null };
  }

  // Never: wiping a disk or stopping the machine, wherever in the line.
  for (const part of command.split(SEGMENT_SPLIT)) {
    const { program } = words(part.replace(WRAPPER, ''));
    if (BLOCKED_PROGRAMS.test(program)) {
      return { level: 'blocked', reason: `"${program}" can wipe a disk or stop the computer, so it is never run.` };
    }
  }
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { level: 'blocked', reason: 'This command could wipe the disk, so it is never run.' };
    }
  }

  if (DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command))) {
    return { level: 'dangerous', reason: 'This command can delete work or change your system.', alwaysAllowKey: null };
  }

  // npm run x / pnpm x: also what the script runs. A script that stops processes by name is blocked like the command.
  const script = scriptOf(command, options.scripts);
  if (script) {
    const inner = classifyCommand(script.body, { ownPids: options.ownPids });
    if (inner.level === 'blocked') return { level: 'blocked', reason: `The "${script.name}" script runs: ${script.body}. ${inner.reason}` };
    if (inner.level === 'dangerous' && inner.alwaysAllowKey === null) {
      return { level: 'dangerous', reason: `The "${script.name}" script runs: ${script.body}. ${inner.reason}`, alwaysAllowKey: null };
    }
  }

  if (isSafeCommand(command, options)) return { level: 'safe' };

  const alwaysAllowKey = alwaysAllowKeyOf(command);
  if (alwaysAllowKey && options.alwaysAllowed?.has(alwaysAllowKey)) {
    return { level: 'safe', reason: `"${alwaysAllowKey}" is always allowed in this project.` };
  }
  return {
    level: 'dangerous',
    reason: SHELL_OPERATORS.test(command)
      ? 'This line runs more than one command (& | ; > or similar).'
      : alwaysAllowKey
        ? 'This command is not on the list of everyday development commands.'
        : 'This runs a shell or a script interpreter, which can do anything.',
    alwaysAllowKey,
  };
}
