import './migrate-user-data';
import { app, BrowserWindow, Menu } from 'electron';
import { handleWindowOpenSafely } from './safe-external';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { release } from 'node:os';
import { failureFingerprint, failureTags, scrubEvent, setFailureReporter } from '@peep/shared';
import { cleanupServices, processRegistry, registerIpcHandlers, setMainWindow } from './ipc';
import { stopLeftoverProcesses } from './services/process-registry';
import { config } from 'dotenv';
import * as Sentry from '@sentry/electron/main';
import log from 'electron-log/main';
import { resolveSentryDsn } from './build-config';
import { hideScrollbarsInPreviewFrames } from './preview-frames';

if (app.isPackaged) {
  // Release builds never read a .env and can't be switched into test mode from the environment.
  delete process.env.E2E_TESTING;
} else {
  config(); // Load .env from root
}

log.initialize();
log.transports.file.level = 'info';
log.transports.console.level = 'info';

function readSavedTelemetryOptIn(): boolean {
  try {
    const optInPath = join(app.getPath('userData'), 'telemetry', 'opt-in.json');
    if (existsSync(optInPath)) {
      const raw = readFileSync(optInPath, 'utf-8');
      const parsed = JSON.parse(raw) as { enabled?: boolean };
      if (typeof parsed?.enabled === 'boolean') {
        return parsed.enabled;
      }
    }
  } catch {
    // ignore
  }

  try {
    const storePath = join(app.getPath('userData'), 'peep-store.json');
    if (existsSync(storePath)) {
      const raw = readFileSync(storePath, 'utf-8');
      const parsed = JSON.parse(raw) as { settings?: { telemetryEnabled?: boolean } };
      if (typeof parsed?.settings?.telemetryEnabled === 'boolean') {
        return parsed.settings.telemetryEnabled;
      }
    }
  } catch {
    // ignore
  }

  return false;
}

let telemetryEnabled = readSavedTelemetryOptIn();

const REPORT_ENV = { appVersion: app.getVersion(), os: `${process.platform} ${release()} ${process.arch}` };

// Turning reports off stops ALL sending. The gate is on the transport, the one way out: events, sessions, minidumps
// and the envelopes the windows pass straight through (which skip beforeSend) all stop there. There is no disk
// queue (the SDK's default offline transport sends saved events at the next start, whatever the setting), so nothing
// captured before is sent later; a queue left by an older version is deleted.
try {
  rmSync(join(app.getPath('userData'), 'sentry', 'queue'), { recursive: true, force: true });
} catch {
  // ignore
}

Sentry.init({
  dsn: resolveSentryDsn(),
  enabled: telemetryEnabled,
  transport: (options) => {
    const net = Sentry.makeElectronTransport(options);
    return {
      send: (envelope) => (telemetryEnabled ? net.send(envelope) : Promise.resolve({})),
      flush: (timeout) => net.flush(timeout),
    };
  },
  release: `atomvs-desktop@${app.getVersion()}`,
  environment: app.isPackaged ? 'production' : 'development',
  sendDefaultPii: false,
  initialScope: { tags: { app_version: REPORT_ENV.appVersion, os: REPORT_ENV.os } },
  // Every event, from the main process and the windows, goes through the shared scrubber (packages/shared).
  beforeSend(event: any) {
    if (!telemetryEnabled) return null;
    return scrubEvent(event);
  },
  beforeBreadcrumb(breadcrumb: any) {
    if (!telemetryEnabled) return null;
    return breadcrumb;
  },
});

// Categorized failures (preview, agent tool crashes): fixed tags so they group by kind, framework, version and OS.
setFailureReporter((report) => {
  if (!telemetryEnabled) return;
  Sentry.withScope((scope) => {
    scope.setTags(failureTags(report, REPORT_ENV));
    scope.setFingerprint(failureFingerprint(report));
    if (report.extra) scope.setExtras(report.extra);
    if (report.error instanceof Error) {
      scope.setExtra('title', report.title);
      Sentry.captureException(report.error);
    } else {
      if (report.error !== undefined) scope.setExtra('detail', String(report.error));
      Sentry.captureMessage(report.title, 'error');
    }
  });
});

log.info(`[SENTRY] Initialized successfully (opt-in: ${telemetryEnabled})`);

export function syncSentryOptIn(enabled: boolean) {
  telemetryEnabled = enabled;
  const client = Sentry.getClient();
  if (client) {
    (client.getOptions() as any).enabled = enabled;
  }
  log.info(`[SENTRY] Telemetry ${enabled ? 'enabled' : 'disabled'}`);
}

// Suppress harmless Chromium GPU cache permission errors on Windows
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disable-gpu-program-cache');
}

let mainWindow: BrowserWindow | null = null;
let appServices: Awaited<ReturnType<typeof registerIpcHandlers>> | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    title: 'Atomvs',
    // Taskbar/window icon; in dev this replaces Electron's default. Packaged via electron-builder `files`.
    icon: join(__dirname, '../../resources/icons/icon.png'),
    backgroundColor: '#0d1117',
    autoHideMenuBar: true,
    // The renderer draws the title bar (menus, search, layout buttons) like Cursor/VS Code.
    // Windows/Linux keep the native window buttons as an overlay; macOS keeps its traffic lights.
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 12, y: 11 } }
      : { titleBarOverlay: { color: '#0f0f12', symbolColor: '#a1a1aa', height: 35 } }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Runs the preload in the preview iframe too, only for its safe-area shim; it exposes nothing there.
      nodeIntegrationInSubFrames: true,
      webviewTag: true,
    },
  });

  setMainWindow(mainWindow);
  hideScrollbarsInPreviewFrames(mainWindow.webContents);

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    setMainWindow(null);
    mainWindow = null;
  });

  // Links from window.open go to the browser only if they are https/http/mailto (safe-external.ts).
  handleWindowOpenSafely(mainWindow.webContents);

  app.on('web-contents-created', (_e, contents) => {
    // Every later window and <webview> (settings, detached preview, guests) gets the same rule.
    handleWindowOpenSafely(contents);
    contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      log.error(`[DID-FAIL-LOAD] Error Code: ${errorCode}, Description: ${errorDescription}, URL: ${validatedURL}`);
    });
    contents.on('console-message', (_e, _level, msg) => {
      if (msg.includes('error') || msg.includes('fail') || msg.includes('refused') || msg.includes('Content-Security-Policy')) {
        log.error(`[CONSOLE] ${msg}`);
      }
    });
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

import { setupPoCIpc } from './ipc/poc';

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.atomvs.desktop');
    // Stop the processes a previous run of Atomvs left behind (a crash or forced quit), by PID: only those, never
    // every dart.exe on the PC (that also stopped the user's own Flutter tools outside Atomvs).
    void stopLeftoverProcesses(processRegistry()).then((pids) => {
      if (pids.length) log.info(`[startup] Stopped ${pids.length} process(es) left over from the last run: ${pids.join(', ')}`);
    });
  }

  // The renderer draws its own VS Code-style menu bar and owns the keybindings, so drop
  // Electron's default menu (its accelerators steal Ctrl+W, Ctrl+R, …). macOS keeps a
  // minimal app/edit menu because native clipboard shortcuts depend on it there.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }])
      : null,
  );

  void registerIpcHandlers({ syncSentryOptIn }).then((services) => {
    appServices = services;
    createWindow();
    setupPoCIpc(mainWindow);
  });


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (appServices) {
    cleanupServices();
    appServices.processManager.killAll();
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (appServices) {
    cleanupServices();
    appServices.processManager.killAll();
  }
});
