import { app, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log/main';
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
 *
 * The automatic check at startup is silent: no network, no published release yet, a GitHub rate limit or any
 * other failure is only logged, and a new version downloads in the background. The user hears about updates in
 * two cases only: an update is ready to install, or they pressed "Check for updates" (then every state shows,
 * errors included).
 */
export class AutoUpdateService {
  private mainWindow: BrowserWindow | null = null;
  private currentInfo: UpdateInfo = { status: 'idle' };
  /** The running check was started by the user, so its progress and errors are shown. */
  private userCheck = false;

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

    // Found in the background: download quietly, then say it is ready.
    autoUpdater.autoDownload = true;
    autoUpdater.logger = log;
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
      this.userCheck = false;
    });

    autoUpdater.on('download-progress', (progress) => {
      this.send({ status: 'downloading', percent: Math.round(progress.percent) });
    });

    autoUpdater.on('update-downloaded', (info) => {
      void this.telemetry.track('update_downloaded', { version: String(info.version) });
      this.send({ status: 'ready', version: String(info.version) });
      this.userCheck = false;
    });

    autoUpdater.on('error', (err) => {
      log.warn(`[updater] ${err.message}`);
      this.send({ status: 'error', error: err.message });
      this.userCheck = false;
    });

    // Check on startup after a short delay (silent; see the class comment).
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err: Error) => log.warn(`[updater] startup check: ${err.message}`));
    }, 5000);
  }

  async checkForUpdates(): Promise<void> {
    if (!app.isPackaged) {
      // Explicit check from the UI: say why nothing happens instead of failing silently.
      this.userCheck = true;
      this.send({ status: 'error', error: 'Updates are only checked in the installed app, not in development builds.' });
      this.userCheck = false;
      return;
    }
    this.userCheck = true;
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      // Also reported through the 'error' event; this keeps the IPC call from rejecting.
      log.warn(`[updater] check: ${(err as Error).message}`);
    }
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
    // Background check: only "ready" reaches the UI; the rest (checking, a background download, errors) is logged.
    if (!this.userCheck && !isShownWithoutAsking(info.status)) {
      log.info(`[updater] ${info.status}${info.version ? ` ${info.version}` : ''}${info.error ? `: ${info.error}` : ''}`);
      return;
    }
    this.currentInfo = info;
    this.mainWindow?.webContents.send(UPDATE_EVENT, info);
  }
}

/** States shown even when the user did not ask: an update is ready to install. Exported for tests. */
export function isShownWithoutAsking(status: UpdateStatus): boolean {
  return status === 'ready';
}
