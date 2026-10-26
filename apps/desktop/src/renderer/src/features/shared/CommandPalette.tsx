import { useEffect, useMemo, useRef, useState } from 'react';
import { COMMANDS, isCommandEnabled, runCommand, type Command } from '../../commands/commands';
import './CommandPalette.css';

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
}

const RECENT_KEY = 'peep.commandPalette.recent';

function loadRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function saveRecent(id: string) {
  try {
    const next = [id, ...loadRecent().filter((r) => r !== id)].slice(0, 10);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — recents are a convenience only.
  }
}

const labelOf = (cmd: Command) => (cmd.category ? `${cmd.category}: ${cmd.title}` : cmd.title);

/** Every word of the query must appear in the label, in any order. */
function matches(label: string, query: string): boolean {
  const lower = label.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => lower.includes(word));
}

export function CommandPalette({ open, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  // Element focused before the palette opened — restored so editor commands target it.
  const previousFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    setQuery('');
    setSelected(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  const { recent, others } = useMemo(() => {
    if (!open) return { recent: [], others: [] };
    const available = [...COMMANDS.values()].filter((c) => isCommandEnabled(c) && matches(labelOf(c), query));
    const recentIds = loadRecent();
    const recent = recentIds
      .map((id) => available.find((c) => c.id === id))
      .filter((c): c is Command => !!c);
    const others = available
      .filter((c) => !recentIds.includes(c.id))
      .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
    return { recent, others };
  }, [open, query]);

  const items = [...recent, ...others];

  useEffect(() => {
    listRef.current?.querySelector('.cp-item.selected')?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;

  const dismiss = () => {
    onClose();
    previousFocus.current?.focus();
  };

  const execute = (cmd: Command | undefined) => {
    if (!cmd) return;
    saveRecent(cmd.id);
    dismiss();
    // Let focus settle back on the previous element before running.
    setTimeout(() => runCommand(cmd.id), 0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setSelected((s) => Math.min(s + 1, items.length - 1));
    else if (e.key === 'ArrowUp') setSelected((s) => Math.max(s - 1, 0));
    else if (e.key === 'PageDown') setSelected((s) => Math.min(s + 10, items.length - 1));
    else if (e.key === 'PageUp') setSelected((s) => Math.max(s - 10, 0));
    else if (e.key === 'Enter') execute(items[selected]);
    else if (e.key === 'Escape') dismiss();
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="cp-overlay" onMouseDown={dismiss}>
      <div className="cp-widget" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cp-input"
          placeholder="Type the name of a command to run."
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
          onKeyDown={onKeyDown}
          spellCheck={false}
        />
        <div className="cp-list" ref={listRef} role="listbox">
          {items.length === 0 && <div className="cp-empty">No matching commands</div>}
          {items.map((cmd, i) => (
            <div
              key={cmd.id}
              role="option"
              aria-selected={i === selected}
              className={`cp-item ${i === selected ? 'selected' : ''}`}
              onMouseMove={() => setSelected(i)}
              onClick={() => execute(cmd)}
            >
              <span className="cp-label">{labelOf(cmd)}</span>
              {i === 0 && recent.length > 0 && <span className="cp-tag">recently used</span>}
              {i === recent.length && recent.length > 0 && <span className="cp-tag">other commands</span>}
              {cmd.keybinding && <kbd className="cp-kbd">{cmd.keybinding}</kbd>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
