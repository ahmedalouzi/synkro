import { create } from 'zustand';

/**
 * Follow mode: when the agent writes a file, the editor opens it, scrolls to the change and plays the edit
 * (removed lines flash red, new lines stream in with a green glow). It never takes focus, and when the user is
 * typing in another tab it only shows a chip ("Agent is editing classes.tsx · Follow").
 */

/** A file edit to play in the editor: what the tab showed before, and what the agent wrote. */
export interface FollowEdit {
  path: string;
  name: string;
  oldContent: string;
  newContent: string;
  /** Distinguishes two edits of the same file. */
  nonce: number;
}

const STORAGE_KEY = 'atomvs.followMode';
/** Typing in the editor this recently counts as "busy": follow mode then only shows the chip. */
const TYPING_GRACE_MS = 2500;

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

interface FollowState {
  enabled: boolean;
  /** The edit the open editor should play now. */
  play: FollowEdit | null;
  /** An edit not followed because the user was typing elsewhere. */
  chip: FollowEdit | null;
  /** Files whose edit is playing: the file watcher leaves their tab alone meanwhile. */
  playing: Set<string>;
  /** A tab follow mode opened: its editor mounts without taking focus. */
  quietPath: string | null;
  lastTyping: { path: string; at: number } | null;
  setEnabled: (enabled: boolean) => void;
  noteTyping: (path: string) => void;
  isUserBusyElsewhere: (path: string) => boolean;
  request: (edit: Omit<FollowEdit, 'nonce'>) => FollowEdit;
  showChip: (edit: Omit<FollowEdit, 'nonce'>) => void;
  dismissChip: () => void;
  setPlaying: (path: string, playing: boolean) => void;
  setQuietPath: (path: string | null) => void;
}

let nonce = 0;

export const useFollowStore = create<FollowState>((set, get) => ({
  enabled: readEnabled(),
  play: null,
  chip: null,
  playing: new Set(),
  quietPath: null,
  lastTyping: null,
  setEnabled: (enabled) => {
    try { localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off'); } catch { /* per-device preference only */ }
    set({ enabled, ...(enabled ? {} : { chip: null }) });
  },
  noteTyping: (path) => set({ lastTyping: { path, at: Date.now() } }),
  isUserBusyElsewhere: (path) => {
    const t = get().lastTyping;
    return !!t && t.path !== path && Date.now() - t.at < TYPING_GRACE_MS;
  },
  request: (edit) => {
    const play = { ...edit, nonce: ++nonce };
    set({ play, chip: null });
    return play;
  },
  showChip: (edit) => set({ chip: { ...edit, nonce: ++nonce } }),
  dismissChip: () => set({ chip: null }),
  setPlaying: (path, playing) => {
    const next = new Set(get().playing);
    if (playing) next.add(path); else next.delete(path);
    set({ playing: next });
  },
  setQuietPath: (quietPath) => set({ quietPath }),
}));
