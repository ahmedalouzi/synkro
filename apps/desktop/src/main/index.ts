import './migrate-user-data';
import { app, BrowserWindow, Menu, shell } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupServices, registerIpcHandlers, setMainWindow } from './ipc';
import { config } from 'dotenv';
import * as Sentry from '@sentry/electron/main';
import log from 'electron-log/main';
import { resolveSentryDsn } from './build-config';

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

Sentry.init({
  dsn: resolveSentryDsn(),
  enabled: telemetryEnabled,
  beforeSend(event: any) {
    if (!telemetryEnabled) {
      return null;
    }

    if (event.request && event.request.data) {
      delete event.request.data;
    }
    
    const tokenRegex = /(Bearer\s+|session_token=)([a-zA-Z0-9\-_]+)/g;
    const apiKeyRegex = /AIza[0-9A-Za-z\-_]{35}|sk-[a-zA-Z0-9]{48}|sk-ant-[a-zA-Z0-9\-_]{90,}/g;

    const scrubString = (str: string) => {
      if (!str) return str;
      let res = str.replace(tokenRegex, '$1[REDACTED]');
      res = res.replace(apiKeyRegex, '[REDACTED_API_KEY]');
      res = res.replace(/(?:[A-Z]:\\[^\s]+|\/[^\s]+)[\\/]([^\s\\/]+)/g, '[REDACTED]/$1');
      return res;
    };

    if (event.breadcrumbs) {
      event.breadcrumbs.forEach((bc: any) => {
        if (bc.message) bc.message = scrubString(bc.message);
        if (bc.data) {
          for (const key in bc.data) {
            if (typeof bc.data[key] === 'string') {
              bc.data[key] = scrubString(bc.data[key]);
            }
          }
        }
      });
    }

    if (event.exception && event.exception.values) {
      event.exception.values.forEach((val: any) => {
        if (val.value) val.value = scrubString(val.value);
      });
    }
    
    return event;
  },
  beforeBreadcrumb(breadcrumb: any) {
    if (!telemetryEnabled) {
      return null;
    }
    return breadcrumb;
  },
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
      webviewTag: true,
    },
  });

  setMainWindow(mainWindow);

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    setMainWindow(null);
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  app.on('web-contents-created', (_e, contents) => {
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
    // Terminate any orphaned dart processes to release active sockets and lockfiles
    import('node:child_process').then(({ exec }) => {
      exec('taskkill /f /im dart.exe', () => {});
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
