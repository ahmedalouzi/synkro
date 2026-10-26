import { spawn, type ChildProcess } from 'node:child_process';
import { platform, homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import type { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '@peep/shared';
import type { RunCommandResult } from '@peep/shared';
import { globalIpcBatcher } from '../utils/ipc-batcher';

const ALLOWED_PREFIXES = [
  'flutter ',
  'dart ',
  'git status',
  'git diff',
  'git log',
  'git add',
  'git commit',
  'git branch',
  'pwd',
  'cd ',
  'dir',
  'ls',
  'echo ',
];

/** Kills a shell and everything it started (e.g. `npm start`), not just the shell itself. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (platform() === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill();
  }
}

type PtyModule = typeof import('@lydell/node-pty');
type Pty = import('@lydell/node-pty').IPty;

let ptyModule: PtyModule | null | undefined;

/** Loads node-pty lazily; null if the native module is unavailable (pipe fallback is used). */
function loadPty(): PtyModule | null {
  if (ptyModule === undefined) {
    try {
      ptyModule = require('@lydell/node-pty') as PtyModule;
    } catch (err) {
      console.error('[TerminalService] node-pty unavailable, falling back to pipes:', err);
      ptyModule = null;
    }
  }
  return ptyModule;
}

interface TerminalSession {
  process: ChildProcess;
  cwd: string;
  buffer: string;
  reject?: (reason?: any) => void;
}

export class TerminalService {
  /** Interactive terminals backed by a real pseudo-terminal (like VS Code's terminalProcess). */
  private ptySessions = new Map<string, Pty>();
  /** Fallback interactive terminals when node-pty can't load. */
  private sessions = new Map<string, TerminalSession>();
  private commandSessions = new Map<string, TerminalSession>();
  private mainWindow: BrowserWindow | null = null;
  private flutterSdkPath?: string;

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  private emitOutput(id: string, data: string): void {
    globalIpcBatcher.bufferString(IPC_EVENTS.TERMINAL_OUTPUT, id, data, 16, (flushId, accumulated) => {
      this.mainWindow?.webContents.send(IPC_EVENTS.TERMINAL_OUTPUT, { id: flushId, data: accumulated });
    });
  }

  setFlutterSdkPath(path: string | undefined): void {
    this.flutterSdkPath = path;
  }

  private getShell(): { command: string; args: string[] } {
    if (platform() === 'win32') {
      return { command: 'powershell.exe', args: ['-NoLogo'] };
    }
    return { command: process.env.SHELL ?? '/bin/bash', args: ['-i'] };
  }

  create(id: string, cwd: string, cols = 80, rows = 24): void {
    if (!cwd || !existsSync(cwd)) {
      console.warn(`[TerminalService] Provided cwd '${cwd}' does not exist. Falling back to homedir.`);
      cwd = homedir();
    }
    console.log(`[TerminalService] Creating terminal session for id: ${id}, cwd: ${cwd}`);
    this.destroy(id);

    const customEnv = { ...process.env };
    if (this.flutterSdkPath) {
      const binPath = join(this.flutterSdkPath, 'bin');
      const pathKeyActual = Object.keys(customEnv).find(k => k.toLowerCase() === 'path') || 'PATH';
      const existingPath = customEnv[pathKeyActual] || '';
      customEnv[pathKeyActual] = platform() === 'win32'
        ? `${binPath};${existingPath}`
        : `${binPath}:${existingPath}`;
    }

    const pty = loadPty();
    if (pty) {
      this.createPty(pty, id, cwd, customEnv, cols, rows);
      return;
    }

    const shell = this.getShell();
    const child = spawn(shell.command, shell.args, {
      cwd,
      env: customEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    const session: TerminalSession = { process: child, cwd, buffer: '' };
    this.sessions.set(id, session);

    const emit = (data: string) => {
      if (!this.sessions.has(id)) return;
      this.emitOutput(id, data);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      emit(chunk.toString().replace(/\r?\n/g, '\r\n'));
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      emit(chunk.toString().replace(/\r?\n/g, '\r\n'));
    });

    child.on('exit', (code) => {
      console.log(`[TerminalService] Process exited with code: ${code}`);
      const current = this.sessions.get(id);
      if (current && current.process === child) {
        this.sessions.delete(id);
      }
      this.mainWindow?.webContents.send(IPC_EVENTS.TERMINAL_EXIT, { id, code: code ?? 0 });
    });

    child.on('error', (error) => {
      console.error(`[TerminalService] Spawn error:`, error);
      emit(`\r\n[terminal error] ${error.message}\r\n`);
    });
  }

  private createPty(pty: PtyModule, id: string, cwd: string, env: NodeJS.ProcessEnv, cols: number, rows: number): void {
    const isWin = platform() === 'win32';
    const command = isWin ? 'powershell.exe' : process.env.SHELL ?? '/bin/bash';
    const args = isWin ? ['-NoLogo'] : platform() === 'darwin' ? ['-l'] : [];

    let proc: Pty;
    try {
      proc = pty.spawn(command, args, {
        name: 'xterm-256color',
        cols: Math.max(cols, 1),
        rows: Math.max(rows, 1),
        cwd,
        env: { ...env, TERM_PROGRAM: 'synkro', COLORTERM: 'truecolor' } as Record<string, string>,
      });
    } catch (error) {
      console.error('[TerminalService] PTY spawn error:', error);
      this.emitOutput(id, `\r\n[terminal error] ${(error as Error).message}\r\n`);
      return;
    }

    this.ptySessions.set(id, proc);
    proc.onData((data) => {
      if (this.ptySessions.get(id) === proc) this.emitOutput(id, data);
    });
    proc.onExit(({ exitCode }) => {
      if (this.ptySessions.get(id) !== proc) return;
      this.ptySessions.delete(id);
      this.mainWindow?.webContents.send(IPC_EVENTS.TERMINAL_EXIT, { id, code: exitCode });
    });
  }

  resize(id: string, cols: number, rows: number): void {
    const proc = this.ptySessions.get(id);
    if (!proc || cols < 1 || rows < 1) return;
    try {
      proc.resize(Math.floor(cols), Math.floor(rows));
    } catch {
      // The process may have exited between the check and the resize.
    }
  }

  write(id: string, data: string): void {
    const proc = this.ptySessions.get(id);
    if (proc) {
      proc.write(data);
      return;
    }

    const session = this.sessions.get(id);
    if (!session) {
      console.warn(`[TerminalService] No session found for id: ${id}`);
      return;
    }

    const emit = (str: string) => {
      this.emitOutput(id, str);
    };

    let i = 0;
    while (i < data.length) {
      const char = data[i];

      // Skip ANSI escape sequences (e.g. arrow keys starting with \x1b[)
      if (char === '\x1b') {
        i++;
        if (data[i] === '[') {
          i++;
          while (i < data.length) {
            const code = data.charCodeAt(i);
            if (code >= 0x40 && code <= 0x7E) {
              i++;
              break;
            }
            i++;
          }
        }
        continue;
      }

      if (char === '\r' || char === '\n') {
        const command = session.buffer;
        session.buffer = '';
        if (session.process.stdin?.writable) {
          session.process.stdin.write(command + '\r\n');
        } else {
          console.warn('[TerminalService] session.process.stdin is not writable!');
        }
        emit('\r\n');
      } else if (char === '\x7f' || char === '\x08') {
        if (session.buffer.length > 0) {
          session.buffer = session.buffer.slice(0, -1);
          emit('\b \b');
        }
      } else if (char === '\x03') {
        session.buffer = '';
        if (session.process.stdin?.writable) {
          session.process.stdin.write('\x03');
        }
        emit('^C\r\n');
      } else {
        const code = char.charCodeAt(0);
        if (code >= 32 || char === '\t') {
          session.buffer += char;
          emit(char);
        }
      }
      i++;
    }
  }

  destroy(id: string): void {
    const proc = this.ptySessions.get(id);
    if (proc) {
      // Delete first so the exit event isn't reported for a terminal the user closed.
      this.ptySessions.delete(id);
      try {
        proc.kill();
      } catch {
        // Already exited.
      }
      return;
    }

    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    killTree(session.process);
  }

  destroyAll(): void {
    for (const id of [...this.ptySessions.keys(), ...this.sessions.keys()]) {
      this.destroy(id);
    }
  }

  isCommandAllowed(command: string): boolean {
    const trimmed = command.trim().toLowerCase();
    if (!trimmed) return false;

    return ALLOWED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
  }

  async runCommand(command: string, cwd: string): Promise<RunCommandResult> {
    if (!this.isCommandAllowed(command)) {
      throw new Error(`Command not allowed: ${command}`);
    }

    return new Promise((resolve, reject) => {
      const shell = platform() === 'win32';
      const customEnv = { ...process.env };
      if (this.flutterSdkPath) {
        const binPath = join(this.flutterSdkPath, 'bin');
        const pathKeyActual = Object.keys(customEnv).find(k => k.toLowerCase() === 'path') || 'PATH';
        const existingPath = customEnv[pathKeyActual] || '';
        customEnv[pathKeyActual] = platform() === 'win32'
          ? `${binPath};${existingPath}`
          : `${binPath}:${existingPath}`;
      }

      const child = spawn(command, [], { cwd, shell, env: customEnv });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      child.on('error', reject);

      child.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });
    });
  }

  async streamCommand(id: string, command: string, cwd: string): Promise<number> {
    if (!this.isCommandAllowed(command)) {
      throw new Error(`Command not allowed: ${command}`);
    }

    if (!cwd || !existsSync(cwd)) {
      console.warn(`[TerminalService] Provided cwd '${cwd}' does not exist. Falling back to homedir.`);
      cwd = homedir();
    }

    return new Promise((resolve, reject) => {
      const shell = platform() === 'win32';
      const customEnv = { ...process.env };
      if (this.flutterSdkPath) {
        const binPath = join(this.flutterSdkPath, 'bin');
        const pathKeyActual = Object.keys(customEnv).find(k => k.toLowerCase() === 'path') || 'PATH';
        const existingPath = customEnv[pathKeyActual] || '';
        customEnv[pathKeyActual] = platform() === 'win32'
          ? `${binPath};${existingPath}`
          : `${binPath}:${existingPath}`;
      }

      const child = spawn(command, [], { cwd, shell, env: customEnv });
      const session: TerminalSession = { process: child, cwd, buffer: '', reject };
      this.commandSessions.set(id, session);

      const emit = (data: string) => {
        if (!this.commandSessions.has(id)) return; // stale chunk protection
        this.emitOutput(id, data);
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        emit(chunk.toString().replace(/\r?\n/g, '\r\n'));
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        emit(chunk.toString().replace(/\r?\n/g, '\r\n'));
      });

      child.on('error', (err) => {
        this.commandSessions.delete(id);
        reject(err);
      });

      child.on('close', (code) => {
        this.commandSessions.delete(id);
        clearTimeout(timeoutHandle);
        resolve(code ?? 1);
      });

      const timeoutHandle = setTimeout(() => {
        this.commandSessions.delete(id);
        killTree(child);
        reject(new Error(`Command timed out after 120s: ${command}`));
      }, 120000);
    });
  }

  cancelCommand(id: string): void {
    const session = this.commandSessions.get(id);
    if (!session) return;
    killTree(session.process);
    this.commandSessions.delete(id);
    if (session.reject) {
      session.reject(new Error('Command cancelled'));
    }
  }
}
