/**
 * Problems with the user's Flutter installation (not with the project): the preview shows them with their own
 * explanation and no "Auto-Fix" (the agent cannot fix them in code, and must not try, e.g. by stopping every
 * flutter.exe on the PC).
 */

/** A cloud-synced folder that the path is inside, or null. Sync clients lock files while they upload them. */
export function syncedFolderOf(path: string, env: Record<string, string | undefined> = {}): string | null {
  const norm = (p: string) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  const target = norm(path);
  // The folders the OneDrive client itself reports (any name, e.g. a renamed or business folder).
  for (const key of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
    const root = env[key];
    if (root && (target === norm(root) || target.startsWith(`${norm(root)}\\`))) return 'OneDrive';
  }
  for (const segment of path.split(/[\\/]+/)) {
    // "OneDrive", or a work/school one: "OneDrive - Contoso".
    if (/^onedrive( - .+)?$/i.test(segment)) return 'OneDrive';
    if (/^dropbox(\s*\(.+\))?$/i.test(segment)) return 'Dropbox';
    if (/^(google\s*drive|my drive|googledrive)$/i.test(segment)) return 'Google Drive';
    if (/^(icloud\s*drive|iclouddrive)$/i.test(segment)) return 'iCloud Drive';
  }
  return null;
}

/** Flutter prints this while another flutter command holds bin/cache/lockfile in the SDK. */
export const FLUTTER_STARTUP_LOCK_LINE = 'Waiting for another flutter command to release the startup lock';

export type FlutterEnvironmentProblem =
  | { kind: 'sdk-in-synced-folder'; folder: string; sdkPath: string }
  | { kind: 'startup-lock'; folder: string | null; sdkPath: string | null };

const SYNCED_PREFIX = 'The Flutter SDK is inside ';
const LOCK_PREFIX = "Flutter's startup lock is held by another Flutter command";

/** The preview error for a problem: English for the agent and logs; the Preview pane shows its own translation. */
export function flutterEnvironmentMessage(problem: FlutterEnvironmentProblem): string {
  const where = problem.sdkPath ? ` (${problem.sdkPath})` : '';
  if (problem.kind === 'sdk-in-synced-folder') {
    return `${SYNCED_PREFIX}${problem.folder}${where}. ${problem.folder} locks the SDK's files while it syncs them, so Flutter `
      + 'cannot update or delete them. Move Flutter out of it (e.g. C:\\src\\flutter) and set the new path in Settings. '
      + 'This is not a problem in the project code.';
  }
  return `${LOCK_PREFIX}${where}, outside Atomvs (another terminal, an IDE, or a command that hangs). `
    + (problem.folder ? `The SDK is inside ${problem.folder}, which can keep Flutter's commands from finishing. ` : '')
    + 'Close that Flutter command or let it finish, then retry. This is not a problem in the project code.';
}

/** Reads a problem back from a preview error (see flutterEnvironmentMessage), or null. */
export function parseFlutterEnvironmentProblem(error: string | undefined | null): FlutterEnvironmentProblem | null {
  if (!error) return null;
  const synced = new RegExp(`^${SYNCED_PREFIX}([^(.]+?)(?: \\((.+?)\\))?\\. `).exec(error);
  if (synced) return { kind: 'sdk-in-synced-folder', folder: synced[1], sdkPath: synced[2] ?? '' };
  if (error.startsWith(LOCK_PREFIX)) {
    const path = /^[^(]*\((.+?)\), outside Atomvs/.exec(error)?.[1] ?? null;
    const folder = /The SDK is inside (.+?), which/.exec(error)?.[1] ?? null;
    return { kind: 'startup-lock', folder, sdkPath: path };
  }
  return null;
}
