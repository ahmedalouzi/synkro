import { access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Diagnostic, MobileEnvironment } from '@peep/shared';
import { parseFlutterAnalyze } from '@peep/flutter-adapter';
import type { ProcessManager } from './process-manager';
import { FrameworkProvider, type ProviderPreviewSession } from './providers/base-provider';

export interface SdkInfo {
  path: string;
  version: string;
}

const PREVIEW_PORT = 5174;
const PREVIEW_STARTUP_MS = 120_000;

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

  async createProject(name: string, parentPath: string, _templateId?: string): Promise<string> {
    await this.runCommand(['create', name, '--project-name', name], parentPath);
    return join(parentPath, name);
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

  async startWebPreview(
    projectRoot: string,
    port = PREVIEW_PORT,
    onLog?: (line: string) => void
  ): Promise<{ url: string; processId: number; logs: string[] }> {
    const flutterRoot = await this.findFlutterRoot(projectRoot);
    const info = this.processManager.spawn(
      this.getFlutterBin(),
      ['run', '-d', 'web-server', '--web-port', String(port), '--web-hostname', '127.0.0.1'],
      flutterRoot,
    );

    const url = `http://127.0.0.1:${port}`;
    const logs: string[] = [];

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Preview startup timed out after ${PREVIEW_STARTUP_MS / 1000}s. Is Flutter SDK installed?`));
      }, PREVIEW_STARTUP_MS);

      const handleOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) logs.push(line);
        }

        if (onLog) onLog(text);

        if (
          text.includes(url) ||
          text.includes('is being served at') ||
          text.includes('Serving at')
        ) {
          clearTimeout(timeout);
          resolve({ url, processId: info.id, logs });
        }
      };

      info.process.stdout?.on('data', handleOutput);
      info.process.stderr?.on('data', handleOutput);

      info.process.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });

      info.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          clearTimeout(timeout);
          reject(new Error(logs.join('\n') || `flutter run exited with code ${code}`));
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

  async validateProject(_projectPath: string): Promise<any> {
    return { success: true, framework: 'flutter', environment: 'local', checks: [], blockingErrors: 0, warnings: 0, errorCategory: 'success' };
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

      info.process.on('error', reject);

      info.process.on('close', (code) => {
        const output = stdout + stderr;
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(output || `flutter exited with code ${code}`));
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
