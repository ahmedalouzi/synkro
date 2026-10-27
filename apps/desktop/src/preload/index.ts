import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS, IPC_EVENTS } from '@peep/shared';
import type {
  SshTarget,
  AgentSendOptions,
  AgentStreamEvent,
  Diagnostic,
  GitDiffResult,
  GitStatusResult,
  IpcApi,
  PreviewSession,
  ProjectInfo,
  ProposedEdit,
  RunCommandResult,
  Settings,
  TerminalCreateOptions,
  UpdateInfo,
  ConnectedDevice,
} from '@peep/shared';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const handler = (_event: unknown, payload: T) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: IpcApi = {
  openFolder: () => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FOLDER) as Promise<ProjectInfo | null>,
  openFile: () => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_OPEN_FILE) as Promise<{ path: string; content: string } | null>,
  saveFileAs: (defaultPath, content) => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SAVE_FILE, defaultPath, content) as Promise<string | null>,
  newWindow: () => ipcRenderer.invoke(IPC_CHANNELS.APP_NEW_WINDOW),
  exitApp: () => ipcRenderer.invoke(IPC_CHANNELS.APP_EXIT),
  minimizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.APP_MINIMIZE),
  maximizeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.APP_MAXIMIZE),
  closeWindow: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CLOSE_WINDOW),
  reloadWindow: () => ipcRenderer.invoke(IPC_CHANNELS.APP_RELOAD_WINDOW),
  toggleFullScreen: () => ipcRenderer.invoke(IPC_CHANNELS.APP_TOGGLE_FULLSCREEN),
  toggleDevTools: () => ipcRenderer.invoke(IPC_CHANNELS.APP_TOGGLE_DEVTOOLS),
  zoom: (direction) => ipcRenderer.invoke(IPC_CHANNELS.APP_ZOOM, direction),
  editAction: (action) => ipcRenderer.invoke(IPC_CHANNELS.APP_EDIT_ACTION, action),
  showAbout: () => ipcRenderer.invoke(IPC_CHANNELS.APP_SHOW_ABOUT),
  openProjectByPath: (path: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_OPEN_FOLDER, path) as Promise<ProjectInfo>,
  getRecentProjects: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_RECENT),
  listDir: (dirPath: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_DIR, dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_READ_FILE, filePath),
  readImage: (filePath: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_READ_IMAGE, filePath) as Promise<string>,
  writeFile: (filePath: string, content: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_WRITE_FILE, filePath, content),
  createDir: (dirPath: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE_DIR, dirPath),
  renameItem: (oldPath: string, newPath: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_RENAME_ITEM, oldPath, newPath),
  deleteItem: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_DELETE_ITEM, path),
  revealItem: (path: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REVEAL_ITEM, path),
  getProject: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_PROJECT),
  searchFiles: (rootPath: string, query: string, includeDirectories?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SEARCH_FILES, rootPath, query, includeDirectories),
  searchContent: (opts) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SEARCH_CONTENT, opts),
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET) as Promise<Settings>,
  setSettings: (settings: Partial<Settings>) =>
    ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, settings) as Promise<Settings>,
  getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION) as Promise<string>,
  detectFlutterSdk: () => ipcRenderer.invoke(IPC_CHANNELS.FLUTTER_DETECT_SDK),
  analyzeProject: (projectPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FLUTTER_ANALYZE, projectPath) as Promise<Diagnostic[]>,
  pubGet: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.FLUTTER_PUB_GET, projectPath),
  startPreview: (projectPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_START, projectPath) as Promise<PreviewSession>,
  rnStartPreview: (projectPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RN_START_PREVIEW, projectPath) as Promise<PreviewSession>,
  stopPreview: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_STOP),
  rnStopPreview: (processId: number) => ipcRenderer.invoke(IPC_CHANNELS.RN_STOP_PREVIEW, processId),
  reloadPreview: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_RELOAD),
  rnReloadPreview: (processId: number) => ipcRenderer.invoke(IPC_CHANNELS.RN_RELOAD_PREVIEW, processId),
  getPreviewSession: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_GET_SESSION) as Promise<PreviewSession | null>,
  detachPreview: (deviceId?: string, frame?: { width: number; height: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_DETACH, deviceId, frame) as Promise<void>,
  attachPreview: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_ATTACH) as Promise<void>,
  isPreviewDetached: () => ipcRenderer.invoke(IPC_CHANNELS.PREVIEW_IS_DETACHED) as Promise<boolean>,
  sendAgentMessage: (options: AgentSendOptions) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_SEND, options),
  cancelAgent: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_CANCEL),
  approvePlan: (projectPath?: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_APPROVE_PLAN, projectPath),
  applyAgentEdits: (editIds: string[]) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_APPLY_EDITS, editIds),
  rejectAgentEdits: (editIds?: string[]) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_REJECT_EDITS, editIds),
  getPendingEdits: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_GET_PENDING_EDITS) as Promise<ProposedEdit[]>,
  getGitStatus: (projectPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STATUS, projectPath) as Promise<GitStatusResult>,
  gitInit: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_INIT, projectPath),
  gitStage: (projectPath: string, files: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_STAGE, projectPath, files),
  gitUnstage: (projectPath: string, files: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_UNSTAGE, projectPath, files),
  gitCommit: (projectPath: string, message: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_COMMIT, projectPath, message),
  gitDiff: (projectPath: string, filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GIT_DIFF, projectPath, filePath) as Promise<GitDiffResult>,
  gitPull: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_PULL, projectPath),
  gitPush: (projectPath: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_PUSH, projectPath),
  gitCheckout: (projectPath: string, branch: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_CHECKOUT, projectPath, branch),
  gitBranch: (projectPath: string, branch: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_BRANCH, projectPath, branch),
  gitClone: (url: string, parentDir: string) => ipcRenderer.invoke(IPC_CHANNELS.GIT_CLONE, url, parentDir),
  openSshTerminal: (target: SshTarget) => ipcRenderer.invoke(IPC_CHANNELS.SSH_OPEN_TERMINAL, target),
  readVsCodeSettings: () => ipcRenderer.invoke(IPC_CHANNELS.VSCODE_READ_SETTINGS),
  createTerminal: (options: TerminalCreateOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_CREATE, options),
  writeTerminal: (id: string, data: string) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_WRITE, id, data),
  destroyTerminal: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_DESTROY, id),
  resizeTerminal: (id: string, cols: number, rows: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_RESIZE, id, cols, rows),
  inlineComplete: (request) => ipcRenderer.invoke(IPC_CHANNELS.AI_INLINE_COMPLETE, request) as Promise<string>,
  cancelInlineCompletion: () => ipcRenderer.invoke(IPC_CHANNELS.AI_INLINE_CANCEL),
  inlineEdit: (request) => ipcRenderer.invoke(IPC_CHANNELS.AI_INLINE_EDIT, request) as Promise<import('@peep/shared').InlineEditResult>,
  cancelInlineEdit: () => ipcRenderer.invoke(IPC_CHANNELS.AI_INLINE_EDIT_CANCEL),
  restoreCheckpoint: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_RESTORE_CHECKPOINT, id) as Promise<string[]>,
  onAgentCheckpoint: (callback) => subscribe<{ id: string; fileCount: number }>(IPC_EVENTS.AGENT_CHECKPOINT, callback),
  runCommand: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.RUN_COMMAND, options) as Promise<RunCommandResult>,
  listProjectTemplates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_LIST_TEMPLATES) as Promise<import('@peep/shared').ProjectTemplateInfo[]>,
  createProject: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE, options) as Promise<ProjectInfo>,
  createProjectFromPrompt: (options) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROJECT_CREATE_FROM_PROMPT, options) as Promise<ProjectInfo>,
  loadChatHistory: (projectPath) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_LOAD_HISTORY, projectPath),
  saveChatHistory: (projectPath, state) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SAVE_HISTORY, projectPath, state),
  listChatThreads: (projectPath?: string) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_LIST_THREADS, projectPath),
  loadChatThread: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_LOAD_THREAD, threadId),
  saveChatThread: (threadId, messages, title, runs) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SAVE_THREAD, threadId, messages, title, runs),
  deleteChatThread: (threadId) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_DELETE_THREAD, threadId),
  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER) as Promise<string | null>,
  getTelemetryEnabled: () => ipcRenderer.invoke(IPC_CHANNELS.TELEMETRY_GET) as Promise<boolean>,
  setTelemetryEnabled: (enabled: boolean) => ipcRenderer.invoke(IPC_CHANNELS.TELEMETRY_SET, enabled),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_CHECK),
  downloadAndInstall: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_INSTALL),
  getUpdateStatus: () => ipcRenderer.invoke(IPC_CHANNELS.UPDATE_GET_STATUS) as Promise<UpdateInfo>,
  completeOnboarding: () => ipcRenderer.invoke(IPC_CHANNELS.ONBOARDING_COMPLETE), // Wait, ONBOARDING_COMPLETE
  getPerformanceInfo: () => ipcRenderer.invoke(IPC_CHANNELS.AUDIT_PERFORMANCE),
  publishGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.PUBLISH_GET_STATUS) as Promise<import('@peep/shared').PublishStatus>,
  publishDeploy: (projectPath: string, platform: 'flutter' | 'react-native', target: 'vercel' | 'netlify', token?: string) => ipcRenderer.invoke(IPC_CHANNELS.PUBLISH_DEPLOY, projectPath, platform, target, token) as Promise<void>,
  publishCancel: () => ipcRenderer.invoke(IPC_CHANNELS.PUBLISH_CANCEL) as Promise<void>,
  getConnectedDevices: () => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_GET_LIST) as Promise<ConnectedDevice[]>,
  startDeviceRun: (deviceId: string, platformTarget: string, projectPath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_RUN, deviceId, platformTarget, projectPath) as Promise<{ processId: number }>,
  onPreviewStatus: (callback) => subscribe<PreviewSession>(IPC_EVENTS.PREVIEW_STATUS, callback),
  onDiagnostics: (callback) => subscribe<Diagnostic[]>(IPC_EVENTS.DIAGNOSTICS_UPDATED, callback),
  onPreviewLog: (callback) => subscribe<string>(IPC_EVENTS.PREVIEW_LOG, callback),
  onAgentStream: (callback) => subscribe<AgentStreamEvent>(IPC_EVENTS.AGENT_STREAM, callback),
  // @ts-ignore - TS cache issue with IpcApi missing onAgentActivity
  onAgentActivity: (callback: any) => subscribe<any>('agent:activity', callback),
  // @ts-ignore
  onAgentTimeline: (callback: any) => subscribe<any>(IPC_EVENTS.AGENT_TIMELINE, callback),
  onAgentPhase: (callback: (phase: import('@peep/shared').AgentPhase) => void) =>
    subscribe<import('@peep/shared').AgentPhase>(IPC_EVENTS.AGENT_PHASE_CHANGED, callback),
  onProposedEdits: (callback) => subscribe<ProposedEdit[]>(IPC_EVENTS.AGENT_PROPOSED_EDITS, callback),
  onTerminalOutput: (callback) =>
    subscribe<{ id: string; data: string }>(IPC_EVENTS.TERMINAL_OUTPUT, callback),
  onTerminalExit: (callback) => subscribe<{ id: string; code: number }>(IPC_EVENTS.TERMINAL_EXIT, callback),
  claudeIdeRespond: (requestId, result) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_IDE_RESPOND, requestId, result),
  claudeIdeNotify: (method, params) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_IDE_NOTIFY, method, params),
  claudeIdeSetWorkspace: (folders) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_IDE_SET_WORKSPACE, folders),
  getClaudeIdeStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_IDE_STATUS),
  listAgents: () => ipcRenderer.invoke(IPC_CHANNELS.AGENTS_LIST),
  resolveAgentCli: (extensionId) => ipcRenderer.invoke(IPC_CHANNELS.AGENTS_RESOLVE_CLI, extensionId),
  onClaudeIdeRequest: (callback) => subscribe<import('@peep/shared').ClaudeIdeRequest>(IPC_EVENTS.CLAUDE_IDE_REQUEST, callback),
  onGitChanged: (callback) => subscribe<void>(IPC_EVENTS.GIT_CHANGED, callback),
  onWorkspaceChangedBatch: (callback) => subscribe<any>('workspace:changed:batch', callback),
  onUpdateStatus: (callback) => subscribe<UpdateInfo>(IPC_EVENTS.APP_UPDATE_STATUS, callback),
  // Extensions
  searchExtensions: (query, offset, size) => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_SEARCH, query, offset, size) as Promise<import('@peep/shared').ExtensionSearchResult>,
  getInstalledExtensions: () => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_INSTALLED) as Promise<import('@peep/shared').ExtensionInfo[]>,
  installExtension: (id, url) => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_INSTALL, id, url) as Promise<void>,
  uninstallExtension: (id) => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_UNINSTALL, id) as Promise<void>,
  getExtensionDetails: (id) => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_DETAILS, id) as Promise<any>,
  // Auth
  authSignIn: (email, password) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_SIGN_IN, email, password),
  authSignUp: (email, password) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_SIGN_UP, email, password),
  authLogout: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_LOGOUT),
  authGetAccount: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_ACCOUNT),
  onPublishStatus: (callback: (status: import('@peep/shared').PublishStatus) => void) => subscribe<import('@peep/shared').PublishStatus>(IPC_EVENTS.PUBLISH_STATUS, callback),
  onPublishLog: (callback: (line: string) => void) => subscribe<string>(IPC_EVENTS.PUBLISH_LOG, callback),
  onOpenFile: (callback: (payload: { path: string; name: string; content: string; dirty: boolean }) => void) => subscribe<{ path: string; name: string; content: string; dirty: boolean }>('open:file', callback),
  onFileChanged: (callback: (path: string) => void) => subscribe<string>(IPC_EVENTS.FILE_CHANGED, callback),
  onAuthSessionExpired: (callback: () => void) => subscribe<void>(IPC_EVENTS.AUTH_SESSION_EXPIRED, callback),
  onPlanUpdated: (callback: (plan: any) => void) => subscribe<any>('workspace:plan-updated', callback),
  // PoC
  pocToggle: (visible: boolean) => ipcRenderer.invoke('peep:poc-toggle', { visible }),
  pocBounds: (bounds: any) => ipcRenderer.send('peep:poc-bounds', bounds),
  // Cloud Build
  startCloudBuild: (workspacePath: string, framework: string, target: string) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_BUILD_START, workspacePath, framework, target),
  getCloudBuild: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_BUILD_GET, id),
  cancelCloudBuild: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_BUILD_CANCEL, id),
  getCloudBuildHistory: () => ipcRenderer.invoke(IPC_CHANNELS.CLOUD_BUILD_HISTORY),
  onBuildLogChunk: (callback: (payload: { id: string; chunk: string }) => void) => subscribe<{ id: string; chunk: string }>(IPC_EVENTS.BUILD_LOG_CHUNK, callback),
};

contextBridge.exposeInMainWorld('peep', {
  ...api,
  getInspectorPreloadPath: () => require('path').join(__dirname, 'inspector.js'),
});
