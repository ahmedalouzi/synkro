import { useState } from 'react';
import { useWorkspace } from '../../hooks/useWorkspace';
import './NewProjectModal.css';

interface Props {
  onClose: () => void;
}

export function CloneRepoModal({ onClose }: Props) {
  const { openProjectByPath } = useWorkspace();
  const [url, setUrl] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSelectFolder = async () => {
    const folder = await window.peep.selectFolder();
    if (folder) setParentPath(folder);
  };

  const handleClone = async () => {
    setError('');
    if (!url.trim()) return setError('Enter a repository URL.');
    if (!parentPath) return setError('Choose where to clone the repository.');
    setLoading(true);
    try {
      const clonedPath = await window.peep.gitClone(url.trim(), parentPath);
      await openProjectByPath(clonedPath);
      onClose();
    } catch (err) {
      // Electron prefixes IPC errors with "Error invoking remote method '…': Error: "
      setError(((err as Error).message ?? String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="new-project-overlay" onClick={loading ? undefined : onClose}>
      <div className="new-project-modal" onClick={(e) => e.stopPropagation()}>
        <div className="new-project-modal__header">
          <h2>Clone Repository</h2>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>×</button>
        </div>

        <div className="new-project-modal__body">
          <label className="new-project-field">
            <span>Repository URL</span>
            <input
              autoFocus
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !loading) void handleClone(); }}
              placeholder="https://github.com/owner/repo.git"
              disabled={loading}
            />
            <small>Private repositories use your Git credentials (Git Credential Manager or SSH keys).</small>
          </label>

          <label className="new-project-field">
            <span>Clone into</span>
            <div className="new-project-field__row">
              <input value={parentPath} readOnly placeholder="Select folder…" />
              <button type="button" className="btn btn-ghost" onClick={() => void handleSelectFolder()} disabled={loading}>
                Browse
              </button>
            </div>
          </label>

          {loading && <div className="new-project-status">⏳ Cloning… this can take a minute for large repositories.</div>}
          {error && <div className="new-project-error">⚠ {error}</div>}
        </div>

        <div className="new-project-modal__footer">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={loading}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => void handleClone()} disabled={loading}>
            {loading ? 'Cloning…' : 'Clone & Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
