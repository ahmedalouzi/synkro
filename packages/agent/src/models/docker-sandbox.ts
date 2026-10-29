import { spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setupBuildNetwork, verifyBuildNetwork, BUILD_NETWORK, RESOLVER_IP } from './network-setup.js';

export type BuildFramework = 'flutter' | 'react-native';

export interface SandboxConfig {
  jobId: string;
  projectPath: string;
  timeoutMs?: number;
  framework?: BuildFramework;
  /** Release signing key for this build (see signing-keys.ts). */
  signing?: SandboxSigning;
}

export interface SandboxSigning {
  keystore: Buffer;
  storePassword: string;
  keyPassword: string;
  alias: string;
}

// The Android Gradle Plugin's "injected" signing properties (what Android Studio's Generate Signed APK uses)
// override the signingConfig in build.gradle for every variant, so one mechanism signs React Native, Expo
// (after prebuild) and Flutter without editing their Gradle files. They are read from gradle.properties in
// GRADLE_USER_HOME, which keeps the passwords out of the command line, the environment and the build log.
const GRADLE_USER_HOME = '/tmp/.gradle';
const SIGNING_KEYSTORE_PATH = `${GRADLE_USER_HOME}/synkro-upload.p12`;

/** Exported for tests. */
export function signingGradleProperties(signing: SandboxSigning): string {
  return [
    `android.injected.signing.store.file=${SIGNING_KEYSTORE_PATH}`,
    `android.injected.signing.store.password=${signing.storePassword}`,
    `android.injected.signing.key.alias=${signing.alias}`,
    `android.injected.signing.key.password=${signing.keyPassword}`,
    '',
  ].join('\n');
}

/** One ustar header + content, padded to 512-byte blocks. */
function tarEntry(name: string, mode: number, content: Buffer | null): Buffer {
  const header = Buffer.alloc(512);
  const field = (value: string, offset: number, length: number) => header.write(value, offset, length, 'utf8');
  const octal = (value: number, offset: number, length: number) => field(value.toString(8).padStart(length - 1, '0') + '\0', offset, length);
  field(name, 0, 100);
  octal(mode, 100, 8);
  octal(1000, 108, 8); // uid: the sandbox user
  octal(1000, 116, 8); // gid
  octal(content ? content.length : 0, 124, 12);
  octal(Math.floor(Date.now() / 1000), 136, 12);
  header.fill(' ', 148, 156); // the checksum is computed with this field as spaces
  field(content ? '0' : '5', 156, 1);
  field('ustar\0', 257, 6);
  field('00', 263, 2);
  let sum = 0;
  for (const byte of header) sum += byte;
  field(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  if (!content) return header;
  return Buffer.concat([header, content, Buffer.alloc((512 - (content.length % 512)) % 512)]);
}

/**
 * A tar archive for `docker cp -a - <container>:/` holding GRADLE_USER_HOME with the keystore and the signing
 * properties, owned by the sandbox user and readable only by it. Streamed over stdin, so nothing secret is
 * written to the host's disk. Exported for tests.
 */
export function createSigningArchive(signing: SandboxSigning): Buffer {
  const dir = GRADLE_USER_HOME.slice(1);
  return Buffer.concat([
    tarEntry(`${dir}/`, 0o700, null),
    tarEntry(`${dir}/gradle.properties`, 0o600, Buffer.from(signingGradleProperties(signing), 'utf8')),
    tarEntry(SIGNING_KEYSTORE_PATH.slice(1), 0o600, signing.keystore),
    Buffer.alloc(1024),
  ]);
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

/** Exported for tests. */
export function getBuildCommand(framework: BuildFramework): string {
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

  // Not -Pandroid.injected.build.abi: that is Android Studio's deploy-to-one-device flag, and with it Gradle did not
  // write app/build/outputs/apk/release/app-release.apk, so the worker found no APK (Oct 30, Expo on rn-sandbox:1).
  const gradlewCmd = 'cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,armeabi-v7a';

  // NOTE: We do NOT use `npx react-native build-android` here — the RN CLI wrapper calls
  // getTaskNames(..., 'bundle') internally, which runs bundleRelease and produces an .aab
  // (Android App Bundle). .aab requires Google Play's bundletool to install; it cannot be
  // sideloaded directly. We invoke ./gradlew assembleRelease explicitly to get a plain .apk.
  return [
    'npm install --no-audit --no-fund',
    ENSURE_RN_ANDROID_PROJECT,
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
    // In production the worker runs as the unprivileged synkro user. The firewall (iptables, ipset, dnsmasq) is
    // then set up by root at boot (synkro-build-network.service, see scripts/setup-production-server.sh), and the
    // build only starts once it is confirmed to be in place.
    if (process.platform === 'linux' && process.getuid?.() !== 0) {
      try {
        await verifyBuildNetwork();
        return BUILD_NETWORK;
      } catch (e: any) {
        onLog(`[SYSTEM] Build network is not ready: ${e.message}. Run: sudo systemctl restart synkro-build-network\n`);
        return false;
      }
    }
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

  /**
   * Arguments for `docker create`. They are visible to anyone on the host (docker inspect, ps), so they never
   * carry secrets: the signing key goes in through createSigningArchive(). Public for tests.
   */
  createContainerArgs(netName: string): string[] {
    const framework = this.config.framework || 'flutter';
    const image = FRAMEWORK_IMAGES[framework];

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
      '-e', `GRADLE_USER_HOME=${GRADLE_USER_HOME}`,
      image,
    ];

    createArgs.push('sh', '-c', `cd /build && ${getBuildCommand(framework)}`);
    return createArgs;
  }

  async runBuild(onLog: (chunk: string) => void): Promise<boolean> {
    const framework = this.config.framework || 'flutter';
    const timeoutMs = this.config.timeoutMs || BUILD_TIMEOUT_MS[framework];

    const netName = await this.setupNetwork(onLog);
    if (!netName) return false;

    const createArgs = this.createContainerArgs(netName);

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

    if (this.config.signing) {
      onLog(`[SYSTEM] Injecting release signing key...\n`);
      try {
        await new Promise<void>((resolve, reject) => {
          const cp = spawn('docker', ['cp', '-a', '-', `${this.containerName}:/`]);
          let stderr = '';
          cp.stderr?.on('data', (d) => { stderr += d.toString(); });
          cp.on('error', reject);
          cp.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `docker cp exited with ${code}`))));
          cp.stdin?.end(createSigningArchive(this.config.signing!));
        });
      } catch (err: any) {
        onLog(`[SYSTEM] Signing key injection failed: ${err.message}\n`);
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
