import { useState, useRef, useEffect } from 'react';
import { useWorkspaceStore } from '../stores/workspace-store';
import { usePreviewStore } from '../stores/preview-store';
import { useWorkspace } from '../hooks/useWorkspace';
import { useAuthStore } from '../stores/auth-store';
import { DEVICES } from './PreviewPane';
import { buildApk, getCommand, isCommandEnabled, runCommand } from '../commands/commands';
import { MenuBar } from './MenuBar';
import { useBuildStore } from '../stores/build-store';
import { openWebPage } from '../config/web';
import './TitleBar.css';

/**
 * Single-row title bar like Cursor/VS Code: logo + menus, navigation, a search box in the
 * middle, layout toggles and account on the right. The window is frameless; Windows/Linux
 * draw their native window buttons over the right edge (see titleBarOverlay in main).
 */

const IS_MAC = navigator.userAgent.includes('Mac');

const openSettings = (section?: string) =>
  window.dispatchEvent(new CustomEvent('peep:open-settings', { detail: section ? { section } : undefined }));

function Icon({ d, size = 15 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={d} />
    </svg>
  );
}

const ICON = {
  sidebar: 'M3 4h18v16H3zM9 4v16',
  back: 'M15 18l-6-6 6-6',
  forward: 'M9 18l6-6-6-6',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM21 21l-4.35-4.35',
  panel: 'M3 4h18v16H3zM3 15h18',
  phone: 'M7 2h10a1 1 0 0 1 1 1v18a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM11 18h2',
  chat: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  check: 'M20 6 9 17l-5-5',
};

/** A title-bar button that runs a registry command and reflects its enabled state. */
function CommandButton({ id, icon, title }: { id: string; icon: string; title: string }) {
  const cmd = getCommand(id);
  const enabled = !!cmd && isCommandEnabled(cmd);
  return (
    <button type="button" className="tb-btn" title={title} disabled={!enabled} onClick={() => runCommand(id)}>
      <Icon d={icon} />
    </button>
  );
}

export function TitleBar() {
  const { project } = useWorkspace();
  const { user, settings, logout } = useAuthStore();
  const currentBuild = useBuildStore((s) => s.currentBuild);
  // Re-render when the editor navigation history or layout changes.
  useWorkspaceStore((s) => s.activeFilePath);
  const sidebarOpen = useWorkspaceStore((s) => (s.project ? s.sidebarOpen : s.homeSidebarOpen));
  const bottomPanelOpen = useWorkspaceStore((s) => s.bottomPanelOpen);
  const previewPaneOpen = useWorkspaceStore((s) => s.previewPaneOpen);
  const agentPaneOpen = useWorkspaceStore((s) => s.agentPaneOpen);
  const deviceId = usePreviewStore((s) => s.deviceId);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setActiveMenu(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const toggleMenu = (menu: string) => setActiveMenu(activeMenu === menu ? null : menu);
  const handleMenuClick = (action: () => void) => {
    action();
    setActiveMenu(null);
  };

  const plan = (user?.tier || user?.plan || 'free').toString();
  const isFreePlan = plan.toLowerCase() === 'free' || plan.toLowerCase() === 'free plan';
  const canBuild = !!project && ['flutter', 'react-native', 'react-native-local', 'expo'].includes(project.platform as string);
  const isBuildActive = currentBuild?.status === 'queued' || currentBuild?.status === 'running';

  const openSearch = () => runCommand(project ? 'workbench.action.quickOpen' : 'workbench.action.showCommands');

  return (
    <div className={`topbar ${IS_MAC ? 'topbar--mac' : 'topbar--win'}`} ref={menuRef}>
      {/* ── Left: logo, menus, navigation ── */}
      <div className="topbar__left">
        {!IS_MAC && (
          <svg className="topbar__logo" width="16" height="16" viewBox="0 0 32 32" fill="none" aria-label="Synkro">
            <g stroke="currentColor" strokeWidth="2.4" fill="none" strokeLinecap="round">
              <ellipse cx="16" cy="16" rx="5" ry="11" />
              <ellipse cx="16" cy="16" rx="5" ry="11" transform="rotate(60 16 16)" />
              <ellipse cx="16" cy="16" rx="5" ry="11" transform="rotate(120 16 16)" />
            </g>
          </svg>
        )}
        <MenuBar />
        <div className="topbar__nav">
          <button
            type="button"
            className={`tb-btn ${sidebarOpen ? 'tb-btn--on' : ''}`}
            title="Toggle Primary Side Bar (Ctrl+B)"
            onClick={() => runCommand('workbench.action.toggleSidebarVisibility')}
          >
            <Icon d={ICON.sidebar} />
          </button>
          <CommandButton id="workbench.action.navigateBack" icon={ICON.back} title="Go Back (Alt+Left)" />
          <CommandButton id="workbench.action.navigateForward" icon={ICON.forward} title="Go Forward (Alt+Right)" />
        </div>
      </div>

      {/* ── Center: search ── */}
      <button type="button" className="topbar__search" onClick={openSearch} title={project ? 'Go to File (Ctrl+P)' : 'Command Palette (Ctrl+Shift+P)'}>
        <Icon d={ICON.search} size={13} />
        <span>{project ? project.name : 'Search'}</span>
      </button>

      {/* ── Right: build, layout, settings, account ── */}
      <div className="topbar__right">
        {settings?.isDevBypassActive && <span className="topbar__dev" title="Development authentication bypass is active">Dev</span>}

        {user && isFreePlan && (
          <button type="button" className="topbar__upgrade" title="Opens Synkro pricing" onClick={() => openWebPage('pricing')}>Upgrade to Pro</button>
        )}

        {canBuild && (
          <button
            id="build-apk-btn"
            type="button"
            className="topbar__build"
            disabled={isBuildActive}
            onClick={() => void buildApk()}
            title={isBuildActive ? 'Build already in progress' : 'Build Android APK (Ctrl+Shift+B)'}
          >
            {isBuildActive ? 'Building…' : 'Build APK'}
          </button>
        )}

        {project && (
          <>
            <button type="button" className={`tb-btn ${bottomPanelOpen ? 'tb-btn--on' : ''}`} title="Toggle Panel (Ctrl+J)" onClick={() => runCommand('workbench.action.togglePanel')}>
              <Icon d={ICON.panel} />
            </button>
            <div className="tb-popover-anchor">
              <button
                type="button"
                className={`tb-btn ${previewPaneOpen ? 'tb-btn--on' : ''} ${activeMenu === 'preview-devices' ? 'tb-btn--active' : ''}`}
                title="Preview & Device"
                onClick={() => toggleMenu('preview-devices')}
              >
                <Icon d={ICON.phone} />
              </button>
              {activeMenu === 'preview-devices' && (
                <div className="tb-menu">
                  <button type="button" className="tb-menu__item" onClick={() => handleMenuClick(() => runCommand('peep.togglePreview'))}>
                    {previewPaneOpen ? 'Hide Preview' : 'Show Preview'}
                  </button>
                  <div className="tb-menu__sep" />
                  <div className="tb-menu__label">Device</div>
                  {DEVICES.map((d) => (
                    <button key={d.id} type="button" className="tb-menu__item" onClick={() => handleMenuClick(() => usePreviewStore.getState().setDeviceId(d.id))}>
                      <span className="tb-menu__check">{deviceId === d.id && <Icon d={ICON.check} size={12} />}</span>
                      {d.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button type="button" className={`tb-btn ${agentPaneOpen ? 'tb-btn--on' : ''}`} title="Toggle Chat (Ctrl+Alt+B)" onClick={() => runCommand('peep.toggleChat')}>
              <Icon d={ICON.chat} />
            </button>
          </>
        )}

        <button type="button" className="tb-btn" title="Settings (Ctrl+,)" onClick={() => openSettings()}>
          <Icon d={ICON.settings} />
        </button>

        {user && (
          <div className="tb-popover-anchor">
            <button
              type="button"
              className={`topbar__avatar ${activeMenu === 'user-account' ? 'tb-btn--active' : ''}`}
              title={user.email}
              onClick={() => toggleMenu('user-account')}
            >
              {user.email.charAt(0).toUpperCase()}
            </button>
            {activeMenu === 'user-account' && (
              <div className="tb-menu tb-menu--account">
                <div className="tb-menu__account">
                  <div className="tb-menu__email">{user.email}</div>
                  <div className="tb-menu__plan">{plan.charAt(0).toUpperCase() + plan.slice(1)}</div>
                </div>
                <div className="tb-menu__sep" />
                <button type="button" className="tb-menu__item" onClick={() => handleMenuClick(() => openSettings('usage'))}>Plan & Usage</button>
                <button type="button" className="tb-menu__item" onClick={() => handleMenuClick(() => openWebPage('account'))}>Manage Account ↗</button>
                <button type="button" className="tb-menu__item" onClick={() => handleMenuClick(() => openSettings())}>Settings</button>
                <div className="tb-menu__sep" />
                <button type="button" className="tb-menu__item tb-menu__item--danger" onClick={() => handleMenuClick(() => void logout())}>Sign Out</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
