import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useExtensionsStore } from '../../stores/extensions-store';
import './ExtensionDetailsView.css';

interface ExtensionDetailsViewProps {
  extensionId: string;
}

export function ExtensionDetailsView({ extensionId }: ExtensionDetailsViewProps) {
  const [details, setDetails] = useState<any>(null);
  const [readmeContent, setReadmeContent] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isInstalling = useExtensionsStore((s) => s.isInstalling[extensionId]);
  const install = useExtensionsStore((s) => s.install);
  const uninstall = useExtensionsStore((s) => s.uninstall);
  
  const installedExtensions = useExtensionsStore((s) => s.installedExtensions);
  const installedInfo = installedExtensions.find((e) => e.id.toLowerCase() === extensionId.toLowerCase());
  const isInstalled = !!installedInfo;

  useEffect(() => {
    let isMounted = true;
    setLoading(true);
    
    window.peep.getExtensionDetails(extensionId)
      .then(async (data) => {
        if (!isMounted) return;
        setDetails(data);
        setError(null);
        
        // Fetch README content
        if (data.files?.readme) {
          try {
            const readmeRes = await fetch(data.files.readme);
            if (readmeRes.ok) {
              const text = await readmeRes.text();
              if (isMounted) setReadmeContent(text);
            } else {
              if (isMounted) setReadmeContent('*No README content available.*');
            }
          } catch (e) {
            if (isMounted) setReadmeContent('*Failed to load README.*');
          }
        } else {
          if (isMounted) setReadmeContent('*No README available for this extension.*');
        }
      })
      .catch((err) => {
        console.error('Failed to load extension details:', err);
        if (isMounted) setError('Failed to load extension details.');
      })
      .finally(() => {
        if (isMounted) setLoading(false);
      });
      
    return () => { isMounted = false; };
  }, [extensionId]);

  if (loading) {
    return <div className="extension-details__loading">Loading extension details...</div>;
  }

  if (error || !details) {
    return <div className="extension-details__error">{error || 'Extension not found.'}</div>;
  }

  const handleInstallClick = () => {
    if (isInstalled) {
      void uninstall(extensionId);
    } else {
      void install(extensionId, details.files?.download);
    }
  };

  const formatNumber = (num?: number) => {
    if (!num) return '0';
    if (num > 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num > 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toString();
  };
  
  const dateStr = details.timestamp ? new Date(details.timestamp).toLocaleDateString() : 'Unknown';

  return (
    <div className="extension-details">
      <div className="extension-details__header-section">
        <div className="extension-details__icon">
          {details.files?.icon ? (
            <img src={details.files.icon} alt={details.name} />
          ) : (
            <div className="extension-details__icon-placeholder">
              {details.name.substring(0, 1).toUpperCase()}
            </div>
          )}
        </div>
        <div className="extension-details__info">
          <h1 className="extension-details__title">{details.displayName || details.name}</h1>
          <div className="extension-details__meta">
            <span className="extension-details__publisher">{details.namespace}</span>
            {details.downloadCount !== undefined && (
              <span className="extension-details__stat">
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M2.75 14A1.75 1.75 0 0 1 1 12.25v-2.5a.75.75 0 0 1 1.5 0v2.5c0 .138.112.25.25.25h10.5a.25.25 0 0 0 .25-.25v-2.5a.75.75 0 0 1 1.5 0v2.5A1.75 1.75 0 0 1 13.25 14Z"></path><path d="M7.25 7.689V2a.75.75 0 0 1 1.5 0v5.689l1.97-1.969a.749.749 0 1 1 1.06 1.06l-3.25 3.25a.749.749 0 0 1-1.06 0L4.22 6.78a.749.749 0 1 1 1.06-1.06l1.97 1.969Z"></path></svg>
                {formatNumber(details.downloadCount)}
              </span>
            )}
            {details.averageRating !== undefined && details.averageRating > 0 && (
              <span className="extension-details__stat" style={{ color: '#cca700' }}>
                <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z"></path></svg>
                {details.averageRating.toFixed(1)}
              </span>
            )}
          </div>
          <div className="extension-details__description">{details.description}</div>
          <div className="extension-details__actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleInstallClick}
              disabled={isInstalling}
              style={{ display: isInstalled ? 'none' : 'inline-block' }}
            >
              {isInstalling ? 'Installing...' : 'Install'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleInstallClick}
              disabled={isInstalling}
              style={{ display: isInstalled ? 'inline-block' : 'none' }}
            >
              {isInstalling ? 'Working...' : 'Uninstall'}
            </button>
          </div>
        </div>
      </div>
      
      <div className="extension-details__tabs">
        <div className="extension-details__tab active">DETAILS</div>
        <div className="extension-details__tab">FEATURES</div>
        <div className="extension-details__tab">CHANGELOG</div>
      </div>

      <div className="extension-details__layout">
        <div className="extension-details__main-content">
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {readmeContent}
            </ReactMarkdown>
          </div>
        </div>
        <div className="extension-details__sidebar">
          <div className="extension-details__sidebar-section">
            <h3>Installation</h3>
            <div className="extension-details__sidebar-item">
              <span className="label">Identifier</span>
              <span className="value identifier">{details.namespace}.{details.name}</span>
            </div>
            <div className="extension-details__sidebar-item">
              <span className="label">Version</span>
              <span className="value">{details.version}</span>
            </div>
            <div className="extension-details__sidebar-item">
              <span className="label">Last Updated</span>
              <span className="value">{dateStr}</span>
            </div>
          </div>
          
          <div className="extension-details__sidebar-section">
            <h3>Marketplace</h3>
            <div className="extension-details__sidebar-item">
              <span className="label">Published</span>
              <span className="value">{dateStr}</span>
            </div>
          </div>

          <div className="extension-details__sidebar-section">
            <h3>Categories</h3>
            <div className="extension-details__categories">
              {details.categories?.map((c: string) => (
                <span key={c} className="extension-details__category-tag">{c}</span>
              )) || <span className="extension-details__category-tag">Other</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
