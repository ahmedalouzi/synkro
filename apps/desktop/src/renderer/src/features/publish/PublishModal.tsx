import { useEffect, useRef, useState } from 'react';
import { useWorkspaceStore } from '../../stores/workspace-store';
import QRCode from 'qrcode';
import './PublishModal.css';

interface PublishModalProps {
  open: boolean;
  onClose: () => void;
}

function UrlQrCode({ url }: { url: string }) {
  const [dataUrl, setDataUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(url, { margin: 1, width: 160 })
      .then((d) => { if (!cancelled) setDataUrl(d); })
      .catch(() => setDataUrl(''));
    return () => { cancelled = true; };
  }, [url]);
  return dataUrl ? <img className="publish-qrcode" src={dataUrl} alt={`QR code for ${url}`} /> : null;
}

export function PublishModal({ open, onClose }: PublishModalProps) {
  const project = useWorkspaceStore((s) => s.project);
  const [target, setTarget] = useState<'vercel' | 'netlify'>('vercel');
  const [token, setToken] = useState('');
  const [status, setStatus] = useState<any>({ status: 'idle', message: 'Ready to deploy', logs: [] });
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    void window.peep.publishGetStatus().then(setStatus);

    const unsubStatus = window.peep.onPublishStatus((newStatus) => {
      setStatus(newStatus);
    });

    const unsubLog = window.peep.onPublishLog((line) => {
      setStatus((prev: any) => ({
        ...prev,
        logs: [...(prev.logs || []), line],
      }));
    });

    return () => {
      unsubStatus();
      unsubLog();
    };
  }, [open]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [status.logs]);

  if (!open || !project) return null;

  const platform = project.platform === 'react-native' || project.platform === 'expo' ? 'react-native' : 'flutter';

  const handlePublishWeb = () => {
    void window.peep.publishDeploy(
      project.path,
      platform,
      target,
      token.trim() || undefined
    );
  };

  const handleCancel = () => {
    void window.peep.publishCancel();
  };

  const isWorking = status.status === 'building' || status.status === 'deploying';

  return (
    <div className="publish-overlay" onClick={onClose}>
      <div className="publish-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="publish-modal__header">
          <h2>🚀 Publish Application</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={isWorking}>
            ×
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="publish-tabs">
          <div className="publish-tab publish-tab--active">
            🌐 Web / PWA Hosting
          </div>
        </div>

        {/* Body */}
        <div className="publish-modal__body">
          <div className="publish-panel">
            <p className="publish-desc">
              Easily host your application on the web using a static deployment provider.
              This allows you to share your project instantly as a web application or Progressive Web App (PWA).
            </p>

            <div className="publish-form-group">
              <label className="publish-field">
                <span>Target Provider</span>
                <select
                  value={target}
                  onChange={(e: any) => setTarget(e.target.value)}
                  disabled={isWorking}
                >
                  <option value="vercel">Vercel (Zero Config)</option>
                  <option value="netlify">Netlify</option>
                </select>
              </label>

              <label className="publish-field">
                <span>API Token (Optional)</span>
                <input
                  type="password"
                  placeholder="Leave blank to log in via browser"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={isWorking}
                />
              </label>
            </div>

            {!isWorking && status.status !== 'completed' && status.status !== 'error' && (
              <button
                type="button"
                className="btn btn-primary publish-action-btn"
                onClick={handlePublishWeb}
              >
                Go Live (Build & Deploy)
              </button>
            )}
          </div>

          {/* Progress / Status Visuals */}
          {status.status !== 'idle' && (
            <div className="publish-progress-section">
              <div className="publish-status-bar">
                <span className="status-indicator-icon">
                  {status.status === 'building' && '⏳'}
                  {status.status === 'deploying' && '📦'}
                  {status.status === 'completed' && '✅'}
                  {status.status === 'error' && '⚠️'}
                </span>
                <div className="status-text-block">
                  <strong>{status.status.toUpperCase()}</strong>
                  <p>{status.message}</p>
                </div>
                {isWorking && (
                  <button type="button" className="btn btn-ghost cancel-btn" onClick={handleCancel}>
                    Cancel
                  </button>
                )}
              </div>

              {/* Deployment Link / QR Code Mockup */}
              {status.status === 'completed' && status.url && (
                <div className="publish-success-card">
                  <h4>🎉 Your application is live!</h4>
                  <a href={status.url} target="_blank" rel="noopener noreferrer" className="publish-link">
                    {status.url}
                  </a>

                  <div className="pwa-install-tip">
                    <p>📱 Scan this code with your phone to open the app and install it as a PWA.</p>
                    <UrlQrCode url={status.url} />
                  </div>
                </div>
              )}

              {/* Live Output Logs */}
              <div className="publish-log-box">
                <div className="publish-log-header">Build & Deployment Logs</div>
                <div className="publish-log-lines">
                  {status.logs && status.logs.map((log: string, idx: number) => (
                    <div key={idx} className="log-line">{log}</div>
                  ))}
                  <div ref={logEndRef} />
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
