import { useCallback, useEffect, useReducer, useState, type ReactNode } from 'react';
import type { Settings } from '@peep/shared';
import { getCommand, isCommandEnabled, runCommand } from '../../commands/commands';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { MODELS } from '../chat/models';
import { openWebPage } from '../../config/web';
import './SettingsModal.css';

/**
 * Full-page settings, laid out like Cursor's: account + search + section nav on the left,
 * cards of "title / description / control" rows on the right. Every control is wired to a
 * real command or IPC call; toggles read the same state as the menus (commands.ts `checked`).
 */

type SectionId = 'general' | 'usage' | 'models' | 'editor' | 'tab' | 'rules' | 'sdk' | 'privacy' | 'beta' | 'about';

type Account = NonNullable<Awaited<ReturnType<typeof window.peep.authGetAccount>>>;

const NAV: { group: SectionId[] }[] = [
  { group: ['general'] },
  { group: ['usage'] },
  { group: ['models', 'editor', 'tab', 'rules', 'sdk'] },
  { group: ['privacy', 'beta', 'about'] },
];

const SECTION_LABELS: Record<SectionId, string> = {
  general: 'General',
  usage: 'Plan & Usage',
  models: 'Models',
  editor: 'Editor',
  tab: 'Tab',
  rules: 'Rules',
  sdk: 'Mobile SDKs',
  privacy: 'Privacy',
  beta: 'Beta',
  about: 'About',
};

const ICONS: Record<SectionId | 'settings', ReactNode> = {
  settings: <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4" />,
  general: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  usage: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M8 15h3" /></>,
  models: <><path d="M12 2l9 5v10l-9 5-9-5V7z" /><path d="M3 7l9 5 9-5M12 12v10" /></>,
  editor: <><path d="M16 18l6-6-6-6M8 6l-6 6 6 6" /></>,
  tab: <><path d="M3 12h14M13 8l4 4-4 4M21 5v14" /></>,
  rules: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5z" /><path d="M8 7h8M8 11h6" /></>,
  sdk: <><rect x="7" y="2" width="10" height="20" rx="2" /><path d="M11 18h2" /></>,
  privacy: <><rect x="4" y="11" width="16" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  beta: <><path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-9V3" /></>,
  about: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h0" /></>,
};

function Icon({ name }: { name: SectionId | 'settings' }) {
  return (
    <svg className="sx-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[name]}
    </svg>
  );
}

/* ── Building blocks ─────────────────────────────────────────────────── */

function Row({ title, description, query, children }: { title: string; description?: ReactNode; query: string; children?: ReactNode }) {
  if (query) {
    const haystack = `${title} ${typeof description === 'string' ? description : ''}`.toLowerCase();
    if (!haystack.includes(query)) return null;
  }
  return (
    <div className="sx-row">
      <div className="sx-row__text">
        <div className="sx-row__title">{title}</div>
        {description && <div className="sx-row__desc">{description}</div>}
      </div>
      {children && <div className="sx-row__control">{children}</div>}
    </div>
  );
}

function Card({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="sx-card-group">
      {label && <div className="sx-card-label">{label}</div>}
      <div className="sx-card">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (next: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`sx-switch ${checked ? 'sx-switch--on' : ''}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="sx-switch__thumb" />
    </button>
  );
}

/** A toggle backed by a command from the registry, so it always matches the menus. */
function CommandToggle({ id, onToggled }: { id: string; onToggled: () => void }) {
  const cmd = getCommand(id);
  if (!cmd) return null;
  return (
    <Toggle
      checked={!!cmd.checked?.()}
      disabled={!isCommandEnabled(cmd)}
      onChange={() => {
        runCommand(id);
        onToggled();
      }}
    />
  );
}

const ipcErrorMessage = (err: unknown) =>
  ((err as Error)?.message ?? String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const formatDate = (iso?: string) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';

/* ── Page ────────────────────────────────────────────────────────────── */

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  /** Section to show first, e.g. 'usage' from an Upgrade button. */
  initialSection?: string;
}

export function SettingsModal({ open, onClose, initialSection }: SettingsModalProps) {
  const project = useWorkspaceStore((s) => s.project);
  // Re-render on any workspace change so command-backed toggles stay in sync.
  useWorkspaceStore();
  const [, refresh] = useReducer((n: number) => n + 1, 0);

  const [section, setSection] = useState<SectionId>('general');
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();

  // Account
  const [account, setAccount] = useState<Account | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [authMode, setAuthMode] = useState<'signin' | 'signup' | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  // SDK
  const [flutterPath, setFlutterPath] = useState('');
  const [savedFlutterPath, setSavedFlutterPath] = useState('');
  const [sdkVersion, setSdkVersion] = useState<string | null>(null);
  const [sdkStatus, setSdkStatus] = useState('');

  // Privacy / beta
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [developerMode, setDeveloperMode] = useState(false);
  const [aiProvider, setAiProvider] = useState('gemini');
  const [aiKey, setAiKey] = useState('');
  const [aiKeyConfigured, setAiKeyConfigured] = useState(false);
  const [aiStatus, setAiStatus] = useState('');

  // Models / import
  const [model, setModel] = useState<string | undefined>(undefined);
  const [importStatus, setImportStatus] = useState('');

  // About
  const [version, setVersion] = useState('');
  const [perfInfo, setPerfInfo] = useState<{ heapUsedMB: number; rssMemMB: number } | null>(null);
  const [updateInfo, setUpdateInfo] = useState<any>({ status: 'idle' });

  const loadAccount = useCallback(async (settings?: Settings) => {
    setAccountLoading(true);
    try {
      const s = settings ?? (await window.peep.getSettings());
      setAccount(s.sessionConfigured ? await window.peep.authGetAccount().catch(() => null) : null);
    } finally {
      setAccountLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) setSection(initialSection && initialSection in SECTION_LABELS ? (initialSection as SectionId) : 'general');
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return;
    void window.peep.getSettings().then((s) => {
      setFlutterPath(s.flutterSdkPath ?? '');
      setSavedFlutterPath(s.flutterSdkPath ?? '');
      setAiProvider(s.aiProvider || 'gemini');
      setAiKeyConfigured(!!s.aiProviderApiKeyConfigured);
      setDeveloperMode(!!s.developerMode);
      setModel(s.apiModel || undefined);
      setImportStatus('');
      void loadAccount(s);
    });
    void window.peep.detectFlutterSdk().then((sdk) => setSdkVersion(sdk?.version ?? null));
    void window.peep.getTelemetryEnabled().then(setTelemetryEnabled);
    void window.peep.getVersion().then(setVersion);
    void window.peep.getUpdateStatus?.().then((info) => setUpdateInfo(info || { status: 'idle' }));
    void window.peep.getPerformanceInfo?.().then(setPerfInfo);
    return window.peep.onUpdateStatus?.((info) => setUpdateInfo(info));
  }, [open, loadAccount]);

  const handleClose = useCallback(() => {
    window.dispatchEvent(new CustomEvent('peep:settings-closed'));
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  if (!open) return null;

  /** Closes settings, then runs something that opens its own UI. */
  const closeThen = (fn: () => void) => {
    handleClose();
    setTimeout(fn, 0);
  };

  const handleAuthSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthBusy(true);
    setAuthError('');
    try {
      const res = authMode === 'signin' ? await window.peep.authSignIn(email, password) : await window.peep.authSignUp(email, password);
      if (!res.success) {
        setAuthError(res.error || 'Authentication failed');
      } else {
        setAuthMode(null);
        setEmail('');
        setPassword('');
        await loadAccount();
      }
    } catch (err) {
      setAuthError(ipcErrorMessage(err));
    } finally {
      setAuthBusy(false);
    }
  };

  const handleSignOut = async () => {
    await window.peep.authLogout();
    await loadAccount();
  };

  const handleSaveSdk = async () => {
    setSdkStatus('Saving…');
    try {
      await window.peep.setSettings({ flutterSdkPath: flutterPath.trim() || undefined });
      setSavedFlutterPath(flutterPath.trim());
      const sdk = await window.peep.detectFlutterSdk();
      setSdkVersion(sdk?.version ?? null);
      setSdkStatus(sdk?.version ? `Saved — Flutter ${sdk.version} detected.` : 'Saved — Flutter was not found at this location.');
    } catch (err) {
      setSdkStatus(ipcErrorMessage(err));
    }
  };

  const handleBrowseSdk = async () => {
    const folder = await window.peep.selectFolder();
    if (folder) setFlutterPath(folder);
  };

  const handleTelemetry = async (enabled: boolean) => {
    setTelemetryEnabled(enabled);
    await window.peep.setTelemetryEnabled(enabled);
  };

  const handleDeveloperMode = async (enabled: boolean) => {
    setDeveloperMode(enabled);
    await window.peep.setSettings({ developerMode: enabled });
  };

  const handleSaveLocalAi = async () => {
    setAiStatus('Saving…');
    try {
      await window.peep.setSettings(aiKey ? { aiProvider, aiProviderApiKey: aiKey } : { aiProvider });
      if (aiKey) {
        setAiKeyConfigured(true);
        setAiKey('');
      }
      setAiStatus('Saved.');
    } catch (err) {
      setAiStatus(ipcErrorMessage(err));
    }
  };

  const chooseModel = async (id: string | undefined) => {
    setModel(id);
    await window.peep.setSettings({ apiModel: id });
  };

  /** Brings over the VS Code settings Synkro supports, flipping only the ones that differ. */
  const handleImportVsCode = async () => {
    setImportStatus('Reading VS Code settings…');
    try {
      const result = await window.peep.readVsCodeSettings();
      if (!result.found) {
        setImportStatus(`VS Code settings were not found (${result.path}).`);
        return;
      }
      const applied: string[] = [];
      const apply = (value: boolean | undefined, commandId: string, label: string) => {
        if (value === undefined) return;
        if (!!getCommand(commandId)?.checked?.() !== value) runCommand(commandId);
        applied.push(`${label} ${value ? 'on' : 'off'}`);
      };
      apply(result.settings.autoSave, 'workbench.action.toggleAutoSave', 'Auto Save');
      apply(result.settings.wordWrap, 'editor.action.toggleWordWrap', 'Word Wrap');
      apply(result.settings.minimap, 'editor.action.toggleMinimap', 'Minimap');
      refresh();
      setImportStatus(
        applied.length > 0
          ? `Imported from VS Code: ${applied.join(', ')}.`
          : 'VS Code uses the defaults for Auto Save, Word Wrap and Minimap — nothing to change.',
      );
    } catch (err) {
      setImportStatus(`Could not import: ${ipcErrorMessage(err)}`);
    }
  };

  const signedIn = !!account;
  const plan = (account?.tier || account?.plan || 'free').toString();
  const isFreePlan = /^free( plan)?$/i.test(plan);
  const poolLimit = account?.weeklyPoolUsd ?? account?.limit ?? account?.budgetCost ?? 0;
  const poolUsed = account?.weeklyUsedUsd ?? account?.usage ?? account?.usedCost ?? 0;
  const poolPct = poolLimit > 0 ? Math.min(100, (poolUsed / poolLimit) * 100) : 0;
  const visibleSections: SectionId[] = query ? (Object.keys(SECTION_LABELS) as SectionId[]) : [section];

  /* ── Sections ── */

  const accountRow = accountLoading ? (
    <Row title="Atomvs Account" description="Loading account…" query={query} />
  ) : signedIn ? (
    <Row title="Atomvs Account" description={`Manage your account and billing · ${account!.email}`} query={query}>
      <button type="button" className="sx-btn" title="Opens the Atomvs website" onClick={() => openWebPage('account')}>Open ↗</button>
      <button type="button" className="sx-btn" onClick={() => void handleSignOut()}>Sign out</button>
    </Row>
  ) : (
    <Row title="Atomvs Account" description="Sign in to use the AI agent, chat and Tab completions." query={query}>
      <button type="button" className="sx-btn" onClick={() => setAuthMode('signup')}>Sign up</button>
      <button type="button" className="sx-btn sx-btn--primary" onClick={() => setAuthMode('signin')}>Sign in</button>
    </Row>
  );

  const upgradeRow = (
    <Row title="Upgrade to Pro" description="More weekly AI usage, unlimited Tab completions, and the most capable models." query={query}>
      <button type="button" className="sx-btn sx-btn--upgrade" title="Opens Atomvs pricing" onClick={() => openWebPage('pricing')}>↑ Upgrade</button>
    </Row>
  );

  const authForm = authMode && (
    <form className="sx-auth" onSubmit={handleAuthSubmit}>
      <div className="sx-auth__title">{authMode === 'signin' ? 'Sign in to Atomvs' : 'Create an Atomvs account'}</div>
      {authError && <div className="sx-error">{authError}</div>}
      <input className="sx-input" type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required disabled={authBusy} autoFocus />
      <input className="sx-input" type="password" placeholder="Password (8+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} disabled={authBusy} />
      <div className="sx-auth__actions">
        <button type="button" className="sx-btn" onClick={() => { setAuthMode(null); setAuthError(''); }} disabled={authBusy}>Cancel</button>
        <button type="submit" className="sx-btn sx-btn--primary" disabled={authBusy}>
          {authBusy ? 'Please wait…' : authMode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
      </div>
    </form>
  );

  const sections: Record<SectionId, ReactNode> = {
    general: (
      <>
        <Card>
          {accountRow}
          {authForm}
          {signedIn && isFreePlan && upgradeRow}
        </Card>
        <Card label="Preferences">
          <Row title="Editor Settings" description="Configure auto save, word wrap and the minimap" query={query}>
            <button type="button" className="sx-btn" onClick={() => setSection('editor')}>Open</button>
          </Row>
          <Row title="Keyboard Shortcuts" description="See every keyboard shortcut" query={query}>
            <button type="button" className="sx-btn" onClick={() => closeThen(() => runCommand('workbench.action.openGlobalKeybindings'))}>Open</button>
          </Row>
          <Row title="Command Palette" description="Search and run any command (Ctrl+Shift+P)" query={query}>
            <button type="button" className="sx-btn" onClick={() => closeThen(() => runCommand('workbench.action.showCommands'))}>Open</button>
          </Row>
          <Row title="Zoom" description="Make the whole interface larger or smaller" query={query}>
            <button type="button" className="sx-btn" title="Zoom Out (Ctrl+-)" onClick={() => runCommand('workbench.action.zoomOut')}>−</button>
            <button type="button" className="sx-btn" title="Reset Zoom (Ctrl+0)" onClick={() => runCommand('workbench.action.zoomReset')}>Reset</button>
            <button type="button" className="sx-btn" title="Zoom In (Ctrl+=)" onClick={() => runCommand('workbench.action.zoomIn')}>+</button>
          </Row>
          <Row title="Full Screen" description="Toggle full screen mode (F11)" query={query}>
            <button type="button" className="sx-btn" onClick={() => runCommand('workbench.action.toggleFullScreen')}>Toggle</button>
          </Row>
          <Row title="Import Settings from VS Code" description="Bring over your VS Code auto save, word wrap and minimap settings" query={query}>
            <button type="button" className="sx-btn" onClick={() => void handleImportVsCode()}>Import</button>
          </Row>
          {importStatus && <div className="sx-note">{importStatus}</div>}
        </Card>
        <Card label="Layout">
          <Row title="Primary Side Bar" description="Show the explorer, search and source control side bar (Ctrl+B)" query={query}>
            <CommandToggle id="workbench.action.toggleSidebarVisibility" onToggled={refresh} />
          </Row>
          <Row title="Chat" description="Show the AI chat pane (Ctrl+Alt+B)" query={query}>
            <CommandToggle id="peep.toggleChat" onToggled={refresh} />
          </Row>
          <Row title="Preview" description="Show the mobile preview pane" query={query}>
            <CommandToggle id="peep.togglePreview" onToggled={refresh} />
          </Row>
          <Row title="Bottom Panel" description="Show the terminal, problems and build panel (Ctrl+J)" query={query}>
            <CommandToggle id="workbench.action.togglePanel" onToggled={refresh} />
          </Row>
          <Row title="Status Bar" description="Show the status bar at the bottom of the window" query={query}>
            <CommandToggle id="workbench.action.toggleStatusbarVisibility" onToggled={refresh} />
          </Row>
        </Card>
      </>
    ),

    usage: (
      <Card>
        {!signedIn ? (
          <Row title="Not signed in" description="Sign in to see your plan and usage." query={query}>
            <button type="button" className="sx-btn sx-btn--primary" onClick={() => { setSection('general'); setAuthMode('signin'); }}>Sign in</button>
          </Row>
        ) : (
          <>
            <Row title="Current Plan" description={`You are on the ${plan.charAt(0).toUpperCase() + plan.slice(1)} plan.`} query={query}>
              <span className="sx-badge">{plan.toUpperCase()}</span>
            </Row>
            <Row
              title="Included Usage"
              description={account?.weekResetsAt ? `Refreshes weekly · next reset ${formatDate(account.weekResetsAt)}` : 'Usage is tracked and enforced by the Atomvs server.'}
              query={query}
            >
              <div className="sx-meter">
                <div className="sx-meter__text">${poolUsed.toFixed(2)} / ${poolLimit.toFixed(2)}</div>
                <div className="sx-meter__bar"><div className={`sx-meter__fill ${poolPct > 90 ? 'sx-meter__fill--warn' : ''}`} style={{ width: `${poolPct}%` }} /></div>
              </div>
            </Row>
            <Row
              title="Tab Completions"
              description={account?.monthlyCompletions === null ? 'Unlimited on your plan.' : account?.completionsResetAt ? `Resets ${formatDate(account.completionsResetAt)}` : 'Tab completions this month.'}
              query={query}
            >
              <span className="sx-value">
                {account?.monthlyCompletions === null
                  ? 'Unlimited'
                  : `${account?.completionsUsed ?? 0} / ${account?.monthlyCompletions ?? '—'}`}
              </span>
            </Row>
            {isFreePlan && upgradeRow}
            <Row title="Billing" description="Manage your subscription, payment method and invoices" query={query}>
              <button type="button" className="sx-btn" title="Opens the Atomvs website" onClick={() => openWebPage('billing')}>Open ↗</button>
            </Row>
            <Row title="Refresh" description="Fetch the latest usage from the server" query={query}>
              <button type="button" className="sx-btn" onClick={() => void loadAccount()} disabled={accountLoading}>
                {accountLoading ? 'Refreshing…' : 'Refresh'}
              </button>
            </Row>
          </>
        )}
      </Card>
    ),

    models: (
      <Card>
        {MODELS.map((m) => {
          // Choosing a model is a paid feature; Free plans always run on Auto (enforced by the server).
          const locked = (!signedIn || isFreePlan) && m.id !== undefined;
          const selected = locked ? false : (!signedIn || isFreePlan) ? m.id === undefined : model === m.id;
          return (
            <Row key={m.label} title={m.label} description={locked ? `${m.hint} · available on paid plans` : m.hint} query={query}>
              {locked ? (
                <button type="button" className="sx-btn" title="Opens Atomvs pricing" onClick={() => openWebPage('pricing')}>🔒 Upgrade</button>
              ) : (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`sx-radio ${selected ? 'sx-radio--on' : ''}`}
                  onClick={() => void chooseModel(m.id)}
                  title={`Use ${m.label}`}
                />
              )}
            </Row>
          );
        })}
        <div className="sx-note">
          {signedIn && !isFreePlan
            ? 'Also available from the model menu under the chat input.'
            : 'On the Free plan, Auto picks a fast model for each task. Upgrade to Pro to choose a model.'}
        </div>
      </Card>
    ),

    editor: (
      <Card>
        <Row title="Auto Save" description="Save files automatically shortly after you stop typing" query={query}>
          <CommandToggle id="workbench.action.toggleAutoSave" onToggled={refresh} />
        </Row>
        <Row title="Word Wrap" description="Wrap long lines to fit the editor width (Alt+Z)" query={query}>
          <CommandToggle id="editor.action.toggleWordWrap" onToggled={refresh} />
        </Row>
        <Row title="Minimap" description="Show the code overview on the right side of the editor" query={query}>
          <CommandToggle id="editor.action.toggleMinimap" onToggled={refresh} />
        </Row>
      </Card>
    ),

    tab: (
      <Card>
        <Row title="Atomvs Tab" description="AI suggestions as you type. Tab accepts, Esc dismisses, Ctrl+→ accepts word by word." query={query}>
          <CommandToggle id="peep.toggleAICompletions" onToggled={refresh} />
        </Row>
        <Row title="Trigger Suggestion" description="Ask for a suggestion at the cursor at any time with Alt+\" query={query} />
      </Card>
    ),

    rules: (
      <Card>
        <Row
          title="Project Rules"
          description={project ? 'Instructions the AI follows in this project (.synkro/rules.md)' : 'Open a project to edit its rules.'}
          query={query}
        >
          <button type="button" className="sx-btn" disabled={!project} onClick={() => closeThen(() => runCommand('synkro.openProjectRules'))}>Open</button>
        </Row>
      </Card>
    ),

    sdk: (
      <Card>
        <Row
          title="Flutter SDK"
          description={sdkVersion ? `Flutter ${sdkVersion} detected` : 'Flutter was not detected. Choose its folder, or leave empty to use PATH.'}
          query={query}
        >
          <span className={`sx-status ${sdkVersion ? 'sx-status--ok' : 'sx-status--warn'}`}>{sdkVersion ? 'Detected' : 'Not found'}</span>
        </Row>
        <Row title="Flutter SDK Path" description="Leave empty to auto-detect from PATH" query={query}>
          <input className="sx-input sx-input--wide" placeholder="C:\src\flutter" value={flutterPath} onChange={(e) => setFlutterPath(e.target.value)} />
          <button type="button" className="sx-btn" onClick={() => void handleBrowseSdk()}>Browse</button>
          <button type="button" className="sx-btn sx-btn--primary" disabled={flutterPath.trim() === savedFlutterPath} onClick={() => void handleSaveSdk()}>Save</button>
        </Row>
        {sdkStatus && <div className="sx-note">{sdkStatus}</div>}
      </Card>
    ),

    privacy: (
      <Card>
        <Row
          title="Anonymous Usage Data"
          description="Share feature usage and crash counts to help improve Atomvs. Never includes code, file names or personal data."
          query={query}
        >
          <Toggle checked={telemetryEnabled} onChange={(v) => void handleTelemetry(v)} />
        </Row>
      </Card>
    ),

    beta: (
      <>
        <Card>
          <Row title="Developer Mode" description="Use your own AI provider key instead of an Atomvs account" query={query}>
            <Toggle checked={developerMode} onChange={(v) => void handleDeveloperMode(v)} />
          </Row>
          <Row title="Developer Tools" description="Open Chromium developer tools for this window (Ctrl+Shift+I)" query={query}>
            <button type="button" className="sx-btn" onClick={() => runCommand('workbench.action.toggleDevTools')}>Toggle</button>
          </Row>
        </Card>
        {developerMode && (
          <Card label="Local AI Provider">
            <Row title="Provider" description="Only Google Gemini is supported for now" query={query}>
              <select className="sx-input" value={aiProvider} onChange={(e) => setAiProvider(e.target.value)}>
                <option value="gemini">Google Gemini</option>
              </select>
            </Row>
            <Row title="API Key" description="Encrypted and stored only on this device" query={query}>
              <input
                className="sx-input sx-input--wide"
                type="password"
                placeholder={aiKeyConfigured ? '•••••••• (configured)' : 'Paste API key'}
                value={aiKey}
                onChange={(e) => setAiKey(e.target.value)}
              />
              <button type="button" className="sx-btn sx-btn--primary" onClick={() => void handleSaveLocalAi()}>Save</button>
            </Row>
            {aiStatus && <div className="sx-note">{aiStatus}</div>}
          </Card>
        )}
      </>
    ),

    about: (
      <Card>
        <Row title="Version" description={`Atomvs ${version || '—'} · ${navigator.platform}`} query={query} />
        <Row
          title="Software Update"
          description={
            updateInfo.status === 'checking' ? 'Checking for updates…'
              : updateInfo.status === 'available' ? `Version ${updateInfo.version} is available — downloading…`
              : updateInfo.status === 'downloading' ? `Downloading update… ${updateInfo.percent ?? 0}%`
              : updateInfo.status === 'ready' ? `Version ${updateInfo.version} is ready to install.`
              : updateInfo.status === 'not-available' ? 'You are on the latest version.'
              : updateInfo.status === 'error' ? `Update failed: ${updateInfo.error}`
              : 'Check for a newer version of Atomvs.'
          }
          query={query}
        >
          {updateInfo.status === 'ready' ? (
            <button type="button" className="sx-btn sx-btn--primary" onClick={() => void window.peep.downloadAndInstall?.()}>Restart to Install</button>
          ) : (
            <button
              type="button"
              className="sx-btn"
              disabled={['checking', 'available', 'downloading'].includes(updateInfo.status)}
              onClick={() => void window.peep.checkForUpdates?.()}
            >
              Check for Updates
            </button>
          )}
        </Row>
        {perfInfo && (
          <Row title="Memory" description={`Heap ${perfInfo.heapUsedMB} MB · Resident ${perfInfo.rssMemMB} MB`} query={query} />
        )}
      </Card>
    ),
  };

  const initial = account?.email?.charAt(0).toUpperCase() ?? '?';

  return (
    <div className="sx-page" style={{ top: 35 }} role="dialog" aria-label="Atomvs Settings">
      <div className="sx-tabbar">
        <div className="sx-tab">
          <Icon name="settings" />
          <span>Atomvs Settings</span>
          <button type="button" className="sx-tab__close" title="Close (Esc)" onClick={handleClose}>×</button>
        </div>
      </div>

      <div className="sx-body">
        <aside className="sx-nav">
          <div className="sx-profile">
            <div className="sx-avatar">{initial}</div>
            <div className="sx-profile__text">
              <div className="sx-profile__email">{accountLoading ? 'Loading…' : account?.email ?? 'Not signed in'}</div>
              <div className="sx-profile__plan">{signedIn ? `${plan.charAt(0).toUpperCase() + plan.slice(1)} Plan` : 'Sign in to use AI'}</div>
            </div>
          </div>

          <input
            className="sx-search"
            placeholder="Search settings"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape' && search) { e.preventDefault(); setSearch(''); } }}
          />

          {NAV.map(({ group }, i) => (
            <div key={i} className="sx-nav__group">
              {group.map((id) => (
                <button
                  key={id}
                  type="button"
                  className={`sx-nav__item ${!query && section === id ? 'sx-nav__item--active' : ''}`}
                  onClick={() => { setSearch(''); setSection(id); }}
                >
                  <Icon name={id} />
                  {SECTION_LABELS[id]}
                </button>
              ))}
            </div>
          ))}

          <div className="sx-nav__group">
            <button type="button" className="sx-nav__item" title="Opens the Atomvs docs" onClick={() => openWebPage('docs')}>
              <Icon name="rules" />
              Docs ↗
            </button>
          </div>
          {signedIn && isFreePlan && (
            <button type="button" className="sx-nav__upgrade" onClick={() => openWebPage('pricing')}>
              <Icon name="usage" />
              Upgrade to Pro
            </button>
          )}
        </aside>

        <main className="sx-content">
          <div className="sx-content__inner">
            {visibleSections.map((id) => (
              <section key={id} className="sx-section">
                <h2 className="sx-section__title">{SECTION_LABELS[id]}</h2>
                {sections[id]}
              </section>
            ))}
            {query && <div className="sx-empty">No settings match “{search}”.</div>}
          </div>
        </main>
      </div>
    </div>
  );
}
