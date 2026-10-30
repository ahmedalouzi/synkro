// QA Edit Injection Test - Concurrent Modification Triggered!
import { ipcMain, dialog, app, BrowserWindow, screen } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { IPC_CHANNELS, IPC_EVENTS } from '@peep/shared';
import type { ClaudeIdeStatus, ClaudeIdeToolResult, InlineCompletionRequest, InlineEditRequest, Settings, SshTarget } from '@peep/shared';
import { InlineEditService } from '../services/inline-edit-service';
import { InlineCompletionService } from '../services/inline-completion-service';
import { DatabaseService } from '../services/db';
import { WorkspaceManager } from '../services/workspace-manager';
import { ProcessManager } from '../services/process-manager';
import { FlutterService } from '../services/flutter-service';
import { PreviewManager } from '../services/preview-manager';
import { FileWatcherService } from '../services/file-watcher';
import { searchFiles } from '../services/file-search';
import { searchContent } from '../services/content-search';
import { AgentService } from '../services/agent-service';
import { GitService } from '../services/git-service';
import { openSshTerminal } from '../services/ssh-service';
import { readVsCodeSettings } from '../services/vscode-import';
import { TerminalService } from '../services/terminal-service';
import { ProjectService } from '../services/project-service';
import { TelemetryService } from '../services/telemetry-service';
import { AutoUpdateService } from '../services/auto-update-service';
import { CloudBuildService } from '../services/cloud-build-service';
import { ReactNativeService } from '../services/react-native-service';
import { ReactNativeManagedProvider } from '../services/providers/react-native-managed';
import { PlatformRegistry } from '../services/platform-registry';
import { buildAuditReport, capturePerformanceSnapshot } from '../services/audit-service';
import { ExtensionService } from '../services/extension-service';
import { ClaudeIdeServer } from '../services/claude-ide-server';
import { PublishService } from '../services/publish-service';
import { DeviceService } from '../services/device-service';


let db: DatabaseService | null = null;
let mainWindow: BrowserWindow | null = null;
let previewWindow: BrowserWindow | null = null;
let agentService: AgentService | null = null;
let publishService: PublishService | null = null;
let cloudBuildService: CloudBuildService | null = null;

const previewManager = new PreviewManager();
const fileWatcher = new FileWatcherService();
const gitService = new GitService();
const terminalService = new TerminalService();
const telemetryService = new TelemetryService();
let autoUpdateService: AutoUpdateService | null = null;
let rnService: ReactNativeService | null = null;
let platformRegistry: PlatformRegistry | null = null;
const extensionService = new ExtensionService();
const claudeIdeServer = new ClaudeIdeServer();

// Terminals Synkro opens let `claude` find and connect to this window, like VS Code's terminals do.
terminalService.setEnvProvider(() => {
  const port = claudeIdeServer.getPort();
  const cli = extensionService.findClaudeCli();
  const env: Record<string, string> = port ? { CLAUDE_CODE_SSE_PORT: String(port), ENABLE_IDE_INTEGRATION: 'true' } : {};
  return {
    env,
    pathDirs: cli ? [path.dirname(cli)] : [],
  };
});

export function setMainWindow(window: BrowserWindow | null): void {
  mainWindow = window;
  previewManager.setMainWindow(window);
  agentService?.setMainWindow(window);
  terminalService.setMainWindow(window);
  claudeIdeServer.setMainWindow(window);
  autoUpdateService?.setMainWindow(window);
  publishService?.setMainWindow(window);
}

import { globalIpcBatcher } from '../utils/ipc-batcher';
import { resolveGatewayUrl } from '../build-config';

function notifyGitChanged(): void {
  globalIpcBatcher.throttle(IPC_EVENTS.GIT_CHANGED, 500, () => {
    mainWindow?.webContents.send(IPC_EVENTS.GIT_CHANGED);
  });
}

async function runAnalyze(projectPath: string, flutter: FlutterService): Promise<void> {
  const diagnostics = await flutter.analyze(projectPath);
  mainWindow?.webContents.send(IPC_EVENTS.DIAGNOSTICS_UPDATED, diagnostics);
}

async function runRnAnalyze(projectPath: string, rn: ReactNativeService): Promise<void> {
  const diagnostics = await rn.analyze(projectPath);
  mainWindow?.webContents.send(IPC_EVENTS.DIAGNOSTICS_UPDATED, diagnostics);
}


async function openProjectAtPath(
  projectPath: string,
  workspace: WorkspaceManager,
  registry: PlatformRegistry,
  previewManager: PreviewManager,
  agentSvc: AgentService,
): Promise<Awaited<ReturnType<WorkspaceManager['openFolder']>>> {
  const project = await workspace.openFolder(projectPath);
  await onProjectOpened(project.path, registry, previewManager, agentSvc);
  notifyGitChanged();
  return project;
}

async function onProjectOpened(
  projectPath: string,
  registry: PlatformRegistry,
  previewManager: PreviewManager,
  agentSvc: AgentService,
): Promise<void> {
  const { provider, projectRoot } = await registry.detect(projectPath, { requireProject: true, timeoutMs: 2000 });
  if (!provider) return;

  fileWatcher.watch(projectPath, mainWindow, (events) => {
    setTimeout(() => {
      const session = previewManager.getSession();
      if (session && session.processId && session.status === 'running') {
        provider.reloadPreview(session.processId);
      }
    }, 500);
    
    // We can emit individual events to agentSvc if it expects them, or update agentSvc to handle batches.
    // For now, loop through and send to agentSvc
    for (const ev of events) {
      if (ev.type === 'add' || ev.type === 'change' || ev.type === 'unlink') {
        agentSvc.onFileChanged(projectPath, ev.type, ev.path);
      }
      if (ev.type === 'change') {
        mainWindow?.webContents.send(IPC_EVENTS.FILE_CHANGED, ev.path);
      }
    }
    
    mainWindow?.webContents.send('workspace:changed:batch', { events });
  });

  previewManager.start(projectRoot, provider).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    mainWindow?.webContents.send(IPC_EVENTS.PREVIEW_LOG, `[preview error] ${message}`);
  });
}

interface IpcDependencies {
  syncSentryOptIn: (enabled: boolean) => void;
}

export async function registerIpcHandlers({ syncSentryOptIn }: IpcDependencies): Promise<{
  db: DatabaseService;
  workspace: WorkspaceManager;
  flutter: FlutterService;
  processManager: ProcessManager;
  previewManager: PreviewManager;
  agentService: AgentService;
  gitService: GitService;
  terminalService: TerminalService;
  telemetryService: TelemetryService;
  autoUpdateService: AutoUpdateService;
}> {
  // IPC Validation Wrapper
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel: string, listener: (...args: any[]) => any) => {
    return originalHandle(channel, async (event, ...args) => {
      // Don't apply path traversal checks to text-heavy channels like chat/agent send
      if (channel === 'agent:send' || channel === 'chat:send') {
        return listener(event, ...args);
      }
      
      for (const arg of args) {
        if (typeof arg === 'string') {
          if (arg.includes('..') || arg.split(/[/\\]/).includes('..')) {
            throw new Error(`IPC Security Block: Traversal path argument not allowed in channel ${channel}`);
          }
        } else if (typeof arg === 'object' && arg !== null) {
          for (const [key, value] of Object.entries(arg)) {
            if (typeof value === 'string' && (value.includes('..') || value.split(/[/\\]/).includes('..'))) {
              if (key === 'message' || key === 'content' || key === 'prompt') continue; // Safe text fields
              throw new Error(`IPC Security Block: Traversal path argument key "${key}" not allowed in channel ${channel}`);
            }
          }
        }
      }
      return listener(event, ...args);
    });
  };

  db = new DatabaseService();
  await db.init();
  cloudBuildService = new CloudBuildService(db);

  await telemetryService.init();
  autoUpdateService = new AutoUpdateService(telemetryService);
  autoUpdateService.init();

  const workspace = new WorkspaceManager(db);
  const processManager = new ProcessManager();
  const settings = db.getSettingsRaw();
  processManager.setFlutterSdkPath(settings.flutterSdkPath);
  terminalService.setFlutterSdkPath(settings.flutterSdkPath);
  const flutter = new FlutterService(processManager, settings.flutterSdkPath);
  rnService = new ReactNativeService(processManager);
  platformRegistry = new PlatformRegistry();
  platformRegistry.register(flutter);
  platformRegistry.register(rnService);
  
  // Register the managed provider
  platformRegistry.register(new ReactNativeManagedProvider(processManager));

  publishService = new PublishService(processManager, platformRegistry);
  agentService = new AgentService(db, workspace, platformRegistry, terminalService);
  agentService.setMainWindow(mainWindow);
  const projectService = new ProjectService(platformRegistry, workspace);
  const deviceService = new DeviceService();

  ipcMain.handle(IPC_CHANNELS.DEVICE_GET_LIST, async () => {
    const sdkPath = db?.getSettingsRaw().flutterSdkPath;
    return deviceService.listDevices(sdkPath);
  });

  ipcMain.handle(IPC_CHANNELS.DEVICE_RUN, async (_event, deviceId: string, platformTarget: string, projectPath: string) => {
    const flutterBin = process.platform === 'win32' ? 'flutter.bat' : 'flutter';
    const sdkPath = db?.getSettingsRaw().flutterSdkPath;
    const command = sdkPath
      ? require('node:path').join(sdkPath, 'bin', flutterBin)
      : flutterBin;

    let args: string[] = [];
    if (platformTarget === 'flutter') {
      args = ['run', '-d', deviceId];
    } else {
      args = ['run-android', '--deviceId', deviceId];
    }

    const info = processManager.spawn(command, args, projectPath);

    const handleData = (chunk: Buffer) => {
      const text = chunk.toString();
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC_EVENTS.PREVIEW_LOG, line);
        }
      }
    };

    info.process.stdout?.on('data', handleData);
    info.process.stderr?.on('data', handleData);

    return { processId: info.id };
  });

  ipcMain.handle(IPC_CHANNELS.DIALOG_SELECT_FOLDER, async () => {
    const options = {
      properties: ['openDirectory' as const, 'createDirectory' as const],
      title: 'Select parent folder',
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_FOLDER, async () => {
    if (process.env.E2E_TESTING === '1') {
      const e2ePath = path.join(__dirname, '..', '..', '..', '..', 'e2e-fresh-workspace', 'TestFlow');
      const projectName = require('path').basename(e2ePath);
      const project: import('@peep/shared').ProjectInfo = {
        id: `local-${projectName}-${Date.now()}`,
        name: projectName,
        path: e2ePath,
        lastOpened: new Date().toISOString(),
        platform: 'react-native',
      };
      await db!.upsertProject(project);
      return project;
    }

    const options = {
      properties: ['openDirectory' as const],
      title: 'Open Flutter Project',
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    const project = await openProjectAtPath(result.filePaths[0], workspace, platformRegistry!, previewManager, agentService!);
    return project;
  });

  ipcMain.handle(IPC_CHANNELS.DIALOG_OPEN_FILE, async () => {
    const options = {
      properties: ['openFile' as const],
      title: 'Open File',
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    const filePath = result.filePaths[0];
    const content = await fs.promises.readFile(filePath, 'utf-8');
    return { path: filePath, content };
  });

  ipcMain.handle(IPC_CHANNELS.DIALOG_SAVE_FILE, async (_event, defaultPath?: string, content?: string) => {
    const options = {
      title: 'Save File',
      defaultPath,
    };
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);

    if (result.canceled || !result.filePath) {
      return null;
    }

    if (content !== undefined) {
      await fs.promises.writeFile(result.filePath, content, 'utf-8');
    }

    return result.filePath;
  });

  ipcMain.handle(IPC_CHANNELS.APP_NEW_WINDOW, () => {
    // Services in this process are bound to a single main window, so a new window
    // is a separate app instance (like VS Code's "New Window").
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const child = spawn(process.execPath, process.argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  });

  ipcMain.handle(IPC_CHANNELS.APP_EXIT, () => {
    app.quit();
  });

  ipcMain.handle(IPC_CHANNELS.APP_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.APP_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });

  ipcMain.handle(IPC_CHANNELS.APP_CLOSE_WINDOW, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle(IPC_CHANNELS.APP_RELOAD_WINDOW, (event) => {
    event.sender.reload();
  });

  ipcMain.handle(IPC_CHANNELS.APP_TOGGLE_FULLSCREEN, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.setFullScreen(!win.isFullScreen());
  });

  ipcMain.handle(IPC_CHANNELS.APP_TOGGLE_DEVTOOLS, (event) => {
    event.sender.toggleDevTools();
  });

  ipcMain.handle(IPC_CHANNELS.APP_ZOOM, (event, direction: 'in' | 'out' | 'reset') => {
    const contents = event.sender;
    if (direction === 'reset') {
      contents.setZoomLevel(0);
    } else {
      const next = contents.getZoomLevel() + (direction === 'in' ? 0.5 : -0.5);
      contents.setZoomLevel(Math.max(-8, Math.min(8, next)));
    }
  });

  const EDIT_ACTIONS = new Set(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
  ipcMain.handle(IPC_CHANNELS.APP_EDIT_ACTION, (event, action: string) => {
    if (!EDIT_ACTIONS.has(action)) return;
    (event.sender as any)[action]();
  });

  ipcMain.handle(IPC_CHANNELS.APP_SHOW_ABOUT, async (event) => {
    const os = require('node:os') as typeof import('node:os');
    const detail = [
      `Version: ${app.getVersion()}`,
      `Electron: ${process.versions.electron}`,
      `Chromium: ${process.versions.chrome}`,
      `Node.js: ${process.versions.node}`,
      `V8: ${process.versions.v8}`,
      `OS: ${os.type()} ${os.arch()} ${os.release()}`,
    ].join('\n');
    const win = BrowserWindow.fromWebContents(event.sender);
    const options = {
      type: 'info' as const,
      title: 'Atomvs',
      message: 'Atomvs',
      detail,
      buttons: ['Copy', 'OK'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const { response } = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options);
    if (response === 0) {
      const { clipboard } = require('electron') as typeof import('electron');
      clipboard.writeText(detail);
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_OPEN_FOLDER, async (_event, folderPath: string) => {
    return openProjectAtPath(folderPath, workspace, platformRegistry!, previewManager, agentService!);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_RECENT, () => {
    return workspace.getRecentProjects();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_PROJECT, () => {
    return workspace.getProject();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_DIR, async (_event, dirPath: string, maxDepth?: number) => {
    return workspace.listDir(dirPath, 0, maxDepth !== undefined ? maxDepth : 3);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SEARCH_CONTENT, async (_event, options: { projectPath: string; query: string; caseSensitive?: boolean; isRegex?: boolean }) => {
    return searchContent(options);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_READ_FILE, async (_event, filePath: string) => {
    return workspace.readFile(filePath);
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_LOAD_HISTORY, async (_event, projectPath: string) => {
    try {
      if (!path.isAbsolute(projectPath)) throw new Error('projectPath must be absolute');
      const registered = db!.getRecentProjects().some(p => p.path === projectPath);
      if (!registered) throw new Error('Untrusted project path');
      
      const chatJsonPath = path.join(projectPath, '.peep', 'chat.json');
      const content = await fs.promises.readFile(chatJsonPath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return null; // Return null (empty state) safely if missing or malformed
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_SAVE_HISTORY, async (_event, projectPath: string, state: any) => {
    try {
      if (!path.isAbsolute(projectPath)) throw new Error('projectPath must be absolute');
      const registered = db!.getRecentProjects().some(p => p.path === projectPath);
      if (!registered) throw new Error('Untrusted project path');

      const chatJsonPath = path.join(projectPath, '.peep', 'chat.json');
      await workspace.atomicWriteFile(chatJsonPath, JSON.stringify(state, null, 2));
    } catch (err) {
      console.error('Failed to save chat history:', err);
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_LIST_THREADS, async (_event, projectPath?: string) => {
    const settings = db!.getSettingsRaw();
    const gatewayUrl = resolveGatewayUrl(settings.gatewayUrl);
    try {
      const res = await fetch(`${gatewayUrl}/v1/threads`, {
        headers: { Authorization: `Bearer ${settings.sessionToken}` }
      });
      if (!res.ok) throw new Error('Failed to list threads');
      const data = await res.json();
      let threads = data.threads || [];
      if (projectPath) {
        const { performThreadMigration } = await import('./thread-migration');
        threads = await performThreadMigration(projectPath, settings, gatewayUrl, threads);
      }
      return threads;
    } catch (err: any) {
      console.error('List threads error:', err);
      return [];
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_LOAD_THREAD, async (_event, threadId: string) => {
    const settings = db!.getSettingsRaw();
    const gatewayUrl = resolveGatewayUrl(settings.gatewayUrl);
    try {
      const res = await fetch(`${gatewayUrl}/v1/threads/${threadId}`, {
        headers: { Authorization: `Bearer ${settings.sessionToken}` }
      });
      if (!res.ok) throw new Error('Failed to load thread');
      return await res.json();
    } catch (err: any) {
      console.error('Load thread error:', err);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_SAVE_THREAD, async (_event, threadId: string, messages: any[], title: string, runs?: any[]) => {
    const settings = db!.getSettingsRaw();
    const gatewayUrl = resolveGatewayUrl(settings.gatewayUrl);
    try {
      const res = await fetch(`${gatewayUrl}/v1/threads/${threadId}`, {
        method: 'POST',
        headers: { 
          Authorization: `Bearer ${settings.sessionToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ messages, title, runs })
      });
      if (!res.ok) {
        console.warn(`Thread save returned ${res.status}, ignoring for now.`);
        return null;
      }
      return await res.json();
    } catch (err: any) {
      console.warn('Save thread error (ignored):', err.message);
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_DELETE_THREAD, async (_event, threadId: string) => {
    const settings = db!.getSettingsRaw();
    const gatewayUrl = resolveGatewayUrl(settings.gatewayUrl);
    try {
      const res = await fetch(`${gatewayUrl}/v1/threads/${threadId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${settings.sessionToken}` }
      });
      if (!res.ok) throw new Error('Failed to delete thread');
      return true;
    } catch (err: any) {
      console.error('Delete thread error:', err);
      return false;
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_READ_IMAGE, async (_event, filePath: string) => {
    const buf = await fs.promises.readFile(filePath);
    const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
    const mimeMap: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
      ico: 'image/x-icon', bmp: 'image/bmp', avif: 'image/avif',
    };
    const mime = mimeMap[ext] ?? 'image/png';
    return `data:${mime};base64,${buf.toString('base64')}`;
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_WRITE_FILE, async (_event, filePath: string, content: string) => {
    await workspace.writeFile(filePath, content);
    const project = workspace.getProject();
    if (project) {
      const isFlutter = await flutter.isFlutterProject(project.path);
      const isRN = !isFlutter && (await rnService!.isReactNativeProject(project.path));
      if (isFlutter) {
        void runAnalyze(project.path, flutter);
        previewManager.reload();
      } else if (isRN) {
        void runRnAnalyze(project.path, rnService!);
        const session = previewManager.getSession();
        if (session && session.processId && session.status === 'running') {
          rnService!.reloadPreview(session.processId);
        }
      }
      notifyGitChanged();
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE_DIR, async (_event, dirPath: string) => {
    await workspace.createDir(dirPath);
    const project = workspace.getProject();
    if (project) {
      notifyGitChanged();
    }
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_RENAME_ITEM, async (_event, oldPath: string, newPath: string) => {
    await workspace.renameItem(oldPath, newPath);
    if (workspace.getProject()) notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_DELETE_ITEM, async (_event, path: string) => {
    await workspace.deleteItem(path);
    if (workspace.getProject()) notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REVEAL_ITEM, async (_event, path: string) => {
    await workspace.revealItem(path);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SEARCH_FILES, async (_event, rootPath: string, query: string, includeDirectories?: boolean) => {
    return searchFiles(rootPath, query, 50, includeDirectories === true);
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET, () => {
    return db!.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SETTINGS_SET, async (_event, partial: Partial<Settings>) => {
    await db!.setSettings(partial);
    if ('flutterSdkPath' in partial) {
      flutter.setSdkPath(partial.flutterSdkPath);
      processManager.setFlutterSdkPath(partial.flutterSdkPath);
      terminalService.setFlutterSdkPath(partial.flutterSdkPath);
    }
    return db!.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, () => {
    return app.getVersion();
  });

  ipcMain.handle(IPC_CHANNELS.FLUTTER_DETECT_SDK, () => {
    return flutter.detectSdk();
  });

  ipcMain.handle(IPC_CHANNELS.FLUTTER_ANALYZE, async (_event, projectPath: string) => {
    const diagnostics = await flutter.analyze(projectPath);
    mainWindow?.webContents.send(IPC_EVENTS.DIAGNOSTICS_UPDATED, diagnostics);
    return diagnostics;
  });

  ipcMain.handle(IPC_CHANNELS.FLUTTER_PUB_GET, async (_event, projectPath: string) => {
    await flutter.pubGet(projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_START, async (_event, projectPath: string) => {
    return previewManager.start(projectPath, flutter);
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_STOP, () => {
    previewManager.stop();
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_RELOAD, () => {
    previewManager.reload();
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_GET_SESSION, () => {
    return previewManager.getSession();
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_IS_DETACHED, () => {
    return previewWindow !== null && !previewWindow.isDestroyed();
  });

  let currentDetachedDeviceId = 'iphone-15';

  /** Detached window size that shows the whole device frame (portrait phones and wide foldables alike). */
  const detachedWindowSize = (frame?: { width: number; height: number }) => {
    // DetachedPreview chrome: 44px header + 32px margin on each axis.
    const chromeW = 32;
    const chromeH = 44 + 32;
    if (!frame || frame.width <= 0 || frame.height <= 0) return { width: 400, height: 820 };
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const maxW = workArea.width * 0.8 - chromeW;
    const maxH = workArea.height * 0.85 - chromeH;
    // Up to the device's natural (1x) size; smaller only when the screen can't fit it.
    const scale = Math.min(1, maxW / frame.width, maxH / frame.height);
    return {
      width: Math.round(frame.width * scale + chromeW),
      height: Math.round(frame.height * scale + chromeH),
    };
  };

  const loadDetachedPreview = (win: BrowserWindow) => {
    const isDev = !app.isPackaged && process.env.ELECTRON_RENDERER_URL;
    if (isDev) {
      void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?windowType=preview&deviceId=${currentDetachedDeviceId}`);
    } else {
      void win.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { windowType: 'preview', deviceId: currentDetachedDeviceId } });
    }
  };

  ipcMain.handle(IPC_CHANNELS.PREVIEW_DETACH, async (_event, deviceId?: string, frame?: { width: number; height: number }) => {
    const deviceChanged = !!deviceId && deviceId !== currentDetachedDeviceId;
    if (deviceId) {
      currentDetachedDeviceId = deviceId;
    }
    const size = detachedWindowSize(frame);

    if (previewWindow && !previewWindow.isDestroyed()) {
      // Already detached: switch to the newly selected device and fit the window to it.
      if (deviceChanged) {
        previewWindow.setSize(size.width, size.height, true);
        loadDetachedPreview(previewWindow);
      }
      previewWindow.focus();
      return;
    }

    previewWindow = new BrowserWindow({
      width: size.width,
      height: size.height,
      minWidth: 240,
      minHeight: 320,
      title: 'Atomvs Mobile Preview',
      backgroundColor: '#00000000',
      transparent: true,
      frame: false,
      hasShadow: true,
      webPreferences: {
        preload: path.join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: true,
      },
    });

    loadDetachedPreview(previewWindow);

    previewWindow.on('closed', () => {
      previewWindow = null;
      // Broadcast state update that preview is attached back
      const session = previewManager.getSession();
      if (session) {
        previewManager.setSession({ ...session });
      }
    });
  });

  ipcMain.handle(IPC_CHANNELS.PREVIEW_ATTACH, () => {
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.close();
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_SEND, async (_event, options) => {
    await agentService!.send(options);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL, () => {
    agentService!.cancel();
  });

    // @ts-ignore
  ipcMain.handle(IPC_CHANNELS.AGENT_APPROVE_PLAN, async (_event, projectPath?: string) => {
    // @ts-ignore
    await agentService!.approvePlan(projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_RESTORE_CHECKPOINT, async (_event, id: string) => {
    return agentService!.restoreCheckpoint(id);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_APPLY_EDITS, async (_event, editIds: string[]) => {
    await agentService!.applyEdits(editIds);
    const project = workspace.getProject();
    if (project) {
      const isFlutter = await flutter.isFlutterProject(project.path);
      const isRN = !isFlutter && (await rnService!.isReactNativeProject(project.path));
      if (isFlutter) {
        previewManager.reload();
      } else if (isRN) {
        const session = previewManager.getSession();
        if (session && session.processId && session.status === 'running') {
          rnService!.reloadPreview(session.processId);
        }
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_REJECT_EDITS, async (_event, editIds?: string[]) => {
    await agentService!.rejectEdits(editIds);
    const project = workspace.getProject();
    if (project) {
      const isFlutter = await flutter.isFlutterProject(project.path);
      const isRN = !isFlutter && (await rnService!.isReactNativeProject(project.path));
      if (isFlutter) {
        previewManager.reload();
      } else if (isRN) {
        const session = previewManager.getSession();
        if (session && session.processId && session.status === 'running') {
          rnService!.reloadPreview(session.processId);
        }
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_GET_PENDING_EDITS, () => {
    return agentService!.getPendingEdits();
  });

  ipcMain.handle(IPC_CHANNELS.GIT_STATUS, async (_event, projectPath: string) => {
    return gitService.status(projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_INIT, async (_event, projectPath: string) => {
    await gitService.init(projectPath);
    notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.GIT_STAGE, async (_event, projectPath: string, files: string[]) => {
    await gitService.stage(projectPath, files);
    notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.GIT_UNSTAGE, async (_event, projectPath: string, files: string[]) => {
    await gitService.unstage(projectPath, files);
    notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.GIT_COMMIT, async (_event, projectPath: string, message: string) => {
    await gitService.commit(projectPath, message);
    notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.GIT_DIFF, async (_event, projectPath: string, filePath: string) => {
    return gitService.diff(projectPath, filePath);
  });

  ipcMain.handle(IPC_CHANNELS.GIT_PULL, async (_event, projectPath: string) => {
    await gitService.pull(projectPath);
    notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.GIT_PUSH, async (_event, projectPath: string) => {
    await gitService.push(projectPath);
    notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.GIT_CHECKOUT, async (_event, projectPath: string, branch: string) => {
    await gitService.checkoutBranch(projectPath, branch);
    notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.GIT_BRANCH, async (_event, projectPath: string, branch: string) => {
    await gitService.createBranch(projectPath, branch);
    notifyGitChanged();
  });

  ipcMain.handle(IPC_CHANNELS.GIT_CLONE, async (_event, url: string, parentDir: string) => {
    return gitService.clone(url, parentDir);
  });

  ipcMain.handle(IPC_CHANNELS.SSH_OPEN_TERMINAL, async (_event, target: SshTarget) => {
    openSshTerminal(target);
  });

  ipcMain.handle(IPC_CHANNELS.VSCODE_READ_SETTINGS, async () => readVsCodeSettings());

  ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, async (_event, options: { id: string; cwd: string; cols?: number; rows?: number }) => {
    terminalService.create(options.id, options.cwd, options.cols, options.rows);
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_RESIZE, async (_event, id: string, cols: number, rows: number) => {
    terminalService.resize(id, cols, rows);
  });

  const inlineCompletions = new InlineCompletionService(() => db);
  ipcMain.handle(IPC_CHANNELS.AI_INLINE_COMPLETE, (_event, request: InlineCompletionRequest) => {
    return inlineCompletions.complete(request);
  });
  ipcMain.handle(IPC_CHANNELS.AI_INLINE_CANCEL, () => {
    inlineCompletions.cancel();
  });

  const inlineEdits = new InlineEditService(() => db);
  ipcMain.handle(IPC_CHANNELS.AI_INLINE_EDIT, (_event, request: InlineEditRequest) => {
    return inlineEdits.edit(request);
  });
  ipcMain.handle(IPC_CHANNELS.AI_INLINE_EDIT_CANCEL, () => {
    inlineEdits.cancel();
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_WRITE, async (_event, id: string, data: string) => {
    terminalService.write(id, data);
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_DESTROY, async (_event, id: string) => {
    terminalService.destroy(id);
  });

  ipcMain.handle(IPC_CHANNELS.RUN_COMMAND, async (_event, options: { command: string; cwd: string }) => {
    return terminalService.runCommand(options.command, options.cwd);
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_LIST_TEMPLATES, () => {
    return projectService.listTemplates();
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE, async (_event, options) => {
    const projectPath = await projectService.createFromTemplate(options);
    return openProjectAtPath(projectPath, workspace, platformRegistry!, previewManager, agentService!);
  });

  ipcMain.handle(IPC_CHANNELS.PROJECT_CREATE_FROM_PROMPT, async (_event, options) => {
    const projectPath = await projectService.createFromTemplate({
      name: options.name,
      parentPath: options.parentPath,
      templateId: 'blank',
    });

    mainWindow?.webContents.send(IPC_EVENTS.AGENT_STREAM, {
      type: 'status',
      content: 'Scaffolding project with AI…',
    });

    await agentService!.scaffold(projectPath, options.prompt);
    return openProjectAtPath(projectPath, workspace, platformRegistry!, previewManager, agentService!);
  });

  // ── Telemetry ──────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.TELEMETRY_GET, () => {
    return telemetryService.isEnabled();
  });

  ipcMain.handle(IPC_CHANNELS.TELEMETRY_SET, async (_event, enabled: boolean) => {
    await telemetryService.setEnabled(enabled);
    syncSentryOptIn(enabled);
    await db!.setSettings({ telemetryEnabled: enabled });
  });

  // ── Auto-update ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.UPDATE_CHECK, async () => {
    await autoUpdateService!.checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_INSTALL, async () => {
    await autoUpdateService!.downloadAndInstall();
  });

  ipcMain.handle(IPC_CHANNELS.UPDATE_GET_STATUS, () => {
    return autoUpdateService!.getStatus();
  });

  // ── Onboarding ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.ONBOARDING_COMPLETE, async () => {
    await db!.setSettings({ onboardingCompleted: true });
    void telemetryService.track('onboarding_completed');
  });

  // ── Extensions ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_SEARCH, async (_event, query: string, offset?: number, size?: number) => {
    return extensionService.searchExtensions(query, offset, size);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_INSTALLED, async () => {
    return extensionService.getInstalledExtensions();
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_INSTALL, async (_event, id: string, url?: string) => {
    return extensionService.installExtension(id, url);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_UNINSTALL, async (_event, id: string) => {
    return extensionService.uninstallExtension(id);
  });

  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_DETAILS, async (_event, id: string) => {
    return extensionService.getExtensionDetails(id);
  });

  // ── Claude Code IDE integration ─────────────────────────────────────────────

  void claudeIdeServer.start().catch((error) => console.error('[ClaudeIde] failed to start:', error));

  ipcMain.handle(IPC_CHANNELS.CLAUDE_IDE_RESPOND, async (_event, requestId: string, result: ClaudeIdeToolResult) => {
    claudeIdeServer.respond(requestId, result);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_IDE_NOTIFY, async (_event, method: string, params: unknown) => {
    claudeIdeServer.notify(method, params);
  });

  ipcMain.handle(IPC_CHANNELS.CLAUDE_IDE_SET_WORKSPACE, async (_event, folders: string[]) => {
    claudeIdeServer.setWorkspaceFolders(Array.isArray(folders) ? folders : []);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTS_LIST, async () => extensionService.listAgents());

  ipcMain.handle(IPC_CHANNELS.AGENTS_RESOLVE_CLI, async (_event, extensionId: string) =>
    extensionService.ensureAgentCli(extensionId).catch(() => null));

  ipcMain.handle(IPC_CHANNELS.CLAUDE_IDE_STATUS, async (): Promise<ClaudeIdeStatus> => ({
    port: claudeIdeServer.getPort(),
    connected: claudeIdeServer.isConnected(),
    cliPath: await extensionService.ensureClaudeCli().catch(() => null),
  }));

  // ── Auth ─────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_IN, async (_event, email, password) => {
    const settings = db!.getSettingsRaw();
    const gatewayUrl = resolveGatewayUrl(settings.gatewayUrl);
    try {
      const res = await fetch(`${gatewayUrl}/v1/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Login failed');
      
      await db!.setSettings({
        sessionToken: data.sessionToken,
        refreshToken: data.refreshToken
      });
      return { success: true };
    } catch (err: any) {
      console.error('[AUTH_SIGN_IN] Fetch failed:', {
        message: err.message,
        cause: err.cause,
        code: err.code,
        url: `${gatewayUrl}/v1/auth/signin`
      });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_SIGN_UP, async (_event, email, password) => {
    const settings = db!.getSettingsRaw();
    const gatewayUrl = resolveGatewayUrl(settings.gatewayUrl);
    try {
      const res = await fetch(`${gatewayUrl}/v1/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || 'Sign up failed');
      
      await db!.setSettings({
        sessionToken: data.sessionToken,
        refreshToken: data.refreshToken
      });
      return { success: true };
    } catch (err: any) {
      console.error('[AUTH_SIGN_UP] Fetch failed:', {
        message: err.message,
        cause: err.cause,
        code: err.code,
        url: `${gatewayUrl}/v1/auth/signup`
      });
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async () => {
    const settings = db!.getSettingsRaw();
    const gatewayUrl = resolveGatewayUrl(settings.gatewayUrl);
    try {
      if (settings.sessionToken) {
        await fetch(`${gatewayUrl}/v1/auth/logout`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.sessionToken}`
          },
          body: JSON.stringify({ refreshToken: settings.refreshToken })
        });
      }
    } catch {
      // Ignore network errors on logout
    } finally {
      await db!.setSettings({ sessionToken: '', refreshToken: '' });
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_GET_ACCOUNT, async () => {
    const settings = db!.getSettingsRaw();
    if (!settings.sessionToken) return null;
    const gatewayUrl = resolveGatewayUrl(settings.gatewayUrl);
    try {
      const res = await fetch(`${gatewayUrl}/v1/account/status`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${settings.sessionToken}`
        }
      });
      if (res.status === 401 && settings.refreshToken) {
        // Try refresh
        const refreshRes = await fetch(`${gatewayUrl}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: settings.refreshToken })
        });
        if (refreshRes.ok) {
          const data = await refreshRes.json();
          await db!.setSettings({ sessionToken: data.sessionToken, refreshToken: data.refreshToken });
          // Retry
          const retryRes = await fetch(`${gatewayUrl}/v1/account/status`, {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${data.sessionToken}`
            }
          });
          if (retryRes.ok) return retryRes.json();
        } else {
          // Token reuse or expired refresh token
          await db!.setSettings({ sessionToken: '', refreshToken: '' });
          return null;
        }
      }
      if (res.ok) {
        return await res.json();
      }
      return null;
    } catch {
      return null;
    }
  });

  // ── React Native ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PLATFORM_DETECT, async (_event, projectPath: string) => {
    return platformRegistry!.detect(projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.RN_DETECT_PROJECT, async (_event, projectPath: string) => {
    return rnService!.isReactNativeProject(projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.RN_GET_PROJECT_INFO, async (_event, projectPath: string) => {
    return rnService!.getProjectInfo(projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.RN_INSTALL, async (_event, projectPath: string) => {
    await rnService!.install(projectPath);
  });

  ipcMain.handle(IPC_CHANNELS.RN_ANALYZE, async (_event, projectPath: string) => {
    const diagnostics = await rnService!.analyze(projectPath);
    mainWindow?.webContents.send(IPC_EVENTS.DIAGNOSTICS_UPDATED, diagnostics);
    return diagnostics;
  });

  ipcMain.handle(IPC_CHANNELS.RN_START_PREVIEW, async (_event, projectPath: string) => {
    console.log('[DEBUG_RUNTIME] IPC RN_START_PREVIEW invoked');
    console.log('[DEBUG_RUNTIME] original projectPath:', projectPath);
    
    // Use strict mode with a 15-second bounded retry to wait for package.json to appear
    const { provider, projectRoot } = await platformRegistry!.detect(projectPath, {
      requireProject: true,
      timeoutMs: 15000
    });
    
    console.log('[DEBUG_RUNTIME] detected projectRoot:', projectRoot);
    if (!provider) {
      console.log('[DEBUG_RUNTIME] PROJECT_NOT_READY: No valid project detected at', projectPath);
      throw new Error(`PROJECT_NOT_READY: No valid project detected in workspace: ${projectPath}`);
    }
    
    console.log('[DEBUG_RUNTIME] Calling previewManager.start with projectRoot');
    return previewManager.start(projectRoot, provider);
  });

  ipcMain.handle(IPC_CHANNELS.RN_STOP_PREVIEW, async (_event, _projectPath: string) => {
    previewManager.stop();
  });

  ipcMain.handle(IPC_CHANNELS.RN_RELOAD_PREVIEW, async (_event, _projectPath: string) => {
    previewManager.reload();
  });



  // ── Audit / Performance ────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.AUDIT_PERFORMANCE, async () => {
    return capturePerformanceSnapshot();
  });

  ipcMain.handle(IPC_CHANNELS.AUDIT_PROJECT, async (_event, projectPath?: string) => {
    const root = projectPath ?? workspace.getProject()?.path;
    return buildAuditReport(root);
  });

  // ── Publish ───────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.PUBLISH_GET_STATUS, () => {
    return publishService?.getStatus() ?? { status: 'idle', message: 'Publishing not ready', logs: [] };
  });

  ipcMain.handle(IPC_CHANNELS.PUBLISH_CANCEL, () => {
    publishService?.cancel();
  });

  ipcMain.handle(IPC_CHANNELS.PUBLISH_DEPLOY, async (_event, projectPath: string, _platform: 'flutter' | 'react-native', target: 'vercel' | 'netlify', token?: string) => {
    if (!publishService) throw new Error('Publish service not initialized');
    return publishService.buildAndDeploy(projectPath, target, token);
  });

  // ── Cloud Build ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC_CHANNELS.CLOUD_BUILD_START, async (_event, workspacePath: string, framework: string, target: string) => {
    if (!cloudBuildService) throw new Error('Cloud build service not initialized');
    const build = await cloudBuildService.startBuild(workspacePath, framework, target);
    cloudBuildService.startLogStream(build.id, mainWindow!);
    return build;
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_BUILD_GET, async (_event, id: string) => {
    if (!cloudBuildService) throw new Error('Cloud build service not initialized');
    return cloudBuildService.getBuild(id);
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_BUILD_HISTORY, async () => {
    if (!cloudBuildService) throw new Error('Cloud build service not initialized');
    return cloudBuildService.getHistory();
  });

  ipcMain.handle(IPC_CHANNELS.CLOUD_BUILD_CANCEL, async (_event, id: string) => {
    if (!cloudBuildService) throw new Error('Cloud build service not initialized');
    return cloudBuildService.cancelBuild(id);
  });

  return { db, workspace, flutter, processManager, previewManager, agentService, gitService, terminalService, telemetryService, autoUpdateService: autoUpdateService! };
}

export function cleanupServices(): void {
  fileWatcher.stop();
  previewManager.stop();
  agentService?.cancel();
  publishService?.cancel();
  terminalService.destroyAll();
  claudeIdeServer.stop();
}
