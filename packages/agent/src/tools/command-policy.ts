/**
 * Unified Command Policy & Parser
 *
 * Single source of truth for command permissions across Synkro / Peep.
 * Used by both `safety.ts` (agent planning layer) and `TerminalService` (desktop execution layer).
 *
 * Rules:
 * 1. Tokenize command into argv (handling single/double quotes and escapes).
 * 2. Reject unquoted shell metacharacters: ; & | < > ` $( ) { } \n \r * ?
 * 3. On Windows (Fix 1b): reject any argument containing ", %, ^, !, \n, or \r.
 * 4. Validate argv[0] against the allowed binaries list (Fix 2: 13 allowed binaries).
 * 5. Apply git subcommand restrictions (Fix 2: status, diff, log, add, commit, branch, checkout, stash, merge).
 * 6. Classify commands as 'safe' (allowed), 'dangerous' (requires confirmation), or 'blocked' (never run) (Fix 3).
 */

export type SafetyLevel = 'safe' | 'dangerous' | 'blocked';

export interface TokenizeResult {
  argv?: string[];
  error?: string;
}

export type CommandPolicyResult =
  | { allowed: true; level: 'safe'; argv: string[]; reason?: undefined }
  | { allowed: false; level: 'dangerous' | 'blocked'; reason: string; argv?: string[] };

/**
 * Shell metacharacters that are rejected when encountered OUTSIDE quotes.
 */
const UNQUOTED_METACHARS = new Set([
  ';', '&', '|', '<', '>', '`', '$', '(', ')', '{', '}', '\n', '\r', '*', '?'
]);

/**
 * Characters forbidden in any argument on Windows (Fix 1b) to prevent cmd.exe
 * quote breakout, environment variable expansion (%VAR%), and operator execution.
 */
const WINDOWS_FORBIDDEN_CHARS = /["%^!\n\r]/;

/** Patterns that are always blocked — never execute under any circumstances */
const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//, // rm -rf on root
  /format\s+[a-z]:/i, // Windows disk format
  /mkfs\./,
  /dd\s+if=/,
  /shutdown/i,
  /reboot/i,
  /halt/i,
];

/** Patterns that require user confirmation (Dangerous tier) */
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/i,
  /del\s+\/[sq]/i,          // Windows: del /s or /q
  /rmdir\s+\/s/i,            // Windows: rmdir /s
  /git\s+push/i,
  /git\s+reset/i,
  /git\s+clean/i,
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /truncate/i,
  /sudo\s+/i,
  /\/etc\//,                  // any write to /etc
  /passwd/i,
  /curl.*\|\s*(sh|bash)/i,   // curl pipe to shell
  /wget.*\|\s*(sh|bash)/i,
  /chmod\s+777/,
];

/**
 * Allowed binaries allowlist (Fix 2: 13 binaries only).
 */
export const ALLOWED_BINARIES = new Set([
  'npm',
  'npx',
  'pnpm',
  'pnpx',
  'yarn',
  'node',
  'flutter',
  'dart',
  'git',
  'pwd',
  'dir',
  'ls',
  'echo',
]);

/**
 * Safe git subcommands allowed to run without confirmation.
 * status, diff, log, add, commit, branch (old terminal layer)
 * plus checkout (non-force), stash, merge (old safety.ts).
 */
export const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'add',
  'commit',
  'branch',
  'checkout',
  'stash',
  'merge',
]);

/**
 * Normalizes a binary name or path to a lower-case base command name.
 * e.g. "C:\\tools\\flutter.bat" -> "flutter", "/usr/bin/git" -> "git", "node.exe" -> "node"
 */
export function normalizeBinary(bin: string): string {
  const parts = bin.split(/[/\\]/);
  const base = parts[parts.length - 1] || bin;
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/**
 * Tokenizes a command line string into an argv array.
 * Rejects unquoted shell metacharacters and unterminated quotes.
 */
export function tokenizeCommandLine(command: string): TokenizeResult {
  const trimmed = command.trim();
  if (!trimmed) {
    return { error: 'Command is empty' };
  }

  const argv: string[] = [];
  let currentArg = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let hasToken = false;

  for (let i = 0; i < command.length; i++) {
    const char = command[i];

    if (inSingleQuote) {
      if (char === "'") {
        inSingleQuote = false;
      } else {
        currentArg += char;
      }
      continue;
    }

    if (inDoubleQuote) {
      if (char === '"') {
        inDoubleQuote = false;
      } else if (char === '`') {
        return { error: 'Command substitution with backticks is not allowed' };
      } else if (char === '$' && i + 1 < command.length && command[i + 1] === '(') {
        return { error: "Command substitution with '$(' is not allowed" };
      } else if (char === '\\') {
        // In double quotes, backslash escapes ", \, $, and `
        if (i + 1 < command.length) {
          const next = command[i + 1];
          if (next === '"' || next === '\\' || next === '$' || next === '`') {
            currentArg += next;
            i++;
            continue;
          }
        }
        currentArg += '\\';
      } else {
        currentArg += char;
      }
      continue;
    }

    // Outside quotes
    if (char === "'") {
      inSingleQuote = true;
      hasToken = true;
      continue;
    }

    if (char === '"') {
      inDoubleQuote = true;
      hasToken = true;
      continue;
    }

    if (char === ' ' || char === '\t') {
      if (hasToken) {
        argv.push(currentArg);
        currentArg = '';
        hasToken = false;
      }
      continue;
    }

    if (UNQUOTED_METACHARS.has(char)) {
      if (char === '\n' || char === '\r') {
        return { error: 'Newline-separated commands are not allowed' };
      }
      return { error: `Unquoted shell metacharacter '${char}' is not allowed` };
    }

    if (char === '\\') {
      // Outside quotes: check if escaping a quote, space, or backslash
      if (i + 1 < command.length) {
        const next = command[i + 1];
        if (next === '"' || next === "'" || next === ' ' || next === '\t' || next === '\\') {
          currentArg += next;
          hasToken = true;
          i++;
          continue;
        }
      }
      // Preserve backslash (e.g. Windows file paths C:\foo\bar)
      currentArg += '\\';
      hasToken = true;
      continue;
    }

    currentArg += char;
    hasToken = true;
  }

  if (inSingleQuote || inDoubleQuote) {
    return { error: 'Unterminated quote in command' };
  }

  if (hasToken) {
    argv.push(currentArg);
  }

  if (argv.length === 0) {
    return { error: 'Command is empty' };
  }

  return { argv };
}

export interface PolicyOptions {
  platform?: NodeJS.Platform;
}

/**
 * Validates git command arguments:
 * - Denies arbitrary command execution options (-c, --config-env, --exec-path, --upload-pack)
 * - Skips global options to find the subcommand
 * - Enforces ALLOWED_GIT_SUBCOMMANDS
 * - Explicitly denies push, pull, clone, fetch, remote, config, reset, clean, and checkout --force
 */
function evaluateGitCommand(argv: string[]):
  | { allowed: true; level: 'safe' }
  | { allowed: false; level: 'dangerous' | 'blocked'; reason: string } {
  const args = argv.slice(1);
  let subcommand: string | null = null;
  let subcommandIdx = -1;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // Check for dangerous options that execute commands or scripts
    if (
      arg === '-c' ||
      arg.startsWith('-c=') ||
      arg.startsWith('--config') ||
      arg.startsWith('--exec-path') ||
      arg.startsWith('--upload-pack') ||
      arg.startsWith('--receive-pack')
    ) {
      return {
        allowed: false,
        level: 'blocked',
        reason: `git option '${arg}' is not permitted by policy`,
      };
    }

    // Skip global flags to find the first positional subcommand
    if (arg.startsWith('-')) {
      if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree' || arg === '--namespace') {
        i++; // skip flag value
      }
      continue;
    }

    subcommand = arg.toLowerCase();
    subcommandIdx = i;
    break;
  }

  if (!subcommand) {
    return {
      allowed: false,
      level: 'dangerous',
      reason: 'git command requires a valid subcommand',
    };
  }

  // Explicit denies per Fix 2
  const explicitDenies = ['push', 'pull', 'clone', 'fetch', 'remote', 'config', 'reset', 'clean'];
  if (explicitDenies.includes(subcommand)) {
    return {
      allowed: false,
      level: 'dangerous',
      reason: `git ${subcommand} requires user confirmation`,
    };
  }

  // Checkout --force or -f check
  if (subcommand === 'checkout') {
    const remaining = args.slice(subcommandIdx + 1);
    const isForce = remaining.some(
      (a) => a === '--force' || a === '-f' || (a.startsWith('-') && !a.startsWith('--') && a.includes('f'))
    );
    if (isForce) {
      return {
        allowed: false,
        level: 'dangerous',
        reason: 'git checkout --force requires user confirmation',
      };
    }
  }

  if (!ALLOWED_GIT_SUBCOMMANDS.has(subcommand)) {
    return {
      allowed: false,
      level: 'dangerous',
      reason: `git subcommand '${subcommand}' is not in the allowed list`,
    };
  }

  return { allowed: true, level: 'safe' };
}

/**
 * Evaluates whether a command line is allowed by policy.
 * Returns structured result:
 * - allowed: true, level: 'safe', argv: string[] (safe dev command)
 * - allowed: false, level: 'dangerous', reason: string (requires confirmation)
 * - allowed: false, level: 'blocked', reason: string (hard blocked)
 */
export function evaluateCommandPolicy(command: string, options?: PolicyOptions): CommandPolicyResult {
  const currentPlatform = options?.platform ?? process.platform;

  // 1. Check blocked patterns first
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        level: 'blocked',
        reason: `This command matches a blocked pattern and will never be executed: \`${pattern}\``,
      };
    }
  }

  // 2. Tokenize command into argv
  const tokenized = tokenizeCommandLine(command);
  if (tokenized.error || !tokenized.argv) {
    return {
      allowed: false,
      level: 'blocked',
      reason: tokenized.error || 'Invalid command syntax',
    };
  }

  const { argv } = tokenized;
  const rawBin = argv[0];
  if (!rawBin) {
    return {
      allowed: false,
      level: 'blocked',
      reason: 'Command is empty',
    };
  }

  // 3. Fix 1b: On Windows, reject any argument containing ", %, ^, !, \n, or \r
  if (currentPlatform === 'win32') {
    for (const arg of argv) {
      const match = arg.match(WINDOWS_FORBIDDEN_CHARS);
      if (match) {
        return {
          allowed: false,
          level: 'blocked',
          reason: `Argument '${arg}' contains forbidden Windows character: ${JSON.stringify(match[0])}`,
          argv,
        };
      }
    }
  }

  // 4. Check dangerous patterns
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return {
        allowed: false,
        level: 'dangerous',
        reason: 'This command requires your explicit confirmation before execution.',
        argv,
      };
    }
  }

  // 5. Validate binary against ALLOWED_BINARIES (Fix 2)
  const bin = normalizeBinary(rawBin);
  if (!ALLOWED_BINARIES.has(bin)) {
    return {
      allowed: false,
      level: 'dangerous',
      reason: `Command '${rawBin}' is not in the allowed commands list and requires confirmation.`,
      argv,
    };
  }

  // 6. Check Git subcommand and options rules
  if (bin === 'git') {
    const gitEval = evaluateGitCommand(argv);
    if (!gitEval.allowed) {
      return {
        allowed: false,
        level: gitEval.level,
        reason: gitEval.reason || `git command rejected by policy`,
        argv,
      };
    }
  }

  return {
    allowed: true,
    level: 'safe',
    argv,
  };
}

/**
 * Convenience helper returning boolean allowed status (true only for 'safe' tier).
 */
export function isCommandAllowed(command: string, options?: PolicyOptions): boolean {
  return evaluateCommandPolicy(command, options).allowed;
}

/**
 * Formats an argv array into a safe Windows command line for cmd.exe (Fix 1b).
 * Every argument is wrapped in double quotes. Since arguments containing ", %, ^, !, \n, \r
 * are rejected in evaluateCommandPolicy on Windows, arguments cannot break out of quotes.
 */
export function formatWindowsCommandLine(argv: string[]): string {
  return argv.map((arg) => `"${arg}"`).join(' ');
}
