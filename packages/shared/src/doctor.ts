/**
 * Atomvs Doctor shared types and pure check evaluators.
 *
 * Evaluates the 5 local environment checks:
 *  1. Flutter SDK (installed, version, not inside a cloud-synced folder)
 *  2. Flutter startup lock (`<sdk>/bin/cache/lockfile`: none, stale, Atomvs-owned, or external PID)
 *  3. Node.js & npm (for Expo / React Native)
 *  4. Android SDK, Java, and adb (optional when using Cloud Build)
 *  5. Free disk space
 */

export type DoctorCheckId =
  | 'flutter-sdk'
  | 'startup-lock'
  | 'node-npm'
  | 'android-toolchain'
  | 'disk-space';

export type DoctorStatus = 'ok' | 'warn' | 'error';

export type DoctorFixKind =
  | 'choose-flutter-sdk'
  | 'release-startup-lock'
  | 'clean-atomvs-cache'
  | 'install-flutter-guide'
  | 'install-node-guide'
  | 'install-android-guide';

export interface DoctorCheckItem {
  id: DoctorCheckId;
  title: string;
  status: DoctorStatus;
  summary: string;
  detail?: string;
  path?: string;
  version?: string;
  fixKind?: DoctorFixKind;
  fixLabel?: string;
}

export interface DoctorReport {
  checkedAt: string;
  overall: DoctorStatus;
  errorCount: number;
  warnCount: number;
  okCount: number;
  checks: DoctorCheckItem[];
}

export interface DoctorFixResult {
  ok: boolean;
  fixKind: DoctorFixKind;
  message: string;
  report?: DoctorReport;
}

export interface FlutterSdkCheckInput {
  found: boolean;
  sdkPath?: string | null;
  version?: string | null;
  syncedFolder?: string | null;
}

export function evaluateFlutterSdkCheck(input: FlutterSdkCheckInput): DoctorCheckItem {
  if (!input.found) {
    return {
      id: 'flutter-sdk',
      title: 'Flutter SDK',
      status: 'error',
      summary: 'Flutter SDK not found',
      detail: 'Install Flutter or select your Flutter SDK folder in Settings (outside OneDrive, Dropbox, Google Drive, or iCloud Drive).',
      fixKind: 'install-flutter-guide',
      fixLabel: 'Install Flutter Guide',
    };
  }

  if (input.syncedFolder) {
    return {
      id: 'flutter-sdk',
      title: 'Flutter SDK',
      status: 'error',
      summary: `Flutter SDK is inside ${input.syncedFolder}`,
      detail: `${input.syncedFolder} locks Flutter files while syncing, causing preview and pub failures. Move Flutter to a local folder such as C:\\src\\flutter and choose the new location.`,
      path: input.sdkPath ?? undefined,
      version: input.version ?? undefined,
      fixKind: 'choose-flutter-sdk',
      fixLabel: 'Choose Flutter SDK',
    };
  }

  const ver = input.version ? `Flutter ${input.version}` : 'Flutter detected';
  return {
    id: 'flutter-sdk',
    title: 'Flutter SDK',
    status: 'ok',
    summary: `${ver} ready`,
    detail: input.sdkPath ? `Located at ${input.sdkPath} (not in a cloud-synced folder).` : 'Detected on PATH.',
    path: input.sdkPath ?? undefined,
    version: input.version ?? undefined,
  };
}

export interface StartupLockCheckInput {
  sdkPath?: string | null;
  lockExists: boolean;
  lockFilePath?: string | null;
  holderPid?: number | null;
  holderAlive?: boolean;
  ownedByAtomvs?: boolean;
  syncedFolder?: string | null;
}

export function evaluateStartupLockCheck(input: StartupLockCheckInput): DoctorCheckItem {
  if (!input.lockExists) {
    return {
      id: 'startup-lock',
      title: 'Flutter Startup Lock',
      status: 'ok',
      summary: 'No startup lock active',
      detail: input.sdkPath
        ? 'No other Flutter command is holding the SDK startup lock.'
        : 'Flutter SDK path not detected; no lock detected.',
      path: input.lockFilePath ?? undefined,
    };
  }

  if (!input.holderAlive) {
    return {
      id: 'startup-lock',
      title: 'Flutter Startup Lock',
      status: 'warn',
      summary: 'Stale Flutter startup lockfile found',
      detail: 'A leftover bin/cache/lockfile was found whose process is no longer running. Releasing the lock removes this stale file.',
      path: input.lockFilePath ?? undefined,
      fixKind: 'release-startup-lock',
      fixLabel: 'Release Startup Lock',
    };
  }

  if (input.ownedByAtomvs) {
    return {
      id: 'startup-lock',
      title: 'Flutter Startup Lock',
      status: 'warn',
      summary: `Held by an Atomvs Flutter command (PID ${input.holderPid})`,
      detail: 'A Flutter command started by Atomvs currently holds the SDK startup lock. You can stop that Atomvs-owned command and clear the lock.',
      path: input.lockFilePath ?? undefined,
      fixKind: 'release-startup-lock',
      fixLabel: 'Release Startup Lock',
    };
  }

  const syncNote = input.syncedFolder
    ? ` Your SDK is also inside ${input.syncedFolder}, which can prevent Flutter commands from finishing.`
    : '';
  return {
    id: 'startup-lock',
    title: 'Flutter Startup Lock',
    status: 'error',
    summary: input.holderPid
      ? `Held outside Atomvs (PID ${input.holderPid})`
      : 'Held by another Flutter command outside Atomvs',
    detail: `Another Flutter command outside Atomvs (in another terminal or IDE) is holding bin/cache/lockfile. Close it or wait for it to finish, then re-run Doctor.${syncNote}`,
    path: input.lockFilePath ?? undefined,
    fixKind: 'release-startup-lock',
    fixLabel: 'Check & Release Lock',
  };
}

export interface NodeNpmCheckInput {
  nodeVersion?: string | null;
  npmVersion?: string | null;
}

export function evaluateNodeNpmCheck(input: NodeNpmCheckInput): DoctorCheckItem {
  const hasNode = !!input.nodeVersion;
  const hasNpm = !!input.npmVersion;

  if (hasNode && hasNpm) {
    return {
      id: 'node-npm',
      title: 'Node.js & npm (Expo)',
      status: 'ok',
      summary: `Node ${input.nodeVersion} · npm ${input.npmVersion}`,
      detail: 'Ready for Expo and React Native previews and dependency checks.',
      version: `${input.nodeVersion} / npm ${input.npmVersion}`,
    };
  }

  const missing: string[] = [];
  if (!hasNode) missing.push('Node.js');
  if (!hasNpm) missing.push('npm');

  return {
    id: 'node-npm',
    title: 'Node.js & npm (Expo)',
    status: 'error',
    summary: `Missing ${missing.join(' and ')}`,
    detail: 'Expo and React Native projects require Node.js and npm on PATH for local previews and package management.',
    version: input.nodeVersion ?? undefined,
    fixKind: 'install-node-guide',
    fixLabel: 'Install Node.js Guide',
  };
}

export interface AndroidToolchainCheckInput {
  androidSdkPath?: string | null;
  javaVersion?: string | null;
  adbVersion?: string | null;
}

export function evaluateAndroidToolchainCheck(input: AndroidToolchainCheckInput): DoctorCheckItem {
  const hasSdk = !!input.androidSdkPath;
  const hasJava = !!input.javaVersion;
  const hasAdb = !!input.adbVersion;

  if (hasSdk && hasJava && hasAdb) {
    return {
      id: 'android-toolchain',
      title: 'Android SDK, Java & adb',
      status: 'ok',
      summary: 'Android SDK, Java, and adb ready',
      detail: `Java ${input.javaVersion} · adb ${input.adbVersion}`,
      path: input.androidSdkPath ?? undefined,
      version: input.javaVersion ?? undefined,
    };
  }

  const missing: string[] = [];
  if (!hasSdk) missing.push('Android SDK');
  if (!hasJava) missing.push('Java');
  if (!hasAdb) missing.push('adb');

  return {
    id: 'android-toolchain',
    title: 'Android SDK, Java & adb',
    status: 'warn',
    summary: `Missing: ${missing.join(', ')}`,
    detail: 'Required for local Android builds and USB device runs. Cloud Build still works without local Android tools.',
    path: input.androidSdkPath ?? undefined,
    version: input.javaVersion ?? undefined,
    fixKind: 'install-android-guide',
    fixLabel: 'Android Setup Guide',
  };
}

export interface DiskSpaceCheckInput {
  freeBytes: number | null;
  checkPath?: string | null;
}

const BYTES_PER_GB = 1024 * 1024 * 1024;
export const DISK_ERROR_THRESHOLD_BYTES = 2 * BYTES_PER_GB;
export const DISK_WARN_THRESHOLD_BYTES = 5 * BYTES_PER_GB;

export function evaluateDiskSpaceCheck(input: DiskSpaceCheckInput): DoctorCheckItem {
  if (input.freeBytes === null || !Number.isFinite(input.freeBytes) || input.freeBytes < 0) {
    return {
      id: 'disk-space',
      title: 'Disk Space',
      status: 'warn',
      summary: 'Unable to measure free disk space',
      detail: 'Could not query free space on the target drive.',
      path: input.checkPath ?? undefined,
    };
  }

  const freeGb = (input.freeBytes / BYTES_PER_GB).toFixed(1);

  if (input.freeBytes < DISK_ERROR_THRESHOLD_BYTES) {
    return {
      id: 'disk-space',
      title: 'Disk Space',
      status: 'error',
      summary: `Critically low disk space (${freeGb} GB free)`,
      detail: 'Less than 2 GB free. Builds, pub/npm caches, and previews may fail with ENOSPC. Clean temporary caches or free disk space.',
      path: input.checkPath ?? undefined,
      fixKind: 'clean-atomvs-cache',
      fixLabel: 'Clean Atomvs Cache',
    };
  }

  if (input.freeBytes < DISK_WARN_THRESHOLD_BYTES) {
    return {
      id: 'disk-space',
      title: 'Disk Space',
      status: 'warn',
      summary: `Low disk space (${freeGb} GB free)`,
      detail: 'Less than 5 GB free. Consider cleaning Atomvs temporary caches before running builds.',
      path: input.checkPath ?? undefined,
      fixKind: 'clean-atomvs-cache',
      fixLabel: 'Clean Atomvs Cache',
    };
  }

  return {
    id: 'disk-space',
    title: 'Disk Space',
    status: 'ok',
    summary: `${freeGb} GB free`,
    detail: 'Sufficient free space for local previews and dependency caches.',
    path: input.checkPath ?? undefined,
  };
}

export function summarizeDoctorReport(checks: DoctorCheckItem[], checkedAt = new Date().toISOString()): DoctorReport {
  let errorCount = 0;
  let warnCount = 0;
  let okCount = 0;
  for (const check of checks) {
    if (check.status === 'error') errorCount++;
    else if (check.status === 'warn') warnCount++;
    else okCount++;
  }
  const overall: DoctorStatus = errorCount > 0 ? 'error' : warnCount > 0 ? 'warn' : 'ok';
  return {
    checkedAt,
    overall,
    errorCount,
    warnCount,
    okCount,
    checks,
  };
}
