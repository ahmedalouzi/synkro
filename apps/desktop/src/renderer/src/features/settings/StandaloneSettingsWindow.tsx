import { useEffect, useState, type CSSProperties } from 'react';
import { SettingsModal } from './SettingsModal';
import { useI18n } from '../../i18n';

export function StandaloneSettingsWindow({ initialSection }: { initialSection?: string }) {
  const { t } = useI18n();
  const [section, setSection] = useState<string | undefined>(initialSection);

  useEffect(() => {
    const unsub = window.peep?.onSettingsSection?.((sec) => {
      if (sec) setSection(sec);
    });
    return () => unsub?.();
  }, []);

  const titlebarStyle: CSSProperties = {
    height: 35,
    minHeight: 35,
    display: 'flex',
    alignItems: 'center',
    paddingLeft: 12,
    paddingRight: 140,
    WebkitAppRegion: 'drag',
    userSelect: 'none',
    backgroundColor: '#0f0f12',
    borderBottom: '1px solid #1e1e24',
    fontSize: 12,
    fontWeight: 500,
    color: '#94a3b8',
    gap: 8,
    zIndex: 10,
  } as CSSProperties;

  return (
    <div style={{ width: '100vw', height: '100vh', display: 'flex', flexDirection: 'column', backgroundColor: '#0d1117', overflow: 'hidden' }}>
      <div className="settings-window-titlebar" dir="ltr" style={titlebarStyle}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83 2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
        <span>{t('settings.modalTitle')}</span>
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <SettingsModal
          open={true}
          onClose={() => void window.peep?.closeWindow?.()}
          initialSection={section}
          standalone={true}
        />
      </div>
    </div>
  );
}
