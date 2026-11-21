import type { DoctorCheckId } from './doctor';
import {
  FLUTTER_STARTUP_LOCK_LINE,
  parseFlutterEnvironmentProblem,
  syncedFolderOf,
} from './flutter-environment';
import type { PreviewLayoutIssue } from './index';

/**
 * The 5 recurring failure classes observed across real user sessions:
 *  1. `environment`      — SDK in OneDrive/synced folder, startup lock, missing Flutter/Node, disk full
 *  2. `platform-folders` — hand-written/stale Flutter android/ v1 embedding, legacy Gradle plugin, stale native folders
 *  3. `dependency-peers` — npm ERESOLVE, peer dependency mismatches, Expo SDK mismatches, Dart pub solving failures
 *  4. `layout`           — safe-area overlap, cut tab labels, >5 nav tabs, Flutter RenderFlex overflow
 *  5. `permissions`      — EACCES/EPERM, blocked process-kill-by-name commands, workspace traversal/approval blocks
 */
export type FailureClassId =
  | 'environment'
  | 'platform-folders'
  | 'dependency-peers'
  | 'layout'
  | 'permissions';

export interface FailureClassification {
  classId: FailureClassId;
  subKind: string;
  title: string;
  plainMessage: string;
  agentRule: string;
  canAgentFixInCode: boolean;
  doctorCheckId?: DoctorCheckId;
}

export interface FailureClassificationInput {
  error?: string | null;
  logs?: string | null;
  layout?: PreviewLayoutIssue[] | null;
  runtimeErrors?: Array<{ kind?: string; message: string }> | null;
}

function lockedDirectoryFromText(text: string): string | null {
  const m = /Flutter failed to delete a directory at[:\s]+"?([^"\r\n]+?)"?(?:\.\s|\.?\r?\n|\.?$)/i.exec(text);
  return m ? m[1].trim() : null;
}

/**
 * Classifies a preview, build, command, or runtime failure into one of the 5 failure classes.
 * Returns `null` when the output is clean or does not belong to any of the 5 classes.
 */
export function classifyFailure(input: FailureClassificationInput): FailureClassification | null {
  const runtimeText = (input.runtimeErrors ?? []).map((e) => e.message).join('\n');
  const errorText = input.error ?? '';
  const logsText = input.logs ?? '';
  const combined = [errorText, logsText, runtimeText].filter(Boolean).join('\n').trim();
  const layoutIssues = Array.isArray(input.layout) ? input.layout : [];

  if (!combined && layoutIssues.length === 0) {
    return null;
  }

  // ── 1. Environment ────────────────────────────────────────────────────────
  const envProblem = parseFlutterEnvironmentProblem(errorText) ?? parseFlutterEnvironmentProblem(logsText);
  if (envProblem?.kind === 'sdk-in-synced-folder') {
    return {
      classId: 'environment',
      subKind: 'sdk-in-synced-folder',
      title: `Flutter SDK is inside ${envProblem.folder}`,
      plainMessage: `${envProblem.folder} locks Flutter's files while syncing them, so Flutter cannot update or delete them. Move Flutter to a local folder (e.g. C:\\src\\flutter) and update its path in Atomvs Doctor.`,
      agentRule: 'Do not edit project code or stop processes for a synced-folder Flutter SDK error. Tell the user to move Flutter out of the synced folder and open Atomvs Doctor to set the new SDK path.',
      canAgentFixInCode: false,
      doctorCheckId: 'flutter-sdk',
    };
  }

  const lockedDir = lockedDirectoryFromText(combined);
  if (lockedDir) {
    const synced = syncedFolderOf(lockedDir);
    if (synced) {
      return {
        classId: 'environment',
        subKind: 'sdk-in-synced-folder',
        title: `Flutter SDK is inside ${synced}`,
        plainMessage: `${synced} is locking Flutter SDK files (${lockedDir}). Move Flutter to a local folder (e.g. C:\\src\\flutter) and select it in Atomvs Doctor.`,
        agentRule: 'Do not edit project code or kill processes when a cloud sync client locks the Flutter SDK. Instruct the user to move Flutter out of the synced folder and use Atomvs Doctor.',
        canAgentFixInCode: false,
        doctorCheckId: 'flutter-sdk',
      };
    }
  }

  if (envProblem?.kind === 'startup-lock' || combined.includes(FLUTTER_STARTUP_LOCK_LINE)) {
    return {
      classId: 'environment',
      subKind: 'startup-lock',
      title: 'Another Flutter command holds the startup lock',
      plainMessage: 'Flutter only runs one command at a time. Another Flutter command outside Atomvs is still running or stuck. Close it or open Atomvs Doctor to check and release Atomvs-owned locks.',
      agentRule: 'Do not edit project code and never kill external processes by name (taskkill /IM, pkill, killall). Tell the user to close the other Flutter command or run Atomvs Doctor.',
      canAgentFixInCode: false,
      doctorCheckId: 'startup-lock',
    };
  }

  if (
    /flutter sdk not found|is flutter sdk installed\?|spawn flutter(?:\.bat)? enoent|flutter(?:\.bat)?['"]?\s+is not recognized|flutter:\s*(?:command )?not found/i.test(
      combined,
    )
  ) {
    return {
      classId: 'environment',
      subKind: 'flutter-sdk-missing',
      title: 'Flutter SDK not found',
      plainMessage: 'Atomvs could not find a local Flutter SDK. Install Flutter or set its path in Atomvs Doctor.',
      agentRule: 'Do not modify project code when the Flutter SDK is missing. Direct the user to Atomvs Doctor to install or configure the Flutter SDK path.',
      canAgentFixInCode: false,
      doctorCheckId: 'flutter-sdk',
    };
  }

  if (
    /spawn (?:node|npm|npx)(?:\.cmd)? enoent|(?:node|npm|npx)['"]?\s+is not recognized|(?:node|npm|npx):\s*(?:command )?not found/i.test(
      combined,
    )
  ) {
    return {
      classId: 'environment',
      subKind: 'node-missing',
      title: 'Node.js or npm not found',
      plainMessage: 'Expo and React Native require Node.js and npm on your PATH. Install Node.js via Atomvs Doctor and retry.',
      agentRule: 'Do not edit project code when Node.js or npm is missing from the system. Direct the user to Atomvs Doctor to install Node.js.',
      canAgentFixInCode: false,
      doctorCheckId: 'node-npm',
    };
  }

  if (/\bENOSPC\b|no space left on device|there is not enough space on the disk/i.test(combined)) {
    return {
      classId: 'environment',
      subKind: 'disk-full',
      title: 'Disk space is full',
      plainMessage: 'Your disk ran out of free space while running the preview or build. Open Atomvs Doctor to clean Atomvs caches or free up space.',
      agentRule: 'Do not retry builds in a loop when ENOSPC occurs. Tell the user to free disk space or run Clean Atomvs Cache in Atomvs Doctor.',
      canAgentFixInCode: false,
      doctorCheckId: 'disk-space',
    };
  }

  // ── 2. Platform Folders ───────────────────────────────────────────────────
  if (
    /io\.flutter\.app\.FlutterActivity|deleted Android v1 embedding|v1 android embedding|android v1 embedding|apply from:.*flutter\.gradle|deprecated imperative apply of flutter's gradle plugins|android\/ folder was made for an older version of flutter|flutterEmbedding.*must be.*2/i.test(
      combined,
    )
  ) {
    return {
      classId: 'platform-folders',
      subKind: 'flutter-android-v1-embedding',
      title: 'Outdated Flutter android/ folder (v1 embedding)',
      plainMessage: 'The project android/ folder uses Flutter v1 embedding or legacy Gradle syntax, which current Flutter versions reject.',
      agentRule: 'Never hand-write Flutter android/ folders or copy v1 embedding templates. Keep v2 embedding (io.flutter.embedding.android.FlutterActivity, flutterEmbedding=2, dev.flutter.flutter-gradle-plugin) or remove broken hand-written android/ files so Flutter/Cloud Build regenerates them cleanly.',
      canAgentFixInCode: true,
    };
  }

  if (
    /expo prebuild.*(?:android|ios)|native (?:android|ios) folder.*(?:out of sync|conflict)|cng.*prebuild/i.test(
      combined,
    )
  ) {
    return {
      classId: 'platform-folders',
      subKind: 'expo-native-folder-mismatch',
      title: 'Expo native platform folder mismatch',
      plainMessage: 'The local android/ or ios/ folder is out of sync with app.json / app.config and Expo plugins.',
      agentRule: 'Prefer Expo managed config (app.json / app.config.js) instead of hand-editing generated android/ or ios/ folders. Only edit native files when strictly needed and keep them consistent with Expo config.',
      canAgentFixInCode: true,
    };
  }

  // ── 3. Dependency Peers ───────────────────────────────────────────────────
  if (
    /\bERESOLVE\b|unable to resolve dependency tree|could not resolve dependency|peer\s+dep(?:endency|endencies)?\b|npm ls.*invalid:|invalid:\s*"[^"]+"\s+from\s+node_modules\/|expected version:\s*[~^]?\d|ERR_PACKAGE_PATH_NOT_EXPORTED|registerWebModule\s*\)?\s*is not a function|version solving failed/i.test(
      combined,
    )
  ) {
    return {
      classId: 'dependency-peers',
      subKind: /version solving failed/i.test(combined) ? 'pub-version-solving' : 'npm-peer-conflict',
      title: 'Package dependency or peer version conflict',
      plainMessage: 'Some packages have conflicting versions or do not match your Expo/Flutter SDK. Installing compatible versions will fix both preview and Cloud Build.',
      agentRule: 'Never use --legacy-peer-deps or --force. In Expo projects install packages with "npx expo install <pkg>" or run "npx expo install --fix", verify with "npm ls --depth=0", and pick major versions whose peer dependencies match the project SDK (e.g. React Navigation 6 on Expo SDK 51).',
      canAgentFixInCode: true,
    };
  }

  // ── 4. Layout ─────────────────────────────────────────────────────────────
  const overflowFromLayout = layoutIssues.find((i) => i.kind === 'flutter-renderflex-overflow');
  if (overflowFromLayout || /RenderFlex overflowed by/i.test(combined)) {
    return {
      classId: 'layout',
      subKind: 'flutter-renderflex-overflow',
      title: 'Flutter RenderFlex layout overflow',
      plainMessage: overflowFromLayout?.message ?? 'A Flutter Row or Column overflowed the available screen space.',
      agentRule: 'Fix RenderFlex overflows before claiming done: wrap overflowing Row/Column children in Expanded or Flexible, use Wrap/SingleChildScrollView/ListView for long content, and avoid rigid widths or heights.',
      canAgentFixInCode: true,
    };
  }

  if (layoutIssues.length > 0) {
    const first = layoutIssues[0]!;
    return {
      classId: 'layout',
      subKind: first.kind,
      title: 'On-screen layout issue detected',
      plainMessage: first.message,
      agentRule: 'Treat layout problems like errors and fix them before claiming done: use Scaffold + SafeArea in Flutter, at most 5 bottom-nav tabs with short labels, and never hardcode fixed height/paddingBottom in React Navigation tabBarStyle without useSafeAreaInsets().',
      canAgentFixInCode: true,
    };
  }

  // ── 5. Permissions ────────────────────────────────────────────────────────
  if (
    /\bEACCES\b|\bEPERM\b|permission denied|access is denied|operation not permitted|IPC Security Block|BLOCKED:.*(?:stop processes by name|kill|outside)|command was rejected by user/i.test(
      combined,
    )
  ) {
    const isBlockedCmd = /BLOCKED:|IPC Security Block|command was rejected by user/i.test(combined);
    return {
      classId: 'permissions',
      subKind: isBlockedCmd ? 'safety-policy-block' : 'os-permission-denied',
      title: isBlockedCmd ? 'Action blocked by safety policy' : 'Permission denied by operating system',
      plainMessage: isBlockedCmd
        ? 'That command or path was blocked by Atomvs safety rules (such as killing processes by name or accessing files outside the project).'
        : 'The operating system denied permission to access a file or folder. Check folder ownership, antivirus exclusions, or file permissions.',
      agentRule: 'Never bypass permissions, never stop processes by name (taskkill /IM, pkill, killall, Stop-Process -Name, npx kill-port), and never access paths outside the project root. Use restart_preview to recycle Atomvs-owned processes or explain the permission error plainly to the user.',
      canAgentFixInCode: false,
    };
  }

  return null;
}
