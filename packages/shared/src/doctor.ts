/**
 * Atomvs Doctor: the checks a new (mostly Windows) user's machine needs for Flutter and Expo, each with a safe fix.
 *
 * The main process gathers the facts (DoctorProbes: versions, two read-only registry values, free space, three
 * HEAD requests, the open project's files); evaluateDoctor turns them into checks. The window shows them in the
 * user's language from the check id, status and params. A fix is an id: the main process maps it to a fixed
 * action (open a Windows settings page or a download page, install the open project's dependencies). No fix needs
 * admin rights, writes the registry, or stops a process.
 */
import { syncedFolderOf } from './flutter-environment';

export type DoctorCheckId =
  | 'flutter-sdk'
  | 'flutter-sdk-location'
  | 'git'
  | 'node'
  | 'windows-developer-mode'
  | 'windows-long-paths'
  | 'home-path'
  | 'disk-space'
  | 'network'
  | 'project-location'
  | 'project-deps';

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip';

/** Fixes the window handles itself. */
export type DoctorUiFix = 'open-sdk-settings' | 'retry';
/** Fixes the main process runs: the only ones DOCTOR_FIX accepts. */
export type DoctorMainFix = 'open-developer-settings' | 'install-git' | 'install-node' | 'long-paths-guide' | 'install-project-deps';
export type DoctorFix = DoctorUiFix | DoctorMainFix;

export const DOCTOR_MAIN_FIXES: readonly DoctorMainFix[] = [
  'open-developer-settings', 'install-git', 'install-node', 'long-paths-guide', 'install-project-deps',
];

/** The pages the link fixes open (fixed here; the window never sends a URL). */
export const DOCTOR_FIX_URLS: Record<'install-git' | 'install-node' | 'long-paths-guide', string> = {
  'install-git': 'https://git-scm.com/download/win',
  'install-node': 'https://nodejs.org/en/download',
  'long-paths-guide': 'https://learn.microsoft.com/windows/win32/fileio/maximum-file-path-limitation#enable-long-paths-in-windows-10-version-1607-and-later',
};

export interface DoctorCheck {
  id: DoctorCheckId;
  status: DoctorStatus;
  /** Values for the message (version, folder, GB, hosts). */
  params?: Record<string, string | number>;
  fix?: DoctorFix;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ranAt: string;
}

export interface DoctorFixResult {
  ok: boolean;
  /** A short reason when it failed (the end of the installer's output). */
  error?: string;
}

export interface DoctorProbes {
  platform: string;
  /** `flutter --version` worked: its version and the SDK folder (null when Flutter comes from PATH). */
  flutter: { version: string; sdkPath: string | null } | null;
  /** `git --version` / `node --version` output, or null when the command is missing. */
  git: string | null;
  node: string | null;
  /** Windows only (null elsewhere or when the value could not be read). */
  developerMode: boolean | null;
  longPathsEnabled: boolean | null;
  homeDir: string;
  /** PUB_CACHE is set (then the home folder's name does not matter to Flutter). */
  pubCacheSet: boolean;
  /** Free space on the drive of the open project (or the home folder), or null. */
  freeBytes: number | null;
  /** Host → reachable. */
  network: Record<string, boolean>;
  project: { path: string; framework: 'flutter' | 'react-native' | null; depsInstalled: boolean } | null;
  env: Record<string, string | undefined>;
}

const GB = 1024 ** 3;
/** Spaces or non-ASCII characters: Flutter's Windows tooling (and some Gradle plugins) break on them. */
const AWKWARD_PATH = /[\s]|[^\x00-\x7f]/;

function versionMajor(text: string | null): number | null {
  const m = /(\d+)\.\d+/.exec(text ?? '');
  return m ? Number(m[1]) : null;
}

/** The checks, in the order they are shown. Exported for tests. */
export function evaluateDoctor(p: DoctorProbes): DoctorCheck[] {
  const win = p.platform === 'win32';
  const checks: DoctorCheck[] = [];
  const projectFramework = p.project?.framework ?? null;

  // Flutter: required for Flutter projects; for an Expo-only user a missing SDK is a note, not a failure.
  if (p.flutter) {
    checks.push({ id: 'flutter-sdk', status: 'ok', params: { version: p.flutter.version } });
  } else {
    checks.push({ id: 'flutter-sdk', status: projectFramework === 'flutter' ? 'fail' : 'warn', fix: 'open-sdk-settings' });
  }

  const sdkPath = p.flutter?.sdkPath ?? null;
  if (!sdkPath) {
    checks.push({ id: 'flutter-sdk-location', status: 'skip' });
  } else {
    const synced = syncedFolderOf(sdkPath, p.env);
    if (synced) checks.push({ id: 'flutter-sdk-location', status: 'warn', params: { reason: 'synced', folder: synced, path: sdkPath }, fix: 'open-sdk-settings' });
    else if (win && AWKWARD_PATH.test(sdkPath)) checks.push({ id: 'flutter-sdk-location', status: 'warn', params: { reason: 'characters', path: sdkPath }, fix: 'open-sdk-settings' });
    else checks.push({ id: 'flutter-sdk-location', status: 'ok', params: { path: sdkPath } });
  }

  // Git: Flutter itself needs it (and so do most package installs from git).
  checks.push(p.git
    ? { id: 'git', status: 'ok', params: { version: /(\d+\.\d+(\.\d+)?)/.exec(p.git)?.[1] ?? p.git.trim() } }
    : { id: 'git', status: 'fail', fix: 'install-git' });

  // Node.js 18+ for Expo (SDK 50+).
  const nodeMajor = versionMajor(p.node);
  if (!p.node) checks.push({ id: 'node', status: projectFramework === 'react-native' ? 'fail' : 'warn', fix: 'install-node' });
  else if (nodeMajor !== null && nodeMajor < 18) checks.push({ id: 'node', status: 'fail', params: { version: p.node.trim() }, fix: 'install-node' });
  else checks.push({ id: 'node', status: 'ok', params: { version: p.node.trim() } });

  // Windows: Flutter plugins need symlinks (Developer Mode); deep node_modules / Gradle paths need long paths.
  if (!win || p.developerMode === null) checks.push({ id: 'windows-developer-mode', status: 'skip' });
  else checks.push(p.developerMode
    ? { id: 'windows-developer-mode', status: 'ok' }
    : { id: 'windows-developer-mode', status: 'warn', fix: 'open-developer-settings' });
  if (!win || p.longPathsEnabled === null) checks.push({ id: 'windows-long-paths', status: 'skip' });
  else checks.push(p.longPathsEnabled
    ? { id: 'windows-long-paths', status: 'ok' }
    : { id: 'windows-long-paths', status: 'warn', fix: 'long-paths-guide' });

  // A user folder with spaces or non-ASCII letters breaks Flutter's package cache (unless PUB_CACHE moves it).
  if (!win) checks.push({ id: 'home-path', status: 'skip' });
  else if (AWKWARD_PATH.test(p.homeDir) && !p.pubCacheSet) checks.push({ id: 'home-path', status: 'warn', params: { path: p.homeDir } });
  else checks.push({ id: 'home-path', status: 'ok' });

  if (p.freeBytes === null) checks.push({ id: 'disk-space', status: 'skip' });
  else {
    const gb = Math.floor((p.freeBytes / GB) * 10) / 10;
    checks.push({ id: 'disk-space', status: p.freeBytes < 5 * GB ? 'fail' : p.freeBytes < 10 * GB ? 'warn' : 'ok', params: { gb } });
  }

  const down = Object.entries(p.network).filter(([, ok]) => !ok).map(([host]) => host);
  checks.push(down.length === 0
    ? { id: 'network', status: 'ok' }
    : { id: 'network', status: 'fail', params: { hosts: down.join(', ') }, fix: 'retry' });

  if (!p.project) {
    checks.push({ id: 'project-location', status: 'skip' }, { id: 'project-deps', status: 'skip' });
  } else {
    const synced = syncedFolderOf(p.project.path, p.env);
    checks.push(synced
      ? { id: 'project-location', status: 'warn', params: { folder: synced } }
      : { id: 'project-location', status: 'ok' });
    if (!p.project.framework) checks.push({ id: 'project-deps', status: 'skip' });
    else checks.push(p.project.depsInstalled
      ? { id: 'project-deps', status: 'ok', params: { framework: p.project.framework } }
      : { id: 'project-deps', status: 'warn', params: { framework: p.project.framework }, fix: 'install-project-deps' });
  }
  return checks;
}
