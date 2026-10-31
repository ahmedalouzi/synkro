import chokidar, { type FSWatcher } from 'chokidar';
import type { BrowserWindow } from 'electron';
import { IPC_EVENTS } from '@peep/shared';

const IGNORED = /(^|[\\/])(\.git|node_modules|\.dart_tool|build|\.peep|\.atomvs)([\\/]|$)/;

export class FileWatcherService {
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private onChangeCallback: ((events: { type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string }[]) => void) | null = null;
  private batch: { type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string }[] = [];

  watch(
    projectPath: string,
    mainWindow: BrowserWindow | null,
    onChange: (events: { type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir'; path: string }[]) => void,
  ): void {
    this.stop();
    this.onChangeCallback = onChange;

    this.watcher = chokidar.watch(projectPath, {
      ignored: IGNORED,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    });

    const handleEvent = (type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir', rawPath: string) => {
      const normalizedPath = rawPath.replace(/\\/g, '/');
      this.batch.push({ type, path: normalizedPath });

      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => {
        if (this.batch.length > 0) {
          const eventsToEmit = [...this.batch];
          this.batch = [];
          this.onChangeCallback?.(eventsToEmit);
          mainWindow?.webContents.send(IPC_EVENTS.PREVIEW_LOG, `[watch] Processed ${eventsToEmit.length} file changes`);
        }
      }, 300);
    };

    this.watcher.on('change', (path) => handleEvent('change', path));
    this.watcher.on('add', (path) => handleEvent('add', path));
    this.watcher.on('unlink', (path) => handleEvent('unlink', path));
    this.watcher.on('addDir', (path) => handleEvent('addDir', path));
    this.watcher.on('unlinkDir', (path) => handleEvent('unlinkDir', path));
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.batch = [];
    void this.watcher?.close();
    this.watcher = null;
    this.onChangeCallback = null;
  }
}
