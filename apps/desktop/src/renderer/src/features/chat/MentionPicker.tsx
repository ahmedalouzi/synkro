import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { AgentMention } from '@peep/shared';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useDiagnosticsStore } from '../../stores/preview-store';
import { getActiveTerminalOutput } from '../terminal/terminal-registry';
import { getFileIcon } from '../explorer/FileIcons';
import './MentionPicker.css';

export interface MentionItem {
  /** Unique key (also used to avoid attaching the same thing twice). */
  id: string;
  /** Text inserted after `@` in the input and shown on the pill. */
  label: string;
  detail?: string;
  icon: 'file' | 'folder' | 'code' | 'problems' | 'terminal' | 'git';
  mention: AgentMention;
}

export interface MentionPickerHandle {
  /** Returns true if the picker consumed the key. */
  handleKeyDown: (e: React.KeyboardEvent) => boolean;
}

interface MentionPickerProps {
  query: string;
  onSelect: (item: MentionItem) => void;
  onClose: () => void;
}

const relativePath = (root: string | undefined, path: string) =>
  root && path.startsWith(root) ? path.slice(root.length).replace(/^[\\/]/, '').replace(/\\/g, '/') : path;

export function MentionIcon({ icon, name }: { icon: MentionItem['icon']; name?: string }) {
  if (icon === 'file' && name) return <span className="mention-icon">{getFileIcon(name)}</span>;
  const paths: Record<MentionItem['icon'], JSX.Element> = {
    file: <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM13 2v7h7" />,
    folder: <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />,
    code: <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />,
    problems: <path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />,
    terminal: <path d="M4 17l6-6-6-6M12 19h8" />,
    git: <path d="M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9" />,
  };
  return (
    <span className="mention-icon">
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {paths[icon]}
      </svg>
    </span>
  );
}

type Selection = NonNullable<ReturnType<typeof useWorkspaceStore.getState>['activeSelection']>;

/* Builders for context items — shared by the @ picker and the / commands. */

export function fileMention(path: string, root?: string): MentionItem {
  return {
    id: `file:${path}`,
    label: path.split(/[\\/]/).pop() ?? path,
    detail: relativePath(root, path),
    icon: 'file',
    mention: { kind: 'file', path },
  };
}

export function selectionMention(selection: Selection): MentionItem {
  const name = selection.filePath.split(/[\\/]/).pop() ?? selection.filePath;
  return {
    id: `code:${selection.filePath}:${selection.startLine}-${selection.endLine}`,
    label: `${name} (${selection.startLine}-${selection.endLine})`,
    detail: 'Selected code',
    icon: 'code',
    mention: { kind: 'code', ...selection },
  };
}

export function problemsMention(count: number): MentionItem {
  return { id: 'problems', label: 'Problems', detail: `${count} in workspace`, icon: 'problems', mention: { kind: 'problems' } };
}

/** Null when the terminal has no output yet. */
export function terminalMention(): MentionItem | null {
  const text = getActiveTerminalOutput();
  return text ? { id: 'terminal', label: 'Terminal', detail: 'Recent output', icon: 'terminal', mention: { kind: 'terminal', text } } : null;
}

export function gitDiffMention(): MentionItem {
  return { id: 'git-diff', label: 'Git Diff', detail: 'Uncommitted changes', icon: 'git', mention: { kind: 'gitDiff' } };
}

/** `@` context picker shown above the chat input (Cursor's @-mention menu). */
export const MentionPicker = forwardRef<MentionPickerHandle, MentionPickerProps>(function MentionPicker(
  { query, onSelect, onClose },
  ref,
) {
  const project = useWorkspaceStore((s) => s.project);
  const openFiles = useWorkspaceStore((s) => s.openFiles);
  const selection = useWorkspaceStore((s) => s.activeSelection);
  const problemCount = useDiagnosticsStore((s) => s.items.length);
  const [searchResults, setSearchResults] = useState<MentionItem[]>([]);
  const [highlighted, setHighlighted] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Built-in context sources, filtered by the query.
  const specialItems = useMemo<MentionItem[]>(() => {
    const items = [
      selection && selectionMention(selection),
      problemsMention(problemCount),
      terminalMention(),
      project && gitDiffMention(),
    ].filter((i): i is MentionItem => !!i);
    const q = query.toLowerCase();
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.detail?.toLowerCase().includes(q));
  }, [selection, problemCount, project, query]);

  // Files & folders: open editors when the query is empty, otherwise a workspace search.
  useEffect(() => {
    const root = project?.path;
    const toItem = (path: string, type: 'file' | 'directory'): MentionItem => ({
      id: `${type}:${path}`,
      label: path.split(/[\\/]/).pop() ?? path,
      detail: relativePath(root, path),
      icon: type === 'directory' ? 'folder' : 'file',
      mention: type === 'directory' ? { kind: 'folder', path } : { kind: 'file', path },
    });

    if (!query) {
      setSearchResults(
        openFiles
          .filter((f) => !/^[a-z-]+:\/\//.test(f.path) && !f.path.startsWith('untitled-'))
          .slice(-8)
          .reverse()
          .map((f) => toItem(f.path, 'file')),
      );
      return;
    }
    if (!root) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.peep.searchFiles(root, query, true).then((entries) => {
        if (cancelled) return;
        // Folders first, then shorter paths (closer to the root) first.
        const sorted = [...entries].sort((a, b) =>
          Number(b.type === 'directory') - Number(a.type === 'directory') || a.path.length - b.path.length,
        );
        setSearchResults(sorted.slice(0, 30).map((e) => toItem(e.path, e.type)));
      });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, project?.path, openFiles]);

  const items = useMemo(() => [...searchResults, ...specialItems], [searchResults, specialItems]);

  useEffect(() => setHighlighted(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector('.mention-item.highlighted')?.scrollIntoView({ block: 'nearest' });
  }, [highlighted]);

  useImperativeHandle(ref, () => ({
    handleKeyDown: (e) => {
      switch (e.key) {
        case 'ArrowDown':
          setHighlighted((h) => (items.length ? (h + 1) % items.length : 0));
          break;
        case 'ArrowUp':
          setHighlighted((h) => (items.length ? (h - 1 + items.length) % items.length : 0));
          break;
        case 'Enter':
        case 'Tab':
          if (!items[highlighted]) return false;
          onSelect(items[highlighted]);
          break;
        case 'Escape':
          onClose();
          break;
        default:
          return false;
      }
      e.preventDefault();
      return true;
    },
  }), [items, highlighted, onSelect, onClose]);

  const fileCount = searchResults.length;

  return (
    <div className="mention-picker" ref={listRef} role="listbox" onMouseDown={(e) => e.preventDefault()}>
      {items.length === 0 && <div className="mention-empty">No results for "{query}"</div>}
      {items.map((item, i) => (
        <div key={item.id}>
          {i === 0 && fileCount > 0 && <div className="mention-section">{query ? 'Files & Folders' : 'Recent Files'}</div>}
          {i === fileCount && <div className="mention-section">Context</div>}
          <div
            role="option"
            aria-selected={i === highlighted}
            className={`mention-item ${i === highlighted ? 'highlighted' : ''}`}
            onMouseMove={() => setHighlighted(i)}
            onClick={() => onSelect(item)}
          >
            <MentionIcon icon={item.icon} name={item.label} />
            <span className="mention-label">{item.label}</span>
            {item.detail && <span className="mention-detail">{item.detail}</span>}
          </div>
        </div>
      ))}
    </div>
  );
});
