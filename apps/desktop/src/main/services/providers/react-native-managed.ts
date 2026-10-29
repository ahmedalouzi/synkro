import { basename, join } from 'node:path';
import { FrameworkProvider, ProviderPreviewSession } from './base-provider';
import type { MobileEnvironment, ValidationResult, BuildResult, TestResult, AppStartResult, AppStatusResult, AppLogsResult, RuntimeError } from '@peep/shared';
import type { ProcessManager } from '../process-manager';
import { access, readFile, mkdir, writeFile } from 'node:fs/promises';
import { getTemplate } from '@peep/flutter-adapter'; // Assuming templates are accessible here or from shared

export class ReactNativeManagedProvider extends FrameworkProvider {
  readonly id = 'react-native-managed';
  readonly name = 'React Native (Managed)';
  readonly env: MobileEnvironment = {
    framework: 'react-native',
    environment: 'managed',
    mode: 'beginner',
    capabilities: {
      localSdk: false,
      terminal: true,
      preview: true,
      androidBuild: false,
      iosBuild: false
    }
  };

  constructor(private processManager: ProcessManager) {
    super();
  }

  async detectPackageManager(projectPath: string): Promise<'pnpm' | 'yarn' | 'npm'> {
    try {
      await access(join(projectPath, 'pnpm-lock.yaml'));
      return 'pnpm';
    } catch {}
    try {
      await access(join(projectPath, 'yarn.lock'));
      return 'yarn';
    } catch {}
    return 'npm';
  }

  async detect(projectPath: string): Promise<boolean> {
    try {
      const packageJsonPath = join(projectPath, 'package.json');
      await access(packageJsonPath);
      const content = await readFile(packageJsonPath, 'utf8');
      const parsed = JSON.parse(content);
      // If it has expo and react-native, it's a managed project
      return !!(parsed.dependencies?.expo || parsed.devDependencies?.expo);
    } catch {
      return false;
    }
  }

  async createProject(name: string, parentPath: string, templateId?: string): Promise<string> {
    const projectPath = join(parentPath, name);
    try {
      await access(projectPath);
      throw new Error(`Folder already exists: ${projectPath}`);
    } catch (e: any) {
      if (e.message.startsWith('Folder already exists')) throw e;
    }
    
    await mkdir(projectPath, { recursive: true });

    // In managed mode, we can create the project via `create-expo-app` or use a template.
    if (templateId) {
      const template = getTemplate(templateId);
      if (template && template.files.length > 0) {
        for (const file of template.files) {
          const fullPath = join(projectPath, file.relativePath);
          await mkdir(join(fullPath, '..'), { recursive: true });
          await writeFile(fullPath, file.content, 'utf-8');
        }
      }
      
      // Install dependencies
      const pm = await this.detectPackageManager(projectPath);
      const installCmd = process.platform === 'win32' ? `${pm}.cmd` : pm;
      await new Promise<void>((resolve, reject) => {
        const info = this.processManager.spawn(installCmd, ['install'], projectPath, undefined, { shell: false });
        info.process.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${pm} install failed`));
        });
      });
    } else {
      // Default to npx create-expo-app
      const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
      await new Promise<void>((resolve, reject) => {
        const info = this.processManager.spawn(npx, ['create-expo-app', name, '--template', 'blank'], parentPath, undefined, { shell: false });
        info.process.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error('create-expo-app failed'));
        });
      });
    }
    
    return projectPath;
  }

  async startPreview(projectPath: string, port: number, onLog?: (line: string) => void): Promise<ProviderPreviewSession> {
    const pm = await this.detectPackageManager(projectPath);
    const execCmd = process.platform === 'win32' ? (pm === 'npm' ? 'npx.cmd' : `${pm}.cmd`) : (pm === 'npm' ? 'npx' : pm);
    const cmdArgs = pm === 'npm' ? ['expo', 'start', '--web', '--port', port.toString()] : ['exec', 'expo', 'start', '--web', '--port', port.toString()];
    
    console.log('[DEBUG_RUNTIME] react-native-managed startPreview received path:', projectPath);
    
    return new Promise((resolve, reject) => {
      let resolved = false;
      let logs: string[] = [];
      console.log(`[DEBUG_RUNTIME] ProcessManager.spawn command: ${execCmd} ${cmdArgs.join(' ')}`);
      console.log(`[DEBUG_RUNTIME] ProcessManager.spawn cwd: ${projectPath}`);

      const info = this.processManager.spawn(execCmd, cmdArgs, projectPath, {
        EXPO_NO_TELEMETRY: 'true',
        CI: 'true',
      }, { shell: false });

      const timeout = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          this.processManager.kill(info.id);
          reject(new Error('Preview failed to start within timeout.'));
        }
      }, 150000);

      info.process.stdout?.on('data', (data) => {
        const str = data.toString();
        logs.push(str);
        if (onLog) onLog(str);
        
        const isReady = /(localhost|127\.0\.0\.1):\d+/.test(str) || str.toLowerCase().includes('running on') || str.toLowerCase().includes('ready on') || str.includes('Metro waiting on');
        if (!resolved && isReady) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            url: `http://localhost:${port}`,
            processId: info.id,
            logs
          });
        }
      });

      info.process.stderr?.on('data', (data) => {
        const str = data.toString();
        logs.push(str);
        if (onLog) onLog(str);
      });

      info.process.on('exit', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          const fullLog = logs.join('\n').trim();
          reject(new Error(fullLog || `Preview process exited with code ${code}`));
        }
      });
    });
  }

  stopPreview(processId: number): void {
    this.processManager.kill(processId);
  }

  reloadPreview(processId: number): void {
    this.processManager.writeStdin(processId, 'r\n');
  }

  async buildAndroid(_projectPath: string): Promise<string> {
    throw new Error('Android build is not yet supported in Managed mode (requires EAS cloud).');
  }

  async buildIos(_projectPath: string): Promise<string> {
    throw new Error('iOS build requires EAS cloud.');
  }

  async buildWeb(projectPath: string): Promise<string> {
    const pm = await this.detectPackageManager(projectPath);
    const execCmd = process.platform === 'win32' ? (pm === 'npm' ? 'npx.cmd' : `${pm}.cmd`) : (pm === 'npm' ? 'npx' : pm);
    const cmdArgs = pm === 'npm' ? ['expo', 'export', '--platform', 'web'] : ['exec', 'expo', 'export', '--platform', 'web'];
    
    return new Promise((resolve, reject) => {
      const info = this.processManager.spawn(execCmd, cmdArgs, projectPath, undefined, { shell: false });
      info.process.on('exit', (code) => {
        if (code === 0) resolve(join(projectPath, 'dist'));
        else reject(new Error('Web build failed'));
      });
    });
  }

  async getAgentContext(projectPath: string): Promise<string> {
    try {
      const packageJsonPath = join(projectPath, 'package.json');
      await access(packageJsonPath);
      return 'This is a React Native project using Expo in a managed environment. Do NOT run native Android/iOS commands. Use Expo CLI.';
    } catch {
      return 'This workspace is completely EMPTY and UNINITIALIZED. You MUST run the `bootstrap_project` tool first before doing anything else.';
    }
  }

  async validateProject(projectPath: string): Promise<ValidationResult> {
    const pm = await this.detectPackageManager(projectPath);
    const execCmd = process.platform === 'win32' ? (pm === 'npm' ? 'npx.cmd' : `${pm}.cmd`) : (pm === 'npm' ? 'npx' : pm);
    const cmdArgs = pm === 'npm' ? ['tsc', '--noEmit'] : ['exec', 'tsc', '--noEmit'];

    const checks = [];
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    // We can just run tsc --noEmit as a basic check if tsconfig exists
    try {
      const tsconfigPath = join(projectPath, 'tsconfig.json');
      await access(tsconfigPath);
      
      await new Promise<void>((resolve) => {
        const info = this.processManager.spawn(execCmd, cmdArgs, projectPath, undefined, { shell: false });
        info.process.stdout?.on('data', (d) => stdout += d.toString());
        info.process.stderr?.on('data', (d) => stderr += d.toString());
        info.process.on('exit', (code) => {
          exitCode = code ?? 1;
          resolve();
        });
      });

      checks.push({
        type: 'tsc',
        success: exitCode === 0,
        exitCode,
        stdout,
        stderr
      });

    } catch {
      // no tsconfig, maybe just check eslint if exists?
      checks.push({
        type: 'tsc',
        success: true,
        exitCode: 0,
        stdout: 'No tsconfig.json found, skipping typecheck.',
        stderr: ''
      });
    }

    const missingPackages: string[] = [];
    const missingRegex = /Cannot find module '([^']+)'/g;
    let match;
    while ((match = missingRegex.exec(stdout)) !== null) {
      if (match[1] && !match[1].startsWith('.') && !missingPackages.includes(match[1])) {
        const pkg = match[1].split('/')[0];
        if (pkg && !missingPackages.includes(pkg)) {
          missingPackages.push(pkg);
        }
      }
    }
    while ((match = missingRegex.exec(stderr)) !== null) {
      if (match[1] && !match[1].startsWith('.') && !missingPackages.includes(match[1])) {
        const pkg = match[1].split('/')[0];
        if (pkg && !missingPackages.includes(pkg)) {
          missingPackages.push(pkg);
        }
      }
    }

    let isMissingDeps = missingPackages.length > 0;
    
    // Auto-repair missing or broken dependencies
    if (isMissingDeps || stdout.includes('Cannot find module') || stderr.includes('Cannot find module') || stdout.includes('Command failed') || stderr.includes('Command failed')) {
      console.log(`[DEBUG_RUNTIME] Missing dependencies detected, attempting repair with ${pm} install...`);
      const installCmd = process.platform === 'win32' ? `${pm}.cmd` : pm;
      try {
        await new Promise<void>((resolve, reject) => {
          const info = this.processManager.spawn(installCmd, ['install'], projectPath, undefined, { shell: false });
          info.process.on('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`${pm} install failed`));
          });
        });
        console.log(`[DEBUG_RUNTIME] Repair successful.`);
        isMissingDeps = false; // Repaired
      } catch (err) {
        console.error(`[DEBUG_RUNTIME] Repair failed:`, err);
      }
    }

    const blockingErrors = checks.filter(c => !c.success).length;

    return {
      success: blockingErrors === 0 && !isMissingDeps,
      framework: 'react-native',
      environment: 'managed',
      checks,
      blockingErrors: blockingErrors + (isMissingDeps ? 1 : 0),
      warnings: 0,
      errorCategory: isMissingDeps ? 'missing_dependencies' : (blockingErrors > 0 ? 'type_error' : 'success'),
      missingPackages
    } as any;
  }

  async buildProject(projectPath: string, platform: string): Promise<BuildResult> {
    const startTime = Date.now();
    if (platform === 'web') {
      try {
        const outputPath = await this.buildWeb(projectPath);
        return {
          success: true,
          framework: 'react-native',
          environment: 'managed',
          platform,
          outputPath,
          exitCode: 0,
          stdout: 'Web export successful.',
          stderr: '',
          duration: Date.now() - startTime
        };
      } catch (err: any) {
        return {
          success: false,
          framework: 'react-native',
          environment: 'managed',
          platform,
          exitCode: 1,
          stdout: '',
          stderr: err.message || String(err),
          duration: Date.now() - startTime,
          errorCategory: 'compile_error'
        };
      }
    }

    return {
      success: false,
      framework: 'react-native',
      environment: 'managed',
      platform,
      exitCode: null,
      stdout: '',
      stderr: '',
      errorCategory: 'environment_error',
      message: `Local builds for ${platform} are not supported in Expo Managed mode (requires EAS cloud).`
    };
  }

  async runTests(projectPath: string): Promise<TestResult> {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
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
      console.log('[DEBUG_RUNTIME] react-native-managed startApplication received projectPath:', projectPath);
      // expo start on a default port
      const port = 8081;
      const preview = await this.startPreview(projectPath, port);
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
        environment: 'managed',
        startedAt: '',
        exitCode: null
      };
    }

    return {
      processId,
      status: info.status,
      command: info.command,
      framework: 'react-native',
      environment: 'managed',
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

  async bootstrapProject(projectPath: string, _options?: { template?: string }): Promise<{ success: boolean; message: string }> {
    const appName = basename(projectPath);
    const appSlug = appName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
    try {
      
      // 1. Create package.json
      const packageJson = {
        name: appSlug,
        version: "1.0.0",
        scripts: {
          "start": "expo start",
          "android": "expo start --android",
          "ios": "expo start --ios",
          "web": "expo start --web",
          "ts:check": "tsc"
        },
        dependencies: {
          "expo": "~51.0.0",
          "expo-status-bar": "~1.12.1",
          "react": "18.2.0",
          "react-dom": "18.2.0",
          "react-native": "0.74.1",
          "react-native-web": "~0.19.10",
          "@expo/metro-runtime": "~3.2.1"
        },
        devDependencies: {
          "@babel/core": "^7.20.0",
          "@types/react": "~18.2.45",
          "typescript": "^5.1.3"
        },
        private: true
      };
      await writeFile(join(projectPath, 'package.json'), JSON.stringify(packageJson, null, 2));

      // 2. Create tsconfig.json
      const tsconfig = {
        extends: "expo/tsconfig.base",
        compilerOptions: {
          strict: true
        }
      };
      await writeFile(join(projectPath, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));

      // 3. Create app.json
      // No icon/splash image paths: assets/ starts empty, and `expo prebuild` fails on a missing image.
      // Expo uses its default icon until the user adds one.
      const appJson = {
        expo: {
          name: appName,
          slug: appSlug,
          version: "1.0.0",
          orientation: "portrait",
          userInterfaceStyle: "light",
          splash: {
            resizeMode: "contain",
            backgroundColor: "#ffffff"
          },
          ios: {
            supportsTablet: true
          },
          android: {
            adaptiveIcon: {
              backgroundColor: "#ffffff"
            }
          }
        }
      };
      await writeFile(join(projectPath, 'app.json'), JSON.stringify(appJson, null, 2));

      // 4. Create App.tsx
      const Apptsx = `import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>Welcome to your new Synkro React Native app!</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
`;
      await writeFile(join(projectPath, 'App.tsx'), Apptsx);

      // Create assets/ folder
      await mkdir(join(projectPath, 'assets'), { recursive: true });

      // 5. Run install
      const pm = await this.detectPackageManager(projectPath);
      const installCmd = process.platform === 'win32' ? `${pm}.cmd` : pm;
      await new Promise<void>((resolve, reject) => {
        const info = this.processManager.spawn(installCmd, ['install'], projectPath, undefined, { shell: false });
        info.process.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`${pm} install failed with exit code ${code}`));
        });
      });

      return {
        success: true,
        message: 'Project successfully bootstrapped in-place.'
      };

    } catch (err: any) {
      return {
        success: false,
        message: `Failed to bootstrap project: ${err.message || String(err)}`
      };
    }
  }

  async installDependencies(projectPath: string, packages: string[]): Promise<{ success: boolean; exitCode: number | null; stdout: string; stderr: string; message?: string }> {
    const pm = await this.detectPackageManager(projectPath);
    const installCmd = process.platform === 'win32' ? `${pm}.cmd` : pm;
    const args = pm === 'npm' ? ['install', '--save', ...packages] : ['add', ...packages];
    
    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      await new Promise<void>((resolve, reject) => {
        const info = this.processManager.spawn(installCmd, args, projectPath, undefined, { shell: false });
        info.process.stdout?.on('data', (d) => stdout += d.toString());
        info.process.stderr?.on('data', (d) => stderr += d.toString());
        info.process.on('exit', (code) => {
          exitCode = code ?? 1;
          if (code === 0) resolve();
          else reject(new Error(`${pm} install failed with exit code ${code}`));
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
