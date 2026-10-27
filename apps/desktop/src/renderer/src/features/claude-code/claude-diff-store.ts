import { create } from 'zustand';

/** A change Claude Code proposed through openDiff, waiting for the user to accept or reject it. */
export interface ClaudeDiff {
  requestId: string;
  filePath: string;
  tabName: string;
  oldContents: string;
  newContents: string;
}

export const CLAUDE_DIFF_PREFIX = 'claude-diff://';

export const claudeDiffTabPath = (requestId: string) => `${CLAUDE_DIFF_PREFIX}${requestId}`;

interface ClaudeDiffState {
  diffs: Record<string, ClaudeDiff>;
  add: (diff: ClaudeDiff) => void;
  remove: (requestId: string) => void;
}

export const useClaudeDiffStore = create<ClaudeDiffState>((set) => ({
  diffs: {},
  add: (diff) => set((s) => ({ diffs: { ...s.diffs, [diff.requestId]: diff } })),
  remove: (requestId) => set((s) => {
    const { [requestId]: _removed, ...rest } = s.diffs;
    return { diffs: rest };
  }),
}));
