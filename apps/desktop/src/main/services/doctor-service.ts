import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { evaluateDoctor, type DoctorProbes, type DoctorReport } from '@peep/shared';

/** Runs a program (no shell) and returns its output, or null when it is missing, fails or takes too long. */
export type ProbeRunner = (file: string, args: string[], timeoutMs: number) => Promise<string | null>;

export const runProbe: ProbeRunner = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve(err ? null : `${stdout}${stderr}`.trim() || null);
      });
    } catch {
      resolve(null);
    }
  });

/** The hosts a new project needs: Flutter packages, npm packages, and Atomvs itself. Only a HEAD request, no data. */
export function doctorHosts(gatewayUrl: string): Record<string, string> {
  const hosts: Record<string, string> = { 'pub.dev': 'https://pub.dev/', 'registry.npmjs.org': 'https://registry.npmjs.org/' };
  try {
    const url = new URL(gatewayUrl);
    hosts[url.host] = `${url.origin}/`;
  } catch {
    // no gateway configured
  }
  return hosts;
}

async function reachable(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    return res.status > 0;
  } catch {
    return false;
  }
}

/** A REG_DWORD from `reg query` (read-only): true for 0x1, false for 0x0 or a missing value, null if reg failed. */
export function parseRegDword(output: string | null, name: string): boolean | null {
  if (output === null) return null;
  const m = new RegExp(`${name}\\s+REG_DWORD\\s+0x([0-9a-f]+)`, 'i').exec(output);
  return m ? Number.parseInt(m[1], 16) === 1 : false;
}

export interface DoctorDeps {
  detectFlutter: () => Promise<{ version: string; path: string } | null>;
  gatewayUrl: string;
  projectPath: string | null;
  run?: ProbeRunner;
  ping?: (url: string) => Promise<boolean>;
  platform?: string;
  env?: Record<string, string | undefined>;
}

/** Gathers the facts and evaluates them. Read-only: nothing on the machine is changed. */
export async function runDoctor(deps: DoctorDeps): Promise<DoctorReport> {
  const run = deps.run ?? runProbe;
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const win = platform === 'win32';
  const ping = deps.ping ?? ((url: string) => reachable(url, 6000));
  const hosts = doctorHosts(deps.gatewayUrl);

  // `reg query` exits with an error when the value is not set, which for both values means off.
  const regKey = async (key: string, name: string) => (win ? (await run('reg', ['query', key, '/v', name], 5000)) ?? '' : null);
  const [flutter, git, node, devMode, longPaths, free, net] = await Promise.all([
    deps.detectFlutter().catch(() => null),
    run('git', ['--version'], 8000),
    run('node', ['--version'], 8000),
    regKey('HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock', 'AllowDevelopmentWithoutDevLicense'),
    regKey('HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem', 'LongPathsEnabled'),
    statfs(deps.projectPath ?? homedir()).then((s) => s.bavail * s.bsize).catch(() => null),
    Promise.all(Object.entries(hosts).map(async ([host, url]) => [host, await ping(url)] as const)),
  ]);

  let project: DoctorProbes['project'] = null;
  if (deps.projectPath) {
    const p = deps.projectPath;
    const framework = existsSync(join(p, 'pubspec.yaml')) ? 'flutter' : existsSync(join(p, 'package.json')) ? 'react-native' : null;
    const depsInstalled = framework === 'flutter'
      ? existsSync(join(p, '.dart_tool', 'package_config.json'))
      : framework === 'react-native' ? existsSync(join(p, 'node_modules', '.package-lock.json')) || existsSync(join(p, 'node_modules', 'react-native', 'package.json')) : false;
    project = { path: p, framework, depsInstalled };
  }

  const probes: DoctorProbes = {
    platform,
    flutter: flutter ? { version: flutter.version, sdkPath: flutter.path && flutter.path !== 'PATH' ? flutter.path : null } : null,
    git,
    node,
    developerMode: parseRegDword(devMode, 'AllowDevelopmentWithoutDevLicense'),
    longPathsEnabled: parseRegDword(longPaths, 'LongPathsEnabled'),
    homeDir: homedir(),
    pubCacheSet: Boolean(env.PUB_CACHE),
    freeBytes: free,
    network: Object.fromEntries(net),
    project,
    env: { OneDrive: env.OneDrive, OneDriveConsumer: env.OneDriveConsumer, OneDriveCommercial: env.OneDriveCommercial },
  };
  return { checks: evaluateDoctor(probes), ranAt: new Date().toISOString() };
}
