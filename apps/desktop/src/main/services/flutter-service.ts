import { access, mkdir, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FLUTTER_STARTUP_LOCK_LINE, flutterEnvironmentMessage, parseFlutterEnvironmentProblem, syncedFolderOf, type Diagnostic, type MobileEnvironment, type ValidationResult } from '@peep/shared';
import { getTemplate, parseFlutterAnalyze } from '@peep/flutter-adapter';
import type { ProcessManager } from './process-manager';
import { writePreviewEntry } from './flutter-preview-entry';
import { FrameworkProvider, type ProviderPreviewSession } from './providers/base-provider';

export function isFlutterSdkNotFoundError(msg: string): boolean {
  if (!msg) return false;
  const lower = msg.toLowerCase();
  return (
    lower.includes('flutter.bat') ||
    lower.includes('not recognized as an internal or external command') ||
    (lower.includes('command not found') && lower.includes('flutter')) ||
    lower.includes('flutter: command not found') ||
    lower.includes('flutter: not found') ||
    lower.includes('the system cannot find the path specified') ||
    lower.includes('the system cannot find the file specified') ||
    lower.includes('spawn flutter enoent') ||
    (lower.includes('enoent') && (lower.includes('flutter') || lower.includes('bin'))) ||
    lower.includes('is flutter sdk installed') ||
    lower.includes('flutter sdk not found') ||
    lower.includes('exited with code 127')
  );
}

export interface SdkInfo {
  path: string;
  version: string;
}

const PREVIEW_PORT = 5174;
const PREVIEW_STARTUP_MS = 120_000;

/** A flutter (or dart) command started by Atomvs, from ProcessInfo.command. Exported for tests. */
export function isFlutterCommand(command: string): boolean {
  return /(^|[\\/"\s])(flutter|dart)(\.bat|\.exe)?("?\s|"?$)/i.test(command);
}

/** The SDK folder from PATH: the folder above the bin/ that holds flutter(.bat), or null. Exported for tests. */
export function sdkFromPath(pathVar: string, isWin: boolean): string | null {
  for (const dir of pathVar.split(isWin ? ';' : ':')) {
    if (dir && existsSync(join(dir, isWin ? 'flutter.bat' : 'flutter'))) return dirname(dir.replace(/[\\/]+$/, ''));
  }
  return null;
}

/**
 * The path in "Flutter failed to delete a directory at "<path>"" (a sync client or antivirus held a file), or null.
 * Exported for tests.
 */
export function lockedSdkPath(log: string): string | null {
  const m = /Flutter failed to delete a directory at[:\s]+"?([^"\r\n]+?)"?(?:\.\s|\.?\r?\n|\.?$)/i.exec(log);
  return m ? m[1].trim() : null;
}

/** C:\...\flutter\.pub-preload-cache or C:\...\flutter\bin\cache\x -> C:\...\flutter. */
function sdkOfLockedPath(path: string): string {
  const parts = path.split(/[\\/]/);
  const bin = parts.lastIndexOf('bin');
  return (bin > 0 ? parts.slice(0, bin) : parts.slice(0, -1)).join('\\');
}

class LockedSdkFileError extends Error {
  constructor(readonly path: string, log: string) {
    super(log);
  }
}

export const FLUTTER_SDK_NOT_FOUND_MSG =
  'Flutter SDK not found. A local Flutter SDK is required for live preview. Please install Flutter or configure its path in Settings.';

export class FlutterService extends FrameworkProvider {
  readonly id = 'flutter-local';
  readonly name = 'Flutter Local';
  readonly env: MobileEnvironment = {
    framework: 'flutter',
    environment: 'local',
    mode: 'advanced',
    capabilities: {
      localSdk: true,
      terminal: true,
      preview: true,
      androidBuild: true,
      iosBuild: true
    }
  };

  constructor(
    private processManager: ProcessManager,
    private sdkPath?: string,
  ) {
    super();
  }

  /** How long the preview waits for a startup lock held outside Atomvs, and before retrying a locked SDK file. */
  readonly timings = { lockWaitMs: 60_000, retryMs: 3_000 };

  setSdkPath(path: string | undefined): void {
    this.sdkPath = path;
  }

  private getFlutterBin(): string {
    if (this.sdkPath) {
      return join(this.sdkPath, 'bin', process.platform === 'win32' ? 'flutter.bat' : 'flutter');
    }
    return process.platform === 'win32' ? 'flutter.bat' : 'flutter';
  }

  async detectSdk(): Promise<SdkInfo | null> {
    try {
      const version = await this.runCommand(['--version'], process.cwd());
      const match = version.match(/Flutter\s+([\d.]+)/);
      return {
        path: this.sdkPath ?? 'PATH',
        version: match?.[1] ?? 'unknown',
      };
    } catch {
      return null;
    }
  }

  async createProject(name: string, parentPath: string, templateId?: string): Promise<string> {
    // Pass --org com.atomvs to ensure package namespace is not com.example (rejected by Google Play)
    await this.runCommand(['create', name, '--project-name', name, '--org', 'com.atomvs'], parentPath);
    const projectPath = join(parentPath, name);

    // Apply template files if specified (or default to material-app)
    const effectiveTemplateId = templateId || 'material-app';
    const template = getTemplate(effectiveTemplateId);

    if (template && template.files.length > 0) {
      for (const file of template.files) {
        const fullPath = join(projectPath, file.relativePath);
        await mkdir(join(fullPath, '..'), { recursive: true });
        await writeFile(fullPath, file.content, 'utf-8');
      }

      // Update test/widget_test.dart to test app entrypoint without hardcoding MyApp
      const testPath = join(projectPath, 'test', 'widget_test.dart');
      const testContent = `import 'package:flutter_test/flutter_test.dart';
import 'package:${name}/main.dart' as app;

void main() {
  testWidgets('app starts', (tester) async {
    app.main();
    await tester.pump();
  });
}
`;
      await mkdir(join(testPath, '..'), { recursive: true });
      await writeFile(testPath, testContent, 'utf-8');
    }

    return projectPath;

  }

  async pubGet(projectRoot: string): Promise<void> {
    const flutterRoot = await this.findFlutterRoot(projectRoot);
    await this.runCommand(['pub', 'get'], flutterRoot);
  }

  async analyze(projectRoot: string): Promise<Diagnostic[]> {
    const flutterRoot = await this.findFlutterRoot(projectRoot);
    try {
      const output = await this.runCommand(['analyze'], flutterRoot);
      return parseFlutterAnalyze(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return parseFlutterAnalyze(message);
    }
  }

  /** The SDK folder: the one set in Settings, else the one whose bin/ holds flutter on PATH. */
  private resolveSdkPath(): string | null {
    return this.sdkPath ?? sdkFromPath(process.env.PATH ?? process.env.Path ?? '', process.platform === 'win32');
  }

  async startWebPreview(
    projectRoot: string,
    port = PREVIEW_PORT,
    onLog?: (line: string) => void
  ): Promise<{ url: string; processId: number; logs: string[] }> {
    const flutterRoot = await this.findFlutterRoot(projectRoot);
    // Through the preview entrypoint: the app gets the phone's safe-area insets (see flutter-preview-entry.ts).
    const target = await writePreviewEntry(flutterRoot);
    const sdkPath = this.resolveSdkPath();
    const folder = sdkPath ? syncedFolderOf(sdkPath, process.env) : null;
    if (folder) onLog?.(`[Atomvs] ${flutterEnvironmentMessage({ kind: 'sdk-in-synced-folder', folder, sdkPath: sdkPath! })}\n`);
    try {
      return await this.runWebPreview(flutterRoot, port, sdkPath, folder, onLog, target);
    } catch (error) {
      if (!(error instanceof LockedSdkFileError)) throw error;
      // A sync client or antivirus held a file for a moment (e.g. .pub-preload-cache on the first run): once more.
      onLog?.(`[Atomvs] Flutter could not delete a folder in its SDK (${error.path}); retrying once in ${this.timings.retryMs / 1000} s...\n`);
      await new Promise((resolve) => setTimeout(resolve, this.timings.retryMs));
      try {
        return await this.runWebPreview(flutterRoot, port, sdkPath, folder, onLog, target);
      } catch (again) {
        if (!(again instanceof LockedSdkFileError)) throw again;
        const lockedIn = folder ?? syncedFolderOf(again.path, process.env);
        if (lockedIn) {
          throw new Error(flutterEnvironmentMessage({ kind: 'sdk-in-synced-folder', folder: lockedIn, sdkPath: sdkPath ?? sdkOfLockedPath(again.path) }));
        }
        throw new Error(again.message);
      }
    }
  }

  /** One `flutter run -d web-server`. Rejects with LockedSdkFileError when Flutter could not delete a folder in its SDK. */
  private runWebPreview(
    flutterRoot: string, port: number, sdkPath: string | null, folder: string | null, onLog?: (line: string) => void,
    target: string | null = null,
  ): Promise<{ url: string; processId: number; logs: string[] }> {
    const info = this.processManager.spawn(
      this.getFlutterBin(),
      ['run', '-d', 'web-server', '--web-port', String(port), '--web-hostname', '127.0.0.1', ...(target ? ['-t', target] : [])],
      flutterRoot,
    );

    const url = `http://127.0.0.1:${port}`;
    const logs: string[] = [];
    const startupTimeout = () => new Error(`Preview startup timed out after ${PREVIEW_STARTUP_MS / 1000}s. Is Flutter SDK installed?`);

    return new Promise((resolve, reject) => {
      let settled = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let waitingForLock = false;
      let lockHandled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };
      // A preview that does not start is stopped: a flutter command left running keeps holding the startup lock.
      const fail = (error: Error) => finish(() => {
        if (info.process.exitCode === null) this.processManager.kill(info.id);
        reject(error);
      });
      const setDeadline = (ms: number, error: () => Error) => {
        clearTimeout(deadline);
        deadline = setTimeout(() => fail(error()), ms);
      };
      setDeadline(PREVIEW_STARTUP_MS, startupTimeout);

      const handleOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) logs.push(line);
        }

        if (onLog) onLog(text);

        if (text.includes(FLUTTER_STARTUP_LOCK_LINE)) {
          if (!lockHandled) {
            // Another flutter command holds the SDK's startup lock. Stop the ones Atomvs started (by PID: never every
            // flutter.exe on the PC), then wait a while for one outside Atomvs to finish.
            lockHandled = true;
            waitingForLock = true;
            const stopped = this.processManager.stopWhere((p) => p.id !== info.id && isFlutterCommand(p.command));
            onLog?.(`[Atomvs] Another Flutter command holds Flutter's startup lock. `
              + (stopped ? `Stopped ${stopped} Flutter command(s) Atomvs had started. ` : '')
              + `Waiting up to ${this.timings.lockWaitMs / 1000} s for it to be released...\n`);
            setDeadline(this.timings.lockWaitMs, () => new Error(flutterEnvironmentMessage({ kind: 'startup-lock', folder, sdkPath })));
          }
        } else if (waitingForLock && text.trim()) {
          // The lock is free and flutter goes on: the usual startup time from here.
          waitingForLock = false;
          setDeadline(PREVIEW_STARTUP_MS, startupTimeout);
        }

        if (
          text.includes(url) ||
          text.includes('is being served at') ||
          text.includes('Serving at')
        ) {
          finish(() => resolve({ url, processId: info.id, logs }));
        }
      };

      info.process.stdout?.on('data', handleOutput);
      info.process.stderr?.on('data', handleOutput);

      info.process.on('error', (error) => {
        const msg = error instanceof Error ? error.message : String(error);
        if ((error as any)?.code === 'ENOENT' || isFlutterSdkNotFoundError(msg)) {
          fail(new Error(FLUTTER_SDK_NOT_FOUND_MSG));
        } else {
          fail(error);
        }
      });

      info.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          const fullLog = logs.join('\n');
          const locked = lockedSdkPath(fullLog);
          if (locked) {
            fail(new LockedSdkFileError(locked, fullLog));
          } else if (code === 127 || isFlutterSdkNotFoundError(fullLog)) {
            fail(new Error(FLUTTER_SDK_NOT_FOUND_MSG));
          } else {
            fail(new Error(fullLog || `flutter run exited with code ${code}`));
          }
        }
      });
    });
  }

  async detect(projectPath: string): Promise<boolean> {
    try {
      await access(join(projectPath, 'pubspec.yaml'));
      return true;
    } catch {
      return false;
    }
  }

  async startPreview(projectPath: string, port: number, onLog?: (line: string) => void): Promise<ProviderPreviewSession> {
    return this.startWebPreview(projectPath, port, onLog);
  }

  async buildAndroid(projectPath: string): Promise<string> {
    await this.runCommand(['build', 'apk'], projectPath);
    return join(projectPath, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
  }

  async buildIos(projectPath: string): Promise<string> {
    await this.runCommand(['build', 'ios', '--no-codesign'], projectPath);
    return join(projectPath, 'build', 'ios', 'iphoneos');
  }

  async buildWeb(projectPath: string): Promise<string> {
    await this.runCommand(['build', 'web', '--release'], projectPath);
    return join(projectPath, 'build', 'web');
  }

  async getAgentContext(_projectPath: string): Promise<string> {
    return 'This is a Flutter project running in a local environment.';
  }

  /**
   * `flutter analyze` on the project: its errors block (the app would not compile), warnings and infos do not.
   * Throws when Flutter itself cannot run (no SDK, a locked or synced SDK), which is not the code's fault.
   */
  async validateProject(projectPath: string): Promise<ValidationResult> {
    const root = await this.findFlutterRoot(projectPath);
    let output: string;
    let exitCode = 0;
    try {
      output = await this.runCommand(['analyze'], root);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Not the analyzer's report: Flutter could not run at all.
      if (message === FLUTTER_SDK_NOT_FOUND_MSG || parseFlutterEnvironmentProblem(message)) throw error;
      output = message;
      exitCode = 1;
    }
    const diagnostics = parseFlutterAnalyze(output);
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const lines = errors.map((d) => `${d.file}:${d.line}:${d.column}: error: ${d.message}`);
    // A failed run that printed no diagnostics (e.g. pub get failed): its output is the error.
    const unexplained = exitCode !== 0 && diagnostics.length === 0;
    const ok = errors.length === 0 && !unexplained;
    return {
      success: ok,
      framework: 'flutter',
      environment: 'local',
      checks: [{
        type: 'flutter analyze',
        success: ok,
        exitCode,
        stdout: lines.length ? lines.join('\n') : unexplained ? output.trim().split(/\r?\n/).slice(-15).join('\n') : 'No errors.',
        stderr: '',
        errors: lines,
      }],
      blockingErrors: unexplained ? 1 : errors.length,
      warnings: diagnostics.filter((d) => d.severity === 'warning').length,
      errorCategory: ok ? 'success' : 'compile_error',
    };
  }

  stopPreview(processId: number): void {
    this.processManager.kill(processId);
  }

  reloadPreview(processId: number): void {
    this.processManager.writeStdin(processId, 'r\n');
  }

  private runCommand(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const info = this.processManager.spawn(this.getFlutterBin(), args, cwd);
      let stdout = '';
      let stderr = '';

      info.process.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      info.process.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      info.process.on('error', (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        if ((err as any)?.code === 'ENOENT' || isFlutterSdkNotFoundError(msg)) {
          reject(new Error(FLUTTER_SDK_NOT_FOUND_MSG));
        } else {
          reject(err);
        }
      });

      info.process.on('close', (code) => {
        const output = stdout + stderr;
        if (code === 0) {
          resolve(output);
        } else {
          const locked = lockedSdkPath(output);
          const lockedIn = locked ? syncedFolderOf(this.resolveSdkPath() ?? locked, process.env) ?? syncedFolderOf(locked, process.env) : null;
          if (code === 127 || isFlutterSdkNotFoundError(output)) {
            reject(new Error(FLUTTER_SDK_NOT_FOUND_MSG));
          } else if (locked && lockedIn) {
            reject(new Error(flutterEnvironmentMessage({ kind: 'sdk-in-synced-folder', folder: lockedIn, sdkPath: this.resolveSdkPath() ?? sdkOfLockedPath(locked) })));
          } else {
            reject(new Error(output || `flutter exited with code ${code}`));
          }
        }
      });
    });
  }

  async findFlutterRoot(dir: string): Promise<string> {
    const isDirect = await this.isFlutterProjectDirect(dir);
    if (isDirect) return dir;

    // Scan subdirectories up to depth 3
    const queue: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > 3) continue;

      if (await this.isFlutterProjectDirect(current.path)) {
        return current.path;
      }

      try {
        const entries = await readdir(current.path, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const name = entry.name;
            if (name === 'node_modules' || name === '.git' || name === '.dart_tool' || name === 'build' || name === 'dist' || name === '.peep' || name === '.atomvs' || name === '.idea' || name === '.vscode') {
              continue;
            }
            queue.push({ path: join(current.path, name), depth: current.depth + 1 });
          }
        }
      } catch {}
    }

    return dir;
  }

  private async isFlutterProjectDirect(root: string): Promise<boolean> {
    try {
      await access(join(root, 'pubspec.yaml'));
      return true;
    } catch {
      return false;
    }
  }

  async isFlutterProject(root: string): Promise<boolean> {
    const flutterRoot = await this.findFlutterRoot(root);
    return this.isFlutterProjectDirect(flutterRoot);
  }
}
