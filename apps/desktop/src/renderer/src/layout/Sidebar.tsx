
import { useWorkspace } from '../hooks/useWorkspace';
import { FileTree } from '../features/explorer/FileTree';
import { useWorkspaceStore } from '../stores/workspace-store';
import { ExtensionsPanel } from '../features/extensions/ExtensionsPanel';
import { GitPanel } from '../features/git/GitPanel';
import { SearchPanel } from '../features/explorer/SearchPanel';
import { SkyBackdrop } from '../features/shared/SkyBackdrop';


export function Sidebar() {
  const { project, fileTree, openProjectByPath, recentProjects, activeFilePath } = useWorkspace();
  const sidebarView = useWorkspaceStore((s) => s.sidebarView);
  const setCreatingItem = useWorkspaceStore((s) => s.setCreatingItem);
  const selectedExplorerPath = useWorkspaceStore((s) => s.selectedExplorerPath);

  if (sidebarView === 'extensions') {
    return <ExtensionsPanel />;
  }

  if (sidebarView === 'search') {
    return <SearchPanel />;
  }

  if (sidebarView === 'git') {
    return <GitPanel />;
  }



  const handleNewItem = (type: 'file' | 'folder') => {
    if (!project) return;
    let baseDir = project.path;
    
    if (selectedExplorerPath) {
      if (selectedExplorerPath.type === 'directory') {
        baseDir = selectedExplorerPath.path;
      } else {
        const lastSlash = Math.max(selectedExplorerPath.path.lastIndexOf('/'), selectedExplorerPath.path.lastIndexOf('\\'));
        if (lastSlash > -1) {
          baseDir = selectedExplorerPath.path.substring(0, lastSlash);
        }
      }
    } else if (activeFilePath) {
      const lastSlash = Math.max(activeFilePath.lastIndexOf('/'), activeFilePath.lastIndexOf('\\'));
      if (lastSlash > -1) {
        baseDir = activeFilePath.substring(0, lastSlash);
      }
    }
    
    const normalizedBase = baseDir.replace(/[/\\]$/, '');
    setCreatingItem({ type, baseDir: normalizedBase });
  };

  const handleRefresh = async () => {
    if (project) {
      const tree = await window.peep.listDir(project.path);
      useWorkspaceStore.getState().setFileTree(tree);
    }
  };

  return (
    <div className="sidebar">
      <SkyBackdrop interactive={false} />
      <div className="sidebar-header">
        <span className="sidebar-title">Explorer</span>
        <div className="sidebar-actions">
          <button className="sidebar-btn" title="New File" onClick={() => handleNewItem('file')}>
            <svg style={{width:'12px',height:'12px',stroke:'currentColor',fill:'none',strokeWidth:'2'}} viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button className="sidebar-btn" title="New Folder" onClick={() => handleNewItem('folder')}>
            <svg style={{width:'12px',height:'12px',stroke:'currentColor',fill:'none',strokeWidth:'2'}} viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
          </button>
          <button className="sidebar-btn" title="Refresh Explorer" onClick={handleRefresh}>
            <svg style={{width:'12px',height:'12px',stroke:'currentColor',fill:'none',strokeWidth:'2'}} viewBox="0 0 24 24"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
          </button>
          <button className="sidebar-btn" title="Collapse" onClick={() => {
            // Simplest way to collapse is to trigger a re-render of FileTree with all nodes closed.
            // For MVP, just reload the workspace if needed, or leave it as a no-op if too complex.
            // No-op for now.
          }}>
            <svg style={{width:'12px',height:'12px',stroke:'currentColor',fill:'none',strokeWidth:'2'}} viewBox="0 0 24 24"><path d="M18 15l-6-6-6 6"/></svg>
          </button>
        </div>
      </div>
      <div className="sidebar-search">
        <input type="text" placeholder="Filter files..." />
      </div>
      <div className="sidebar-tree">
        {!project ? (
          <>
            {recentProjects.length > 0 && (
              <>
                <div className="tree-section">Recent Projects</div>
                {recentProjects.map((item) => (
                  <div 
                    key={item.id} 
                    className="tree-item"
                    onClick={() => void openProjectByPath(item.path)}
                    title={item.path}
                  >
                    <svg className="tree-icon tree-folder" fill="currentColor" viewBox="0 0 16 16"><path d="M.54 3.87.5 3a2 2 0 0 1 2-2h3.19a2 2 0 0 1 1.37.527l.806.806A2 2 0 0 0 9.31 3h3.19a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 1.5H2.5A2 2 0 0 1 .5 13.5V3.87z"/></svg>
                    {item.name}
                  </div>
                ))}
              </>
            )}
          </>
        ) : (
          <>
            <div className="tree-section">{project.name}</div>
            <FileTree entries={fileTree} rootPath={project.path} />
          </>
        )}
      </div>
    </div>
  );
}
