import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildArtifact, BuildRecord, BuildStatus, PublishOptions } from '@peep/shared';

export type BuildLogCallback = (buildId: string, line: string) => void;
export type BuildStatusCallback = (record: BuildRecord) => void;

export class AndroidBuilder {
  private activeProcess: ReturnType<typeof spawn> | null = null;
  private currentBuildId: string | null = null;

  constructor(
    private readonly flutterBin: string,
    private readonly onLog: BuildLogCallback,
    private readonly onStatus: BuildStatusCallback,
  ) {}

  async build(
    record: BuildRecord,
    options: PublishOptions,
  ): Promise<BuildRecord> {
    this.currentBuildId = record.id;

    const emit = (status: BuildStatus, extra?: Partial<BuildRecord>) => {
      const updated: BuildRecord = { ...record, status, ...extra };
      record = updated;
      this.onStatus(updated);
    };

    const log = (line: string) => this.onLog(record.id, line);

    try {
      emit('preparing');
      log('🔧 Preparing build environment...');

      // pub get
      log('📦 Running flutter pub get...');
      await this.runFlutter(['pub', 'get'], options.projectPath, log);

      emit('building');

      const targets: Array<'apk' | 'aab'> = options.target === 'both'
        ? ['apk', 'aab']
        : [options.target];

      const artifacts: BuildArtifact[] = [];

      for (const t of targets) {
        if (t === 'apk') {
          log('🏗️  Building APK (release)...');
          emit('building');
          await this.runFlutter(
            ['build', 'apk', '--release',
              '--build-name', record.versionName,
              '--build-number', String(record.versionCode)],
            options.projectPath, log,
          );
          const apkPath = join(options.projectPath, 'build', 'app', 'outputs', 'flutter-apk', 'app-release.apk');
          const apkStat = await stat(apkPath);
          artifacts.push({ type: 'apk', path: apkPath, sizeBytes: apkStat.size });
          log(`✅ APK built: ${apkPath} (${(apkStat.size / 1_000_000).toFixed(1)} MB)`);
        } else {
          log('🏗️  Building AAB (release)...');
          emit('packaging');
          await this.runFlutter(
            ['build', 'appbundle', '--release',
              '--build-name', record.versionName,
              '--build-number', String(record.versionCode)],
            options.projectPath, log,
          );
          const aabPath = join(options.projectPath, 'build', 'app', 'outputs', 'bundle', 'release', 'app-release.aab');
          const aabStat = await stat(aabPath);
          artifacts.push({ type: 'aab', path: aabPath, sizeBytes: aabStat.size });
          log(`✅ AAB built: ${aabPath} (${(aabStat.size / 1_000_000).toFixed(1)} MB)`);
        }
      }

      const completedAt = new Date().toISOString();
      const durationMs = Date.now() - new Date(record.startedAt).getTime();
      const final: BuildRecord = { ...record, status: 'completed', completedAt, durationMs, artifacts };
      this.onStatus(final);
      log(`\n🎉 Build completed in ${(durationMs / 1000).toFixed(1)}s`);
      this.currentBuildId = null;
      return final;

    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const friendly = this.friendlyError(errMsg);
      log(`\n❌ Build failed: ${friendly}`);
      const failed: BuildRecord = { ...record, status: 'failed', error: friendly, completedAt: new Date().toISOString() };
      this.onStatus(failed);
      this.currentBuildId = null;
      return failed;
    }
  }

  cancel(): void {
    if (this.activeProcess) {
      this.activeProcess.kill('SIGTERM');
      this.activeProcess = null;
    }
    if (this.currentBuildId) {
      this.onLog(this.currentBuildId, '⚠️  Build cancelled by user.');
    }
    this.currentBuildId = null;
  }

  private runFlutter(args: string[], cwd: string, log: (l: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(this.flutterBin, args, { cwd, shell: true });
      this.activeProcess = proc;

      const handleData = (chunk: Buffer) => {
        const text = chunk.toString();
        for (const line of text.split(/\r?\n/)) {
          if (line.trim()) log(line);
        }
      };

      proc.stdout?.on('data', handleData);
      proc.stderr?.on('data', handleData);

      proc.on('error', (err) => {
        this.activeProcess = null;
        reject(err);
      });

      proc.on('close', (code) => {
        this.activeProcess = null;
        if (code === 0 || code === null) resolve();
        else reject(new Error(`flutter ${args[0]} exited with code ${code}`));
      });
    });
  }

  private friendlyError(msg: string): string {
    if (msg.includes('flutter.bat') || msg.includes('flutter: command not found')) {
      return 'Flutter SDK not found. Please install Flutter and add it to your PATH.';
    }
    if (msg.includes('ANDROID_HOME') || msg.includes('Android SDK')) {
      return 'Android SDK not found. Please install Android Studio and set ANDROID_HOME.';
    }
    if (msg.includes('java') && msg.includes('not found')) {
      return 'Java not found. Please install Java 11 or 17 from https://adoptium.net/';
    }
    if (msg.includes('Gradle')) {
      return `Gradle build failed. ${msg.split('\n').slice(-5).join('\n')}`;
    }
    return msg.split('\n').slice(-10).join('\n');
  }
}
