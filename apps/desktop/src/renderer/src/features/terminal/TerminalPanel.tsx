import { useEffect, useRef, useState } from 'react';
import { Terminal, type ITerminalOptions } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { usePreviewStore } from '../../stores/preview-store';
import { isGlobalKeybinding } from '../../commands/keybindings';
import { ContextMenu, type ContextMenuItem } from '../shared/ContextMenu';
import { clearActiveTerminal, getActiveTerminalOutput, setActiveTerminal } from './terminal-registry';
import { askAgent } from '../chat/ask-agent';
import './TerminalPanel.css';

interface TermInstance {
  id: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
}

const AGENT_TERMINAL_ID = 'agent-terminal';
/** Read-only tab that mirrors the running app's output (Metro, flutter run, ...). */
const RUN_TERMINAL_ID = 'run-output';
/** Tabs backed by a real shell (not the agent or run mirrors). */
const isShell = (id: string) => id !== AGENT_TERMINAL_ID && id !== RUN_TERMINAL_ID;

/** Colors a line of run output the way the terminal shows it (green success, red errors, ...). */
function colorizeRunLine(line: string): string {
  const reset = '\x1b[0m';
  const withLinks = line.replace(/(https?:\/\/\S+|exp:\/\/\S+)/g, `\x1b[38;2;147;197;253m$1${reset}`);
  if (/\b(error|failed|exception|cannot|unable)\b/i.test(line)) return `\x1b[38;2;248;113;113m${line}${reset}`;
  if (/\bwarn(ing)?\b/i.test(line)) return `\x1b[38;2;252;211;77m${line}${reset}`;
  if (/(✓|√|bundled|success|compiled|ready|running at|listening)/i.test(line)) return `\x1b[38;2;74;222;128m${withLinks}${reset}`;
  if (/^\s*[›>»]/.test(line)) return `\x1b[38;2;165;180;252m›${reset}${withLinks.replace(/^\s*[›>»]/, '')}`;
  if (/^\[(watch|preview)/.test(line)) return `\x1b[38;2;82;82;91m${line}${reset}`;
  return withLinks;
}

const BASE_OPTIONS: ITerminalOptions = {
  theme: {
    background: '#0d0d10',
    foreground: '#d4d4d8',
    cursor: '#a5b4fc',
    cursorAccent: '#0d0d10',
    selectionBackground: 'rgba(124, 131, 255, 0.32)',
    black: '#18181b',
    red: '#f87171',
    green: '#4ade80',
    yellow: '#fcd34d',
    blue: '#93c5fd',
    magenta: '#c792ea',
    cyan: '#7dd3fc',
    white: '#d4d4d8',
    brightBlack: '#52525b',
    brightRed: '#fca5a5',
    brightGreen: '#86efac',
    brightYellow: '#fde68a',
    brightBlue: '#bfdbfe',
    brightMagenta: '#f0abfc',
    brightCyan: '#a5f3fc',
    brightWhite: '#fafafa',
  },
  fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, monospace",
  fontSize: 12,
  lineHeight: 1.45,
  scrollback: 5000,
};

/** Creates an xterm instance with the addons VS Code's terminal uses (fit, search, links). */
export function createXterm(
  id: string,
  name: string,
  options: ITerminalOptions,
  onFind: () => void,
): TermInstance {
  const term = new Terminal({ ...BASE_OPTIONS, ...options });
  const fit = new FitAddon();
  const search = new SearchAddon();
  term.loadAddon(fit);
  term.loadAddon(search);
  // Ctrl/Cmd+click opens URLs, like VS Code.
  term.loadAddon(new WebLinksAddon((event, uri) => {
    if (event.ctrlKey || event.metaKey) window.open(uri);
  }));

  // xterm needs a parent element before it can render; it's moved into the panel when shown.
  const host = document.createElement('div');
  host.style.height = '100%';
  term.open(host);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const ctrl = e.ctrlKey || e.metaKey;

    // Copy when there is a selection; otherwise Ctrl+C goes to the shell as SIGINT.
    if (ctrl && !e.shiftKey && e.code === 'KeyC' && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (ctrl && e.code === 'KeyV') {
      if (!options.disableStdin) {
        void navigator.clipboard.readText().then((text) => text && term.paste(text));
      }
      return false;
    }
    if (ctrl && !e.shiftKey && e.code === 'KeyF') {
      onFind();
      return false;
    }
    // Let workbench keybindings (Ctrl+`, Ctrl+B, Ctrl+P, …) reach the global handler.
    if (isGlobalKeybinding(e)) return false;
    return true;
  });

  return { id, name, term, fit, search };
}

interface TerminalPanelProps {
  /** Kill the shells when the panel goes away (the start page's terminal has no other owner). */
  disposeOnUnmount?: boolean;
}

export function TerminalPanel({ disposeOnUnmount = false }: TerminalPanelProps = {}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const project = useWorkspaceStore((s) => s.project);

  const [terminals, setTerminals] = useState<TermInstance[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const findInputRef = useRef<HTMLInputElement>(null);

  // Keep refs for event handlers to avoid stale closures
  const terminalsRef = useRef(terminals);
  terminalsRef.current = terminals;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const lastAgentSessionIdRef = useRef<string | null>(null);
  const terminalCounterRef = useRef(0);

  const getActive = () => terminalsRef.current.find((t) => t.id === activeIdRef.current);

  const openFind = () => {
    setFindOpen(true);
    const selection = getActive()?.term.getSelection();
    if (selection && !selection.includes('\n')) setFindQuery(selection);
    requestAnimationFrame(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  };
  const openFindRef = useRef(openFind);
  openFindRef.current = openFind;

  /** Removes a terminal tab; `killProcess` is false when the shell already exited. */
  const disposeTerminal = (id: string, killProcess = true) => {
    const t = terminalsRef.current.find((x) => x.id === id);
    if (!t) return;
    clearActiveTerminal(t.term);
    t.term.dispose();
    if (killProcess && isShell(id)) void window.peep.destroyTerminal(id);
    setTerminals((prev) => {
      const next = prev.filter((x) => x.id !== id);
      if (activeIdRef.current === id) {
        setActiveId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
  };

  const addTerminal = (options: { title?: string; run?: string } = {}) => {
    const id = `term-${Date.now()}`;
    terminalCounterRef.current += 1;
    const instance = createXterm(id, options.title ?? `Terminal ${terminalCounterRef.current}`, { cursorBlink: true }, () => openFindRef.current());

    instance.term.onData((data) => {
      void window.peep.writeTerminal(id, data);
    });
    // Keep the pseudo-terminal's size in sync with the view (like terminalResizeDebouncer).
    instance.term.onResize(({ cols, rows }) => {
      void window.peep.resizeTerminal(id, cols, rows);
    });

    // Without a project (start page) the main process falls back to the home folder.
    void window.peep.createTerminal({ id, cwd: project?.path ?? '', cols: instance.term.cols, rows: instance.term.rows }).then(() => {
      if (options.run) void window.peep.writeTerminal(id, `${options.run}
`);
    });

    // Updated now (not on the next render) so a second "create the first terminal" pass sees it.
    terminalsRef.current = [...terminalsRef.current, instance];
    setTerminals((prev) => [...prev, instance]);
    setActiveId(id);
  };

  // Initialize first terminal on mount
  useEffect(() => {
    if (terminalsRef.current.length === 0) {
      addTerminal();
    }
  }, [project]);

  // The running app's output (Metro, flutter run, ...) in its own read-only tab.
  useEffect(() => {
    const ensureRunTerminal = (activate: boolean) => {
      let run = terminalsRef.current.find((t) => t.id === RUN_TERMINAL_ID);
      if (!run) {
        run = createXterm(RUN_TERMINAL_ID, 'Run', { convertEol: true, disableStdin: true, cursorBlink: false }, () => openFindRef.current());
        const created = run;
        terminalsRef.current = [...terminalsRef.current, created];
        setTerminals((prev) => [...prev, created]);
      }
      if (activate) setActiveId(RUN_TERMINAL_ID);
      return run;
    };

    // Backfill what the app printed while the panel was closed.
    const { session, logs } = usePreviewStore.getState();
    if (session && session.status !== 'stopped' && logs.length > 0) {
      const run = ensureRunTerminal(true);
      run.term.reset();
      for (const line of logs) run.term.writeln(colorizeRunLine(line));
    }

    return usePreviewStore.subscribe((state, prev) => {
      if (state.session !== prev.session && state.session) {
        const { status, url } = state.session;
        if (status === 'starting' && prev.session?.status !== 'starting') {
          const run = ensureRunTerminal(true);
          run.term.reset();
          run.term.writeln('\x1b[38;2;82;82;91m$\x1b[0m \x1b[1mStarting preview…\x1b[0m');
        } else if (status === 'running' && prev.session?.status !== 'running') {
          ensureRunTerminal(false).term.writeln(`\x1b[38;2;74;222;128m✓ Running\x1b[0m${url ? ` at \x1b[38;2;147;197;253m${url}\x1b[0m` : ''}`);
        } else if (status === 'error') {
          ensureRunTerminal(true).term.writeln(`\x1b[38;2;248;113;113m✕ ${state.session.error ?? 'Preview failed'}\x1b[0m`);
        } else if (status === 'stopped' && prev.session?.status !== 'stopped') {
          terminalsRef.current.find((t) => t.id === RUN_TERMINAL_ID)?.term.writeln('\x1b[38;2;82;82;91m[stopped]\x1b[0m');
        }
      }
      // addLog appends one line at a time.
      if (state.logs !== prev.logs && state.logs.length > 0 && state.logs.length >= prev.logs.length - 1) {
        const line = state.logs[state.logs.length - 1];
        if (line !== prev.logs[prev.logs.length - 1] || state.logs.length !== prev.logs.length) {
          ensureRunTerminal(false).term.writeln(colorizeRunLine(line));
        }
      }
    });
  }, []);

  // Handle terminal output and exit events
  useEffect(() => {
    const getOrCreateAgentTerminal = (terminalsArr: TermInstance[]) => {
      let agentTerm = terminalsArr.find((t) => t.id === AGENT_TERMINAL_ID);
      if (!agentTerm) {
        // Agent commands run without a pty, so normalize bare \n line endings.
        agentTerm = createXterm(
          AGENT_TERMINAL_ID,
          '🤖 Agent Terminal',
          { convertEol: true, disableStdin: true, cursorBlink: false },
          () => openFindRef.current(),
        );
        const created = agentTerm;
        setTerminals((prev) => [...prev, created]);

        // Auto-switch to Agent Terminal when created
        setActiveId(AGENT_TERMINAL_ID);
        // Ensure bottom panel is open and on the terminal tab
        const wsState = useWorkspaceStore.getState();
        if (wsState.bottomPanelTab !== 'terminal') wsState.setBottomPanelTab('terminal');
        if (!wsState.bottomPanelOpen) wsState.toggleBottomPanel();
      }
      return agentTerm;
    };

    const unsubOutput = window.peep.onTerminalOutput(({ id, data }) => {
      if (id.startsWith('agent-cmd-')) {
        const t = getOrCreateAgentTerminal(terminalsRef.current);
        if (lastAgentSessionIdRef.current && lastAgentSessionIdRef.current !== id) {
          t.term.writeln(`\r\n\x1b[90m--- New Agent Command Session ---\x1b[0m\r\n`);
        }
        lastAgentSessionIdRef.current = id;
        t.term.write(data);
        return;
      }

      const t = terminalsRef.current.find((x) => x.id === id);
      if (t) t.term.write(data);
    });

    const unsubExit = window.peep.onTerminalExit(({ id, code }) => {
      if (id.startsWith('agent-cmd-')) {
        const t = terminalsRef.current.find((x) => x.id === AGENT_TERMINAL_ID);
        if (t) t.term.writeln(`\r\n\x1b[90m[Agent command finished with code ${code}]\x1b[0m\r\n`);
        return;
      }

      // VS Code closes the tab when the shell exits cleanly (e.g. `exit`) and keeps it otherwise.
      if (code === 0) {
        disposeTerminal(id, false);
        return;
      }
      const t = terminalsRef.current.find((x) => x.id === id);
      if (t) t.term.writeln(`\r\n\x1b[90m[The terminal process terminated with exit code: ${code}]\x1b[0m`);
    });

    return () => {
      unsubOutput();
      unsubExit();
    };
  }, []);

  // Update DOM when active terminal changes
  useEffect(() => {
    if (!containerRef.current) return;
    const container = containerRef.current;

    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }

    const active = terminals.find((t) => t.id === activeId);
    setActiveTerminal(active?.term ?? null);
    if (active && active.term.element) {
      container.appendChild(active.term.element);
      requestAnimationFrame(() => {
        active.fit.fit();
        active.term.focus();
      });
    }
  }, [activeId, terminals]);

  // Refit when the panel is resized (window resize or dragging the panel splitter).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const active = getActive();
        if (active && container.offsetWidth > 0 && container.offsetHeight > 0) active.fit.fit();
      });
    });
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [project]);

  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    if (!disposeOnUnmount) return;
    return () => {
      mountedRef.current = false;
      // Deferred so React StrictMode's immediate re-mount in dev doesn't kill the shells.
      setTimeout(() => {
        if (mountedRef.current) return;
        for (const t of terminalsRef.current) {
          clearActiveTerminal(t.term);
          t.term.dispose();
          if (isShell(t.id)) void window.peep.destroyTerminal(t.id);
        }
      }, 0);
    };
  }, [disposeOnUnmount]);

  // Commands from the menu bar / command palette (Terminal menu)
  const addTerminalRef = useRef(addTerminal);
  addTerminalRef.current = addTerminal;
  const disposeTerminalRef = useRef(disposeTerminal);
  disposeTerminalRef.current = disposeTerminal;
  useEffect(() => {
    const onNew = (e: Event) => addTerminalRef.current((e as CustomEvent<{ title?: string; run?: string } | undefined>).detail ?? {});
    const onClear = () => getActive()?.term.clear();
    const onRunText = (e: Event) => {
      const text = (e as CustomEvent<string>).detail;
      let target = getActive();
      if (!target || !isShell(target.id)) {
        target = terminalsRef.current.find((t) => isShell(t.id));
      }
      if (target && text) {
        setActiveId(target.id);
        void window.peep.writeTerminal(target.id, text.endsWith('\n') ? text : `${text}\r`);
      }
    };
    const onKill = () => {
      const t = getActive();
      if (t && isShell(t.id)) disposeTerminalRef.current(t.id);
    };
    window.addEventListener('peep:terminal-new', onNew);
    window.addEventListener('peep:terminal-clear', onClear);
    window.addEventListener('peep:terminal-run-text', onRunText);
    window.addEventListener('peep:terminal-kill', onKill);
    return () => {
      window.removeEventListener('peep:terminal-new', onNew);
      window.removeEventListener('peep:terminal-clear', onClear);
      window.removeEventListener('peep:terminal-run-text', onRunText);
      window.removeEventListener('peep:terminal-kill', onKill);
    };
  }, []);

  const runFind = (direction: 'next' | 'previous') => {
    const active = getActive();
    if (!active || !findQuery) return;
    if (direction === 'next') active.search.findNext(findQuery);
    else active.search.findPrevious(findQuery);
  };

  const closeFind = () => {
    setFindOpen(false);
    getActive()?.term.clearSelection();
    getActive()?.term.focus();
  };

  const commitRename = (id: string, value: string) => {
    const name = value.trim();
    if (name) setTerminals((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)));
    setRenamingId(null);
  };

  const active = terminals.find((t) => t.id === activeId);
  const isUserTerminal = !!active && isShell(active.id);
  const menuItems: ContextMenuItem[] = [
    { label: 'Copy', keybinding: 'Ctrl+C', enabled: !!active?.term.hasSelection(), run: () => {
      if (active) void navigator.clipboard.writeText(active.term.getSelection());
    } },
    { label: 'Paste', keybinding: 'Ctrl+V', enabled: isUserTerminal, run: () => {
      void navigator.clipboard.readText().then((text) => text && active?.term.paste(text));
    } },
    { label: 'Select All', enabled: !!active, run: () => active?.term.selectAll() },
    '-',
    { label: '✦ Fix with AI', enabled: !!active, run: () => {
      const output = getActiveTerminalOutput(80);
      if (output) askAgent(`Explain the error in this terminal output and fix it:\n\n\`\`\`\n${output}\n\`\`\``);
    } },
    '-',
    { label: 'Find', keybinding: 'Ctrl+F', enabled: !!active, run: openFind },
    { label: 'Clear Terminal', enabled: !!active, run: () => active?.term.clear() },
    '-',
    { label: 'New Terminal', keybinding: 'Ctrl+Shift+`', run: addTerminal },
    { label: 'Rename...', enabled: isUserTerminal, run: () => active && setRenamingId(active.id) },
    { label: 'Kill Terminal', enabled: isUserTerminal, run: () => active && disposeTerminal(active.id) },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Terminal Tabs */}
      <div className="terminal-sessions">
        {terminals.map((t) => (
          <div
            key={t.id}
            className={`terminal-tab-item ${activeId === t.id ? 'active' : ''}`}
            onClick={() => setActiveId(t.id)}
            onDoubleClick={() => isShell(t.id) && setRenamingId(t.id)}
            onAuxClick={(e) => { if (e.button === 1 && t.id !== AGENT_TERMINAL_ID) disposeTerminal(t.id); }}
            title={t.id !== AGENT_TERMINAL_ID ? 'Double-click to rename' : undefined}
          >
            {renamingId === t.id ? (
              <input
                autoFocus
                className="terminal-rename-input"
                defaultValue={t.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => commitRename(t.id, e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(t.id, e.currentTarget.value);
                  if (e.key === 'Escape') setRenamingId(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <span>{t.name}</span>
            )}
            {t.id !== AGENT_TERMINAL_ID && (
              <button
                className="terminal-tab-close"
                onClick={(e) => { e.stopPropagation(); disposeTerminal(t.id); }}
                title="Kill Terminal"
              >
                ✕
              </button>
            )}
          </div>
        ))}
        <button className="terminal-tab-add" onClick={() => addTerminal()} title="New Terminal (Ctrl+Shift+`)">
          +
        </button>
      </div>

      {/* Terminal Viewport */}
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        {findOpen && (
          <div className="terminal-find" onMouseDown={(e) => e.stopPropagation()}>
            <input
              ref={findInputRef}
              placeholder="Find"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runFind(e.shiftKey ? 'previous' : 'next');
                else if (e.key === 'Escape') closeFind();
                else return;
                e.preventDefault();
                e.stopPropagation();
              }}
            />
            <button title="Previous Match (Shift+Enter)" onClick={() => runFind('previous')}>↑</button>
            <button title="Next Match (Enter)" onClick={() => runFind('next')}>↓</button>
            <button title="Close (Escape)" onClick={closeFind}>✕</button>
          </div>
        )}
        <div
          ref={containerRef}
          className="terminal-viewport"
          onClick={() => getActive()?.term.focus()}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu({ x: e.clientX, y: e.clientY });
          }}
        />
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}
