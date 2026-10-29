import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setupBuildNetwork, BUILD_NETWORK, RESOLVER_IP } from './network-setup.js';

export type BuildFramework = 'flutter' | 'react-native';

export interface SandboxConfig {
  jobId: string;
  projectPath: string;
  timeoutMs?: number;
  framework?: BuildFramework;
  keystorePath?: string;
  keystorePassword?: string;
  keyAlias?: string;
  keyPassword?: string;
}

export const FRAMEWORK_IMAGES: Record<BuildFramework, string> = {
  'flutter': 'synkro/flutter-sandbox:2',
  'react-native': 'synkro/rn-sandbox:1',
};

// Runs inside the container on the copy of the project in /build, just before `expo prebuild`; the user's own
// files are never touched. Only a static app.json is handled (an app.config.js is left as it is).
// - Non-interactive prebuild refuses to run without android.package, which Expo templates leave out:
//   one without it gets com.synkro.<slug>.
// - Prebuild fails on an image path that does not exist (older Synkro templates pointed at an empty assets/):
//   only that key is removed, so Expo falls back to its default image.
const PREPARE_EXPO_CONFIG_JS = `
const fs = require('fs');
const path = require('path');
if (fs.existsSync('app.json')) {
  const json = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  const expo = json.expo || json;
  expo.android = expo.android || {};
  if (!expo.android.package) {
    const slug = String(expo.slug || expo.name || 'app').toLowerCase().replace(/[^a-z0-9]/g, '');
    expo.android.package = 'com.synkro.' + (/^[a-z]/.test(slug) ? slug : 'app' + slug);
    console.log('[SYSTEM] android.package is not set, using ' + expo.android.package);
  }
  const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
  const dropMissingImages = (obj, at) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string' && IMAGE.test(value) && !/^[a-z]+:/i.test(value) && !fs.existsSync(path.resolve(value))) {
        delete obj[key];
        console.log('[SYSTEM] ' + at + key + ' points to a missing image (' + value + '), using the Expo default');
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        dropMissingImages(value, at + key + '.');
      }
    }
  };
  dropMissingImages(expo, 'expo.');
  fs.writeFileSync('app.json', JSON.stringify(json, null, 2));
}
`;
// Base64 keeps the script clear of shell quoting.
const PREPARE_EXPO_CONFIG = `echo ${Buffer.from(PREPARE_EXPO_CONFIG_JS).toString('base64')} | base64 -d > /tmp/prepare-expo-config.js && node /tmp/prepare-expo-config.js`;

// Expo projects usually have no android/ folder, so generate it the same way the Flutter command runs
// `flutter create`. Checks for android/gradlew, not the folder, so a half-made android/ still counts as missing.
// CI=1 keeps prebuild non-interactive and EXPO_NO_TELEMETRY stops it calling Expo's servers. With the default
// template it only fetches expo-template-bare-minimum from the npm registry, which the network allowlist covers.
// --no-install skips prebuild's own install; npm install runs again after it in case package.json changed.
const ENSURE_RN_ANDROID_PROJECT = [
  '( [ -f android/gradlew ] || (',
  '( [ -d node_modules/expo ] || { echo "[SYSTEM] There is no android/ project and this is not an Expo project, so one cannot be generated." >&2; exit 1; } )',
  `&& ${PREPARE_EXPO_CONFIG}`,
  '&& CI=1 EXPO_NO_TELEMETRY=1 npx expo prebuild --platform android --no-install',
  '&& npm install --no-audit --no-fund',
  ') )',
].join(' ');

/** `signingSetup` runs after android/ exists and before Gradle (React Native only). Exported for tests. */
export function getBuildCommand(framework: BuildFramework, signingSetupOrHasKeystore: string[] | boolean = []): string {
  if (framework === 'flutter') {
    // If the project lacks an android/ folder (e.g. web-only repo), generate it safely
    // without overwriting existing lib/ or pubspec.yaml.
    return 'cd /build && ( [ -d android ] || flutter create --platforms=android . ) && flutter build apk --release';
  }
  // Append sandbox Gradle constraints to android/gradle.properties before invoking the wrapper:
  //   - workers.max=2: cap JVM worker processes to our CPU budget (avoids spawning host-core-count workers)
  //   - parallel=false: no inter-project parallel execution (irrelevant for single-app builds, but safe)
  //   - daemon=false: skip the persistent daemon JVM — it is wasted inside a one-shot container and
  //                   costs an extra forked process plus a daemon-watcher process
  //   - jvmargs=-Xmx1g: cap build JVM heap explicitly (default would be ~25% of container memory;
  //                      capping at 1g frees headroom for clang during native CMake compilation)
  //   - reactNativeArchitectures=arm64-v8a,armeabi-v7a: ABI filter restricting NDK compilation to ARM devices,
  //     cutting compilation time by ~50% by avoiding x86 and x86_64 emulator binaries.
  // Together these keep Gradle's peak PID count well under 200, letting us use pids-limit=384.
  const gradleConstraints = [
    'mkdir -p android && touch android/gradle.properties',
    'printf "\\norg.gradle.workers.max=2\\n" >> android/gradle.properties',
    'printf "org.gradle.parallel=false\\n" >> android/gradle.properties',
    'printf "org.gradle.daemon=false\\n" >> android/gradle.properties',
    'printf "org.gradle.jvmargs=-Xmx1g\\n" >> android/gradle.properties',
    'printf "reactNativeArchitectures=arm64-v8a,armeabi-v7a\\n" >> android/gradle.properties',
  ].join(' && ');

  const signing = Array.isArray(signingSetupOrHasKeystore) ? signingSetupOrHasKeystore : [];
  const gradlewCmd = 'cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a -Pandroid.injected.build.abi=arm64-v8a,armeabi-v7a';

  // NOTE: We do NOT use `npx react-native build-android` here — the RN CLI wrapper calls
  // getTaskNames(..., 'bundle') internally, which runs bundleRelease and produces an .aab
  // (Android App Bundle). .aab requires Google Play's bundletool to install; it cannot be
  // sideloaded directly. We invoke ./gradlew assembleRelease explicitly to get a plain .apk.
  return [
    'npm install --no-audit --no-fund',
    ENSURE_RN_ANDROID_PROJECT,
    ...signing,
    '([ -f android/gradlew ] && chmod +x android/gradlew || true)',
    gradleConstraints,
    gradlewCmd,
  ].join(' && ');
}

// TEMPORARY: a blank Expo app took ~40 minutes in a 2-CPU sandbox, most of it downloading and compiling Gradle
// dependencies from scratch. Go back to 15 minutes once the pre-built image exists
// (Trello: "Pre-warmed RN/Expo sandbox image"). Keep the reconciler in build-worker.ts at least 5 minutes above this.
export const BUILD_TIMEOUT_MS: Record<BuildFramework, number> = {
  'flutter': 15 * 60 * 1000,
  'react-native': 45 * 60 * 1000,
};

function getArtifactPath(framework: BuildFramework): string {
  if (framework === 'flutter') {
    return '/build/build/app/outputs/flutter-apk/app-release.apk';
  }
  return '/build/android/app/build/outputs/apk/release/app-release.apk';
}

export class DockerSandbox {
  private containerName: string;
  private childProcess: ReturnType<typeof spawn> | null = null;
  private config: SandboxConfig;

  constructor(config: SandboxConfig) {
    this.config = config;
    this.containerName = `build_sandbox_${config.jobId}`;
  }

  private async setupNetwork(onLog: (chunk: string) => void): Promise<string | false> {
    try {
      await setupBuildNetwork();
    } catch (e: any) {
      if (process.platform === 'linux') {
        onLog(`[SYSTEM] Network isolation setup failed: ${e.message}\n`);
        return false;
      }
      console.warn('[SANDBOX] Network isolation setup failed (expected on non-Linux hosts):', e.message);
    }
    return BUILD_NETWORK;
  }

  async runBuild(onLog: (chunk: string) => void): Promise<boolean> {
    const framework = this.config.framework || 'flutter';
    const timeoutMs = this.config.timeoutMs || BUILD_TIMEOUT_MS[framework];
    const image = FRAMEWORK_IMAGES[framework];
    const hasKeystore = !!this.config.keystorePath;

    const netName = await this.setupNetwork(onLog);
    if (!netName) return false;

    // Flutter needs a much larger storage limit (15G) because the SDK/Android SDK are in the image layer
    // and NDK/CMake downloads at build time consume a significant amount of additional space.
    // React Native remains at 5G.
    const storageLimit = framework === 'flutter' ? 'size=15G' : 'size=5G';

    const createArgs = [
      'create',
      '--name', this.containerName,
      '--memory=5g',
      '--memory-swap=5g',
      '--cpus=2.0',
      '--pids-limit=384',
      '--storage-opt', storageLimit,
      '--cap-drop=ALL',
      '--security-opt', 'no-new-privileges',
      '--network', netName,
      '--dns', RESOLVER_IP,
      '--user=1000:1000',
      '-e', 'NPM_CONFIG_CACHE=/tmp/.npm-cache',
      '-e', 'HOME=/tmp',
      '-e', 'GRADLE_USER_HOME=/tmp/.gradle',
      image,
    ];

    const canSign = hasKeystore && !!this.config.keystorePassword && !!this.config.keyAlias;
    const keyPassword = this.config.keyPassword || this.config.keystorePassword;
    // React Native writes its signing properties inside the build command, after android/ has been generated.
    const rnSigningSetup = canSign && framework === 'react-native'
      ? [
          `echo "MYAPP_UPLOAD_STORE_FILE=/build/release.jks" >> /build/android/gradle.properties`,
          `echo "MYAPP_UPLOAD_STORE_PASSWORD=${this.config.keystorePassword}" >> /build/android/gradle.properties`,
          `echo "MYAPP_UPLOAD_KEY_ALIAS=${this.config.keyAlias}" >> /build/android/gradle.properties`,
          `echo "MYAPP_UPLOAD_KEY_PASSWORD=${keyPassword}" >> /build/android/gradle.properties`,
        ]
      : [];
    const buildCommand = getBuildCommand(framework, rnSigningSetup);

    let shellScript = `cd /build && ${buildCommand}`;

    if (canSign && framework === 'flutter') {
      shellScript = [
        `mkdir -p /build/android`,
        `echo "storeFile=/build/release.jks" > /build/android/key.properties`,
        `echo "storePassword=${this.config.keystorePassword}" >> /build/android/key.properties`,
        `echo "keyAlias=${this.config.keyAlias}" >> /build/android/key.properties`,
        `echo "keyPassword=${keyPassword}" >> /build/android/key.properties`,
        `cd /build && ${buildCommand}`,
      ].join(' && ');
    }

    createArgs.push('sh', '-c', shellScript);

    onLog(`[SYSTEM] Creating ${framework} sandbox with security constraints...\n`);

    const { execFile } = await import('node:child_process');
    const execFileAsync = promisify(execFile);

    try {
      await execFileAsync('docker', createArgs);
    } catch (err: any) {
      onLog(`[SYSTEM] Container creation failed: ${err.message}\n`);
      return false;
    }

    onLog(`[SYSTEM] Setting source ownership to unprivileged user...\n`);
    try {
      if (process.platform !== 'win32') {
        await execFileAsync('chown', ['-R', '1000:1000', this.config.projectPath]);
      }
    } catch (err: any) {
      onLog(`[SYSTEM] Host source chown failed: ${err.message}\n`);
      return false;
    }

    onLog(`[SYSTEM] Injecting source files...\n`);
    try {
      await execFileAsync('docker', ['cp', `${this.config.projectPath}/.`, `${this.containerName}:/build`]);
    } catch (err: any) {
      onLog(`[SYSTEM] Source injection failed: ${err.message}\n`);
      return false;
    }

    if (hasKeystore) {
      onLog(`[SYSTEM] Injecting signing keystore...\n`);
      try {
        if (process.platform !== 'win32') {
          await execFileAsync('chown', ['1000:1000', this.config.keystorePath!]);
        }
        await execFileAsync('docker', ['cp', this.config.keystorePath!, `${this.containerName}:/build/release.jks`]);
      } catch (err: any) {
        onLog(`[SYSTEM] Keystore injection failed: ${err.message}\n`);
        return false;
      }
    }

    onLog(`[SYSTEM] Starting ${framework} build process...\n`);

    return new Promise((resolve) => {
      let isResolved = false;
      this.childProcess = spawn('docker', ['start', '-a', this.containerName]);

      const timeoutTimer = setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          onLog(`[SYSTEM] Build timed out after ${Math.round(timeoutMs / 1000)}s. Terminating container...`);
          await this.forceKill();
          resolve(false);
        }
      }, timeoutMs);

      this.childProcess.stdout?.on('data', (data) => {
        onLog(data.toString());
      });

      this.childProcess.stderr?.on('data', (data) => {
        onLog(`[ERROR] ${data.toString()}`);
      });

      this.childProcess.on('close', async (code) => {
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutTimer);
          if (code === 0) {
            // Do NOT forceKill here. The container must remain (in stopped state)
            // so we can extract the artifact from it.
            resolve(true);
          } else {
            await this.forceKill();
            onLog(`[SYSTEM] Build exited with code ${code}`);
            resolve(false);
          }
        }
      });
    });
  }

  /**
   * Extracts the built artifact safely from the stopped container.
   *
   * SECURITY: docker cp resolves symlinks found inside the container's tar
   * stream relative to the HOST filesystem (CVE-2019-14271).
   * To prevent a malicious build from planting a symlink at the artifact path
   * (e.g. pointing to /etc/shadow) and exfiltrating host files:
   * 1. We docker cp the PARENT directory of the artifact into a fresh host temp dir.
   * 2. We use fs.lstat (which does not follow symlinks) on the host to verify
   *    the artifact is a regular file before reading/copying it.
   */
  async extractArtifact(localDestPath: string): Promise<boolean> {
    const framework = this.config.framework || 'flutter';
    const artifactPath = getArtifactPath(framework);
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { mkdtemp, lstat, copyFile, rm } = await import('node:fs/promises');
    const { join, dirname, basename } = await import('node:path');
    const os = await import('node:os');

    const tempDir = await mkdtemp(join(os.tmpdir(), 'extract-'));
    try {
      // 1. Copy the parent directory to a safe host location
      await execFileAsync('docker', ['cp', `${this.containerName}:${dirname(artifactPath)}/.`, tempDir]);

      const extractedFile = join(tempDir, basename(artifactPath));
      
      // 2. Safely verify it is a regular file
      const stats = await lstat(extractedFile);
      
      if (stats.isSymbolicLink()) {
        console.error(`[SECURITY] Critical: Symlink detected at artifact path. Extraction rejected.`);
        return false;
      }
      
      if (!stats.isFile()) {
        console.error(`[SYSTEM] Artifact is not a regular file.`);
        return false;
      }

      // 3. Size cap (250MB) to prevent disk exhaustion
      const MAX_SIZE = 250 * 1024 * 1024;
      if (stats.size > MAX_SIZE) {
        console.error(`[SYSTEM] Artifact size exceeds limit of 250MB.`);
        return false;
      }

      // 4. Move to final destination
      await copyFile(extractedFile, localDestPath);
      return true;
    } catch (err: any) {
      console.error(`[DOCKER] Artifact extraction failed: ${err.message}`);
      return false;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async forceKill(): Promise<void> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    try {
      await execFileAsync('docker', ['rm', '-f', this.containerName]);
    } catch (e: any) {
      console.error(`[DOCKER] Failed to kill container ${this.containerName}:`, e.message);
    }
  }
}
