import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { SshTarget } from '@peep/shared';

const HOST_RE = /^([A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[?[0-9A-Fa-f:]+\]?)$/;
const USER_RE = /^[A-Za-z0-9._-]+$/;
// The command line is built for a shell, so key paths must not contain quoting/metacharacters.
const SAFE_PATH_RE = /^[^"'`$&|;<>^%!\r\n]+$/;

/** Validates the target and returns the ssh argument list. Throws on anything unsafe. */
export function buildSshArgs(target: SshTarget): string[] {
  const host = target.host?.trim() ?? '';
  const user = target.user?.trim() ?? '';
  if (!HOST_RE.test(host)) throw new Error('Enter a valid host name or IP address.');
  if (user && !USER_RE.test(user)) throw new Error('User name may only contain letters, digits, ".", "_" and "-".');

  const args: string[] = [];
  if (target.port !== undefined && target.port !== 22) {
    if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) throw new Error('Port must be between 1 and 65535.');
    args.push('-p', String(target.port));
  }
  const key = target.identityFile?.trim();
  if (key) {
    if (!SAFE_PATH_RE.test(key)) throw new Error('The key file path contains unsupported characters.');
    if (!existsSync(key)) throw new Error(`Key file not found: ${key}`);
    args.push('-i', key);
  }
  args.push(user ? `${user}@${host.replace(/^\[|\]$/g, '')}` : host.replace(/^\[|\]$/g, ''));
  return args;
}

const quote = (arg: string) => (/\s/.test(arg) ? `"${arg}"` : arg);

/** Opens the platform's terminal running `ssh <args>`. */
export function openSshTerminal(target: SshTarget): void {
  const args = buildSshArgs(target);
  const sshCommand = ['ssh', ...args.map(quote)].join(' ');

  if (process.platform === 'win32') {
    // `start` opens a new console window; `cmd /k` keeps it open after ssh exits so errors stay visible.
    spawn('cmd.exe', ['/c', 'start', '"Synkro SSH"', 'cmd.exe', '/k', sshCommand], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      windowsVerbatimArguments: true,
    }).unref();
  } else if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "${sshCommand.replace(/"/g, '\\"')}"\ntell application "Terminal" to activate`;
    spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('x-terminal-emulator', ['-e', 'ssh', ...args], { detached: true, stdio: 'ignore' }).unref();
  }
}
