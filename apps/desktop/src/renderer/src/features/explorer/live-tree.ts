import type { FileEntry } from '@peep/shared';

/** A change the main process's file watcher reports for the open project. */
export interface WatchEvent {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
  path: string;
}

export function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * The same file? The watcher reports "C:/a/b.ts" while the tree and the tabs hold "C:\a\b.ts", so a plain ===
 * never matched (open tabs did not reload). Windows paths compare without case.
 */
export function samePath(a: string, b: string): boolean {
  const x = normPath(a);
  const y = normPath(b);
  return x === y || (/^[a-z]:\//i.test(x) && x.toLowerCase() === y.toLowerCase());
}

/** The folders whose listing changed: the parent of each file or folder that was added or removed. */
export function foldersToRefresh(events: WatchEvent[]): string[] {
  const dirs = new Map<string, string>();
  for (const e of events) {
    if (e.type === 'change') continue;
    const p = normPath(e.path);
    const cut = p.lastIndexOf('/');
    if (cut > 0) dirs.set(p.slice(0, cut).toLowerCase(), p.slice(0, cut));
  }
  return [...dirs.values()];
}

/** The tree node for a path, if that folder is in the (lazily loaded) tree. */
export function findNode(nodes: FileEntry[], path: string): FileEntry | null {
  for (const node of nodes) {
    if (samePath(node.path, path)) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}
