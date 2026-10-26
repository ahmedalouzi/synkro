import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../../stores/auth-store';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useWorkspace } from '../../hooks/useWorkspace';
import { TitleBar } from '../../layout/TitleBar';
import { StatusBar } from '../../layout/StatusBar';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { openWebPage } from '../../config/web';
import './HomeScreen.css';

/** Start page like Cursor's: brand + plan, quick actions, recent projects. */

const emit = (name: string, detail?: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }));

/** The folder a project lives in, shown on the right of each recent row. */
const parentDir = (path: string) => path.replace(/[\\/][^\\/]+[\\/]?$/, '') || path;

function Icon({ d }: { d: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const ICON = {
  open: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  newProject: 'M12 5v14M5 12h14',
  clone: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
  ssh: 'M4 17l6-6-6-6M12 19h8',
};

const RECENT_COLLAPSED = 5;
const TERMINAL_MIN_HEIGHT = 120;
const TERMINAL_DEFAULT_HEIGHT = 280;

export function HomeScreen() {
  const { user, settings } = useAuthStore();
  const recentProjects = useWorkspaceStore((s) => s.recentProjects);
  const sidebarOpen = useWorkspaceStore((s) => s.homeSidebarOpen);
  const statusBarVisible = useWorkspaceStore((s) => s.statusBarVisible);
  const { openProjectFolder, openProjectByPath } = useWorkspace();
  const [showAllRecent, setShowAllRecent] = useState(false);

  /* ── Terminal panel (like Cursor's start page): opened from Terminal › New Terminal or Ctrl+` ── */
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [panelTab, setPanelTab] = useState<'problems' | 'terminal'>('terminal');
  // The shell starts the first time the Terminal tab is shown, then stays alive across tab switches.
  const [terminalStarted, setTerminalStarted] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT);
  const terminalOpenRef = useRef(terminalOpen);
  terminalOpenRef.current = terminalOpen;
  const panelTabRef = useRef(panelTab);
  panelTabRef.current = panelTab;

  useEffect(() => {
    const onTerminal = (e: Event) => {
      const action = (e as CustomEvent<'new' | 'toggle' | 'problems'>).detail;
      if (action === 'problems') {
        setPanelTab('problems');
        return setTerminalOpen(true);
      }
      if (action === 'toggle') {
        setPanelTab('terminal');
        setTerminalStarted(true);
        return setTerminalOpen((v) => !v);
      }
      // An open terminal gets another tab; otherwise the panel opens with its first terminal.
      if (terminalOpenRef.current && panelTabRef.current === 'terminal') window.dispatchEvent(new CustomEvent('peep:terminal-new'));
      setPanelTab('terminal');
      setTerminalStarted(true);
      setTerminalOpen(true);
    };
    window.addEventListener('peep:home-terminal', onTerminal);
    return () => window.removeEventListener('peep:home-terminal', onTerminal);
  }, []);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const onMove = (ev: MouseEvent) => {
      const max = window.innerHeight - 35 - 22 - 120;
      setTerminalHeight(Math.min(max, Math.max(TERMINAL_MIN_HEIGHT, window.innerHeight - 22 - ev.clientY)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // The list is otherwise only filled after a project opens, so load it for the start page.
  useEffect(() => {
    void window.peep.getRecentProjects().then((recent) => useWorkspaceStore.getState().setRecentProjects(recent));
  }, []);

  const plan = (user?.tier || user?.plan || 'free').toString();
  const planLabel = plan.toLowerCase().endsWith('plan') ? plan : `${plan.charAt(0).toUpperCase()}${plan.slice(1)} Plan`;
  const isFreePlan = /^free( plan)?$/i.test(plan);
  const shownRecent = showAllRecent ? recentProjects : recentProjects.slice(0, RECENT_COLLAPSED);

  const actions = [
    { label: 'Open project', icon: ICON.open, run: () => void openProjectFolder() },
    { label: 'New project', icon: ICON.newProject, run: () => emit('peep:new-project') },
    { label: 'Clone repo', icon: ICON.clone, run: () => emit('peep:clone-repo') },
    { label: 'Connect via SSH', icon: ICON.ssh, run: () => emit('peep:ssh-connect') },
  ];

  return (
    <div className="home">
      <TitleBar />

      <div className="home__body">
      {sidebarOpen && (
        <aside className="home__sidebar">
          <div className="home__sidebar-head">No folder opened</div>
          <div className="home__sidebar-body">
            <p>You have not yet opened a folder.</p>
            <button type="button" className="home__sidebar-btn" onClick={() => void openProjectFolder()}>Open Folder</button>
            <p>You can clone a repository locally.</p>
            <button type="button" className="home__sidebar-btn" onClick={() => emit('peep:clone-repo')}>Clone Repository</button>
            <p>Or start a new Flutter or React Native app.</p>
            <button type="button" className="home__sidebar-btn home__sidebar-btn--secondary" onClick={() => emit('peep:new-project')}>New Project</button>
          </div>
        </aside>
      )}

      <div className="home__workarea">
      <main className="home__main">
        <div className="home__content">
          <div className="home__brand">
            <svg className="home__logo" width="30" height="30" viewBox="0 0 32 32" fill="none" aria-hidden="true">
              <g stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round">
                <ellipse cx="16" cy="16" rx="5" ry="11" />
                <ellipse cx="16" cy="16" rx="5" ry="11" transform="rotate(60 16 16)" />
                <ellipse cx="16" cy="16" rx="5" ry="11" transform="rotate(120 16 16)" />
              </g>
              <circle cx="16" cy="16" r="1.6" fill="currentColor" />
            </svg>
            <span className="home__wordmark">SYNKRO</span>
          </div>

          {user && (
            <div className="home__plan">
              <span>{planLabel}</span>
              {isFreePlan && (
                <>
                  <span className="home__plan-dot">·</span>
                  <button type="button" className="home__link" title="Opens Synkro pricing" onClick={() => openWebPage('pricing')}>Upgrade</button>
                </>
              )}
              {settings?.isDevBypassActive && <span className="home__dev">Dev auth bypass</span>}
            </div>
          )}

          <div className="home__actions">
            {actions.map((a) => (
              <button key={a.label} type="button" className="home__action" onClick={a.run}>
                <Icon d={a.icon} />
                <span>{a.label}</span>
              </button>
            ))}
          </div>

          <section className="home__recent">
            <div className="home__recent-head">
              <span>Recent projects</span>
              {recentProjects.length > RECENT_COLLAPSED && (
                <button type="button" className="home__link home__link--muted" onClick={() => setShowAllRecent((v) => !v)}>
                  {showAllRecent ? 'Show less' : `View all (${recentProjects.length})`}
                </button>
              )}
            </div>
            {recentProjects.length === 0 ? (
              <div className="home__recent-empty">No recent projects yet. Open or create one to get started.</div>
            ) : (
              <div className={`home__recent-list ${showAllRecent ? 'home__recent-list--all' : ''}`}>
                {shownRecent.map((p) => (
                  <button key={p.id} type="button" className="home__recent-row" title={p.path} onClick={() => void openProjectByPath(p.path)}>
                    <span className="home__recent-name">{p.name}</span>
                    <span className="home__recent-path">{parentDir(p.path)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </div>

        <button type="button" className="home__pill" onClick={() => void window.peep.newWindow()}>
          Try a new window to work on several apps in parallel ↗
        </button>
      </main>

      {terminalOpen && (
        <section className="home__terminal" style={{ height: terminalHeight }}>
          <div className="home__terminal-resize" onMouseDown={startResize} />
          <div className="home__terminal-head">
            <div className="home__panel-tabs" role="tablist">
              {(['problems', 'terminal'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={panelTab === t}
                  className={`home__panel-tab ${panelTab === t ? 'home__panel-tab--active' : ''}`}
                  onClick={() => {
                    setPanelTab(t);
                    if (t === 'terminal') setTerminalStarted(true);
                  }}
                >
                  {t === 'problems' ? 'Problems' : 'Terminal'}
                </button>
              ))}
            </div>
            <button type="button" className="home__terminal-close" title="Close Panel" onClick={() => setTerminalOpen(false)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          <div className="home__terminal-body">
            {panelTab === 'problems' && (
              <div className="home__problems">No problems have been detected. Open a project to see errors and warnings.</div>
            )}
            {terminalStarted && (
              <div style={{ display: panelTab === 'terminal' ? 'block' : 'none', height: '100%' }}>
                <TerminalPanel disposeOnUnmount />
              </div>
            )}
          </div>
        </section>
      )}
      </div>
      </div>

      {statusBarVisible && <StatusBar />}
    </div>
  );
}
