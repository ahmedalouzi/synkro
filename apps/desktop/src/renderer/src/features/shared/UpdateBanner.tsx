import { useState, useEffect } from 'react';
import type { UpdateInfo } from '@peep/shared';
import './UpdateBanner.css';

export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    // Load current status on mount
    void window.peep.getUpdateStatus().then((s) => {
      if (s.status !== 'idle' && s.status !== 'not-available') setInfo(s);
    });

    // Listen for future updates
    const unsub = window.peep.onUpdateStatus((s) => {
      if (s.status !== 'idle' && s.status !== 'not-available') {
        setInfo(s);
        setDismissed(false);
      }
    });
    return unsub;
  }, []);

  if (!info || dismissed) return null;
  if (info.status === 'idle' || info.status === 'not-available' || info.status === 'checking') return null;

  const handleInstall = async () => {
    if (info.status === 'available') {
      setInstalling(true);
      await window.peep.downloadAndInstall();
      setInstalling(false);
    } else if (info.status === 'ready') {
      // Will close & install
      void window.peep.downloadAndInstall();
    }
  };

  return (
    <div className={`update-banner update-banner--${info.status}`}>
      <span className="update-banner__icon">
        {info.status === 'error' ? '⚠' : info.status === 'ready' ? '🚀' : '↑'}
      </span>

      <span className="update-banner__text">
        {info.status === 'available' && `Atomvs ${info.version} is available`}
        {info.status === 'downloading' && `Downloading update… ${info.percent ?? 0}%`}
        {info.status === 'ready' && `Atomvs ${info.version} ready to install`}
        {info.status === 'error' && `Update error: ${info.error ?? 'unknown'}`}
      </span>

      {info.status === 'downloading' && (
        <div className="update-banner__progress">
          <div
            className="update-banner__progress-fill"
            style={{ width: `${info.percent ?? 0}%` }}
          />
        </div>
      )}

      {(info.status === 'available' || info.status === 'ready') && (
        <button
          className="update-banner__btn"
          onClick={() => void handleInstall()}
          disabled={installing}
        >
          {info.status === 'ready' ? 'Restart & Install' : installing ? 'Downloading…' : 'Download'}
        </button>
      )}

      <button
        className="update-banner__dismiss"
        onClick={() => setDismissed(true)}
        title="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
