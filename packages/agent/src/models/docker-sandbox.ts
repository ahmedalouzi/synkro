import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { setupBuildNetwork, verifyBuildNetwork, BUILD_NETWORK, RESOLVER_IP } from './network-setup.js';
import { BuildLogLines } from './build-log.js';
import { cachedDiskQuota, diskQuotaRequired } from './disk-quota.js';

export type BuildFramework = 'flutter' | 'react-native';

export interface SandboxConfig {
  jobId: string;
  projectPath: string;
  timeoutMs?: number;
  framework?: BuildFramework;
  /** The project's stable ID (a UUID). Flutter builds need it for the package name, see flutterOrg(). */
  projectId?: string;
  /** Release signing key for this build (see signing-keys.ts). */
  signing?: SandboxSigning;
  /**
   * Mount the shared read-only Gradle cache when it exists (default true). scripts/warm-gradle-cache.ts turns it off:
   * it builds the cache, so its own Gradle must download and store everything.
   */
  gradleRoCache?: boolean;
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

/**
 * ABIs packaged into every APK (DEC-09): 64-bit ARM only. Every phone sold since ~2017 is 64-bit and Google Play requires
 * 64-bit; dropping armeabi-v7a halves the native (CMake/NDK) compilation and shrinks the APK. Trade-off: very old
 * 32-bit-only phones cannot install the app. x86/x86_64 are only for emulators.
 */
export const PACKAGED_ABIS = ['arm64-v8a'];
/** The same list for React Native's Gradle property (comma-separated). */
const RN_ARCHITECTURES = PACKAGED_ABIS.join(',');

/**
 * Gradle init script (GRADLE_USER_HOME/init.d/, applied to every build) that packages only PACKAGED_ABIS.
 * reactNativeArchitectures and Flutter's --target-platform only limit what is compiled; prebuilt .so files
 * from AARs (Hermes, fbjni, ...) still ship for every ABI unless the app's ndk.abiFilters says otherwise.
 * finalizeDsl runs after the app's build.gradle, so this overrides its own abiFilters without editing the
 * user's files. Not -Pandroid.injected.build.abi: with it Gradle did not write the APK where we look for it.
 *
 * It also turns off lint on release builds (checkReleaseBuilds): assembleRelease otherwise runs lintVital, which
 * resolves the test classpath of the libraries (Robolectric for expo-modules-core) and costs minutes. A blocked
 * download there failed an RN build (Nov 13) that needed none of it. Exported for tests.
 */
export const ABI_INIT_SCRIPT = `// Atomvs Cloud Build: package only ${PACKAGED_ABIS.join(' and ')}, and no lint on release builds.
def abis = [${PACKAGED_ABIS.map((a) => `'${a}'`).join(', ')}]
gradle.allprojects { project ->
  project.plugins.withId('com.android.application') {
    def components = project.extensions.findByName('androidComponents')
    if (components != null) {
      components.finalizeDsl { android ->
        android.defaultConfig.ndk.abiFilters.clear()
        android.defaultConfig.ndk.abiFilters.addAll(abis)
        android.lint.checkReleaseBuilds = false
      }
    } else {
      project.afterEvaluate {
        project.android.defaultConfig.ndk.abiFilters.clear()
        project.android.defaultConfig.ndk.abiFilters.addAll(abis)
        project.android.lintOptions.checkReleaseBuilds = false
      }
    }
  }
}
`;

/**
 * Gradle init script for the build cache baked into the sandbox image (Dockerfile.rn-sandbox, DEC-11): builds READ it
 * (org.gradle.caching=true, see getBuildCommand) but never store new entries in it (push = false), and Gradle's cache
 * cleanup is off: those caches are image files, and cleaning them would only copy or delete files in this build's own
 * layer, against its disk limit. Each part is guarded, so an older Gradle without these settings builds as before.
 * Exported for tests.
 */
export const CACHE_INIT_SCRIPT = `// Atomvs Cloud Build: read the image's Gradle build cache, never write it; no cache cleanup.
gradle.settingsEvaluated { settings ->
  try { settings.buildCache { local { push = false } } } catch (Throwable ignored) {}
}
beforeSettings { settings ->
  try {
    if (org.gradle.util.GradleVersion.current() >= org.gradle.util.GradleVersion.version('8.0')) {
      settings.caches { cleanup = org.gradle.api.cache.Cleanup.DISABLED }
    }
  } catch (Throwable ignored) {}
}
`;

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
 * A tar archive for `docker cp -a - <container>:/` holding GRADLE_USER_HOME: the ABI init script, the cache init script
 * (CACHE_INIT_SCRIPT) and, when the build is signed, the keystore and the signing properties. Owned by the sandbox
 * user and readable only by it. Extracted over the image's GRADLE_USER_HOME, whose caches it leaves in place.
 * Streamed over stdin, so nothing secret is written to the host's disk. Exported for tests.
 */
export function createGradleHomeArchive(signing?: SandboxSigning): Buffer {
  const dir = GRADLE_USER_HOME.slice(1);
  return Buffer.concat([
    tarEntry(`${dir}/`, 0o700, null),
    tarEntry(`${dir}/init.d/`, 0o700, null),
    tarEntry(`${dir}/init.d/atomvs-abi.gradle`, 0o600, Buffer.from(ABI_INIT_SCRIPT, 'utf8')),
    ...(signing
      ? [
          tarEntry(`${dir}/gradle.properties`, 0o600, Buffer.from(signingGradleProperties(signing), 'utf8')),
          tarEntry(SIGNING_KEYSTORE_PATH.slice(1), 0o600, signing.keystore),
        ]
      : []),
    // Last, so the entries above keep their positions (tests read them by index).
    tarEntry(`${dir}/init.d/atomvs-cache.gradle`, 0o600, Buffer.from(CACHE_INIT_SCRIPT, 'utf8')),
    Buffer.alloc(1024),
  ]);
}

export const FRAMEWORK_IMAGES: Record<BuildFramework, string> = {
  'flutter': 'synkro/flutter-sandbox:2',
  'react-native': 'synkro/rn-sandbox:1',
};

/**
 * Per-build disk limit in GB (`--storage-opt size=`: the container's writable layer, i.e. everything the build writes:
 * node_modules, Gradle caches under /tmp/.gradle, native build intermediates, the APK). Enforced since DEC-06.
 * Builds run one at a time (the worker takes one job), on the 100 GB Docker volume that also holds ~20 GB of images,
 * so one limit at a time has to fit next to the images, not all of them together.
 * - Flutter 15G: the SDK is in the image, but NDK/CMake downloads and Gradle caches come on top.
 * - React Native / Expo 12G (DEC-07): a real Expo build ran out of space at 5G (Gradle caches, expo-modules-core CMake
 *   intermediates) as soon as the quota was really enforced. The old 5G was never applied before DEC-06.
 */
export const BUILD_DISK_LIMIT_GB: Record<BuildFramework, number> = {
  'flutter': 15,
  'react-native': 12,
};

/**
 * CPU and memory of one build, and the Gradle settings that follow from them (DEC-08).
 * These assume builds run ONE AT A TIME: the worker claims the next job only after the current build has finished
 * (build-worker.ts, poll), and there is one server process. On the 4 vCPU / 8 GB server a build may then use 3.5 CPUs,
 * which leaves half a core for the API, Postgres and Docker. If builds ever run in parallel, these must be divided
 * between them first. Memory stays 5g; pids, disk, network and capabilities are set in createContainerArgs and do not
 * depend on this.
 * - gradleWorkers 3: Gradle's parallel workers, one per full CPU.
 * - gradleHeap 2g: the Gradle JVM (it was 1g); with Gradle's other JVMs, Metro and clang it stays inside the 5g.
 */
export const SANDBOX_RESOURCES = {
  cpus: '3.5',
  memory: '5g',
  gradleWorkers: 3,
  gradleHeap: '2g',
} as const;

/**
 * Shared READ-ONLY Gradle dependency cache (DEC-08). One per framework, at <dir>/<framework>/modules-2, filled by
 * scripts/warm-gradle-cache.sh from a template build. Gradle reads it through GRADLE_RO_DEP_CACHE and never writes to
 * it: what is not there is downloaded into the build's own GRADLE_USER_HOME as before. It is bind-mounted read-only and
 * owned by root on the host, so no build can change what the next build reads, and as a bind mount it does not count
 * against the per-build disk limit. <dir> is a bind mount of a directory on the Docker volume
 * (scripts/setup-production-server.sh), and <dir>/<framework> a symlink to the current version, which the warm script
 * swaps atomically; a running build keeps the version it started with. SYNKRO_GRADLE_RO_CACHE_DIR overrides <dir>.
 */
export function gradleRoCacheHostDir(): string {
  return process.env.SYNKRO_GRADLE_RO_CACHE_DIR || '/var/lib/synkro/gradle-ro-cache';
}
/** Where the read-only cache appears inside the sandbox. */
export const GRADLE_RO_CACHE_MOUNT = '/opt/gradle-ro-cache';

/**
 * The host directory to mount for `framework`, with its symlink resolved (so the build keeps that version even if the
 * warm script swaps in a new one), or null when there is no cache yet: then builds run exactly as without it.
 * Exported for tests.
 */
export function gradleRoCacheSource(framework: BuildFramework, hostDir: string = gradleRoCacheHostDir()): string | null {
  try {
    const dir = fs.realpathSync(path.join(hostDir, framework));
    return fs.statSync(path.join(dir, 'modules-2')).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** "1m42s": build step times in the log. Exported for tests. */
export function formatStepDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** One line for the build log, e.g. "[SYSTEM] Disk used: 7.4 GB of 12 GB". Docker's G is 1024³ bytes. Exported for tests. */
export function formatDiskUsage(bytes: number, limitGb: number): string {
  return `[SYSTEM] Disk used: ${(bytes / 1024 ** 3).toFixed(1)} GB of ${limitGb} GB`;
}

/** What the user sees when a build fails because it filled its disk limit. Exported for tests. */
export const OUT_OF_DISK_MESSAGE = "[SYSTEM] The build ran out of disk space on our server; we've been notified.";

/** The disk quota probe (disk-quota.ts) runs in the smaller sandbox image; one probe covers both frameworks. */
export const DISK_QUOTA_PROBE_IMAGE = FRAMEWORK_IMAGES['react-native'];

// Runs inside the container on the copy of the project in /build, just before `expo prebuild`; the user's own
// files are never touched. Only a static app.json is handled (an app.config.js is left as it is).
// - Non-interactive prebuild refuses to run without android.package, which Expo templates leave out:
//   one without it gets com.atomvs.<slug>.
// - Prebuild fails on an image path that does not exist (older Synkro templates pointed at an empty assets/):
//   only that key is removed, so Expo falls back to its default image.
// - Expo SDK 51 and older: without a splash backgroundColor, prebuild removes the splashscreen_background color but
//   keeps drawable/splashscreen.xml, which uses it, so Gradle fails much later in processReleaseResources ("resource
//   color/splashscreen_background not found"). Such projects get Expo's default, #ffffff. SDK 52+ is not affected
//   (checked on 52.0.49 and 58.0.25) and is left as it is. Exported for tests.
export const PREPARE_EXPO_CONFIG_JS = `
const fs = require('fs');
const path = require('path');
if (fs.existsSync('app.json')) {
  const json = JSON.parse(fs.readFileSync('app.json', 'utf8'));
  const expo = json.expo || json;
  expo.android = expo.android || {};
  if (!expo.android.package) {
    const slug = String(expo.slug || expo.name || 'app').toLowerCase().replace(/[^a-z0-9]/g, '');
    expo.android.package = 'com.atomvs.' + (/^[a-z]/.test(slug) ? slug : 'app' + slug);
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
  let expoMajor = NaN;
  try {
    expoMajor = parseInt(JSON.parse(fs.readFileSync('node_modules/expo/package.json', 'utf8')).version, 10);
  } catch (e) {}
  const splashColor = (expo.splash && expo.splash.backgroundColor) || (expo.android.splash && expo.android.splash.backgroundColor);
  if (expoMajor <= 51 && !splashColor) {
    expo.splash = Object.assign({}, expo.splash, { backgroundColor: '#ffffff' });
    console.log('[SYSTEM] expo.splash.backgroundColor is not set, using #ffffff (Expo SDK ' + expoMajor + ' needs it to build)');
  }
  fs.writeFileSync('app.json', JSON.stringify(json, null, 2));
}
`;
// Base64 keeps the script clear of shell quoting.
const PREPARE_EXPO_CONFIG = `echo ${Buffer.from(PREPARE_EXPO_CONFIG_JS).toString('base64')} | base64 -d > /tmp/prepare-expo-config.js && node /tmp/prepare-expo-config.js`;

/**
 * `npm_install ci|install`: installs the packages the way Expo's build service does. `npm ci` uses the lockfile
 * when there is one (a lockfile out of step with package.json falls back to `npm install`). A peer dependency
 * conflict (ERESOLVE) is retried once with --legacy-peer-deps, with a warning in the build log: the same project
 * installs locally, where npm is often run with that flag, so it must not fail only on the server.
 * POSIX sh (the image's /bin/sh may be dash): no PIPESTATUS, so npm's exit code goes through a file.
 * --prefer-offline: packages already in the image's npm cache (the whole Expo template tree, Dockerfile.rn-sandbox)
 * are taken from it without asking the registry; anything else is downloaded as before. Exported for tests.
 */
export const NPM_INSTALL_FN = [
  'npm_install() {',
  'if [ "$1" = ci ] && [ -f package-lock.json ]; then set -- ci; else set -- install; fi;',
  '( npm "$1" --no-audit --no-fund --prefer-offline 2>&1; echo $? > /tmp/npm-status ) | tee /tmp/npm-install.log;',
  '[ "$(cat /tmp/npm-status)" = 0 ] && return 0;',
  'if [ "$1" = ci ] && grep -q EUSAGE /tmp/npm-install.log; then',
  'echo "[SYSTEM] WARNING: package-lock.json does not match package.json, installing with npm install instead.";',
  'npm_install install; return $?; fi;',
  'if grep -q ERESOLVE /tmp/npm-install.log; then',
  'echo "[SYSTEM] WARNING: conflicting peer dependencies (ERESOLVE). Retrying once with --legacy-peer-deps. Run npx expo install --fix in the project to fix the versions.";',
  'npm "$1" --no-audit --no-fund --prefer-offline --legacy-peer-deps; return $?; fi;',
  'return 1; };',
].join(' ');

/**
 * `step_done <name>`: prints how long the step since the previous one took, e.g. "[STEP] npm install 1m42s" (the
 * clock starts when the build command starts). A failed step stops the chain, so it has no line; the worker always
 * logs "[STEP] total". Exported for tests.
 */
export const STEP_FN = [
  '_step_t=$(date +%s);',
  'step_done() { _step_n=$(date +%s); _step_d=$((_step_n - _step_t)); _step_t=$_step_n;',
  'printf "[STEP] %s %dm%02ds\\n" "$1" $((_step_d / 60)) $((_step_d % 60)); };',
].join(' ');

/**
 * `cache_report <build output dir>`, run after Gradle: whether the shared read-only Gradle cache (DEC-08) is doing its
 * job, and where the build's disk use goes. The image has no Gradle dependencies, so every file in the build's own
 * caches/modules-2 was downloaded during this build because the read-only cache did not have it. "Disk used" alone
 * cannot tell: it also counts node_modules, native build output and caches/transforms-* (unpacked/dexed AARs), which
 * the dependency cache does not cover. Never fails the build (callers use `|| true`). Exported for tests.
 */
export const CACHE_REPORT_FN = [
  'cache_report() {',
  '_gh="${GRADLE_USER_HOME:-/tmp/.gradle}"; _dl="$_gh/caches/modules-2/files-2.1"; _n=0; _mb=0;',
  '_mbof() { du -sm "$@" 2>/dev/null | awk \'{s+=$1} END {print s+0}\'; };',
  'if [ -d "$_dl" ]; then _n=$(find "$_dl" -type f | wc -l | tr -d " "); _mb=$(_mbof "$_dl"); fi;',
  'echo "[CACHE] Downloaded during this build (not in the shared read-only cache): $_n dependency files, $_mb MB";',
  'if [ -n "$GRADLE_RO_DEP_CACHE" ]; then',
  'echo "[CACHE] Shared read-only cache: $(find "$GRADLE_RO_DEP_CACHE/modules-2/files-2.1" -type f 2>/dev/null | wc -l | tr -d " ") dependency files available";',
  'else echo "[CACHE] Shared read-only cache: not mounted"; fi;',
  'echo "[CACHE] Disk: Gradle caches $(_mbof "$_gh/caches") MB (transforms $(_mbof "$_gh"/caches/transforms-*) MB), node_modules $(_mbof node_modules) MB, $1/ $(_mbof "$1") MB"; };',
].join(' ');

/**
 * `gradle_build <command...>`: runs Gradle once; if it failed because an entry of the image's build cache (DEC-11)
 * could not be read, runs it once more with --no-build-cache. Gradle 8.8 fails the build on such an entry (e.g. a
 * cached transform) instead of rebuilding it. Real builds never write the cache (push = false) and the image build
 * refuses empty entries, so this is a safety net. Any other failure is not retried. The output still streams live;
 * a copy goes to $TMPDIR (/tmp) to look for the error, then is deleted. Exported for tests.
 */
export const BUILD_CACHE_ERROR = 'Could not load from local cache|Failed to load cache entry|Could not load entry .* from local build cache';
export const GRADLE_BUILD_FN = [
  'gradle_build() {',
  '_gl="${TMPDIR:-/tmp}/gradle-build.log"; _gs="${TMPDIR:-/tmp}/gradle-status";',
  '( "$@" 2>&1; echo $? > "$_gs" ) | tee "$_gl"; _gr=$(cat "$_gs");',
  `if [ "$_gr" != 0 ] && grep -qE '${BUILD_CACHE_ERROR}' "$_gl"; then`,
  'rm -f "$_gl"; echo "[SYSTEM] Build cache unreadable, retrying without it";',
  '"$@" --no-build-cache; _gr=$?; fi;',
  'rm -f "$_gl" "$_gs"; return $_gr; };',
].join(' ');

// Expo projects usually have no android/ folder, so generate it the same way the Flutter command runs
// `flutter create`. Checks for android/gradlew, not the folder, so a half-made android/ still counts as missing.
// CI=1 keeps prebuild non-interactive and EXPO_NO_TELEMETRY stops it calling Expo's servers. With the default
// template it only fetches expo-template-bare-minimum from the npm registry, which the network allowlist covers.
// --no-install skips prebuild's own install; the install runs again after it in case package.json changed (then
// the lockfile may no longer match, so `npm install`, not `npm ci`).
const ENSURE_RN_ANDROID_PROJECT = [
  '( [ -f android/gradlew ] || (',
  '( [ -d node_modules/expo ] || { echo "[SYSTEM] There is no android/ project and this is not an Expo project, so one cannot be generated." >&2; exit 1; } )',
  `&& ${PREPARE_EXPO_CONFIG}`,
  '&& CI=1 EXPO_NO_TELEMETRY=1 npx expo prebuild --platform android --no-install',
  '&& npm_install install',
  ') )',
].join(' ');

/**
 * The --org for `flutter create`: com.atomvs.p<first 10 hex of the project ID>. Without it Flutter uses
 * com.example, which Google Play rejects. It must never change for a project (signing_keys.package_name), so it
 * comes from the project ID: the same identity as the project's signing key, and two projects of one user with
 * the same pubspec name still get different packages. Exported for tests.
 */
export function flutterOrg(projectId: string | undefined): string {
  const hex = (projectId ?? '').replace(/-/g, '').toLowerCase().slice(0, 10);
  if (!/^[0-9a-f]{10}$/.test(hex)) {
    throw new Error('Flutter builds need the project ID (a UUID) for a stable package name');
  }
  return `com.atomvs.p${hex}`;
}

/**
 * `flutter_android <org>`: makes sure the sandbox copy has an android/ project today's Flutter can build.
 * - Missing: `flutter create` adds it, without touching lib/ or pubspec.yaml.
 * - Present and current: kept as is, with its own applicationId.
 * - Present but refused or uncompilable: moved aside to $TMPDIR (never back into the user's project), generated
 *   again, and the log gets "[SYSTEM] android/ was ..., regenerated it".
 *
 * Refused or uncompilable means one of:
 * - v1 embedding, checked the way Flutter 3.44 does (flutter_tools project.dart computeEmbeddingVersion): the
 *   manifest is missing, its <application> is io.flutter.app.FlutterApplication, or it has no
 *   <meta-data android:name="flutterEmbedding" android:value="2">;
 * - code using the deleted io.flutter.app.FlutterActivity / FlutterFragmentActivity, which Flutter's check misses and
 *   Kotlin/Java then fails on;
 * - the Flutter Gradle plugin applied the old way (apply from: .../flutter.gradle or app_plugin_loader.gradle), which
 *   those files now refuse with an exception;
 * - incomplete: no settings.gradle(.kts) or no app/build.gradle(.kts).
 *
 * A missing gradlew alone is fine: Flutter's own android/.gitignore leaves it out and `flutter build` adds it.
 * Exported for tests.
 */
export const FLUTTER_ANDROID_FN = [
  'flutter_android() {',
  '_fm=android/app/src/main/AndroidManifest.xml; _why=;',
  'if [ ! -d android ]; then flutter create --platforms=android --org "$1" .; return $?; fi;',
  'if [ ! -f "$_fm" ]; then _why="outdated (v1 embedding: no app/src/main/AndroidManifest.xml)";',
  'elif [ ! -f android/settings.gradle ] && [ ! -f android/settings.gradle.kts ]; then _why="incomplete (no settings.gradle)";',
  'elif [ ! -f android/app/build.gradle ] && [ ! -f android/app/build.gradle.kts ]; then _why="incomplete (no app/build.gradle)";',
  // One manifest tag per line, so an attribute check stays inside its tag.
  "else _tags=$(tr '\\n\\r\\t' '   ' < \"$_fm\" | tr '<' '\\n');",
  'if printf "%s\\n" "$_tags" | grep -qE "^application[[:space:]].*android:name=[\\"\']io\\.flutter\\.app\\.FlutterApplication[\\"\']"',
  '|| ! printf "%s\\n" "$_tags" | grep -E "^meta-data[[:space:]].*android:name=[\\"\']flutterEmbedding[\\"\']" | grep -qE "android:value=[\\"\']2[\\"\']"',
  "|| grep -rqE 'io\\.flutter\\.app\\.(FlutterActivity|FlutterFragmentActivity)([^A-Za-z]|$)' android/app/src; then _why=\"outdated (v1 embedding)\";",
  "elif grep -qsE 'flutter_tools/gradle/(flutter|app_plugin_loader)\\.gradle' android/settings.gradle android/settings.gradle.kts android/app/build.gradle android/app/build.gradle.kts;",
  'then _why="outdated (old Flutter Gradle plugin setup)"; fi; fi;',
  '[ -z "$_why" ] && return 0;',
  'echo "[SYSTEM] android/ was $_why, regenerated it";',
  '_old="${TMPDIR:-/tmp}/android-outdated"; rm -rf "$_old" && mv android "$_old"',
  '&& flutter create --platforms=android --org "$1" .; };',
].join(' ');

/** Exported for tests. */
export function getBuildCommand(framework: BuildFramework, projectId?: string): string {
  if (framework === 'flutter') {
    // Generates android/ when it is missing, outdated (v1 embedding) or incomplete; see FLUTTER_ANDROID_FN.
    return `${STEP_FN} ${CACHE_REPORT_FN} ${FLUTTER_ANDROID_FN} cd /build && flutter_android ${flutterOrg(projectId)}`
      + ' && step_done "flutter create"'
      + ' && flutter build apk --release --target-platform android-arm64'
      + ' && step_done "gradle (flutter build apk)"'
      + ' && (cache_report build || true)';
  }
  // Append sandbox Gradle constraints to android/gradle.properties before invoking the wrapper:
  //   - workers.max: JVM worker processes for our CPU budget (SANDBOX_RESOURCES; not the host's core count)
  //   - parallel=false: no inter-project parallel execution (irrelevant for single-app builds, but safe)
  //   - daemon=false: skip the persistent daemon JVM — it is wasted inside a one-shot container and
  //                   costs an extra forked process plus a daemon-watcher process
  //   - jvmargs=-Xmx: the build JVM heap (SANDBOX_RESOURCES; the default would be ~25% of container memory,
  //                   and a cap leaves headroom for clang during native CMake compilation)
  //   - reactNativeArchitectures=arm64-v8a: ABI filter restricting NDK compilation to 64-bit ARM phones (PACKAGED_ABIS,
  //     DEC-09): no x86/x86_64 emulator binaries and no 32-bit armeabi-v7a.
  // Together these keep Gradle's peak PID count well under 200, letting us use pids-limit=384.
  const gradleConstraints = [
    'mkdir -p android && touch android/gradle.properties',
    `printf "\\norg.gradle.workers.max=${SANDBOX_RESOURCES.gradleWorkers}\\n" >> android/gradle.properties`,
    'printf "org.gradle.parallel=false\\n" >> android/gradle.properties',
    'printf "org.gradle.daemon=false\\n" >> android/gradle.properties',
    `printf "org.gradle.jvmargs=-Xmx${SANDBOX_RESOURCES.gradleHeap}\\n" >> android/gradle.properties`,
    `printf "reactNativeArchitectures=${RN_ARCHITECTURES}\\n" >> android/gradle.properties`,
    // Use the Gradle build cache baked into the image (DEC-11; read-only through CACHE_INIT_SCRIPT). A missing or
    // stale cache is a cache miss: the task simply runs. An unreadable entry: gradle_build retries without the cache.
    'printf "org.gradle.caching=true\\n" >> android/gradle.properties',
  ].join(' && ');

  // Not -Pandroid.injected.build.abi: that is Android Studio's deploy-to-one-device flag, and with it Gradle did not
  // write app/build/outputs/apk/release/app-release.apk, so the worker found no APK (Oct 30, Expo on rn-sandbox:1).
  // NODE_ENV=production for the JS bundle step Gradle runs (Expo's babel preset asks for it), set on Gradle only:
  // on npm ci it would skip devDependencies the bundle needs. gradle_build: one retry without an unreadable build cache.
  const gradlewCmd = `cd android && gradle_build env NODE_ENV=production ./gradlew assembleRelease -PreactNativeArchitectures=${RN_ARCHITECTURES}`;

  // NOTE: We do NOT use `npx react-native build-android` here — the RN CLI wrapper calls
  // getTaskNames(..., 'bundle') internally, which runs bundleRelease and produces an .aab
  // (Android App Bundle). .aab requires Google Play's bundletool to install; it cannot be
  // sideloaded directly. We invoke ./gradlew assembleRelease explicitly to get a plain .apk.
  return `${NPM_INSTALL_FN} ${GRADLE_BUILD_FN} ${STEP_FN} ${CACHE_REPORT_FN} ` + [
    'npm_install ci',
    'step_done "npm install"',
    ENSURE_RN_ANDROID_PROJECT,
    'step_done "expo prebuild"',
    '([ -f android/gradlew ] && chmod +x android/gradlew || true)',
    gradleConstraints,
    `(${gradlewCmd})`,
    'step_done "gradle"',
    '(cache_report android || true)',
  ].join(' && ');
}

// TEMPORARY: React Native/Expo builds download and compile Gradle dependencies from scratch. Measured on the Linux
// server (Oct 30): Expo 23-25 min, bare RN 12 min, Flutter 11 min. Go back to 15 minutes once the pre-built image
// exists (Trello: "Pre-warmed RN/Expo sandbox image"). The reconciler in build-worker.ts uses the longest of these
// plus 5 minutes.
export const BUILD_TIMEOUT_MS: Record<BuildFramework, number> = {
  'flutter': 15 * 60 * 1000,
  'react-native': 35 * 60 * 1000,
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
   * carry secrets: the signing key goes in through createGradleHomeArchive(). Public for tests.
   */
  createContainerArgs(netName: string): string[] {
    const framework = this.config.framework || 'flutter';
    const image = FRAMEWORK_IMAGES[framework];

    const storageLimit = `size=${BUILD_DISK_LIMIT_GB[framework]}G`;

    const createArgs = [
      'create',
      '--name', this.containerName,
      `--memory=${SANDBOX_RESOURCES.memory}`,
      `--memory-swap=${SANDBOX_RESOURCES.memory}`,
      `--cpus=${SANDBOX_RESOURCES.cpus}`,
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
    ];

    // The shared Gradle cache, read-only (see GRADLE_RO_CACHE_HOST_DIR). `readonly` makes the mount itself read-only,
    // whatever the files' permissions: even a process that became root inside the sandbox could not write to it.
    const roCache = this.config.gradleRoCache === false ? null : gradleRoCacheSource(framework);
    if (roCache) {
      createArgs.push(
        '--mount', `type=bind,source=${roCache},target=${GRADLE_RO_CACHE_MOUNT},readonly`,
        '-e', `GRADLE_RO_DEP_CACHE=${GRADLE_RO_CACHE_MOUNT}`,
      );
    }
    createArgs.push(image);

    createArgs.push('sh', '-c', `cd /build && ${getBuildCommand(framework, this.config.projectId)}`);
    return createArgs;
  }

  async runBuild(onLog: (chunk: string) => void): Promise<boolean> {
    const framework = this.config.framework || 'flutter';
    const timeoutMs = this.config.timeoutMs || BUILD_TIMEOUT_MS[framework];
    const startedAt = Date.now();
    const logTotal = () => onLog(`[STEP] total ${formatStepDuration(Date.now() - startedAt)}`);

    const netName = await this.setupNetwork(onLog);
    if (!netName) return false;

    // The per-build disk limit (--storage-opt below) is silently ignored by some Docker setups (disk-quota.ts).
    // Without it one build can fill the disk the database lives on, so production refuses to build.
    if (diskQuotaRequired()) {
      const quota = await cachedDiskQuota(DISK_QUOTA_PROBE_IMAGE);
      if (!quota.ok) {
        console.error(`[SANDBOX] Refusing Cloud Build ${this.config.jobId}: disk quota not enforced: ${quota.problem}`);
        onLog('[SYSTEM] Cloud Build is unavailable on this server right now (the sandbox disk limit is not in place). Please try again later.\n');
        return false;
      }
    }

    let createArgs: string[];
    try {
      createArgs = this.createContainerArgs(netName);
    } catch (err: any) {
      onLog(`[SYSTEM] ${err.message}\n`);
      return false;
    }

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

    onLog(this.config.signing
      ? `[SYSTEM] Injecting Gradle settings and release signing key...\n`
      : `[SYSTEM] Injecting Gradle settings...\n`);
    try {
      await new Promise<void>((resolve, reject) => {
        const cp = spawn('docker', ['cp', '-a', '-', `${this.containerName}:/`]);
        let stderr = '';
        cp.stderr?.on('data', (d) => { stderr += d.toString(); });
        cp.on('error', reject);
        cp.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr.trim() || `docker cp exited with ${code}`))));
        cp.stdin?.end(createGradleHomeArchive(this.config.signing));
      });
    } catch (err: any) {
      onLog(`[SYSTEM] Gradle settings injection failed: ${err.message}\n`);
      return false;
    }

    if (createArgs.some((arg) => arg.startsWith('GRADLE_RO_DEP_CACHE='))) {
      onLog('[SYSTEM] Using the shared Gradle dependency cache (read-only).\n');
    }
    onLog(`[SYSTEM] Starting ${framework} build process...\n`);

    return new Promise((resolve) => {
      let isResolved = false;
      this.childProcess = spawn('docker', ['start', '-a', this.containerName]);

      const timeoutTimer = setTimeout(async () => {
        if (!isResolved) {
          isResolved = true;
          onLog(`[SYSTEM] Build timed out after ${Math.round(timeoutMs / 1000)}s. Terminating container...`);
          await this.logDiskUsage(onLog, framework);
          logTotal();
          await this.forceKill();
          resolve(false);
        }
      }, timeoutMs);

      // npm and Gradle write warnings and progress to stderr, so only lines that read as errors get [ERROR].
      const logLines = new BuildLogLines(onLog);
      this.childProcess.stdout?.on('data', (data) => logLines.push('stdout', data.toString()));
      this.childProcess.stderr?.on('data', (data) => logLines.push('stderr', data.toString()));

      this.childProcess.on('close', async (code) => {
        logLines.flush();
        if (!isResolved) {
          isResolved = true;
          clearTimeout(timeoutTimer);
          // Measured before the container is removed, on success and on failure.
          const usedBytes = await this.logDiskUsage(onLog, framework);
          logTotal();
          if (code === 0) {
            // Do NOT forceKill here. The container must remain (in stopped state)
            // so we can extract the artifact from it.
            resolve(true);
          } else {
            await this.forceKill();
            onLog(`[SYSTEM] Build exited with code ${code}`);
            if (logLines.outOfDisk) {
              // A server-side limit, not the user's code: a plain message for them (BuildLogLines already dropped the
              // Java stack frames), the details in the server error log.
              const used = usedBytes === null ? 'unknown' : `${(usedBytes / 1024 ** 3).toFixed(1)} GB`;
              console.error(`[SANDBOX] Build ${this.config.jobId} (${framework}) ran out of disk space: used ${used} of the ${BUILD_DISK_LIMIT_GB[framework]} GB limit`);
              onLog(OUT_OF_DISK_MESSAGE);
            }
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

  /**
   * Logs how much of its disk limit the build used: the size of the container's writable layer, which is what
   * --storage-opt counts. Works on a stopped container; call it before forceKill(). Null when Docker cannot tell.
   */
  private async logDiskUsage(onLog: (chunk: string) => void, framework: BuildFramework): Promise<number | null> {
    const { execFile } = await import('node:child_process');
    const execFileAsync = promisify(execFile);
    try {
      const { stdout } = await execFileAsync('docker', ['inspect', '--size', '--format', '{{.SizeRw}}', this.containerName], { timeout: 60_000 });
      const bytes = Number(stdout.trim());
      if (!Number.isFinite(bytes) || bytes < 0) return null;
      onLog(formatDiskUsage(bytes, BUILD_DISK_LIMIT_GB[framework]));
      return bytes;
    } catch {
      return null;
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
