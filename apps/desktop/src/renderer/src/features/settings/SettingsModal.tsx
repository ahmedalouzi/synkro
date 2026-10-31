import { useCallback, useEffect, useReducer, useState, type ReactNode } from 'react';
import type { Settings } from '@peep/shared';
import { useI18n, SUPPORTED_LOCALES } from '../../i18n';
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
  standalone?: boolean;
}

export function SettingsModal({ open, onClose, initialSection, standalone }: SettingsModalProps) {
  const project = useWorkspaceStore((s) => s.project);
  const { locale, setLocale, t } = useI18n();
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
    <Row title={t('settings.account.title')} description={t('settings.account.loading')} query={query} />
  ) : signedIn ? (
    <Row title={t('settings.account.title')} description={t('settings.account.manageDesc', { email: account!.email })} query={query}>
      <button type="button" className="sx-btn" title={t('settings.account.openSiteTooltip')} onClick={() => openWebPage('account')}>{t('settings.account.open')}</button>
      <button type="button" className="sx-btn" onClick={() => void handleSignOut()}>{t('settings.account.signOut')}</button>
    </Row>
  ) : (
    <Row title={t('settings.account.title')} description={t('settings.account.signInDesc')} query={query}>
      <button type="button" className="sx-btn" onClick={() => setAuthMode('signup')}>{t('settings.account.signUp')}</button>
      <button type="button" className="sx-btn sx-btn--primary" onClick={() => setAuthMode('signin')}>{t('settings.account.signIn')}</button>
    </Row>
  );

  const upgradeRow = (
    <Row title={t('settings.upgrade.title')} description={t('settings.upgrade.desc')} query={query}>
      <button type="button" className="sx-btn sx-btn--upgrade" title={t('settings.upgrade.pricingTooltip')} onClick={() => openWebPage('pricing')}>{t('settings.upgrade.btn')}</button>
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
        <Card label={t('settings.preferences')}>
          <Row title={t('settings.language')} description={t('settings.languageDesc')} query={query}>
            <div className="sx-lang-picker" style={{ display: 'inline-flex', gap: '4px' }}>
              {SUPPORTED_LOCALES.map((item) => (
                <button
                  key={item.code}
                  type="button"
                  className={`sx-btn ${locale === item.code ? 'sx-btn--primary' : ''}`}
                  onClick={() => setLocale(item.code)}
                >
                  {item.nativeName}
                </button>
              ))}
            </div>
          </Row>
          <Row title={t('settings.general.editorSettings')} description={t('settings.general.editorSettingsDesc')} query={query}>
            <button type="button" className="sx-btn" onClick={() => setSection('editor')}>{t('settings.general.open')}</button>
          </Row>
          <Row title={t('settings.general.keyboardShortcuts')} description={t('settings.general.keyboardShortcutsDesc')} query={query}>
            <button type="button" className="sx-btn" onClick={() => closeThen(() => runCommand('workbench.action.openGlobalKeybindings'))}>{t('settings.general.open')}</button>
          </Row>
          <Row title={t('settings.general.commandPalette')} description={t('settings.general.commandPaletteDesc')} query={query}>
            <button type="button" className="sx-btn" onClick={() => closeThen(() => runCommand('workbench.action.showCommands'))}>{t('settings.general.open')}</button>
          </Row>
          <Row title={t('settings.general.zoom')} description={t('settings.general.zoomDesc')} query={query}>
            <button type="button" className="sx-btn" title={t('settings.general.zoomOut')} onClick={() => runCommand('workbench.action.zoomOut')}>−</button>
            <button type="button" className="sx-btn" title={t('settings.general.zoomReset')} onClick={() => runCommand('workbench.action.zoomReset')}>{t('settings.general.reset')}</button>
            <button type="button" className="sx-btn" title={t('settings.general.zoomIn')} onClick={() => runCommand('workbench.action.zoomIn')}>+</button>
          </Row>
          <Row title={t('settings.general.fullScreen')} description={t('settings.general.fullScreenDesc')} query={query}>
            <button type="button" className="sx-btn" onClick={() => runCommand('workbench.action.toggleFullScreen')}>{t('settings.general.toggle')}</button>
          </Row>
          <Row title={t('settings.general.importVsCode')} description={t('settings.general.importVsCodeDesc')} query={query}>
            <button type="button" className="sx-btn" onClick={() => void handleImportVsCode()}>{t('settings.general.import')}</button>
          </Row>
          {importStatus && <div className="sx-note">{importStatus}</div>}
        </Card>
        <Card label={t('settings.general.layout')}>
          <Row title={t('settings.general.primarySidebar')} description={t('settings.general.primarySidebarDesc')} query={query}>
            <CommandToggle id="workbench.action.toggleSidebarVisibility" onToggled={refresh} />
          </Row>
          <Row title={t('settings.general.chat')} description={t('settings.general.chatDesc')} query={query}>
            <CommandToggle id="peep.toggleChat" onToggled={refresh} />
          </Row>
          <Row title={t('settings.general.preview')} description={t('settings.general.previewDesc')} query={query}>
            <CommandToggle id="peep.togglePreview" onToggled={refresh} />
          </Row>
          <Row title={t('settings.general.bottomPanel')} description={t('settings.general.bottomPanelDesc')} query={query}>
            <CommandToggle id="workbench.action.togglePanel" onToggled={refresh} />
          </Row>
          <Row title={t('settings.general.statusBar')} description={t('settings.general.statusBarDesc')} query={query}>
            <CommandToggle id="workbench.action.toggleStatusbarVisibility" onToggled={refresh} />
          </Row>
        </Card>
      </>
    ),

    usage: (
      <Card>
        {!signedIn ? (
          <Row title={t('settings.usage.notSignedInTitle')} description={t('settings.usage.notSignedInDesc')} query={query}>
            <button type="button" className="sx-btn sx-btn--primary" onClick={() => { setSection('general'); setAuthMode('signin'); }}>{t('settings.account.signIn')}</button>
          </Row>
        ) : (
          <>
            <Row title={t('settings.usage.currentPlan')} description={t('settings.usage.currentPlanDesc', { plan: plan.charAt(0).toUpperCase() + plan.slice(1) })} query={query}>
              <span className="sx-badge">{plan.toUpperCase()}</span>
            </Row>
            <Row
              title={t('settings.usage.includedUsage')}
              description={account?.weekResetsAt ? t('settings.usage.refreshesWeekly', { date: formatDate(account.weekResetsAt) }) : t('settings.usage.usageServerTracked')}
              query={query}
            >
              <div className="sx-meter">
                <div className="sx-meter__text">${poolUsed.toFixed(2)} / ${poolLimit.toFixed(2)}</div>
                <div className="sx-meter__bar"><div className={`sx-meter__fill ${poolPct > 90 ? 'sx-meter__fill--warn' : ''}`} style={{ width: `${poolPct}%` }} /></div>
              </div>
            </Row>
            <Row
              title={t('settings.usage.tabCompletions')}
              description={account?.monthlyCompletions === null ? t('settings.usage.unlimitedOnPlan') : account?.completionsResetAt ? t('settings.usage.resetsDate', { date: formatDate(account.completionsResetAt) }) : t('settings.usage.tabThisMonth')}
              query={query}
            >
              <span className="sx-value">
                {account?.monthlyCompletions === null
                  ? t('settings.usage.unlimited')
                  : `${account?.completionsUsed ?? 0} / ${account?.monthlyCompletions ?? '—'}`}
              </span>
            </Row>
            {isFreePlan && upgradeRow}
            <Row title={t('settings.usage.billing')} description={t('settings.usage.billingDesc')} query={query}>
              <button type="button" className="sx-btn" title={t('settings.account.openSiteTooltip')} onClick={() => openWebPage('billing')}>{t('settings.account.open')}</button>
            </Row>
            <Row title={t('settings.usage.refresh')} description={t('settings.usage.refreshDesc')} query={query}>
              <button type="button" className="sx-btn" onClick={() => void loadAccount()} disabled={accountLoading}>
                {accountLoading ? t('settings.usage.refreshing') : t('settings.usage.refresh')}
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
            <Row key={m.label} title={m.label} description={locked ? `${m.hint} · ${t('settings.models.availableOnPaid')}` : m.hint} query={query}>
              {locked ? (
                <button type="button" className="sx-btn" title={t('settings.upgrade.pricingTooltip')} onClick={() => openWebPage('pricing')}>{t('settings.models.upgrade')}</button>
              ) : (
                <button
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`sx-radio ${selected ? 'sx-radio--on' : ''}`}
                  onClick={() => void chooseModel(m.id)}
                  title={t('settings.models.useModel', { model: m.label })}
                />
              )}
            </Row>
          );
        })}
        <div className="sx-note">
          {signedIn && !isFreePlan ? t('settings.models.paidNote') : t('settings.models.freeNote')}
        </div>
      </Card>
    ),

    editor: (
      <Card>
        <Row title={t('settings.editor.autoSave')} description={t('settings.editor.autoSaveDesc')} query={query}>
          <CommandToggle id="workbench.action.toggleAutoSave" onToggled={refresh} />
        </Row>
        <Row title={t('settings.editor.wordWrap')} description={t('settings.editor.wordWrapDesc')} query={query}>
          <CommandToggle id="editor.action.toggleWordWrap" onToggled={refresh} />
        </Row>
        <Row title={t('settings.editor.minimap')} description={t('settings.editor.minimapDesc')} query={query}>
          <CommandToggle id="editor.action.toggleMinimap" onToggled={refresh} />
        </Row>
      </Card>
    ),

    tab: (
      <Card>
        <Row title={t('settings.tab.title')} description={t('settings.tab.desc')} query={query}>
          <CommandToggle id="peep.toggleAICompletions" onToggled={refresh} />
        </Row>
        <Row title={t('settings.tab.trigger')} description={t('settings.tab.triggerDesc')} query={query} />
      </Card>
    ),

    rules: (
      <Card>
        <Row
          title={t('settings.rules.title')}
          description={project ? t('settings.rules.descWithProject') : t('settings.rules.descNoProject')}
          query={query}
        >
          <button type="button" className="sx-btn" disabled={!project} onClick={() => closeThen(() => runCommand('synkro.openProjectRules'))}>{t('settings.general.open')}</button>
        </Row>
      </Card>
    ),

    sdk: (
      <Card>
        <Row
          title={t('settings.sdk.title')}
          description={sdkVersion ? t('settings.sdk.detectedDesc', { version: sdkVersion }) : t('settings.sdk.notDetectedDesc')}
          query={query}
        >
          <span className={`sx-status ${sdkVersion ? 'sx-status--ok' : 'sx-status--warn'}`}>{sdkVersion ? t('settings.sdk.detected') : t('settings.sdk.notFound')}</span>
        </Row>
        <Row title={t('settings.sdk.pathTitle')} description={t('settings.sdk.pathDesc')} query={query}>
          <input className="sx-input sx-input--wide" placeholder="C:\src\flutter" value={flutterPath} onChange={(e) => setFlutterPath(e.target.value)} />
          <button type="button" className="sx-btn" onClick={() => void handleBrowseSdk()}>{t('settings.sdk.browse')}</button>
          <button type="button" className="sx-btn sx-btn--primary" disabled={flutterPath.trim() === savedFlutterPath} onClick={() => void handleSaveSdk()}>{t('settings.sdk.save')}</button>
        </Row>
        {sdkStatus && <div className="sx-note">{sdkStatus}</div>}
      </Card>
    ),

    privacy: (
      <Card>
        <Row
          title={t('settings.privacy.title')}
          description={t('settings.privacy.desc')}
          query={query}
        >
          <Toggle checked={telemetryEnabled} onChange={(v) => void handleTelemetry(v)} />
        </Row>
      </Card>
    ),

    beta: (
      <>
        <Card>
          <Row title={t('settings.beta.devMode')} description={t('settings.beta.devModeDesc')} query={query}>
            <Toggle checked={developerMode} onChange={(v) => void handleDeveloperMode(v)} />
          </Row>
          <Row title={t('settings.beta.devTools')} description={t('settings.beta.devToolsDesc')} query={query}>
            <button type="button" className="sx-btn" onClick={() => runCommand('workbench.action.toggleDevTools')}>{t('settings.general.toggle')}</button>
          </Row>
        </Card>
        {developerMode && (
          <Card label={t('settings.beta.localAiProvider')}>
            <Row title={t('settings.beta.provider')} description={t('settings.beta.providerDesc')} query={query}>
              <select className="sx-input" value={aiProvider} onChange={(e) => setAiProvider(e.target.value)}>
                <option value="gemini">Google Gemini</option>
              </select>
            </Row>
            <Row title={t('settings.beta.apiKey')} description={t('settings.beta.apiKeyDesc')} query={query}>
              <input
                className="sx-input sx-input--wide"
                type="password"
                placeholder={aiKeyConfigured ? t('settings.beta.configured') : t('settings.beta.pasteApiKey')}
                value={aiKey}
                onChange={(e) => setAiKey(e.target.value)}
              />
              <button type="button" className="sx-btn sx-btn--primary" onClick={() => void handleSaveLocalAi()}>{t('settings.sdk.save')}</button>
            </Row>
            {aiStatus && <div className="sx-note">{aiStatus}</div>}
          </Card>
        )}
      </>
    ),

    about: (
      <Card>
        <Row title={t('settings.about.version')} description={`Atomvs ${version || '—'} · ${navigator.platform}`} query={query} />
        <Row
          title={t('settings.about.softwareUpdate')}
          description={
            updateInfo.status === 'checking' ? t('settings.about.checking')
              : updateInfo.status === 'available' ? t('settings.about.available', { version: updateInfo.version })
              : updateInfo.status === 'downloading' ? t('settings.about.downloading', { percent: updateInfo.percent ?? 0 })
              : updateInfo.status === 'ready' ? t('settings.about.ready', { version: updateInfo.version })
              : updateInfo.status === 'not-available' ? t('settings.about.notAvailable')
              : updateInfo.status === 'error' ? t('settings.about.error', { error: updateInfo.error })
              : t('settings.about.checkDesc')
          }
          query={query}
        >
          {updateInfo.status === 'ready' ? (
            <button type="button" className="sx-btn sx-btn--primary" onClick={() => void window.peep.downloadAndInstall?.()}>{t('settings.about.restartToInstall')}</button>
          ) : (
            <button
              type="button"
              className="sx-btn"
              disabled={['checking', 'available', 'downloading'].includes(updateInfo.status)}
              onClick={() => void window.peep.checkForUpdates?.()}
            >
              {t('settings.about.checkForUpdates')}
            </button>
          )}
        </Row>
        {perfInfo && (
          <Row title={t('settings.about.memory')} description={t('settings.about.memoryDesc', { heap: perfInfo.heapUsedMB, rss: perfInfo.rssMemMB })} query={query} />
        )}
      </Card>
    ),
  };

  const initial = account?.email?.charAt(0).toUpperCase() ?? '?';

  return (
    <div className="sx-page" style={standalone ? { top: 0, height: '100%', position: 'absolute' } : { top: 35 }} role="dialog" aria-label={t('settings.modalTitle')}>
      {!standalone && (
        <div className="sx-tabbar">
          <div className="sx-tab">
            <Icon name="settings" />
            <span>{t('settings.modalTitle')}</span>
            <button type="button" className="sx-tab__close" title="Close (Esc)" onClick={handleClose}>×</button>
          </div>
        </div>
      )}

      <div className="sx-body">
        <aside className="sx-nav">
          <div className="sx-profile">
            <div className="sx-avatar">{initial}</div>
            <div className="sx-profile__text">
              <div className="sx-profile__email">{accountLoading ? t('settings.account.loading') : account?.email ?? t('settings.notSignedIn')}</div>
              <div className="sx-profile__plan">{signedIn ? t('settings.planSuffix', { plan: plan.charAt(0).toUpperCase() + plan.slice(1) }) : t('settings.signInToUseAi')}</div>
            </div>
          </div>

          <input
            className="sx-search"
            placeholder={t('settings.searchPlaceholder')}
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
                  {t(`settings.sections.${id}`)}
                </button>
              ))}
            </div>
          ))}

          <div className="sx-nav__group">
            <button type="button" className="sx-nav__item" title="Opens the Atomvs docs" onClick={() => openWebPage('docs')}>
              <Icon name="rules" />
              {t('settings.docs')}
            </button>
          </div>
          {signedIn && isFreePlan && (
            <button type="button" className="sx-nav__upgrade" onClick={() => openWebPage('pricing')}>
              <Icon name="usage" />
              {t('settings.upgradeToPro')}
            </button>
          )}
        </aside>

        <main className="sx-content">
          <div className="sx-content__inner">
            {visibleSections.map((id) => (
              <section key={id} className="sx-section">
                <h2 className="sx-section__title">{t(`settings.sections.${id}`)}</h2>
                {sections[id]}
              </section>
            ))}
            {query && <div className="sx-empty">{t('settings.noMatch', { search })}</div>}
          </div>
        </main>
      </div>
    </div>
  );
}
