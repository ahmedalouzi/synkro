import { useWorkspaceStore } from '../stores/workspace-store';

export function ActivityBar() {
  const sidebarView = useWorkspaceStore((s) => s.sidebarView);
  const setSidebarView = useWorkspaceStore((s) => s.setSidebarView);

  return (
    <div className="activity-bar">
      <div className={`activity-icon ${sidebarView === 'explorer' ? 'active' : ''}`} title="Explorer" onClick={() => setSidebarView('explorer')}>
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15.5 2H8.6c-.4 0-.8.2-1.1.5-.3.3-.5.7-.5 1.1v12.8c0 .4.2.8.5 1.1.3.3.7.5 1.1.5h9.8c.4 0 .8-.2 1.1-.5.3-.3.5-.7.5-1.1V6.5L15.5 2z"/>
          <path d="M3 7.6v12.8c0 .4.2.8.5 1.1.3.3.7.5 1.1.5h9.8"/>
          <path d="M15 2v5h5"/>
        </svg>
      </div>
      <div className="activity-icon" title="Search" onClick={() => { setSidebarView('search'); if (!useWorkspaceStore.getState().sidebarOpen) useWorkspaceStore.getState().toggleSidebar(); }}>
        <svg className="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
      </div>
      <div className={`activity-icon ${sidebarView === 'git' ? 'active' : ''}`} title="Source Control" onClick={() => setSidebarView('git')}>
        <svg className="icon" viewBox="0 0 24 24"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v1a2 2 0 0 0 2 2h8a2 2 0 0 1 2 2v1"/></svg>
      </div>
      <div className="activity-icon" title="Run & Debug" onClick={() => void window.peep.reloadPreview?.()}>
        <svg className="icon" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
      </div>
      <div className={`activity-icon ${sidebarView === 'extensions' ? 'active' : ''}`} title="Extensions" onClick={() => setSidebarView('extensions')}>
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="4" width="7" height="7" />
          <rect x="4" y="13" width="7" height="7" />
          <rect x="13" y="13" width="7" height="7" />
          <polygon points="17 3 21 7 17 11 13 7" />
        </svg>
      </div>
      <div className="activity-icon" title="AI Assistant" onClick={() => useWorkspaceStore.getState().toggleAgentPane()}>
        <svg className="icon" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
      </div>
      <div className="activity-icon" title="Publish Application" onClick={() => window.dispatchEvent(new CustomEvent('peep:open-publish'))}>
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.5 16.5c-1.5 1.25-2.5 3.5-2.5 3.5s2.25-1 3.5-2.5"/>
          <path d="M12 15c-1.5-1.5-2.5-3-2.5-3L2 19.5l7.5-7.5s1.5 1 2.5 2.5z"/>
          <path d="M13.5 10.5c.75.75 1.5 2.5 1.5 2.5L22 6.5l-7-7-6 6s1.75 1.5 2.5 2.5z"/>
        </svg>
      </div>

      <div className="activity-spacer"></div>
      
      <div className="activity-bottom">
        <div className="activity-icon" title="Settings" onClick={() => { if (window.peep?.openSettingsWindow) { void window.peep.openSettingsWindow(); } else { window.dispatchEvent(new CustomEvent('peep:open-settings')); } }}>
          <svg className="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
        </div>
      </div>
    </div>
  );
}
