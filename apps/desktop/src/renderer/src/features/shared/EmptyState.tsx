import { useI18n } from '../../i18n';
import './EmptyState.css';
import { useState } from 'react';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useWorkspace } from '../../hooks/useWorkspace';
import { openWebPage } from '../../config/web';

/* ── Generic preset ─────────────────────────────────────────────────── */

interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  action?: { label: string; onClick: () => void };
  secondaryAction?: { label: string; onClick: () => void };
  hint?: string;
}

export function EmptyState({ icon, title, description, action, secondaryAction, hint }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon">{icon}</div>
      <h3 className="empty-state__title">{title}</h3>
      <p className="empty-state__desc">{description}</p>
      {(action || secondaryAction) && (
        <div className="empty-state__actions">
          {action && (
            <button className="empty-state__btn primary" onClick={action.onClick}>
              {action.label}
            </button>
          )}
          {secondaryAction && (
            <button className="empty-state__btn secondary" onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </button>
          )}
        </div>
      )}
      {hint && <p className="empty-state__hint">{hint}</p>}
    </div>
  );
}

/* ── Synkro-style "No Project" welcome screen ─────────────────── */

import { useAuthStore } from '../../stores/auth-store';

export function NoProjectEmptyState({
  onOpen,
  onNew,
}: {
  onOpen: () => void;
  onNew: () => void;
}) {
  const { t } = useI18n();
  const { user } = useAuthStore();
  const recentProjects = useWorkspaceStore((s) => s.recentProjects);
  const { openProjectByPath } = useWorkspace();
  const [showAllRecent, setShowAllRecent] = useState(false);

  return (
    <div className="synkro-empty-state">
      <div className="synkro-hero">
        
        {/* Brand Header */}
        <div className="synkro-brand-header">
          <div className="synkro-logo-title-row">
            <svg 
              width="42" 
              height="42" 
              viewBox="0 0 32 32" 
              fill="none"
              className="synkro-logo"
            >
              <circle cx="16" cy="16" r="15" fill="#1e1e26" />
              <g stroke="#93c5fd" strokeWidth="1.5" fill="none" strokeLinecap="round">
                <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(0 16 16)" />
                <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(60 16 16)" />
                <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(120 16 16)" />
              </g>
              <circle cx="16" cy="16" r="1.5" fill="#93c5fd" />
              <circle cx="16" cy="5.5" r="2" fill="#93c5fd" />
              <circle cx="6.9" cy="21.25" r="2" fill="#93c5fd" />
              <circle cx="25.1" cy="21.25" r="2" fill="#93c5fd" />
            </svg>
            <h1 className="synkro-title">ATOMVS</h1>
          </div>
          {user && (
            <div className="synkro-subtitle" style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-muted)', marginTop: '4px' }}>
              <span style={{ fontSize: '10px', background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: '10px', color: '#a78bfa', fontWeight: 'bold' }}>
                {((user.plan || user.tier) ?? t('welcome.freePlan')).toUpperCase()}
              </span>
              <span className="synkro-dot">•</span>
              <span style={{ fontSize: '12px' }}>{user.email}</span>
              <span className="synkro-dot">•</span>
              <a href="#" onClick={(e) => { e.preventDefault(); openWebPage('pricing'); }} className="synkro-link" style={{ color: '#60a5fa', textDecoration: 'underline' }}>{t('welcome.upgrade')}</a>
            </div>
          )}
        </div>

        {/* Action Cards */}
        <div className="synkro-actions">
          <button className="synkro-action-card" onClick={onOpen}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span>{t('welcome.openProject')}</span>
          </button>
          
          <button className="synkro-action-card" onClick={onNew}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>{t('welcome.newProject')}</span>
          </button>

          <button className="synkro-action-card" onClick={() => window.dispatchEvent(new CustomEvent('peep:clone-repo'))}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span>{t('welcome.cloneRepo')}</span>
          </button>
          
          <button className="synkro-action-card" onClick={() => window.dispatchEvent(new CustomEvent('peep:ssh-connect'))}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <polyline points="4 17 10 11 4 5"></polyline>
              <line x1="12" y1="19" x2="20" y2="19"></line>
            </svg>
            <span>{t('welcome.connectSsh')}</span>
          </button>
        </div>

        {/* Recent Projects List */}
        <div className="synkro-recent-section">
          <div className="synkro-recent-header">
            <h3>{t('welcome.recentProjects')}</h3>
            {recentProjects.length > 5 && (
              <button className="synkro-view-all" onClick={() => setShowAllRecent(!showAllRecent)}>
                {showAllRecent ? t('welcome.showLess') : t('welcome.viewAll', { count: recentProjects.length })}
              </button>
            )}
          </div>
          
          <div className="synkro-recent-list">
            {recentProjects.length === 0 && (
              <div className="synkro-recent-item empty">{t('welcome.noRecentProjects')}</div>
            )}
            {(showAllRecent ? recentProjects : recentProjects.slice(0, 5)).map((p) => (
              <button
                key={p.id}
                className="synkro-recent-item"
                title={p.path}
                onClick={() => void openProjectByPath(p.path)}
              >
                <span className="synkro-recent-name" dir="ltr">{p.name}</span>
                <span className="synkro-recent-path" dir="ltr">{p.path}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Bottom Banner */}
        <div className="synkro-bottom-banner">
          <button onClick={() => void window.peep.newWindow()} className="synkro-banner-link" style={{ background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: 'inherit' }}>
            {t('welcome.tryNewWindow')} ↗
          </button>
        </div>

      </div>
    </div>
  );
}

export function NoFileOpenEmptyState() {
  const { t } = useI18n();
  return (
    <div className="synkro-empty-state" style={{ 
      display: 'flex', flexDirection: 'column', alignItems: 'center', 
      justifyContent: 'center', height: '100%', width: '100%' 
    }}>
      <div style={{ opacity: 0.15, marginBottom: '30px' }}>
        <svg width="64" height="64" viewBox="0 0 32 32" fill="none">
          <circle cx="16" cy="16" r="15" fill="#1e1e26" />
          <g stroke="#93c5fd" strokeWidth="1.5" fill="none" strokeLinecap="round">
            <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(0 16 16)" />
            <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(60 16 16)" />
            <ellipse cx="16" cy="16" rx="5" ry="10.5" transform="rotate(120 16 16)" />
          </g>
          <circle cx="16" cy="16" r="1.5" fill="#93c5fd" />
          <circle cx="16" cy="5.5" r="2" fill="#93c5fd" />
          <circle cx="6.9" cy="21.25" r="2" fill="#93c5fd" />
          <circle cx="25.1" cy="21.25" r="2" fill="#93c5fd" />
        </svg>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {[
          { key: 'newAgent', label: t('emptyState.newAgent'), shortcut: 'Ctrl + Shift + L' },
          { key: 'hideTerminal', label: t('emptyState.hideTerminal'), shortcut: 'Ctrl + `' },
          { key: 'searchFiles', label: t('emptyState.searchFiles'), shortcut: 'Ctrl + P' },
          { key: 'openBrowser', label: t('emptyState.openBrowser'), shortcut: 'Ctrl + Shift + B' },
          { key: 'maximizeChat', label: t('emptyState.maximizeChat'), shortcut: 'Ctrl + Alt + E' },
        ].map(item => (
          <div key={item.key} style={{ 
            display: 'flex', justifyContent: 'space-between', 
            width: '280px', fontSize: '13px', color: 'var(--text-muted)' 
          }}>
            <span>{item.label}</span>
            <span dir="ltr" style={{ opacity: 0.7 }}>{item.shortcut}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function NoApiKeyEmptyState({ onSettings }: { onSettings: () => void }) {
  return (
    <EmptyState
      icon="🔑"
      title="API key not configured"
      description="Add your OpenAI or Anthropic API key to start chatting with the AI agent."
      action={{ label: '⚙ Open Settings', onClick: onSettings }}
      hint="Your key is stored locally and never leaves your machine."
    />
  );
}

export function PreviewErrorEmptyState({
  message,
  onRetry,
}: {
  message: string;
  onRetry?: () => void;
}) {
  return (
    <EmptyState
      icon="⚠️"
      title="Preview unavailable"
      description={message}
      action={onRetry ? { label: '↺ Retry', onClick: onRetry } : undefined}
      hint="Make sure Flutter SDK is installed and the project has no syntax errors."
    />
  );
}
