import { useState, useEffect } from 'react';
import { MonacoEditor } from '../features/editor/MonacoEditor';
import { DiffViewer } from '../features/chat/DiffViewer';
import { PlanViewer } from '../features/plan/PlanViewer';

import { NoFileOpenEmptyState, NoProjectEmptyState } from '../features/shared/EmptyState';
import { useWorkspaceStore, type OpenFile } from '../stores/workspace-store';
import { useWorkspace } from '../hooks/useWorkspace';
import { confirmDiscard } from '../commands/commands';
import { ContextMenu, type ContextMenuItem } from '../features/shared/ContextMenu';

const TAB_DRAG_TYPE = 'application/x-synkro-tab';
import { ExtensionDetailsView } from '../features/extensions/ExtensionDetailsView';
import { GitDiffView } from '../features/git/GitDiffView';
import { getFileIcon } from '../features/explorer/FileIcons';

function isVirtualPath(path: string): boolean {
  return path.startsWith('git-diff://') ||
    path.startsWith('extension://') ||
    path === 'peep://proposed-changes' ||
    path.endsWith('.peep/plan.md') ||
    path.endsWith('.peep\\plan.md') ||
    path.endsWith('.peep/walkthrough.md') ||
    path.endsWith('.peep\\walkthrough.md');
}

/** File extensions treated as images */
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'avif']);

function isImageFile(name: string): boolean {
  return IMAGE_EXTS.has(name.split('.').pop()?.toLowerCase() ?? '');
}

/** Loads an image file as a base64 data URL via IPC */
function ImageViewer({ filePath, fileName }: { filePath: string; fileName: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    setSrc(null);
    void window.peep.readImage(filePath).then(setSrc);
  }, [filePath]);

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-base)',
      gap: '16px',
      overflow: 'auto',
      padding: '24px',
    }}>
      {src ? (
        <>
          {/* Checkerboard for transparency */}
          <div style={{
            position: 'relative',
            borderRadius: '8px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.3)',
            overflow: 'hidden',
            maxWidth: '100%',
            maxHeight: 'calc(100% - 80px)',
            border: '1px solid rgba(255,255,255,0.08)',
            background: [
              'linear-gradient(45deg, #222 25%, transparent 25%)',
              'linear-gradient(-45deg, #222 25%, transparent 25%)',
              'linear-gradient(45deg, transparent 75%, #222 75%)',
              'linear-gradient(-45deg, transparent 75%, #222 75%)',
            ].join(', '),
            backgroundSize: '16px 16px',
            backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
          }}>
            <img
              src={src}
              alt={fileName}
              style={{ display: 'block', maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
            />
          </div>
          {/* Info bar */}
          <div style={{
            display: 'flex', gap: '10px', alignItems: 'center',
            fontSize: '11px', color: 'var(--text-muted)',
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: '6px', padding: '6px 14px',
          }}>
            <span style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>{fileName}</span>
            <span>·</span>
            <span>{fileName.split('.').pop()?.toUpperCase()}</span>
          </div>
        </>
      ) : (
        <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Loading…</div>
      )}
    </div>
  );
}

export function EditorPane() {
  const {
    project,
    openFiles,
    activeFilePath,
    setActiveFile,
    updateFileContent,
    saveActiveFile,
    openProjectFolder,
  } = useWorkspace();

  const activeFile = openFiles.find((f) => f.path === activeFilePath) ?? null;

  const handleNewProject = () => {
    window.dispatchEvent(new CustomEvent('peep:new-project'));
  };

  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; file: OpenFile } | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);

  /** Closes editors, asking first if any have unsaved changes (VS Code's save prompt). */
  const closeTabs = (files: OpenFile[]) => {
    if (files.length === 0 || !confirmDiscard(files)) return;
    useWorkspaceStore.getState().closeFiles(files.map((f) => f.path));
  };
  const closeTab = (file: OpenFile) => closeTabs([file]);

  const tabMenuItems = (file: OpenFile): ContextMenuItem[] => {
    const index = openFiles.findIndex((f) => f.path === file.path);
    const onDisk = !isVirtualPath(file.path) && !file.path.startsWith('untitled-');
    const relativePath = project && file.path.startsWith(project.path)
      ? file.path.slice(project.path.length).replace(/^[\\/]/, '')
      : file.path;
    return [
      { label: 'Close', keybinding: 'Ctrl+F4', run: () => closeTab(file) },
      { label: 'Close Others', enabled: openFiles.length > 1, run: () => closeTabs(openFiles.filter((f) => f.path !== file.path)) },
      { label: 'Close to the Right', enabled: index < openFiles.length - 1, run: () => closeTabs(openFiles.slice(index + 1)) },
      { label: 'Close Saved', enabled: openFiles.some((f) => !f.dirty), run: () => closeTabs(openFiles.filter((f) => !f.dirty)) },
      { label: 'Close All', keybinding: 'Ctrl+K Ctrl+W', run: () => closeTabs(openFiles) },
      '-',
      { label: 'Copy Path', enabled: onDisk, run: () => void navigator.clipboard.writeText(file.path) },
      { label: 'Copy Relative Path', enabled: onDisk, run: () => void navigator.clipboard.writeText(relativePath) },
      '-',
      { label: 'Reveal in File Explorer', enabled: onDisk, run: () => void window.peep.revealItem(file.path) },
    ];
  };



  return (
    <div className="editor-area">
      <div className="editor-tabs">
        {openFiles.map((file, index) => {
          const isActive = file.path === activeFilePath;
          return (
            <div
              key={file.path}
              className={`tab ${isActive ? 'active' : ''} ${dragOverPath === file.path ? 'drag-over' : ''}`}
              title={isVirtualPath(file.path) || file.path.startsWith('untitled-') ? file.name : file.path}
              draggable
              onClick={() => setActiveFile(file.path)}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(file); } }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ x: e.clientX, y: e.clientY, file });
              }}
              onDragStart={(e) => {
                e.dataTransfer.setData(TAB_DRAG_TYPE, file.path);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
                e.preventDefault();
                setDragOverPath(file.path);
              }}
              onDragLeave={() => setDragOverPath((p) => (p === file.path ? null : p))}
              onDrop={(e) => {
                const dragged = e.dataTransfer.getData(TAB_DRAG_TYPE);
                setDragOverPath(null);
                if (dragged && dragged !== file.path) {
                  e.preventDefault();
                  useWorkspaceStore.getState().moveOpenFile(dragged, index);
                }
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: isActive ? 1 : 0.7, filter: isActive ? 'none' : 'grayscale(0.5)' }}>
                {getFileIcon(file.name)}
              </span>
              {file.name}
              {file.dirty && <span className="tab-dot"></span>}
              <span className="tab-close" onClick={(e) => { e.stopPropagation(); closeTab(file); }}>✕</span>
            </div>
          );
        })}
      </div>
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems(tabMenu.file)}
          onClose={() => setTabMenu(null)}
        />
      )}

      {activeFile && (
        <div className="editor-toolbar">
          <div className="breadcrumb">
            <span style={{ color: 'var(--text-muted)' }}>{project?.name ?? 'Project'}</span>
            <span className="sep">›</span>
            <span style={{ color: 'var(--gold)' }}>{activeFile.name}</span>
          </div>
          <div className="editor-toolbar-right">
            <span className="ctx-pill">
              <svg style={{ width: '10px', height: '10px', stroke: 'currentColor', fill: 'none', strokeWidth: '2' }} viewBox="0 0 16 16"><path d="M8 2v4l3 3" /><circle cx="8" cy="8" r="6" /></svg>
              {activeFile.name.split('.').pop()?.toUpperCase() ?? 'TEXT'}
            </span>
            {!isVirtualPath(activeFile.path) && (
              <button className="toolbar-btn" onClick={() => void saveActiveFile()}>
                <svg style={{ width: '11px', height: '11px', stroke: 'currentColor', fill: 'none', strokeWidth: '2' }} viewBox="0 0 16 16"><path d="M1 4h14M1 8h14M1 12h8" /></svg>
                Save
              </button>
            )}
            <button className="toolbar-btn" onClick={() => {
              if (project) {
                useWorkspaceStore.getState().setBottomPanelTab('problems');
                if (!useWorkspaceStore.getState().bottomPanelOpen) useWorkspaceStore.getState().toggleBottomPanel();
                if (project.platform === 'react-native' || project.platform === 'expo') {
                  window.peep.analyzeProject(project.path); // Wait, RN analyze is not exposed properly?
                  // We can just rely on the watcher for now, or just open the tab.
                } else {
                  window.peep.analyzeProject(project.path);
                }
              }
            }}>
              <svg style={{ width: '11px', height: '11px', stroke: 'currentColor', fill: 'none', strokeWidth: '2' }} viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" /><path d="M8 5v3l2 2" /></svg>
              Lint
            </button>
          </div>
        </div>
      )}

      <div className="editor-body" style={{ flex: 1, position: 'relative' }}>
        {!project ? (
          <NoProjectEmptyState
            onOpen={() => void openProjectFolder()}
            onNew={handleNewProject}
          />
        ) : !activeFile ? (
          <NoFileOpenEmptyState />
        ) : activeFile.path === 'peep://proposed-changes' ? (
          <DiffViewer />
        ) : activeFile.path.endsWith('.peep/plan.md') || activeFile.path.endsWith('.peep\\plan.md') ? (
          <PlanViewer content={activeFile.content} mode="plan" />
        ) : activeFile.path.endsWith('.peep/walkthrough.md') || activeFile.path.endsWith('.peep\\walkthrough.md') ? (
          <PlanViewer content={activeFile.content} mode="walkthrough" />
        ) : activeFile.path.startsWith('extension://') ? (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'auto', background: 'var(--bg-base)' }}>
            <ExtensionDetailsView extensionId={activeFile.path.replace('extension://', '')} />
          </div>
        ) : activeFile.path.startsWith('git-diff://') ? (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, overflow: 'hidden', background: 'var(--bg-base)' }}>
            <GitDiffView filePath={activeFile.path.replace('git-diff://', '')} />
          </div>
        ) : isImageFile(activeFile.name) ? (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
            <ImageViewer filePath={activeFile.path} fileName={activeFile.name} />
          </div>
        ) : (
          <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}>
            <MonacoEditor
              key={activeFile.path}
              path={activeFile.path}
              value={activeFile.content}
              externallyModified={activeFile.externallyModified}
              onChange={(content) => updateFileContent(activeFile.path, content)}
              onSave={() => void saveActiveFile()}
              onKeepLocal={() => {
                useWorkspaceStore.getState().setFileExternallyModified(activeFile.path, false);
              }}
              onReloadFromDisk={() => {
                void window.peep.readFile(activeFile.path).then((newContent) => {
                  useWorkspaceStore.getState().syncFileContent(activeFile.path, newContent);
                });
              }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
