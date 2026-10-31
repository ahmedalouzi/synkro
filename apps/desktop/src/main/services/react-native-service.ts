import { access, readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { Diagnostic } from '@peep/shared';
import { FrameworkProvider, type ProviderPreviewSession } from './providers/base-provider';
import type { MobileEnvironment, ValidationResult, BuildResult, TestResult, AppStartResult, AppStatusResult, AppLogsResult, RuntimeError } from '@peep/shared';
import type { ProcessManager } from './process-manager';

export interface RnSdkInfo {
  nodeVersion: string;
  hasExpo: boolean;
  hasReactNative: boolean;
  rnVersion?: string;
  expoVersion?: string;
}

const PREVIEW_PORT = 5175;
const PREVIEW_STARTUP_MS = 150_000;

export class ReactNativeService extends FrameworkProvider {
  readonly id = 'react-native-local';
  readonly name = 'React Native (Local)';
  readonly env: MobileEnvironment = {
    framework: 'react-native',
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
    _nodePath?: string,
  ) {
    super();
  }

  setNodePath(_path: string | undefined): void {
    // optional setting
  }

  private getNpxBin(): string {
    return process.platform === 'win32' ? 'npx.cmd' : 'npx';
  }

  private getNpmBin(): string {
    return process.platform === 'win32' ? 'npm.cmd' : 'npm';
  }

  // ── Project detection ────────────────────────────────────────────────────

  async findRnRoot(dir: string): Promise<string> {
    const isDirect = await this.isReactNativeProjectDirect(dir);
    if (isDirect) return dir;

    // Scan subdirectories up to depth 3
    const queue: { path: string; depth: number }[] = [{ path: dir, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.depth > 3) continue;

      if (await this.isReactNativeProjectDirect(current.path)) {
        return current.path;
      }

      try {
        const entries = await readdir(current.path, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const name = entry.name;
            if (name === 'node_modules' || name === '.git' || name === '.expo' || name === 'build' || name === 'dist' || name === '.peep' || name === '.atomvs' || name === '.next' || name === 'Pods' || name === '.idea' || name === '.vscode') {
              continue;
            }
            queue.push({ path: join(current.path, name), depth: current.depth + 1 });
          }
        }
      } catch {}
    }

    return dir;
  }

  private async isReactNativeProjectDirect(root: string): Promise<boolean> {
    try {
      const raw = await readFile(join(root, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const deps = {
        ...((pkg.dependencies as Record<string, unknown>) ?? {}),
        ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
      };
      return 'react-native' in deps || 'expo' in deps;
    } catch {
      return false;
    }
  }

  async isReactNativeProject(root: string): Promise<boolean> {
    const rnRoot = await this.findRnRoot(root);
    return this.isReactNativeProjectDirect(rnRoot);
  }

  async detectSdk(): Promise<RnSdkInfo | null> {
    try {
      const nodeOut = await this.run(['node', '--version'], process.cwd()).catch(() => '');
      const nodeVersion = nodeOut.trim();

      // Read project package.json to check RN/Expo versions
      return {
        nodeVersion,
        hasExpo: false,
        hasReactNative: false,
      };
    } catch {
      return null;
    }
  }

  async getProjectInfo(root: string): Promise<RnSdkInfo> {
    try {
      const rnRoot = await this.findRnRoot(root);
      const raw = await readFile(join(rnRoot, 'package.json'), 'utf-8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const deps = {
        ...((pkg.dependencies as Record<string, unknown>) ?? {}),
        ...((pkg.devDependencies as Record<string, unknown>) ?? {}),
      };

      const nodeOut = await this.run(['node', '--version'], rnRoot).catch(() => 'unknown');

      return {
        nodeVersion: nodeOut.trim(),
        hasExpo: 'expo' in deps,
        hasReactNative: 'react-native' in deps,
        rnVersion: deps['react-native'] as string | undefined,
        expoVersion: deps['expo'] as string | undefined,
      };
    } catch {
      return { nodeVersion: 'unknown', hasExpo: false, hasReactNative: false };
    }
  }

  // ── Package management ───────────────────────────────────────────────────

  private async detectPackageManager(dir: string): Promise<'pnpm' | 'npm'> {
    let current = dir;
    for (let i = 0; i < 4; i++) {
      try {
        await access(join(current, 'pnpm-lock.yaml'));
        return 'pnpm';
      } catch {}
      try {
        await access(join(current, 'pnpm-workspace.yaml'));
        return 'pnpm';
      } catch {}
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return 'npm';
  }

  async install(projectRoot: string): Promise<void> {
    const rnRoot = await this.findRnRoot(projectRoot);
    const pm = await this.detectPackageManager(rnRoot);
    if (pm === 'pnpm') {
      const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      if (process.platform === 'win32') {
        await this.run([pnpmBin, 'install', '--ignore-scripts', '--config.confirmModulesPurge=false'], rnRoot);
      } else {
        await this.run([pnpmBin, 'install', '--config.confirmModulesPurge=false'], rnRoot);
      }
    } else {
      if (process.platform === 'win32') {
        await this.run([this.getNpmBin(), 'install', '--ignore-scripts'], rnRoot);
      } else {
        await this.run([this.getNpmBin(), 'install'], rnRoot);
      }
    }
  }

  // ── Diagnostics ──────────────────────────────────────────────────────────

  async analyze(projectRoot: string): Promise<Diagnostic[]> {
    const rnRoot = await this.findRnRoot(projectRoot);
    const diagnostics: Diagnostic[] = [];

    // TypeScript check
    try {
      await access(join(rnRoot, 'tsconfig.json'));
      const tsOut = await this.run(
        [this.getNpxBin(), 'tsc', '--noEmit', '--pretty', 'false'],
        rnRoot,
      ).catch((e: Error) => e.message);

      diagnostics.push(...parseTscOutput(tsOut, rnRoot));
    } catch {
      // No tsconfig — skip TS check
    }

    // ESLint check
    try {
      const eslintOut = await this.run(
        [this.getNpxBin(), 'eslint', '.', '--ext', '.ts,.tsx,.js,.jsx', '-f', 'compact'],
        rnRoot,
      ).catch((e: Error) => e.message);

      diagnostics.push(...parseEslintOutput(eslintOut, rnRoot));
    } catch {
      // ESLint not configured — skip
    }

    return diagnostics;
  }

  private async getPackageManager(root: string): Promise<string> {
    try {
      await access(join(root, 'pnpm-lock.yaml'));
      return 'pnpm';
    } catch {}
    try {
      await access(join(root, 'yarn.lock'));
      return 'yarn';
    } catch {}
    return 'npm';
  }

  // ── Preview (Expo Web) ───────────────────────────────────────────────────

  async startWebPreview(
    projectRoot: string,
    port = PREVIEW_PORT,
    onLog?: (log: string) => void,
  ): Promise<{ url: string; processId: number; logs: string[] }> {
    const rnRoot = await this.findRnRoot(projectRoot);
    const projectInfo = await this.getProjectInfo(rnRoot);

    if (!projectInfo.hasExpo) {
      throw new Error(
        'Expo is not installed in this project. Run: npx install-expo-modules, or add Expo to use web preview.',
      );
    }

    process.env.EXPO_NO_BROWSER = '1';

    const pm = await this.getPackageManager(projectRoot);
    let bin = this.getNpxBin();
    let args = ['expo', 'start', '--web', '--port', String(port)];

    if (pm === 'pnpm') {
      bin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
      args = ['exec', 'expo', 'start', '--web', '--port', String(port)];
    } else if (pm === 'yarn') {
      bin = process.platform === 'win32' ? 'yarn.cmd' : 'yarn';
      args = ['expo', 'start', '--web', '--port', String(port)];
    }

    const info = this.processManager.spawn(
      bin,
      args,
      rnRoot,
      { BROWSER: 'none' }
    );

    const url = `http://127.0.0.1:${port}`;
    const logs: string[] = [];

    return new Promise((resolve, reject) => {
      let isResolved = false;
      const timeout = setTimeout(() => {
        if (!isResolved) {
          isResolved = true;
          reject(
            new Error(
              `Expo Web startup timed out after ${PREVIEW_STARTUP_MS / 1000}s. The endpoint ${url} did not respond.`
            )
          );
        }
      }, PREVIEW_STARTUP_MS);

      const checkEndpoint = () => {
        if (isResolved) return;
        require('node:http').get(url, (res: any) => {
          if (res.statusCode === 200 || res.statusCode === 404 || res.statusCode === 304) { // Expo might return 200 or something else if ready
            if (!isResolved) {
              isResolved = true;
              clearTimeout(timeout);
              resolve({ url, processId: info.id, logs });
            }
          } else {
            setTimeout(checkEndpoint, 500);
          }
        }).on('error', () => {
          setTimeout(checkEndpoint, 500);
        });
      };

      const handleOutput = (chunk: Buffer) => {
        const text = chunk.toString();
        if (onLog) onLog(text);
        
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) logs.push(line);
        }

        const fullText = logs.join('\n');

        // Once Metro indicates it's starting, begin HTTP polling for readiness.
        if (
          !isResolved &&
          (fullText.includes('Webpack compiled') ||
           fullText.includes('Starting Metro') ||
           fullText.includes(`localhost:${port}`) ||
           fullText.includes('Web is waiting') ||
           fullText.includes('Waiting on http') ||
           fullText.includes('running on'))
        ) {
          checkEndpoint();
        }
      };

      info.process.stdout?.on('data', handleOutput);
      info.process.stderr?.on('data', handleOutput);

      info.process.on('error', (error) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeout);
          reject(error);
        }
      });

      info.process.on('exit', (code) => {
        if (code !== 0 && code !== null) {
          if (!isResolved) {
            isResolved = true;
            clearTimeout(timeout);
            reject(new Error(logs.join('\n') || `expo exited with code ${code}`));
          }
        }
      });
    });
  }

  stopPreview(processId: number): void {
    this.processManager.kill(processId);
  }

  reloadPreview(processId: number): void {
    // Metro hot reload — send 'r' to stdin
    this.processManager.writeStdin(processId, 'r\n');
  }

  // --- FrameworkProvider Implementation ---

  async detect(projectPath: string): Promise<boolean> {
    return this.isReactNativeProject(projectPath);
  }

  async createProject(_name: string, _parentPath: string, _templateId?: string): Promise<string> {
    // Default implementation, though advanced users might just clone/init.
    throw new Error('createProject not fully implemented for ReactNative Local Provider. Use Managed mode or init manually.');
  }

  async buildAndroid(projectPath: string): Promise<string> {
    const rnRoot = await this.findRnRoot(projectPath);
    await this.run([this.getNpxBin(), 'expo', 'build:android'], rnRoot); // Or generic gradle build
    return join(rnRoot, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  }

  async buildIos(_projectPath: string): Promise<string> {
    throw new Error('Local iOS build not yet fully mapped.');
  }

  async buildWeb(projectPath: string): Promise<string> {
    const rnRoot = await this.findRnRoot(projectPath);
    await this.run([this.getNpxBin(), 'expo', 'export', '--platform', 'web'], rnRoot);
    return join(rnRoot, 'dist');
  }

  async getAgentContext(_projectPath: string): Promise<string> {
    return 'This is a React Native project running in a local environment. You have full access to native Android/iOS folders, npm, and system CLI tools.';
  }

  async validateProject(projectPath: string): Promise<ValidationResult> {
    const rnRoot = await this.findRnRoot(projectPath);
    const checks = [];
    let tscStdout = '';
    let tscExit = 0;

    try {
      tscStdout = await this.run([this.getNpxBin(), 'tsc', '--noEmit'], rnRoot);
    } catch (e: any) {
      tscExit = 1;
      tscStdout = e.message || '';
    }

    const tscErrors = parseTscOutput(tscStdout, rnRoot);
    checks.push({
      type: 'typescript',
      success: tscExit === 0 && tscErrors.length === 0,
      exitCode: tscExit,
      stdout: tscStdout,
      stderr: '',
      errors: tscErrors
    });

    const missingPackages: string[] = [];
    const missingRegex = /Cannot find module '([^']+)'/g;
    let match;
    while ((match = missingRegex.exec(tscStdout)) !== null) {
      if (match[1] && !match[1].startsWith('.') && !missingPackages.includes(match[1])) {
        // Strip subpaths like 'react-native/Libraries/...'
        const pkg = match[1].split('/')[0];
        if (pkg && !missingPackages.includes(pkg)) {
          missingPackages.push(pkg);
        }
      }
    }

    const blockingErrors = tscErrors.filter(e => e.severity === 'error').length;
    const isMissingDeps = missingPackages.length > 0;

    return {
      success: blockingErrors === 0 && !isMissingDeps,
      framework: 'react-native',
      environment: 'local',
      checks,
      blockingErrors: blockingErrors + (isMissingDeps ? 1 : 0),
      warnings: tscErrors.filter(e => e.severity === 'warning').length,
      errorCategory: isMissingDeps ? 'missing_dependencies' : (blockingErrors > 0 ? 'type_error' : 'success'),
      missingPackages
    } as any;
  }

  async startPreview(projectPath: string, port: number, onLog?: (line: string) => void): Promise<ProviderPreviewSession> {
    const result = await this.startWebPreview(projectPath, port, onLog);
    return {
      url: result.url,
      processId: result.processId,
      logs: result.logs
    };
  }

  // ── Internal helpers ─────────────────────────────────────────────────────

  private run(cmd: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const [bin, ...args] = cmd;
      const info = this.processManager.spawn(bin!, args, cwd);
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
        if (code === 0) resolve(output);
        else reject(new Error(output || `Command exited with code ${code}`));
      });
    });
  }

  async buildProject(projectPath: string, platform: string): Promise<BuildResult> {
    const startTime = Date.now();
    try {
      let outputPath = '';
      if (platform === 'android') {
        outputPath = await this.buildAndroid(projectPath);
      } else if (platform === 'web') {
        outputPath = await this.buildWeb(projectPath);
      } else {
        throw new Error(`Platform ${platform} build not fully implemented.`);
      }

      return {
        success: true,
        framework: 'react-native',
        environment: 'local',
        platform,
        outputPath,
        exitCode: 0,
        stdout: 'Build completed successfully.',
        stderr: '',
        duration: Date.now() - startTime
      };
    } catch (err: any) {
      return {
        success: false,
        framework: 'react-native',
        environment: 'local',
        platform,
        exitCode: 1,
        stdout: '',
        stderr: err.message || String(err),
        duration: Date.now() - startTime,
        errorCategory: 'compile_error'
      };
    }
  }

  async runTests(projectPath: string): Promise<TestResult> {
    const npm = this.getNpmBin();
    try {
      const packageJsonPath = join(projectPath, 'package.json');
      const content = await readFile(packageJsonPath, 'utf8');
      const parsed = JSON.parse(content);
      if (!parsed.scripts || !parsed.scripts.test) {
        return {
          success: true,
          status: 'not_configured',
          message: 'No test script configured in package.json.'
        };
      }

      let stdout = '';
      let stderr = '';
      let exitCode = 0;

      await new Promise<void>((resolve) => {
        const info = this.processManager.spawn(npm, ['run', 'test'], projectPath);
        info.process.stdout?.on('data', (d) => stdout += d.toString());
        info.process.stderr?.on('data', (d) => stderr += d.toString());
        info.process.on('exit', (code) => {
          exitCode = code ?? 1;
          resolve();
        });
      });

      return {
        success: exitCode === 0,
        status: exitCode === 0 ? 'passed' : 'failed',
        message: exitCode === 0 ? 'All tests passed.' : 'Some tests failed.',
        stdout,
        stderr
      };
    } catch (err: any) {
      return {
        success: false,
        status: 'error',
        message: err.message || String(err)
      };
    }
  }

  async startApplication(projectPath: string): Promise<AppStartResult> {
    try {
      const preview = await this.startPreview(projectPath, PREVIEW_PORT);
      return {
        success: true,
        processId: preview.processId,
        sessionId: String(preview.processId),
        status: 'running',
        previewUrl: preview.url
      };
    } catch (err: any) {
      return {
        success: false,
        processId: 0,
        status: 'error',
        message: err.message || String(err),
        errorCategory: 'runtime_error'
      };
    }
  }

  async stopApplication(processId: number): Promise<boolean> {
    return this.processManager.kill(processId);
  }

  async getApplicationStatus(processId: number): Promise<AppStatusResult> {
    const info = this.processManager.get(processId);
    if (!info) {
      return {
        processId,
        status: 'unknown',
        command: '',
        framework: 'react-native',
        environment: 'local',
        startedAt: '',
        exitCode: null
      };
    }

    return {
      processId,
      status: info.status,
      command: info.command,
      framework: 'react-native',
      environment: 'local',
      startedAt: info.startedAt,
      exitCode: info.exitCode
    };
  }

  async getRuntimeLogs(processId: number): Promise<AppLogsResult> {
    const info = this.processManager.get(processId);
    if (!info) {
      return {
        processId,
        status: 'unknown',
        stdout: '',
        stderr: '',
        logs: [],
        detectedErrors: []
      };
    }

    const logs = (info.stdout + info.stderr).split('\n');
    const detectedErrors: RuntimeError[] = [];

    let i = 0;
    while (i < logs.length) {
      const line = logs[i] || '';
      const lineLower = line.toLowerCase();

      if (
        lineLower.includes('error') || 
        lineLower.includes('exception') || 
        lineLower.includes('fail') || 
        lineLower.includes('unhandled promise rejection')
      ) {
        const message = line.trim();
        let stackTrace = '';
        let file: string | undefined;
        let lineNum: number | undefined;

        // Try to collect stack trace lines
        let j = i + 1;
        while (j < logs.length && (logs[j]?.startsWith('    at ') || logs[j]?.startsWith('\tat ') || logs[j]?.includes('node_modules') || logs[j]?.startsWith(' '))) {
          stackTrace += (logs[j] || '') + '\n';
          j++;
        }

        // Try to parse file and line numbers
        const fileMatch = message.match(/(?:at\s+)?([^:\s]+\.(?:tsx|ts|js|jsx)):(\d+):(\d+)/) || 
                          stackTrace.match(/(?:at\s+)?([^:\s]+\.(?:tsx|ts|js|jsx)):(\d+):(\d+)/);
        if (fileMatch) {
          file = fileMatch[1];
          lineNum = parseInt(fileMatch[2] || '0', 10);
        }

        // Classify error type
        let type: RuntimeError['type'] = 'RUNTIME_ERROR';
        if (lineLower.includes('module') || lineLower.includes('cannot find module') || lineLower.includes('resolver')) {
          type = 'DEPENDENCY_ERROR';
        } else if (lineLower.includes('compile') || lineLower.includes('syntax') || lineLower.includes('typescript')) {
          type = 'BUILD_ERROR';
        } else if (lineLower.includes('network') || lineLower.includes('fetch') || lineLower.includes('socket')) {
          type = 'NETWORK_ERROR';
        }

        detectedErrors.push({
          type,
          message,
          file,
          line: lineNum,
          stackTrace: stackTrace || undefined,
          severity: lineLower.includes('fatal') ? 'fatal' : 'error'
        });

        i = j - 1; // Advance outer loop
      }
      i++;
    }

    if (detectedErrors.length > 0 && info.status === 'running') {
      info.status = 'error';
    }

    return {
      processId,
      status: info.status,
      stdout: info.stdout,
      stderr: info.stderr,
      logs,
      detectedErrors
    };
  }

  async installDependencies(projectPath: string, packages: string[]): Promise<{ success: boolean; exitCode: number | null; stdout: string; stderr: string; message?: string }> {
    const npm = this.getNpmBin();
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const info = this.processManager.spawn(npm, ['install', '--save', ...packages], projectPath);
        info.process.stdout?.on('data', (d) => stdout += d.toString());
        info.process.stderr?.on('data', (d) => stderr += d.toString());
        info.process.on('exit', (code) => {
          exitCode = code ?? 1;
          if (code === 0) resolve();
          else reject(new Error(`npm install failed with exit code ${code}`));
        });
      });

      return {
        success: true,
        exitCode,
        stdout,
        stderr,
        message: 'Dependencies successfully installed.'
      };
    } catch (err: any) {
      return {
        success: false,
        exitCode,
        stdout,
        stderr,
        message: err.message || String(err)
      };
    }
  }
}

// ── Diagnostics parsers ───────────────────────────────────────────────────

function parseTscOutput(output: string, root: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // Format: src/App.tsx(10,5): error TS2345: Argument of type ...
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+TS\d+:\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(output)) !== null) {
    diagnostics.push({
      file: join(root, m[1]!.replace(/\\/g, '/')),
      line: parseInt(m[2]!, 10),
      column: parseInt(m[3]!, 10),
      severity: m[4] as 'error' | 'warning' | 'info',
      message: m[5]!.trim(),
    });
  }
  return diagnostics;
}

function parseEslintOutput(output: string, _root: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  // ESLint compact format: /path/to/file.tsx: line 10, col 5, Error - message (rule)
  const regex = /^(.+?):\s+line\s+(\d+),\s+col\s+(\d+),\s+(Error|Warning|Info)\s+-\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(output)) !== null) {
    diagnostics.push({
      file: m[1]!.trim(),
      line: parseInt(m[2]!, 10),
      column: parseInt(m[3]!, 10),
      severity: m[4]!.toLowerCase() as 'error' | 'warning' | 'info',
      message: m[5]!.replace(/\s+\([^)]+\)$/, '').trim(),
    });
  }
  return diagnostics;
}
