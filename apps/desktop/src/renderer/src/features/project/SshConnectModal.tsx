import { useState } from 'react';
import './NewProjectModal.css';

interface Props {
  onClose: () => void;
}

/** Parses "user@host:port" (user and port optional). */
function parseTarget(input: string): { user?: string; host: string; port?: number } {
  const match = /^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/.exec(input.trim());
  if (!match) throw new Error('Use the form user@host or user@host:port.');
  return { user: match[1], host: match[2], port: match[3] ? Number(match[3]) : undefined };
}

export function SshConnectModal({ onClose }: Props) {
  const [target, setTarget] = useState('');
  const [identityFile, setIdentityFile] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleConnect = async () => {
    setError('');
    setLoading(true);
    try {
      await window.peep.openSshTerminal({ ...parseTarget(target), identityFile: identityFile.trim() || undefined });
      onClose();
    } catch (err) {
      setError(((err as Error).message ?? String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="new-project-overlay" onClick={onClose}>
      <div className="new-project-modal" onClick={(e) => e.stopPropagation()}>
        <div className="new-project-modal__header">
          <h2>Connect via SSH</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose}>×</button>
        </div>

        <div className="new-project-modal__body">
          <label className="new-project-field">
            <span>Host</span>
            <input
              autoFocus
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void handleConnect(); }}
              placeholder="user@example.com or user@192.168.1.10:2222"
            />
          </label>

          <label className="new-project-field">
            <span>Private key (optional)</span>
            <input
              value={identityFile}
              onChange={(e) => setIdentityFile(e.target.value)}
              placeholder="C:\Users\you\.ssh\id_ed25519"
            />
            <small>Leave empty to use your SSH agent, ~/.ssh/config or a password prompt.</small>
          </label>

          <div className="new-project-status">The session opens in a terminal window using your system's OpenSSH client.</div>
          {error && <div className="new-project-error">⚠ {error}</div>}
        </div>

        <div className="new-project-modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void handleConnect()} disabled={loading || !target.trim()}>
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
