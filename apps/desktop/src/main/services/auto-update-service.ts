import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { TelemetryService } from './telemetry-service';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'ready'
  | 'error';

export interface UpdateInfo {
  status: UpdateStatus;
  version?: string;
  percent?: number;
  error?: string;
}

const UPDATE_EVENT = 'app:updateStatus';

/**
 * Wraps electron-updater.
 * In dev mode (app.isPackaged === false) update checks are skipped to
 * avoid confusing errors about missing update-server config.
 */
export class AutoUpdateService {
  private mainWindow: BrowserWindow | null = null;
  private currentInfo: UpdateInfo = { status: 'idle' };

  constructor(private telemetry: TelemetryService) {}

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  init(): void {
    if (!app.isPackaged) {
      // Skip in dev — no publish config available
      this.send({ status: 'idle' });
      return;
    }

    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('checking-for-update', () => {
      this.send({ status: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      void this.telemetry.track('update_available', { version: String(info.version) });
      this.send({ status: 'available', version: String(info.version) });
    });

    autoUpdater.on('update-not-available', () => {
      this.send({ status: 'not-available' });
    });

    autoUpdater.on('download-progress', (progress) => {
      this.send({ status: 'downloading', percent: Math.round(progress.percent) });
    });

    autoUpdater.on('update-downloaded', (info) => {
      void this.telemetry.track('update_downloaded', { version: String(info.version) });
      this.send({ status: 'ready', version: String(info.version) });
    });

    autoUpdater.on('error', (err) => {
      this.send({ status: 'error', error: err.message });
    });

    // Check on startup after a short delay
    setTimeout(() => {
      void autoUpdater.checkForUpdates();
    }, 5000);
  }

  async checkForUpdates(): Promise<void> {
    if (!app.isPackaged) {
      // Explicit check from the UI: say why nothing happens instead of failing silently.
      this.send({ status: 'error', error: 'Updates are only checked in the installed app, not in development builds.' });
      return;
    }
    await autoUpdater.checkForUpdates();
  }

  async downloadAndInstall(): Promise<void> {
    if (!app.isPackaged) return;
    if (this.currentInfo.status === 'ready') {
      this.quitAndInstall();
    } else {
      await autoUpdater.downloadUpdate();
    }
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall();
  }

  getStatus(): UpdateInfo {
    return { ...this.currentInfo };
  }

  private send(info: UpdateInfo): void {
    this.currentInfo = info;
    this.mainWindow?.webContents.send(UPDATE_EVENT, info);
  }
}
