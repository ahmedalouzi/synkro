import { useWorkspace } from '../../hooks/useWorkspace';
import { getFileIcon, FolderIcon } from './FileIcons';
import { useState, useEffect } from 'react';
import type { FileEntry } from '@peep/shared';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { ContextMenu } from './ContextMenu';

interface FileTreeProps {
  entries: FileEntry[];
  rootPath: string;
  dirPath?: string;
  depth?: number;
  onContextMenuShow?: (e: React.MouseEvent, entry: FileEntry) => void;
}

/**
 * The message for a failed create/rename. An existing name is refused by main (never replaced), and the input
 * stays open so the user can pick another name. Electron prefixes errors from main with "Error invoking …".
 */
function fileOpError(err: unknown, name: string): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/already exists|EEXIST/i.test(message)) return `"${name}" already exists in this folder. Choose a different name.`;
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'Unknown error';
}

const inputErrorStyle: React.CSSProperties = {
  flexBasis: '100%', padding: '2px 6px', margin: '2px 0 4px', fontSize: '11px', color: 'var(--text-error, #f48771)',
  background: 'var(--bg-primary)', border: '1px solid var(--text-error, #f48771)',
};

function InlineCreateInput({ depth, baseDir }: { depth: number; baseDir: string }) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const creatingItem = useWorkspaceStore((s) => s.creatingItem);
  const setCreatingItem = useWorkspaceStore((s) => s.setCreatingItem);
  const { project, syncProject } = useWorkspace();

  const handleSubmit = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (name && creatingItem) {
        try {
          const path = `${baseDir}/${name}`;
          // Both refuse an existing name: a new item never replaces one.
          if (creatingItem.type === 'folder') {
            await window.peep.createDir(path, { failIfExists: true });
          } else {
            await window.peep.createFile(path, '');
          }
          setCreatingItem(null);
          if (project) {
            await syncProject(project);
          }
        } catch (err) {
          setError(fileOpError(err, name));
        }
      } else {
        setCreatingItem(null);
      }
    } else if (e.key === 'Escape') {
      setCreatingItem(null);
    }
  };

  if (!creatingItem) return null;

  return (
    <div className={`tree-item tree-indent-${Math.min(depth + 1, 3)} active`} style={{ padding: '2px 8px', flexWrap: 'wrap' }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, marginRight: 6 }}>
        {creatingItem.type === 'folder' ? <FolderIcon isOpen={true} /> : getFileIcon(name)}
      </span>
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => { setName(e.target.value); setError(null); }}
        onKeyDown={handleSubmit}
        onBlur={() => setCreatingItem(null)}
        aria-invalid={error ? true : undefined}
        style={{ flex: 1, background: 'var(--bg-primary)', color: 'var(--text-primary)', border: `1px solid ${error ? 'var(--text-error, #f48771)' : 'var(--accent)'}`, outline: 'none', padding: '2px 4px', fontSize: '12px' }}
      />
      {error && <div role="alert" data-testid="explorer-name-error" style={inputErrorStyle}>{error}</div>}
    </div>
  );
}

function InlineRenameInput({ depth, entry }: { depth: number; entry: FileEntry }) {
  const [name, setName] = useState(entry.name);
  const [error, setError] = useState<string | null>(null);
  const setRenamingItem = useWorkspaceStore((s) => s.setRenamingItem);
  const renameOpenFiles = useWorkspaceStore((s) => s.renameOpenFiles);
  const { renameItem, project, syncProject } = useWorkspace();

  const handleSubmit = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (name && name !== entry.name) {
        try {
          const lastSlash = Math.max(entry.path.lastIndexOf('/'), entry.path.lastIndexOf('\\'));
          const baseDir = lastSlash > -1 ? entry.path.substring(0, lastSlash) : entry.path;
          const newPath = `${baseDir}/${name}`;
          // Refused by main if another item has that name (never replaced).
          await renameItem(entry.path, newPath);
          renameOpenFiles(entry.path, newPath);
          setRenamingItem(null);
          if (project) {
            await syncProject(project);
          }
        } catch (err) {
          setError(fileOpError(err, name));
        }
      } else {
        setRenamingItem(null);
      }
    } else if (e.key === 'Escape') {
      setRenamingItem(null);
    }
  };

  return (
    <div className={`tree-item tree-indent-${Math.min(depth + 1, 3)} active`} style={{ padding: '2px 8px', flexWrap: 'wrap' }}>
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, marginRight: 6 }}>
        {entry.type === 'directory' ? <FolderIcon isOpen={false} /> : getFileIcon(name)}
      </span>
      <input
        autoFocus
        type="text"
        value={name}
        onChange={(e) => { setName(e.target.value); setError(null); }}
        onKeyDown={handleSubmit}
        onBlur={() => setRenamingItem(null)}
        aria-invalid={error ? true : undefined}
        style={{ flex: 1, background: 'var(--bg-primary)', color: 'var(--text-primary)', border: `1px solid ${error ? 'var(--text-error, #f48771)' : 'var(--accent)'}`, outline: 'none', padding: '2px 4px', fontSize: '12px' }}
        onFocus={(e) => {
          // Select just the filename without extension if possible
          const lastDot = name.lastIndexOf('.');
          if (lastDot > 0 && entry.type === 'file') {
            e.target.setSelectionRange(0, lastDot);
          } else {
            e.target.select();
          }
        }}
      />
      {error && <div role="alert" data-testid="explorer-name-error" style={inputErrorStyle}>{error}</div>}
    </div>
  );
}

function FolderItem({ entry, rootPath, depth, onContextMenuShow }: { entry: FileEntry, rootPath: string, depth: number, onContextMenuShow?: (e: React.MouseEvent, entry: FileEntry) => void }) {
  const expandedFolders = useWorkspaceStore((s) => s.expandedFolders);
  const toggleFolder = useWorkspaceStore((s) => s.toggleFolder);
  const updateDirectoryChildren = useWorkspaceStore((s) => s.updateDirectoryChildren);

  const isOpen = expandedFolders[entry.path] !== undefined 
    ? expandedFolders[entry.path] 
    : (depth < 1);

  const creatingItem = useWorkspaceStore((s) => s.creatingItem);
  const renamingItem = useWorkspaceStore((s) => s.renamingItem);
  const setSelectedExplorerPath = useWorkspaceStore((s) => s.setSelectedExplorerPath);
  const selectedExplorerPath = useWorkspaceStore((s) => s.selectedExplorerPath);

  if (renamingItem?.path === entry.path) {
    return <InlineRenameInput depth={depth} entry={entry} />;
  }

  useEffect(() => {
    if (creatingItem?.baseDir === entry.path || creatingItem?.baseDir.startsWith(entry.path + '/')) {
      if (!isOpen) {
        toggleFolder(entry.path);
      }
    }
  }, [creatingItem?.baseDir, entry.path]);

  const isSelected = selectedExplorerPath?.path === entry.path;

  const handleFolderClick = async () => {
    const nextOpen = !isOpen;
    toggleFolder(entry.path);
    setSelectedExplorerPath({ path: entry.path, type: 'directory' });

    if (nextOpen) {
      try {
        const children = await window.peep.listDir(entry.path, 0);
        updateDirectoryChildren(entry.path, children);
      } catch (err) {
        console.error('Failed to load children for directory:', entry.path, err);
      }
    }
  };

  useEffect(() => {
    if (isOpen && (!entry.children || entry.children.length === 0)) {
      window.peep.listDir(entry.path, 0).then((children) => {
        updateDirectoryChildren(entry.path, children);
      }).catch((err) => {
        console.error('Initial directory load failed:', entry.path, err);
      });
    }
  }, [isOpen, entry.path, entry.children?.length]);

  return (
    <>
      <div 
        className={`tree-item tree-indent-${Math.min(depth + 1, 3)} ${isSelected ? 'active' : ''}`}
        onClick={handleFolderClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setSelectedExplorerPath({ path: entry.path, type: 'directory' });
          onContextMenuShow?.(e, entry);
        }}
      >
        <span style={{ display: 'inline-block', width: 12, textAlign: 'center', marginRight: 2, fontSize: 10, color: 'var(--muted)' }}>
          {isOpen ? '▼' : '▶'}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, marginRight: 6 }}>
          <FolderIcon isOpen={isOpen} />
        </span>
        {entry.name}
      </div>
      {isOpen && (
        <FileTree entries={entry.children || []} rootPath={rootPath} dirPath={entry.path} depth={depth + 1} onContextMenuShow={onContextMenuShow} />
      )}
    </>
  );
}

export function FileTree({ entries, rootPath, dirPath, depth = 0, onContextMenuShow }: FileTreeProps) {
  const { loadFile, activeFilePath } = useWorkspace();
  const currentDir = dirPath ?? rootPath;
  const creatingItem = useWorkspaceStore((s) => s.creatingItem);
  const isCreatingHere = creatingItem?.baseDir === currentDir;
  const setSelectedExplorerPath = useWorkspaceStore((s) => s.setSelectedExplorerPath);
  const selectedExplorerPath = useWorkspaceStore((s) => s.selectedExplorerPath);
  const renamingItem = useWorkspaceStore((s) => s.renamingItem);
  
  // State for top-level context menu
  const [contextMenuState, setContextMenuState] = useState<{x: number, y: number, entry: FileEntry} | null>(null);

  // If we are at the top level, we handle the context menu here
  const handleContextMenu = (e: React.MouseEvent, entry: FileEntry) => {
    if (onContextMenuShow) {
      onContextMenuShow(e, entry);
    } else {
      setContextMenuState({ x: e.clientX, y: e.clientY, entry });
    }
  };

  return (
    <>
      {entries.map((entry) => {
        const isActive = activeFilePath === entry.path;
        const isSelected = selectedExplorerPath?.path === entry.path;
        if (entry.type === 'directory') {
          return <FolderItem key={entry.path} entry={entry} rootPath={rootPath} depth={depth} onContextMenuShow={handleContextMenu} />;
        }
        
        if (renamingItem?.path === entry.path) {
          return <InlineRenameInput key={entry.path} depth={depth} entry={entry} />;
        }

        return (
          <div
            key={entry.path}
            className={`tree-item tree-indent-${Math.min(depth + 1, 3)} ${isActive || isSelected ? 'active' : ''}`}
            onClick={() => {
              void loadFile(entry.path, entry.name);
              setSelectedExplorerPath({ path: entry.path, type: 'file' });
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setSelectedExplorerPath({ path: entry.path, type: 'file' });
              handleContextMenu(e, entry);
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 18, height: 18, marginRight: 6 }}>
              {getFileIcon(entry.name)}
            </span>
            {entry.name}
            {isActive && <span className="tree-badge">◈</span>}
          </div>
        );
      })}
      {isCreatingHere && <InlineCreateInput depth={depth} baseDir={currentDir} />}
      {!onContextMenuShow && contextMenuState && (
        <ContextMenu
          x={contextMenuState.x}
          y={contextMenuState.y}
          entry={contextMenuState.entry}
          onClose={() => setContextMenuState(null)}
        />
      )}
    </>
  );
}
