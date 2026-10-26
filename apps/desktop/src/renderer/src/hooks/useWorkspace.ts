import { useCallback } from 'react';
import type { ProjectInfo } from '@peep/shared';
import { useWorkspaceStore } from '../stores/workspace-store';

export function useWorkspace() {
  const store = useWorkspaceStore();

  const loadProject = useCallback(
    async (project: ProjectInfo) => {
      store.setProject(project);
      const [tree, recent] = await Promise.all([
        window.peep.listDir(project.path, 1),
        window.peep.getRecentProjects(),
      ]);
      store.setFileTree(tree);
      store.setRecentProjects(recent);
      return project;
    },
    [store],
  );

  const openProjectFolder = useCallback(async () => {
    store.setLoading(true);
    try {
      const project = await window.peep.openFolder();
      if (!project) return null;
      return loadProject(project);
    } finally {
      store.setLoading(false);
    }
  }, [store, loadProject]);

  const openProjectByPath = useCallback(
    async (path: string) => {
      store.setLoading(true);
      try {
        const project = await window.peep.openProjectByPath(path);
        return loadProject(project);
      } finally {
        store.setLoading(false);
      }
    },
    [store, loadProject],
  );

  const loadFile = useCallback(
    async (filePath: string, name: string) => {
      // Image files don't need text content — we render them via file:// URL
      const IMAGE_EXTS = new Set(['png','jpg','jpeg','gif','svg','webp','ico','bmp','tiff','avif']);
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      const isImage = IMAGE_EXTS.has(ext);

      const content = isImage ? '' : await window.peep.readFile(filePath);
      store.openFile({ path: filePath, name, content, dirty: false });
    },
    [store],
  );

  const saveActiveFile = useCallback(async () => {
    const { activeFilePath, openFiles } = store;
    if (!activeFilePath) return;

    const file = openFiles.find((f) => f.path === activeFilePath);
    if (!file) return;

    if (file.path.startsWith('untitled-')) {
      // Need to save as
      const newPath = await window.peep.saveFileAs(undefined, file.content);
      if (!newPath) return; // Cancelled
      store.closeFile(file.path);
      const name = newPath.split(/[\\/]/).pop() || 'Unknown';
      store.openFile({ path: newPath, name, content: file.content, dirty: false });
    } else {
      try {
        await window.peep.writeFile(file.path, file.content);
        store.markFileSaved(file.path, file.content);
      } catch (err) {
        console.error(err);
      }
    }
  }, [store]);

  const saveAllFiles = useCallback(async () => {
    const { openFiles } = store;
    for (const file of openFiles) {
      if (file.dirty) {
        if (!file.path.startsWith('untitled-')) {
          try {
            await window.peep.writeFile(file.path, file.content);
            store.markFileSaved(file.path, file.content);
          } catch (err) {
            console.error(err);
          }
        }
      }
    }
  }, [store]);

  const newTextFile = useCallback(() => {
    const id = `untitled-${Date.now()}.txt`;
    store.openFile({ path: id, name: 'Untitled', content: '', dirty: true });
  }, [store]);

  const openFileDialog = useCallback(async () => {
    const result = await window.peep.openFile();
    if (result) {
      const name = result.path.split(/[\\/]/).pop() || 'Unknown';
      store.openFile({ path: result.path, name, content: result.content, dirty: false });
    }
  }, [store]);

  const saveFileAs = useCallback(async () => {
    const { activeFilePath, openFiles } = store;
    if (!activeFilePath) return;

    const file = openFiles.find((f) => f.path === activeFilePath);
    if (!file) return;

    const newPath = await window.peep.saveFileAs(
      file.path.startsWith('untitled-') ? undefined : file.path, 
      file.content
    );
    if (!newPath) return;
    
    // Switch to new file
    store.closeFile(file.path);
    const name = newPath.split(/[\\/]/).pop() || 'Unknown';
    store.openFile({ path: newPath, name, content: file.content, dirty: false });
  }, [store]);

  const closeFolder = useCallback(() => {
    store.setProject(null);
    store.setFileTree([]);
    // Close all open files? Or keep them open? Better to close them.
    for (const file of store.openFiles) {
      store.closeFile(file.path);
    }
  }, [store]);

  return {
    ...store,
    openProjectFolder,
    openProjectByPath,
    syncProject: loadProject,
    loadFile,
    saveActiveFile,
    saveAllFiles,
    newTextFile,
    openFileDialog,
    saveFileAs,
    closeFolder,
    toggleSidebar: store.toggleSidebar,
    toggleAgentPane: store.toggleAgentPane,
    renameItem: window.peep.renameItem,
    deleteItem: window.peep.deleteItem,
    revealItem: window.peep.revealItem,
  };
}
