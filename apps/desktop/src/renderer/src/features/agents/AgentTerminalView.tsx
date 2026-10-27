import { useEffect, useRef } from 'react';
import { createXterm } from '../terminal/TerminalPanel';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { AGENT_TAB_PREFIX, agentIdFromTab, useAgentsStore } from './agents-store';
import './AgentTerminalView.css';

/**
 * An editor tab running an agent CLI (Claude Code, Codex, ...). The session outlives the view, so
 * switching tabs keeps the conversation; closing the tab ends it.
 */

interface AgentSession {
  terminalId: string;
  instance: ReturnType<typeof createXterm>;
  dispose: () => void;
}

const sessions = new Map<string, AgentSession>();
let watchingTabs = false;

/** Ends sessions whose tab was closed. */
function watchClosedTabs(): void {
  if (watchingTabs) return;
  watchingTabs = true;
  useWorkspaceStore.subscribe((state, prev) => {
    if (state.openFiles === prev.openFiles) return;
    const open = new Set(state.openFiles.map((f) => f.path));
    for (const [path, session] of sessions) {
      if (!open.has(path)) session.dispose();
    }
  });
}

const quote = (cli: string) => (cli.includes(' ') || cli.includes('\\') ? `"${cli}"` : cli);

async function startSession(path: string, session: AgentSession): Promise<void> {
  const { term } = session.instance;
  const extensionId = agentIdFromTab(path);
  const agent = useAgentsStore.getState().agents.find((a) => a.extensionId === extensionId);
  term.writeln(`\x1b[90mStarting ${agent?.name ?? 'agent'}…\x1b[0m`);

  const cli = await window.peep.resolveAgentCli(extensionId);
  if (!cli) {
    term.writeln(`\x1b[31mCouldn't find the ${agent?.name ?? 'agent'} program for this computer.\x1b[0m`);
    term.writeln('Reinstall the extension from the Extensions view, then open it again.');
    return;
  }
  if (!sessions.has(path)) return; // the tab was closed while resolving
  const cwd = useWorkspaceStore.getState().project?.path ?? '';
  await window.peep.createTerminal({ id: session.terminalId, cwd, cols: term.cols, rows: term.rows });
  // PowerShell needs the call operator to run a quoted path.
  const command = [quote(cli), ...(agent?.args ?? [])].join(' ');
  const run = navigator.userAgent.includes('Windows') ? `& ${command}` : command;
  void window.peep.writeTerminal(session.terminalId, `clear; ${run}\r`);
}

function getSession(path: string): AgentSession {
  const existing = sessions.get(path);
  if (existing) return existing;
  watchClosedTabs();

  const terminalId = `aitab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const instance = createXterm(terminalId, path, { cursorBlink: true, fontSize: 13 }, () => {});
  const { term } = instance;
  term.onData((data) => void window.peep.writeTerminal(terminalId, data));
  term.onResize(({ cols, rows }) => void window.peep.resizeTerminal(terminalId, cols, rows));
  const unsubOutput = window.peep.onTerminalOutput(({ id, data }) => { if (id === terminalId) term.write(data); });
  const unsubExit = window.peep.onTerminalExit(({ id, code }) => {
    if (id === terminalId) term.writeln(`\r\n\x1b[90m[Session ended with exit code ${code}. Close the tab or open the agent again.]\x1b[0m`);
  });

  const session: AgentSession = {
    terminalId,
    instance,
    dispose: () => {
      sessions.delete(path);
      unsubOutput();
      unsubExit();
      term.dispose();
      void window.peep.destroyTerminal(terminalId);
    },
  };
  sessions.set(path, session);
  void startSession(path, session);
  return session;
}

export function AgentTerminalView({ path }: { path: string }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !path.startsWith(AGENT_TAB_PREFIX)) return;
    const { instance } = getSession(path);
    const host = instance.term.element?.parentElement;
    if (host) container.appendChild(host);

    const fit = () => {
      try { instance.fit.fit(); } catch { /* hidden or disposed */ }
    };
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    requestAnimationFrame(() => {
      fit();
      instance.term.focus();
    });

    return () => {
      observer.disconnect();
      // Keep the session alive; just take its view out of this tab.
      if (host && host.parentElement === container) container.removeChild(host);
    };
  }, [path]);

  return <div className="agent-terminal" ref={containerRef} />;
}
