import { create } from 'zustand';
import type { FileEntry, ProjectInfo } from '@peep/shared';

export interface OpenFile {
  path: string;
  name: string;
  content: string;
  dirty: boolean;
  externallyModified?: boolean;
}

interface WorkspaceState {
  project: ProjectInfo | null;
  recentProjects: ProjectInfo[];
  fileTree: FileEntry[];
  openFiles: OpenFile[];
  activeFilePath: string | null;
  activeSelection: { text: string; startLine: number; endLine: number; filePath: string } | null;

  bottomPanelOpen: boolean;
  sidebarOpen: boolean;
  /** Side bar on the start page (no project), hidden by default like Cursor's. */
  homeSidebarOpen: boolean;
  /** Status bar at the bottom of the window (View › Appearance › Status Bar). */
  statusBarVisible: boolean;
  agentPaneOpen: boolean;
  previewPaneOpen: boolean;
  sidebarView: 'explorer' | 'extensions' | 'search' | 'git';
  bottomPanelTab: 'problems' | 'logs' | 'terminal' | 'git' | 'build';
  isLoading: boolean;
  editorWordWrap: boolean;
  editorMinimap: boolean;
  creatingItem: { type: 'file' | 'folder', baseDir: string } | null;
  renamingItem: FileEntry | null;
  selectedExplorerPath: { path: string, type: 'file' | 'directory' } | null;

  setProject: (project: ProjectInfo | null) => void;
  setRecentProjects: (projects: ProjectInfo[]) => void;
  setFileTree: (tree: FileEntry[]) => void;
  openFile: (file: OpenFile) => void;
  updateFileContent: (path: string, content: string) => void;
  setActiveFile: (path: string | null) => void;
  setActiveSelection: (selection: { text: string; startLine: number; endLine: number; filePath: string } | null) => void;
  setFileExternallyModified: (path: string, modified: boolean) => void;
  syncFileContent: (path: string, content: string) => void;
  /** Clears the dirty flag after a write, unless the buffer changed while saving. */
  markFileSaved: (path: string, savedContent: string) => void;
  closeFile: (path: string) => void;
  closeAllFiles: () => void;
  /** Closes several editors at once, keeping the active one if it stays open. */
  closeFiles: (paths: string[]) => void;
  moveOpenFile: (path: string, toIndex: number) => void;
  toggleEditorWordWrap: () => void;
  toggleEditorMinimap: () => void;
  toggleBottomPanel: () => void;
  toggleSidebar: () => void;
  toggleHomeSidebar: () => void;
  toggleStatusBar: () => void;
  setSidebarView: (view: 'explorer' | 'extensions' | 'search' | 'git') => void;
  toggleAgentPane: () => void;
  setPreviewPaneOpen: (open: boolean) => void;
  setBottomPanelTab: (tab: 'problems' | 'logs' | 'terminal' | 'git' | 'build') => void;
  setLoading: (loading: boolean) => void;
  setCreatingItem: (item: { type: 'file' | 'folder', baseDir: string } | null) => void;
  setRenamingItem: (item: FileEntry | null) => void;
  setSelectedExplorerPath: (item: { path: string, type: 'file' | 'directory' } | null) => void;
  expandedFolders: Record<string, boolean>;
  toggleFolder: (path: string) => void;
  updateDirectoryChildren: (path: string, children: FileEntry[]) => void;
  mergeRootChildren: (children: FileEntry[]) => void;
}

const STATUS_BAR_KEY = 'synkro.statusBarVisible';

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  project: null,
  recentProjects: [],
  fileTree: [],
  openFiles: [],
  activeFilePath: null,
  activeSelection: null,
  bottomPanelOpen: true,
  sidebarOpen: true,
  homeSidebarOpen: false,
  statusBarVisible: (() => {
    try {
      return localStorage.getItem(STATUS_BAR_KEY) !== 'hidden';
    } catch {
      return true;
    }
  })(),
  sidebarView: 'explorer',
  agentPaneOpen: true,
  previewPaneOpen: true,
  bottomPanelTab: 'problems',
  isLoading: false,
  editorWordWrap: true,
  editorMinimap: true,
  creatingItem: null,
  renamingItem: null,
  selectedExplorerPath: null,

  setProject: (project) => set({ project, selectedExplorerPath: null }),
  setRecentProjects: (recentProjects) => set({ recentProjects }),
  setFileTree: (fileTree) => set({ fileTree }),

  openFile: (file) => {
    const { openFiles } = get();
    const exists = openFiles.find((f) => f.path === file.path);
    if (exists) {
      set({ activeFilePath: file.path });
      return;
    }
    set({
      openFiles: [...openFiles, file],
      activeFilePath: file.path,
    });
  },

  updateFileContent: (path, content) => {
    set({
      openFiles: get().openFiles.map((f) =>
        f.path === path ? { ...f, content, dirty: true, externallyModified: false } : f,
      ),
    });
  },

  syncFileContent: (path, content) => {
    set({
      openFiles: get().openFiles.map((f) =>
        f.path === path ? { ...f, content, dirty: false, externallyModified: false } : f,
      ),
    });
  },

  markFileSaved: (path, savedContent) => {
    set({
      openFiles: get().openFiles.map((f) =>
        f.path === path && f.content === savedContent ? { ...f, dirty: false, externallyModified: false } : f,
      ),
    });
  },

  setActiveFile: (activeFilePath) => set({ activeFilePath }),

  setFileExternallyModified: (path, modified) => {
    set({
      openFiles: get().openFiles.map((f) =>
        f.path === path ? { ...f, externallyModified: modified } : f,
      ),
    });
  },

  closeFile: (path) => {
    const { openFiles, activeFilePath } = get();
    const next = openFiles.filter((f) => f.path !== path);
    let nextActive = activeFilePath;
    if (activeFilePath === path) {
      nextActive = next.length > 0 ? next[next.length - 1].path : null;
    }
    set({ openFiles: next, activeFilePath: nextActive });
  },

  closeAllFiles: () => set({ openFiles: [], activeFilePath: null }),
  closeFiles: (paths) => {
    const closing = new Set(paths);
    const { openFiles, activeFilePath } = get();
    const next = openFiles.filter((f) => !closing.has(f.path));
    const nextActive = activeFilePath && !closing.has(activeFilePath)
      ? activeFilePath
      : next[next.length - 1]?.path ?? null;
    set({ openFiles: next, activeFilePath: nextActive });
  },
  moveOpenFile: (path, toIndex) => {
    const files = [...get().openFiles];
    const from = files.findIndex((f) => f.path === path);
    if (from < 0) return;
    const [moved] = files.splice(from, 1);
    files.splice(Math.max(0, Math.min(toIndex, files.length)), 0, moved);
    set({ openFiles: files });
  },
  toggleEditorWordWrap: () => set({ editorWordWrap: !get().editorWordWrap }),
  toggleEditorMinimap: () => set({ editorMinimap: !get().editorMinimap }),

  setActiveSelection: (selection) => set({ activeSelection: selection }),

  toggleBottomPanel: () => set({ bottomPanelOpen: !get().bottomPanelOpen }),
  toggleSidebar: () => set({ sidebarOpen: !get().sidebarOpen }),
  toggleHomeSidebar: () => set({ homeSidebarOpen: !get().homeSidebarOpen }),
  toggleStatusBar: () => {
    const statusBarVisible = !get().statusBarVisible;
    try {
      localStorage.setItem(STATUS_BAR_KEY, statusBarVisible ? 'visible' : 'hidden');
    } catch {
      // Not persisted; still applies to this session.
    }
    set({ statusBarVisible });
  },
  setSidebarView: (view) => set({ sidebarView: view, sidebarOpen: true }),
  toggleAgentPane: () => set({ agentPaneOpen: !get().agentPaneOpen }),
  setPreviewPaneOpen: (previewPaneOpen) => set({ previewPaneOpen }),
  setBottomPanelTab: (tab) => set({ bottomPanelTab: tab }),
  setLoading: (loading) => set({ isLoading: loading }),
  setCreatingItem: (item) => set({ creatingItem: item }),
  setRenamingItem: (item) => set({ renamingItem: item }),
  setSelectedExplorerPath: (item) => set({ selectedExplorerPath: item }),
  expandedFolders: {},
  toggleFolder: (path) => {
    const current = get().expandedFolders;
    set({
      expandedFolders: {
        ...current,
        [path]: !current[path],
      },
    });
  },
  updateDirectoryChildren: (path, children) => {
    const updateNode = (nodes: FileEntry[]): FileEntry[] => {
      return nodes.map((node) => {
        if (node.path === path) {
          return { ...node, children };
        }
        if (node.children) {
          return { ...node, children: updateNode(node.children) };
        }
        return node;
      });
    };
    set({ fileTree: updateNode(get().fileTree) });
  },
  mergeRootChildren: (newChildren) => {
    const currentTree = get().fileTree;
    const nextTree = newChildren.map(newChild => {
      const existing = currentTree.find(n => n.path === newChild.path);
      if (existing && existing.type === 'directory') {
        return { ...newChild, children: existing.children };
      }
      return newChild;
    });
    set({ fileTree: nextTree });
  },
}));
