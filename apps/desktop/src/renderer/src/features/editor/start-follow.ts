import { useWorkspaceStore } from '../../stores/workspace-store';
import { useFollowStore, type FollowEdit } from '../../stores/follow-store';
import { samePath } from '../explorer/live-tree';

/** An editor that plays an edit applies the new text within ~0.4 s; one that never mounted (hidden editor) does not. */
const APPLY_TIMEOUT_MS = 1500;

/** Gives a tab the agent's text directly and lets the file watcher update it again. */
function settle(edit: Omit<FollowEdit, 'nonce'>): void {
  const workspace = useWorkspaceStore.getState();
  const tab = workspace.openFiles.find((f) => samePath(f.path, edit.path));
  if (tab && !tab.dirty && tab.content !== edit.newContent) workspace.syncFileContent(tab.path, edit.newContent);
  useFollowStore.getState().setPlaying(tab?.path ?? edit.path, false);
}

/**
 * Shows an agent edit in the editor: opens the file (or brings its tab forward) with the text it had before,
 * without taking focus, and asks its editor to play the change (MonacoEditor → playFollowEdit). A new file opens
 * empty and types in.
 */
export function startFollow(edit: Omit<FollowEdit, 'nonce'>): void {
  const workspace = useWorkspaceStore.getState();
  const follow = useFollowStore.getState();
  // A newer edit replaces one whose editor has not played it yet (two files in a row): that tab gets its text
  // now. Otherwise it kept its old (for a new file: empty) text, and the watcher skipped it as "playing".
  const previous = follow.play;
  if (previous && !samePath(previous.path, edit.path) && follow.playing.has(previous.path)) settle(previous);

  const existing = workspace.openFiles.find((f) => samePath(f.path, edit.path));
  const path = existing?.path ?? edit.path;
  follow.setPlaying(path, true);
  if (workspace.activeFilePath !== path) follow.setQuietPath(path);
  if (existing) {
    workspace.setActiveFile(path);
  } else {
    workspace.openFile({ path, name: edit.name, content: edit.oldContent, dirty: false });
  }
  const play = follow.request({ ...edit, path });

  // The editor may never play it (editor hidden, another edit came first): the tab must not stay stale.
  setTimeout(() => {
    const now = useFollowStore.getState();
    const tab = useWorkspaceStore.getState().openFiles.find((f) => samePath(f.path, path));
    if (now.playing.has(path) && (now.play?.nonce !== play.nonce || tab?.content !== play.newContent)) settle(play);
  }, APPLY_TIMEOUT_MS);
}
