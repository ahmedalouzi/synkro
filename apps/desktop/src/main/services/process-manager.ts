import { spawn, exec, type ChildProcess } from 'node:child_process';
import { platform } from 'node:os';
import { join } from 'node:path';

export interface ProcessInfo {
  id: number;
  command: string;
  process: ChildProcess;
  status: 'starting' | 'running' | 'degraded' | 'error' | 'crashed' | 'stopped' | 'exited' | 'unknown';
  stdout: string;
  stderr: string;
  exitCode: number | null;
  startedAt: string;
}

// cmd.exe metacharacters, escaped with ^ (same rules as the cross-spawn package).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** One argument for a cmd.exe command line: quoted for the program's own parser, then escaped for cmd.exe. */
export function escapeCmdArgument(arg: string): string {
  let quoted = arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, '$1$1');
  quoted = `"${quoted}"`;
  return quoted.replace(CMD_META, '^$1');
}

/**
 * How to start `command args` on Windows. .cmd/.bat files (npm.cmd, npx.cmd, flutter.bat) and bare names
 * resolved through PATHEXT ('flutter', 'npx') need cmd.exe, and Node >= 18.20.2 / 20.12.2 refuses to spawn
 * .cmd/.bat without a shell (EINVAL, CVE-2024-27980). Node's own `shell: true` joins the arguments without
 * quoting, so spaces in paths break and characters like & | ^ in an argument are run by cmd.exe. Instead every
 * argument is quoted and escaped, and cmd.exe gets the line verbatim. A real .exe is spawned directly.
 * Exported for tests.
 */
export function windowsSpawnArgs(command: string, args: string[]): { file: string; args: string[]; verbatim: boolean } {
  if (/\.(exe|com)$/i.test(command)) return { file: command, args, verbatim: false };
  const line = [command.replace(CMD_META, '^$1'), ...args.map(escapeCmdArgument)].join(' ');
  return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], verbatim: true };
}

export class ProcessManager {
  private processes = new Map<number, ProcessInfo>();
  private nextId = 1;
  private flutterSdkPath?: string;

  setFlutterSdkPath(path: string | undefined): void {
    this.flutterSdkPath = path;
  }

  /**
   * Starts `command` with `args` passed as separate arguments, never as a shell string. On Windows see
   * windowsSpawnArgs(). Elsewhere `shell: true` is honored for callers that ask for it.
   */
  spawn(command: string, args: string[], cwd: string, envOverrides?: Record<string, string>, spawnOpts?: { shell?: boolean }): ProcessInfo {
    const customEnv = { ...process.env, ...envOverrides };
    if (this.flutterSdkPath) {
      const binPath = join(this.flutterSdkPath, 'bin');
      const pathKeyActual = Object.keys(customEnv).find(k => k.toLowerCase() === 'path') || 'PATH';
      const existingPath = customEnv[pathKeyActual] || '';
      customEnv[pathKeyActual] = platform() === 'win32'
        ? `${binPath};${existingPath}`
        : `${binPath}:${existingPath}`;
    }

    const win = platform() === 'win32' ? windowsSpawnArgs(command, args) : null;
    const child = spawn(win ? win.file : command, win ? win.args : args, {
      cwd,
      shell: win ? false : spawnOpts?.shell ?? false,
      windowsVerbatimArguments: win?.verbatim,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: customEnv,
    });

    const info: ProcessInfo = {
      id: this.nextId++,
      command: [command, ...args].join(' '),
      process: child,
      status: 'running',
      stdout: '',
      stderr: '',
      exitCode: null,
      startedAt: new Date().toISOString()
    };

    child.stdout?.on('data', (chunk) => {
      info.stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      info.stderr += chunk.toString();
    });

    this.processes.set(info.id, info);

    child.on('exit', (code) => {
      info.exitCode = code;
      info.status = code === 0 ? 'exited' : (code === null ? 'stopped' : 'crashed');
    });

    return info;
  }

  writeStdin(id: number, data: string): boolean {
    const info = this.processes.get(id);
    if (!info?.process.stdin?.writable) return false;
    info.process.stdin.write(data);
    return true;
  }

  kill(id: number): boolean {
    const info = this.processes.get(id);
    if (!info) return false;

    const pid = info.process.pid;
    if (pid && platform() === 'win32') {
      exec(`taskkill /pid ${pid} /f /t`, (err) => {
        if (err) {
          console.error(`Failed to kill process tree for PID ${pid}:`, err);
          info.process.kill();
        }
      });
    } else {
      info.process.kill();
    }

    info.status = 'stopped';
    return true;
  }

  get(id: number): ProcessInfo | undefined {
    return this.processes.get(id);
  }

  killAll(): void {
    for (const info of this.processes.values()) {
      const pid = info.process.pid;
      if (pid && platform() === 'win32') {
        exec(`taskkill /pid ${pid} /f /t`);
      } else {
        info.process.kill();
      }
    }
    this.processes.clear();
  }
}
