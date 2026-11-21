import { dialog, type BrowserWindow } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { open, readdir, readFile, rm, stat, statfs, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateAndroidToolchainCheck,
  evaluateDiskSpaceCheck,
  evaluateFlutterSdkCheck,
  evaluateNodeNpmCheck,
  evaluateStartupLockCheck,
  summarizeDoctorReport,
  syncedFolderOf,
  type DoctorFixKind,
  type DoctorFixResult,
  type DoctorReport,
} from '@peep/shared';
import { openExternalSafely } from '../safe-external';
import { isFlutterCommand, sdkFromPath } from './flutter-service';
import { cleanUserProjectEnv, windowsSpawnArgs, type ProcessManager } from './process-manager';

const COMMAND_TIMEOUT_MS = 10_000;

const DOC_URLS: Record<'install-flutter-guide' | 'install-node-guide' | 'install-android-guide', string> = {
  'install-flutter-guide': 'https://docs.flutter.dev/get-started/install',
  'install-node-guide': 'https://nodejs.org/en/download',
  'install-android-guide': 'https://developer.android.com/studio',
};

const ATOMVS_TEMP_PREFIXES = ['atomvs-', 'peep-', 'synkro-build-', 'atomvs-preview-'];

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runQuickCommand(command: string, args: string[], timeoutMs = COMMAND_TIMEOUT_MS): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const env = cleanUserProjectEnv();
    const isWin = process.platform === 'win32';
    const spawnSpec = isWin ? windowsSpawnArgs(command, args) : { file: command, args, verbatim: false };
    execFile(
      spawnSpec.file,
      spawnSpec.args,
      {
        env,
        timeout: timeoutMs,
        windowsHide: true,
        windowsVerbatimArguments: spawnSpec.verbatim,
        maxBuffer: 1024 * 1024,
      },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ''}\n${stderr ?? ''}`.trim();
        resolve({ ok: !err, output });
      },
    );
  });
}

function detectAndroidSdkPath(env: NodeJS.ProcessEnv): string | null {
  const candidates: string[] = [];
  if (env.ANDROID_HOME) candidates.push(env.ANDROID_HOME);
  if (env.ANDROID_SDK_ROOT) candidates.push(env.ANDROID_SDK_ROOT);

  if (process.platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(path.join(localAppData, 'Android', 'Sdk'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  } else {
    candidates.push(path.join(os.homedir(), 'Android', 'Sdk'));
  }

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function isLockfileExclusivelyHeld(lockFilePath: string): Promise<boolean> {
  try {
    const handle = await open(lockFilePath, 'r+');
    await handle.close();
    return false;
  } catch (err: any) {
    return err?.code === 'EBUSY' || err?.code === 'EPERM' || err?.code === 'EACCES';
  }
}

export interface DoctorServiceDeps {
  processManager: ProcessManager;
  getConfiguredFlutterSdkPath: () => string | undefined;
  setConfiguredFlutterSdkPath: (sdkPath: string | undefined) => Promise<void>;
  getOwnedPids?: () => number[];
}

export class DoctorService {
  constructor(private readonly deps: DoctorServiceDeps) {}

  private resolveFlutterSdkPath(): string | null {
    const configured = this.deps.getConfiguredFlutterSdkPath()?.trim();
    if (configured) return configured;
    return sdkFromPath(process.env.PATH ?? process.env.Path ?? '', process.platform === 'win32');
  }

  private getFlutterBinary(sdkPath: string | null): string {
    const binName = process.platform === 'win32' ? 'flutter.bat' : 'flutter';
    if (sdkPath) {
      const candidate = path.join(sdkPath, 'bin', binName);
      if (existsSync(candidate)) return candidate;
    }
    return binName;
  }

  private getOwnedPidSet(): Set<number> {
    const pids = new Set<number>(this.deps.processManager.pids());
    for (const pid of this.deps.getOwnedPids?.() ?? []) {
      pids.add(pid);
    }
    return pids;
  }

  private async inspectStartupLock(sdkPath: string | null, syncedFolder: string | null) {
    if (!sdkPath) {
      return evaluateStartupLockCheck({ sdkPath: null, lockExists: false, syncedFolder });
    }
    const lockFilePath = path.join(sdkPath, 'bin', 'cache', 'lockfile');
    if (!existsSync(lockFilePath)) {
      return evaluateStartupLockCheck({ sdkPath, lockExists: false, lockFilePath, syncedFolder });
    }

    let raw = '';
    try {
      raw = (await readFile(lockFilePath, 'utf8')).trim();
    } catch {
      // On Windows, reading an exclusively locked file can fail with EBUSY/EACCES.
      const ownedRunning = this.hasRunningAtomvsFlutterProcess();
      return evaluateStartupLockCheck({
        sdkPath,
        lockExists: true,
        lockFilePath,
        holderPid: null,
        holderAlive: true,
        ownedByAtomvs: ownedRunning,
        syncedFolder,
      });
    }

    const parsedPid = /^\d+$/.test(raw) ? Number(raw) : null;
    if (parsedPid && parsedPid > 0) {
      const holderAlive = isPidAlive(parsedPid);
      const ownedByAtomvs = this.getOwnedPidSet().has(parsedPid);
      return evaluateStartupLockCheck({
        sdkPath,
        lockExists: true,
        lockFilePath,
        holderPid: parsedPid,
        holderAlive,
        ownedByAtomvs,
        syncedFolder,
      });
    }

    // Flutter normally leaves an empty 0-byte bin/cache/lockfile behind after clean runs.
    // Only report a lock when the OS confirms the file is exclusively held right now.
    const held = await isLockfileExclusivelyHeld(lockFilePath);
    if (!held) {
      return evaluateStartupLockCheck({ sdkPath, lockExists: false, lockFilePath, syncedFolder });
    }

    const ownedRunning = this.hasRunningAtomvsFlutterProcess();
    return evaluateStartupLockCheck({
      sdkPath,
      lockExists: true,
      lockFilePath,
      holderPid: null,
      holderAlive: true,
      ownedByAtomvs: ownedRunning,
      syncedFolder,
    });
  }

  private hasRunningAtomvsFlutterProcess(): boolean {
    const pm = this.deps.processManager as unknown as {
      processes?: Map<number, { command: string; status: string; process: { exitCode: number | null; signalCode: string | null } }>;
    };
    if (!pm.processes) return false;
    for (const info of pm.processes.values()) {
      if (info.process.exitCode === null && info.process.signalCode === null && info.status !== 'stopped' && isFlutterCommand(info.command)) {
        return true;
      }
    }
    return false;
  }

  async runDoctor(projectPath?: string): Promise<DoctorReport> {
    const normalizedProjectPath = projectPath ? path.resolve(projectPath) : undefined;
    const sdkPath = this.resolveFlutterSdkPath();
    const syncedFolder = sdkPath ? syncedFolderOf(sdkPath, process.env) : null;

    const [flutterCheck, lockCheck, nodeCheck, androidCheck, diskCheck] = await Promise.all([
      this.checkFlutterSdk(sdkPath, syncedFolder),
      this.inspectStartupLock(sdkPath, syncedFolder),
      this.checkNodeNpm(),
      this.checkAndroidToolchain(),
      this.checkDiskSpace(normalizedProjectPath),
    ]);

    return summarizeDoctorReport([flutterCheck, lockCheck, nodeCheck, androidCheck, diskCheck]);
  }

  private async checkFlutterSdk(sdkPath: string | null, syncedFolder: string | null) {
    const bin = this.getFlutterBinary(sdkPath);
    const res = await runQuickCommand(bin, ['--version'], 15_000);
    const versionMatch = /Flutter\s+([\d.]+[^\s]*)/i.exec(res.output);
    const found = res.ok && !!versionMatch;

    if (!found && sdkPath && existsSync(path.join(sdkPath, 'bin', process.platform === 'win32' ? 'flutter.bat' : 'flutter'))) {
      // Binary exists at sdkPath even if --version timed out (e.g. locked by OneDrive/startup lock)
      return evaluateFlutterSdkCheck({
        found: true,
        sdkPath,
        version: versionMatch?.[1] ?? null,
        syncedFolder,
      });
    }

    return evaluateFlutterSdkCheck({
      found,
      sdkPath,
      version: versionMatch?.[1] ?? null,
      syncedFolder,
    });
  }

  private async checkNodeNpm() {
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const [nodeRes, npmRes] = await Promise.all([
      runQuickCommand('node', ['--version']),
      runQuickCommand(npmBin, ['--version']),
    ]);
    const nodeVersion = nodeRes.ok ? nodeRes.output.split(/\r?\n/)[0]?.trim() || null : null;
    const npmVersion = npmRes.ok ? npmRes.output.split(/\r?\n/)[0]?.trim() || null : null;
    return evaluateNodeNpmCheck({ nodeVersion, npmVersion });
  }

  private async checkAndroidToolchain() {
    const androidSdkPath = detectAndroidSdkPath(process.env);
    const adbCandidate = androidSdkPath
      ? path.join(androidSdkPath, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb')
      : null;
    const adbBin = adbCandidate && existsSync(adbCandidate) ? adbCandidate : 'adb';

    const [javaRes, adbRes] = await Promise.all([
      runQuickCommand('java', ['-version']),
      runQuickCommand(adbBin, ['version']),
    ]);

    const javaMatch = /(?:openjdk|java)\s+version\s+"([^"]+)"|openjdk\s+([\d._]+)/i.exec(javaRes.output);
    const javaVersion = javaRes.ok ? javaMatch?.[1] ?? javaMatch?.[2] ?? (javaRes.output ? 'installed' : null) : null;

    const adbMatch = /Android Debug Bridge version\s+([\d.]+)/i.exec(adbRes.output);
    const adbVersion = adbRes.ok ? adbMatch?.[1] ?? (adbRes.output ? 'installed' : null) : null;

    return evaluateAndroidToolchainCheck({ androidSdkPath, javaVersion, adbVersion });
  }

  private async checkDiskSpace(projectPath?: string) {
    const targetPath = projectPath && existsSync(projectPath) ? projectPath : os.homedir();
    try {
      const stats = await statfs(targetPath);
      const freeBytes = Number(stats.bavail) * Number(stats.bsize);
      return evaluateDiskSpaceCheck({ freeBytes, checkPath: targetPath });
    } catch {
      return evaluateDiskSpaceCheck({ freeBytes: null, checkPath: targetPath });
    }
  }

  async applyFix(
    fixKind: DoctorFixKind,
    projectPath?: string,
    parentWindow?: BrowserWindow | null,
  ): Promise<DoctorFixResult> {
    const normalizedProjectPath = projectPath ? path.resolve(projectPath) : undefined;

    if (fixKind === 'install-flutter-guide' || fixKind === 'install-node-guide' || fixKind === 'install-android-guide') {
      openExternalSafely(DOC_URLS[fixKind]);
      return {
        ok: true,
        fixKind,
        message: `Opened setup guide (${DOC_URLS[fixKind]}).`,
      };
    }

    if (fixKind === 'choose-flutter-sdk') {
      const options = {
        properties: ['openDirectory' as const],
        title: 'Choose Flutter SDK folder (outside OneDrive / cloud folders)',
      };
      const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, options)
        : await dialog.showOpenDialog(options);
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, fixKind, message: 'Folder selection was canceled.' };
      }

      const selected = path.resolve(result.filePaths[0]);
      const synced = syncedFolderOf(selected, process.env);
      if (synced) {
        return {
          ok: false,
          fixKind,
          message: `The selected folder is still inside ${synced}. Move Flutter to a local folder (e.g. C:\\src\\flutter) and try again.`,
          report: await this.runDoctor(normalizedProjectPath),
        };
      }

      await this.deps.setConfiguredFlutterSdkPath(selected);
      const report = await this.runDoctor(normalizedProjectPath);
      return {
        ok: true,
        fixKind,
        message: `Flutter SDK path updated to ${selected}.`,
        report,
      };
    }

    if (fixKind === 'release-startup-lock') {
      // Stop ONLY Atomvs-owned Flutter processes by PID; never kill external processes by name or PID.
      const stopped = this.deps.processManager.stopWhere((p) => isFlutterCommand(p.command));
      const sdkPath = this.resolveFlutterSdkPath();
      const lockFilePath = sdkPath ? path.join(sdkPath, 'bin', 'cache', 'lockfile') : null;

      if (lockFilePath && existsSync(lockFilePath)) {
        const syncedFolder = sdkPath ? syncedFolderOf(sdkPath, process.env) : null;
        const lockState = await this.inspectStartupLock(sdkPath, syncedFolder);
        if (lockState.status === 'error') {
          return {
            ok: false,
            fixKind,
            message:
              stopped > 0
                ? `Stopped ${stopped} Atomvs Flutter command(s), but an external Flutter process outside Atomvs still holds the lock. Close it and re-run Doctor.`
                : 'The Flutter startup lock is held by an external process outside Atomvs. Close that terminal or editor and re-run Doctor.',
            report: await this.runDoctor(normalizedProjectPath),
          };
        }
        try {
          await unlink(lockFilePath);
        } catch {
          // ignore if OS already released or removed it
        }
      }

      const report = await this.runDoctor(normalizedProjectPath);
      return {
        ok: true,
        fixKind,
        message:
          stopped > 0
            ? `Stopped ${stopped} Atomvs Flutter process(es) and cleared the startup lock.`
            : 'Cleared stale Flutter startup lockfile.',
        report,
      };
    }

    if (fixKind === 'clean-atomvs-cache') {
      let removedCount = 0;
      let freedBytes = 0;
      const tmpDir = os.tmpdir();
      try {
        const entries = await readdir(tmpDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!ATOMVS_TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
          const full = path.join(tmpDir, entry.name);
          try {
            const info = await stat(full);
            freedBytes += info.size;
            await rm(full, { recursive: true, force: true });
            removedCount++;
          } catch {
            // skip in-use temp items
          }
        }
      } catch {
        // ignore tmp read failures
      }

      if (normalizedProjectPath) {
        const previewDir = path.join(normalizedProjectPath, '.dart_tool', 'atomvs_preview');
        if (existsSync(previewDir)) {
          try {
            await rm(previewDir, { recursive: true, force: true });
            removedCount++;
          } catch {
            // ignore
          }
        }
      }

      const report = await this.runDoctor(normalizedProjectPath);
      const mb = (freedBytes / (1024 * 1024)).toFixed(1);
      return {
        ok: true,
        fixKind,
        message:
          removedCount > 0
            ? `Cleaned ${removedCount} Atomvs cache item(s) (~${mb} MB).`
            : 'Atomvs temporary caches are already clean.',
        report,
      };
    }

    return {
      ok: false,
      fixKind,
      message: `Unknown fix action: ${fixKind}`,
    };
  }
}
