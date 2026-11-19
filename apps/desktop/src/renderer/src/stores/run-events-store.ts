import { create } from 'zustand';

/** What the preview did after an agent run changed files, shown as a row in that run's reply. */
export interface PreviewRefreshEvent {
  /** Fast Refresh (a hot update of a few modules) or a full reload of the bundle. */
  kind: 'fast-refresh' | 'reload';
  /** Metro's own bundling time for the update, in ms. */
  ms: number;
  device: string;
}

interface RunEventsState {
  /** Latest preview refresh per agent run. */
  refreshes: Record<string, PreviewRefreshEvent>;
  /** The run whose file edit is waiting for the preview to pick it up, and since when. */
  pending: { runId: string; since: number } | null;
  expectRefresh: (runId: string) => void;
  /** A preview log line: records it if it is the bundle that followed the pending edit. */
  onPreviewLog: (line: string, device: string) => void;
}

// Metro: "Web Bundled 412ms C:\…\index.js (1 module)" (a Fast Refresh update) or "(336 modules)" (a reload).
const BUNDLED = /\b(?:Web|iOS|Android) Bundled (\d+)ms\b[^\n]*?\((\d+) modules?\)/;
const FAST_REFRESH_MAX_MODULES = 10;
/** An edit that has not shown up in the preview within this long is not waited for any more. */
const PENDING_FOR_MS = 60_000;

/** The bundling time and module count in a Metro log line, or null. Exported for tests. */
export function parseBundled(line: string): { ms: number; modules: number } | null {
  const m = BUNDLED.exec(line.replace(/\u001b\[[0-9;]*m/g, ''));
  return m ? { ms: Number(m[1]), modules: Number(m[2]) } : null;
}

export const useRunEventsStore = create<RunEventsState>((set, get) => ({
  refreshes: {},
  pending: null,
  expectRefresh: (runId) => set({ pending: { runId, since: Date.now() } }),
  onPreviewLog: (line, device) => {
    const { pending } = get();
    if (!pending || Date.now() - pending.since > PENDING_FOR_MS) return;
    const bundled = parseBundled(line);
    if (!bundled) return;
    set({
      pending: null,
      refreshes: {
        ...get().refreshes,
        [pending.runId]: { kind: bundled.modules <= FAST_REFRESH_MAX_MODULES ? 'fast-refresh' : 'reload', ms: bundled.ms, device },
      },
    });
  },
}));
