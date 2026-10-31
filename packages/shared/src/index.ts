export type PlatformTarget = 'flutter' | 'react-native' | 'expo' | 'unknown';


export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileEntry[];
}

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  lastOpened: string;
  platform: PlatformTarget;
}

export interface RnProjectInfo {
  nodeVersion: string;
  hasExpo: boolean;
  hasReactNative: boolean;
  rnVersion?: string;
  expoVersion?: string;
}


export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface PreviewSession {
  url: string;
  processId: number;
  status: 'starting' | 'running' | 'stopped' | 'error';
  error?: string;
}

export type ErrorCategory =
  | 'success'
  | 'warning'
  | 'compile_error'
  | 'type_error'
  | 'lint_error'
  | 'dependency_error'
  | 'configuration_error'
  | 'runtime_error'
  | 'environment_error'
  | 'timeout'
  | 'unknown_error';

export interface ValidationCheck {
  type: string;
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  errors?: any[];
  _testGateway?: any;
}

export interface ValidationResult {
  success: boolean;
  framework: string;
  environment: string;
  checks: ValidationCheck[];
  blockingErrors: number;
  warnings: number;
  errorCategory: ErrorCategory;
  message?: string;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  /** Agent run that produced this assistant message; links it to its timeline steps. */
  runId?: string;
}

export interface ProposedEdit {
  id: string;
  path: string;
  originalContent: string;
  proposedContent: string;
  description?: string;
}

export interface AgentStreamEvent {
  type: 'status' | 'delta' | 'done' | 'error' | 'activity';
  content: string;
  threadId?: string;
}

export interface AgentActivityEvent {
  provider: string;
  selectedModel: string;
  actualModel: string;
  task: string;
  iteration: number;
  maxIterations: number | 'Dynamic';
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface PersistedChatState {
  messages: AgentMessage[];
  timelineActivities: AgentTimelineActivity[];
  updatedAt: string;
}

/**
 * Runtime execution phase of the agent within a single send() invocation.
 * Distinct from the task-level AgentState in design/task-state.ts.
 */
export type AgentPhase =
  | 'idle'
  | 'initializing'
  | 'thinking'
  | 'tool_executing'
  | 'summarizing'
  | 'done'
  | 'cancelled'
  | 'error';

export type AgentTimelineActivityType =
  | 'understanding' | 'exploring' | 'searching' | 'reading'
  | 'editing' | 'creating' | 'deleting' | 'running'
  | 'validating' | 'completed' | 'error';

export interface AgentTimelineActivity {
  id: string;
  runId: string;
  threadId?: string;
  type: AgentTimelineActivityType;
  message: string;
  status: 'in_progress' | 'completed' | 'failed';
  timestamp: string;
  file?: string;
  files?: string[];
  command?: string;
  count?: number;
}

export interface BuildResult {
  success: boolean;
  framework: string;
  environment: string;
  platform: string;
  outputPath?: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  duration?: number;
  errorCategory?: ErrorCategory;
  message?: string;
}

export interface TestResult {
  success: boolean;
  status: 'passed' | 'failed' | 'not_configured' | 'error';
  message?: string;
  stdout?: string;
  stderr?: string;
}

export interface AppStartResult {
  success: boolean;
  processId: number;
  sessionId?: string;
  status: string;
  previewUrl?: string;
  message?: string;
  errorCategory?: ErrorCategory;
}

export interface RuntimeError {
  type: 'RUNTIME_ERROR' | 'BUILD_ERROR' | 'NETWORK_ERROR' | 'DEPENDENCY_ERROR' | 'UNKNOWN';
  message: string;
  file?: string;
  line?: number;
  stackTrace?: string;
  severity: 'error' | 'warning' | 'fatal';
}

export interface AppStatusResult {
  processId: number;
  status: 'starting' | 'running' | 'degraded' | 'error' | 'crashed' | 'stopped' | 'exited' | 'unknown';
  command: string;
  framework: string;
  environment: string;
  startedAt: string;
  exitCode: number | null;
}

export interface AppLogsResult {
  processId: number;
  status: string;
  stdout: string;
  stderr: string;
  logs: string[];
  detectedErrors: RuntimeError[];
}

export interface AgentUsageLog {
  requestId: string;
  sessionId: string;
  taskId: string;
  provider: string;
  model: string;
  timestamp: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
  latencyMs: number;
  success: boolean;
}

export interface Settings {
  flutterSdkPath?: string;
  theme: 'dark' | 'light';
  autoSave: boolean;
  capabilityTier?: CapabilityTier;
  /** @deprecated Use sessionToken + ProductionAIGateway instead. Provider API keys must not be stored on the client. */
  apiProvider?: 'openai' | 'anthropic' | 'google';
  /** @deprecated Never store provider API keys on the client. */
  apiKey?: string;
  /** @deprecated Use ModelTier routing via the gateway instead. */
  apiModel?: string;
  /** @deprecated */
  apiKeyConfigured?: boolean;
  onboardingCompleted?: boolean;
  telemetryEnabled?: boolean;
  /** Session Bearer token for authenticating with ProductionAIGateway. Never a provider API key. */
  sessionToken?: string;
  /** Base URL for the Synkro AI Gateway backend. */
  gatewayUrl?: string;
  /** Refresh token for session recovery. */
  refreshToken?: string;
  /** Indicates whether a session token is currently present. */
  sessionConfigured?: boolean;
  /** Local AI Provider configuration. */
  aiProvider?: string;
  /** Secret API Key for the Local AI Provider. */
  aiProviderApiKey?: string;
  aiProviderApiKeyConfigured?: boolean;
  /** Developer Mode enables advanced or experimental settings, like Local AI. */
  developerMode?: boolean;
  /** Active UI and Agent language locale ('en' default, 'ar', or 'tr'). */
  locale?: 'en' | 'ar' | 'tr';
}

export type UpdateStatus = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'ready' | 'error';

export type PlanStepStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type RecoveryErrorCategory =
  | 'missing_dependency'
  | 'missing_file'
  | 'wrong_directory'
  | 'preview_failure'
  | 'type_error'
  | 'syntax_error'
  | 'port_conflict'
  | 'transient'
  | 'unrecoverable'
  | 'verification_failure';

export interface NormalizedError {
  toolName: string;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  message: string;
  category: RecoveryErrorCategory;
  timestamp: string;
  affectedFiles?: string[];
  impactRadius?: string[];
}

export interface RecoveryAttempt {
  attempt: number;
  strategy: string;
  error: NormalizedError;
  status: 'pending' | 'success' | 'failed';
  timestamp: string;
}

export interface DependencyGraph {
  imports: Record<string, string[]>;
  exports: Record<string, string[]>;
  dependents: Record<string, string[]>;
  fileHashes: Record<string, string>;
  unresolved: Record<string, string[]>;
  lastIndexedAt: string;
}

export interface AgentPlanStep {
  id: string;
  description: string;
  status: PlanStepStatus;
  attempts?: number;
  maxRetries?: number;
  lastError?: string;
  required?: boolean;
  currentStrategy?: string;
  relevantFiles?: string[];
  impactRadius?: string[];
  history?: RecoveryAttempt[];
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  status: 'pending' | 'verifying' | 'verified' | 'failed' | 'not_verifiable';
  verificationMethod: 'test' | 'typecheck' | 'build' | 'ui_structural' | 'visual' | 'manual';
  linkedStepIds?: string[];
  history?: VerificationAttempt[];
}

export interface VerificationAttempt {
  status: 'verifying' | 'verified' | 'failed';
  verificationMethod: string;
  commandOrAction?: string;
  outputSummary?: string;
  timestamp: string;
  evidence?: string;
}

export interface AgentPlan {
  taskId: string;
  goal: string;
  complexity: 'simple' | 'medium' | 'complex';
  steps: AgentPlanStep[];
  acceptanceCriteria?: AcceptanceCriterion[];
  status?: 'in_progress' | 'completed' | 'failed';
  updatedAt?: string;
}

export interface UpdateInfo {
  status: UpdateStatus;
  version?: string;
  percent?: number;
  error?: string;
}

export interface SdkInfo {
  path: string;
  version: string;
}

/** An image attached to a user message (screenshot, design mockup…). */
export interface ChatImage {
  /** e.g. image/png */
  mimeType: string;
  /** Base64 data without the `data:` prefix. */
  data: string;
}

/** Code around the cursor for Tab autocomplete (ghost text). */
export interface InlineCompletionRequest {
  filePath: string;
  language: string;
  /** Text before the cursor. */
  prefix: string;
  /** Text after the cursor. */
  suffix: string;
}

/** Ctrl+K inline edit: rewrite `selection` (may be empty = insert) following `instruction`. */
export interface InlineEditRequest {
  /** Used to load project rules. */
  projectPath?: string;
  filePath: string;
  language: string;
  instruction: string;
  before: string;
  selection: string;
  after: string;
}

export type InlineEditResult = { text: string } | { error: string };

/** Context attached to a chat message with `@` (Cursor-style mentions). */
export type AgentMention =
  | { kind: 'file'; path: string }
  | { kind: 'folder'; path: string }
  | { kind: 'code'; filePath: string; startLine: number; endLine: number; text: string }
  | { kind: 'problems' }
  | { kind: 'terminal'; text: string }
  | { kind: 'gitDiff' };

export interface AgentSendOptions {
  threadId?: string;
  message: string;
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
  projectPath?: string;
  openFilePath?: string;
  openFileContent?: string;
  _testGateway?: AIGateway;
  selectedCode?: {
    text: string;
    startLine: number;
    endLine: number;
    filePath: string;
  };
  diagnostics?: Diagnostic[];
  /** Images pasted or dropped into the chat. */
  images?: ChatImage[];
  /** Id of the user message; the agent's file changes for it can be restored later. */
  checkpointId?: string;
  /** Context the user attached with `@`; resolved and appended to the user message. */
  mentions?: AgentMention[];
  autoApplyEdits?: boolean;
  scaffoldMode?: boolean;
  previewError?: string;
  /** Controls plan-approval UX:
   * - 'approve'  → user clicked "Proceed with Implementation"
   * - 'refine'   → user is modifying the plan before approval
   * - 'normal'   → default, no special handling
   */
  planApprovalMode?: 'approve' | 'refine' | 'normal' | 'auto';
  locale?: 'en' | 'ar' | 'tr';
}

export interface ProjectTemplateInfo {
  id: string;
  name: string;
  description: string;
}

export interface CreateProjectOptions {
  name: string;
  parentPath: string;
  templateId: string;
  mode?: 'beginner' | 'advanced';
  framework?: 'react-native' | 'flutter';
}

export interface CreateProjectFromPromptOptions {
  name: string;
  parentPath: string;
  prompt: string;
  mode?: 'beginner' | 'advanced';
  framework?: 'react-native' | 'flutter';
}

export interface MobileEnvironment {
  framework: 'react-native' | 'flutter';
  environment: 'managed' | 'local' | 'cloud';
  mode: 'beginner' | 'advanced';
  capabilities: {
    localSdk: boolean;
    terminal: boolean;
    preview: boolean;
    androidBuild: boolean;
    iosBuild: boolean;
  };
}

export interface GitFileChange {
  path: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'staged';
  staged: boolean;
}

export interface GitStatusResult {
  isRepo: boolean;
  branch: string;
  changes: GitFileChange[];
}

export interface GitDiffResult {
  path: string;
  diff: string;
}

/** A tool call from the Claude Code CLI that the editor answers (see ClaudeIdeServer). */
export interface ClaudeIdeRequest {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
}

/** MCP tool result: text blocks sent back to Claude. */
export interface ClaudeIdeToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

/** An installed coding-agent extension (Claude Code, Codex, ...) that opens in an editor tab. */
export interface AgentInfo {
  extensionId: string;
  name: string;
  iconUrl?: string;
  /** The bundled CLI, or null when the build on disk is for another platform. */
  cliPath: string | null;
  /** Arguments to start the CLI with. */
  args: string[];
}

export interface ClaudeIdeStatus {
  /** Port of the local server Claude connects to; 0 when it isn't running. */
  port: number;
  connected: boolean;
  /** The `claude` executable Synkro found (bundled with the extension or on PATH), or null. */
  cliPath: string | null;
}

export interface TerminalCreateOptions {
  id: string;
  cwd: string;
  cols?: number;
  rows?: number;
}

export interface RunCommandOptions {
  command: string;
  cwd: string;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ExtensionInfo {
  id: string;           // "ms-python.python"
  name: string;
  namespace: string;
  version: string;
  displayName?: string;
  description?: string;
  iconUrl?: string;
  downloadCount?: number;
  averageRating?: number;
  downloadUrl?: string;
  installed: boolean;
}

export interface ExtensionSearchResult {
  extensions: ExtensionInfo[];
  totalSize: number;
  offset: number;
}

/** Editor settings read from VS Code's settings.json (only those Synkro supports). */
export interface VsCodeSettingsImport {
  found: boolean;
  path: string;
  settings: { autoSave?: boolean; wordWrap?: boolean; minimap?: boolean };
}

export interface SshTarget {
  host: string;
  user?: string;
  port?: number;
  identityFile?: string;
}

export const IPC_CHANNELS = {
  WORKSPACE_OPEN_FOLDER: 'workspace:openFolder',
  WORKSPACE_GET_RECENT: 'workspace:getRecent',
  WORKSPACE_LIST_DIR: 'workspace:listDir',
  WORKSPACE_READ_FILE: 'workspace:readFile',
  WORKSPACE_READ_IMAGE: 'workspace:readImage',
  WORKSPACE_WRITE_FILE: 'workspace:writeFile',
  WORKSPACE_CREATE_DIR: 'workspace:createDir',
  WORKSPACE_RENAME_ITEM: 'workspace:renameItem',
  WORKSPACE_DELETE_ITEM: 'workspace:deleteItem',
  WORKSPACE_REVEAL_ITEM: 'workspace:revealItem',
  WORKSPACE_GET_PROJECT: 'workspace:getProject',
  WORKSPACE_SEARCH_FILES: 'workspace:searchFiles',
  WORKSPACE_SEARCH_CONTENT: 'workspace:searchContent',
  WORKSPACE_SET_FILE_DIRTY: 'workspace:setFileDirty',
  CHAT_LOAD_HISTORY: 'chat:loadHistory',
  CHAT_SAVE_HISTORY: 'chat:saveHistory',
  CHAT_LIST_THREADS: 'chat:listThreads',
  CHAT_LOAD_THREAD: 'chat:loadThread',
  CHAT_SAVE_THREAD: 'chat:saveThread',
  CHAT_DELETE_THREAD: 'chat:deleteThread',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  SETTINGS_OPEN_WINDOW: 'settings:openWindow',
  APP_GET_VERSION: 'app:getVersion',
  APP_NEW_WINDOW: 'app:newWindow',
  APP_EXIT: 'app:exit',
  APP_MINIMIZE: 'app:minimize',
  APP_MAXIMIZE: 'app:maximize',
  APP_CLOSE_WINDOW: 'app:closeWindow',
  APP_RELOAD_WINDOW: 'app:reloadWindow',
  APP_TOGGLE_FULLSCREEN: 'app:toggleFullScreen',
  APP_TOGGLE_DEVTOOLS: 'app:toggleDevTools',
  APP_ZOOM: 'app:zoom',
  APP_EDIT_ACTION: 'app:editAction',
  APP_SHOW_ABOUT: 'app:showAbout',
  DIALOG_OPEN_FOLDER: 'dialog:openFolder',
  DIALOG_OPEN_FILE: 'dialog:openFile',
  DIALOG_SAVE_FILE: 'dialog:saveFile',
  FLUTTER_DETECT_SDK: 'flutter:detectSdk',
  FLUTTER_ANALYZE: 'flutter:analyze',
  FLUTTER_PUB_GET: 'flutter:pubGet',
  PREVIEW_START: 'preview:start',
  PREVIEW_STOP: 'preview:stop',
  PREVIEW_RELOAD: 'preview:reload',
  AGENT_SEND: 'agent:send',
  AGENT_CANCEL: 'agent:cancel',
  AGENT_APPROVE_PLAN: 'agent:approvePlan',
  AGENT_APPLY_EDITS: 'agent:applyEdits',
  AGENT_REJECT_EDITS: 'agent:rejectEdits',
  AGENT_GET_PENDING_EDITS: 'agent:getPendingEdits',
  AGENT_ACTIVITY: 'agent:activity',
  GIT_STATUS: 'git:status',
  GIT_INIT: 'git:init',
  GIT_STAGE: 'git:stage',
  GIT_UNSTAGE: 'git:unstage',
  GIT_COMMIT: 'git:commit',
  GIT_DIFF: 'git:diff',
  GIT_PULL: 'git:pull',
  GIT_PUSH: 'git:push',
  GIT_CHECKOUT: 'git:checkout',
  GIT_BRANCH: 'git:branch',
  GIT_CLONE: 'git:clone',
  SSH_OPEN_TERMINAL: 'ssh:openTerminal',
  VSCODE_READ_SETTINGS: 'vscode:readSettings',
  TERMINAL_CREATE: 'terminal:create',
  TERMINAL_WRITE: 'terminal:write',
  TERMINAL_DESTROY: 'terminal:destroy',
  TERMINAL_RESIZE: 'terminal:resize',
  AI_INLINE_COMPLETE: 'ai:inlineComplete',
  AI_INLINE_CANCEL: 'ai:inlineCancel',
  AI_INLINE_EDIT: 'ai:inlineEdit',
  AI_INLINE_EDIT_CANCEL: 'ai:inlineEditCancel',
  AGENT_RESTORE_CHECKPOINT: 'agent:restoreCheckpoint',
  RUN_COMMAND: 'terminal:runCommand',
  PROJECT_LIST_TEMPLATES: 'project:listTemplates',
  PROJECT_CREATE: 'project:create',
  PROJECT_CREATE_FROM_PROMPT: 'project:createFromPrompt',
  DIALOG_SELECT_FOLDER: 'dialog:selectFolder',
  TELEMETRY_GET: 'telemetry:get',
  TELEMETRY_SET: 'telemetry:set',
  UPDATE_CHECK: 'update:check',
  UPDATE_INSTALL: 'update:install',
  UPDATE_GET_STATUS: 'update:getStatus',
  ONBOARDING_COMPLETE: 'onboarding:complete',
  // React Native
  RN_DETECT_PROJECT: 'rn:detectProject',
  RN_GET_PROJECT_INFO: 'rn:getProjectInfo',
  RN_INSTALL: 'rn:install',
  RN_ANALYZE: 'rn:analyze',
  RN_START_PREVIEW: 'rn:startPreview',
  RN_STOP_PREVIEW: 'rn:stopPreview',
  RN_RELOAD_PREVIEW: 'rn:reloadPreview',
  // Platform
  PLATFORM_DETECT: 'platform:detect',
  // Audit
  AUDIT_PERFORMANCE: 'audit:performance',
  AUDIT_PROJECT: 'audit:project',
  // Preview Detached Window
  PREVIEW_GET_SESSION: 'preview:getSession',
  PREVIEW_DETACH: 'preview:detach',
  PREVIEW_ATTACH: 'preview:attach',
  PREVIEW_IS_DETACHED: 'preview:isDetached',
  // Extensions
  EXTENSIONS_SEARCH: 'extensions:search',
  // Auth
  AUTH_SIGN_IN: 'auth:signIn',
  AUTH_SIGN_UP: 'auth:signUp',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_GET_ACCOUNT: 'auth:getAccount',
  EXTENSIONS_INSTALLED: 'extensions:installed',
  EXTENSIONS_INSTALL: 'extensions:install',
  EXTENSIONS_UNINSTALL: 'extensions:uninstall',
  EXTENSIONS_DETAILS: 'extensions:details',
  // Claude Code IDE integration
  CLAUDE_IDE_RESPOND: 'claudeIde:respond',
  CLAUDE_IDE_NOTIFY: 'claudeIde:notify',
  CLAUDE_IDE_SET_WORKSPACE: 'claudeIde:setWorkspace',
  CLAUDE_IDE_STATUS: 'claudeIde:status',
  AGENTS_LIST: 'agents:list',
  AGENTS_RESOLVE_CLI: 'agents:resolveCli',
  // Publish
  PUBLISH_GET_STATUS: 'publish:getStatus',
  PUBLISH_DEPLOY: 'publish:deploy',
  PUBLISH_EAS_BUILD: 'publish:easBuild',
  PUBLISH_DETECT_DEPS: 'publish:detectDeps',
  PUBLISH_BUILD: 'publish:build',
  PUBLISH_CANCEL: 'publish:cancel',
  DEVICE_GET_LIST: 'device:getList',
  DEVICE_RUN: 'device:run',
  PUBLISH_GET_BUILD: 'publish:getBuild',
  PUBLISH_LIST_BUILDS: 'publish:listBuilds',
  PUBLISH_OPEN_FOLDER: 'publish:openFolder',
  PUBLISH_EXPORT_PROJECT: 'publish:exportProject',
  // Cloud Build
  CLOUD_BUILD_START: 'cloudBuild:start',
  CLOUD_BUILD_GET: 'cloudBuild:get',
  CLOUD_BUILD_HISTORY: 'cloudBuild:history',
  CLOUD_BUILD_CANCEL: 'cloudBuild:cancel',
  CLOUD_BUILD_DOWNLOAD_TOKEN: 'cloudBuild:downloadToken',
} as const;

export interface ConnectedDevice {
  id: string;
  name: string;
  platform: 'android' | 'ios' | 'web' | 'macos' | 'windows' | 'linux';
  type: 'physical' | 'emulator';
}

// ── Cloud Build Types ────────────────────────────────────────────────────────
export type CloudBuildFramework = 'flutter' | 'react-native';
export type CloudBuildStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type CloudBuildTarget = 'apk' | 'aab' | 'both';

export interface CloudBuildJob {
  id: string;
  userId: string;
  projectId: string;
  framework: CloudBuildFramework;
  target: CloudBuildTarget;
  status: CloudBuildStatus;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  buildDurationMs?: number;
  errorLog?: string;
  artifactUrl?: string;
  artifactSizeBytes?: number;
  downloadToken?: string;
  downloadExpiresAt?: number;
}

// ── Publish / Build types ─────────────────────────────────────────────────────

export interface PublishStatus {
  status: 'idle' | 'building' | 'deploying' | 'completed' | 'error';
  progress?: number;
  message: string;
  url?: string;
  logs: string[];
}

export type BuildStatus =
  | 'idle'
  | 'waiting'
  | 'preparing'
  | 'building'
  | 'packaging'
  | 'signing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type BuildTarget = 'apk' | 'aab' | 'both';

export interface PublishOptions {
  projectPath: string;
  target: BuildTarget;
  versionName?: string;  // e.g. "1.0.0"
  versionCode?: number;  // e.g. 1
}

export interface BuildArtifact {
  type: 'apk' | 'aab';
  path: string;
  sizeBytes: number;
}

export interface BuildRecord {
  id: string;
  projectPath: string;
  target: BuildTarget;
  status: BuildStatus;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  artifacts: BuildArtifact[];
  error?: string;
  versionName: string;
  versionCode: number;
  qrDataUrl?: string;  // base64 data URL of QR code
}

export type DependencyStatus = 'checking' | 'found' | 'missing' | 'error';

export interface DependencyInfo {
  name: string;
  status: DependencyStatus;
  version?: string;
  path?: string;
  installUrl?: string;
  errorMessage?: string;
}

export interface DependencyCheckResult {
  flutter: DependencyInfo;
  androidSdk: DependencyInfo;
  java: DependencyInfo;
  adb: DependencyInfo;
  allReady: boolean;
}
export const IPC_EVENTS = {
  /** { id, fileCount } — how many files a checkpoint can restore. */
  AGENT_CHECKPOINT: 'agent:checkpoint',
  /** ClaudeIdeRequest — a Claude Code tool call the editor has to answer. */
  CLAUDE_IDE_REQUEST: 'claudeIde:request',
  PREVIEW_STATUS: 'preview:status',
  DIAGNOSTICS_UPDATED: 'diagnostics:updated',
  PREVIEW_LOG: 'preview:log',
  AGENT_STREAM: 'agent:stream',
  AGENT_PROPOSED_EDITS: 'agent:proposedEdits',
  TERMINAL_OUTPUT: 'terminal:output',
  TERMINAL_EXIT: 'terminal:exit',
  GIT_CHANGED: 'git:changed',
  APP_UPDATE_STATUS: 'app:updateStatus',
  PUBLISH_STATUS: 'publish:status',
  PUBLISH_LOG: 'publish:log',
  AUTH_SESSION_EXPIRED: 'auth:sessionExpired',
  AGENT_TIMELINE: 'agent:timeline',
  AGENT_PHASE_CHANGED: 'agent:phaseChanged',
  FILE_CHANGED: 'file:changed',
  // Cloud Build
  BUILD_LOG_CHUNK: 'build:logChunk',
  SETTINGS_UPDATED: 'settings:updated',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];
export type IpcEvent = (typeof IPC_EVENTS)[keyof typeof IPC_EVENTS];

export interface WorkspaceChangeEvent {
  type: 'add' | 'addDir' | 'change' | 'unlink' | 'unlinkDir';
  path: string;
}

export interface IpcApi {
  openFolder: () => Promise<ProjectInfo | null>;
  openFile: () => Promise<{ path: string; content: string } | null>;
  saveFileAs: (defaultPath?: string, content?: string) => Promise<string | null>;
  newWindow: () => Promise<void>;
  exitApp: () => Promise<void>;
  onFileChanged: (callback: (path: string) => void) => () => void;
  minimizeWindow: () => Promise<void>;
  maximizeWindow: () => Promise<void>;
  closeWindow: () => Promise<void>;
  reloadWindow: () => Promise<void>;
  toggleFullScreen: () => Promise<void>;
  toggleDevTools: () => Promise<void>;
  zoom: (direction: 'in' | 'out' | 'reset') => Promise<void>;
  /** Runs a native edit role (clipboard, undo, …) on the focused element of the calling window. */
  editAction: (action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll') => Promise<void>;
  showAbout: () => Promise<void>;
  openProjectByPath: (path: string) => Promise<ProjectInfo>;
  getRecentProjects: () => Promise<ProjectInfo[]>;
  listDir: (dirPath: string, maxDepth?: number) => Promise<FileEntry[]>;
  readFile: (filePath: string) => Promise<string>;
  readImage: (filePath: string) => Promise<string>;
  writeFile: (filePath: string, content: string) => Promise<void>;
  createDir: (dirPath: string) => Promise<void>;
  renameItem: (oldPath: string, newPath: string) => Promise<void>;
  deleteItem: (path: string) => Promise<void>;
  revealItem: (path: string) => Promise<void>;
  getProject: () => Promise<ProjectInfo | null>;
  searchFiles: (rootPath: string, query: string, includeDirectories?: boolean) => Promise<FileEntry[]>;
  searchContent: (opts: { projectPath: string; query: string; caseSensitive?: boolean; isRegex?: boolean; maxResults?: number }) => Promise<any[]>;
  loadChatHistory: (projectPath: string) => Promise<any>;
  saveChatHistory: (projectPath: string, state: any) => Promise<void>;
  listChatThreads: () => Promise<any[]>;
  loadChatThread: (threadId: string) => Promise<any>;
  saveChatThread: (threadId: string, messages: any[], title?: string, runs?: any[]) => Promise<void>;
  deleteChatThread: (threadId: string) => Promise<void>;
  getSettings: () => Promise<Settings>;
  setSettings: (settings: Partial<Settings>) => Promise<Settings>;
  getVersion: () => Promise<string>;
  detectFlutterSdk: () => Promise<SdkInfo | null>;
  analyzeProject: (projectPath: string) => Promise<Diagnostic[]>;
  pubGet: (projectPath: string) => Promise<void>;
  startPreview: (projectPath: string) => Promise<PreviewSession>;
  rnStartPreview: (projectPath: string) => Promise<PreviewSession>;
  stopPreview: () => Promise<void>;
  rnStopPreview: (processId: number) => Promise<void>;
  reloadPreview: () => Promise<void>;
  rnReloadPreview: (processId: number) => Promise<void>;
  getPreviewSession: () => Promise<PreviewSession | null>;
  /** `frame` is the device frame size in CSS px, used to size the window to the device. */
  detachPreview: (deviceId?: string, frame?: { width: number; height: number }) => Promise<void>;
  attachPreview: () => Promise<void>;
  isPreviewDetached: () => Promise<boolean>;
  sendAgentMessage: (options: AgentSendOptions) => Promise<void>;
  cancelAgent: () => Promise<void>;
  /** Approve the pending Implementation Plan and start autonomous execution. */
  approvePlan: (projectPath?: string) => Promise<void>;

  applyAgentEdits: (editIds: string[]) => Promise<void>;
  rejectAgentEdits: (editIds?: string[]) => Promise<void>;
  getPendingEdits: () => Promise<ProposedEdit[]>;
  getGitStatus: (projectPath: string) => Promise<GitStatusResult>;
  gitInit: (projectPath: string) => Promise<void>;
  gitStage: (projectPath: string, files: string[]) => Promise<void>;
  gitUnstage: (projectPath: string, files: string[]) => Promise<void>;
  gitCommit: (projectPath: string, message: string) => Promise<void>;
  gitDiff: (projectPath: string, filePath: string) => Promise<GitDiffResult>;
  gitPull: (projectPath: string) => Promise<void>;
  gitPush: (projectPath: string) => Promise<void>;
  gitCheckout: (projectPath: string, branch: string) => Promise<void>;
  gitBranch: (projectPath: string, branch: string) => Promise<void>;
  /** Clones `url` into a new folder under `parentDir`; resolves to the cloned folder's path. */
  gitClone: (url: string, parentDir: string) => Promise<string>;
  /** Opens an SSH session to the target in the system terminal. */
  openSshTerminal: (target: SshTarget) => Promise<void>;
  /** Reads importable editor settings from VS Code. */
  readVsCodeSettings: () => Promise<VsCodeSettingsImport>;
  createTerminal: (options: TerminalCreateOptions) => Promise<void>;
  writeTerminal: (id: string, data: string) => Promise<void>;
  destroyTerminal: (id: string) => Promise<void>;
  resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>;
  /** Tab autocomplete: text to insert at the cursor ('' when there is no suggestion). */
  inlineComplete: (request: InlineCompletionRequest) => Promise<string>;
  cancelInlineCompletion: () => Promise<void>;
  /** Ctrl+K: returns the replacement for the selected code. */
  inlineEdit: (request: InlineEditRequest) => Promise<InlineEditResult>;
  cancelInlineEdit: () => Promise<void>;
  /** Restores files to before the agent message `id`; returns restored paths. */
  restoreCheckpoint: (id: string) => Promise<string[]>;
  onAgentCheckpoint: (callback: (payload: { id: string; fileCount: number }) => void) => () => void;
  runCommand: (options: RunCommandOptions) => Promise<RunCommandResult>;
  listProjectTemplates: () => Promise<ProjectTemplateInfo[]>;
  createProject: (options: CreateProjectOptions) => Promise<ProjectInfo>;
  createProjectFromPrompt: (options: CreateProjectFromPromptOptions) => Promise<ProjectInfo>;
  selectFolder: () => Promise<string | null>;
  getTelemetryEnabled: () => Promise<boolean>;
  setTelemetryEnabled: (enabled: boolean) => Promise<void>;
  checkForUpdates: () => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  getUpdateStatus: () => Promise<UpdateInfo>;
  completeOnboarding: () => Promise<void>;
  getPerformanceInfo?: () => Promise<{ heapUsedMB: number; rssMemMB: number }>;
  publishGetStatus: () => Promise<PublishStatus>;
  publishDeploy: (projectPath: string, platform: 'flutter' | 'react-native', target: 'vercel' | 'netlify', token?: string) => Promise<void>;
  publishCancel: () => Promise<void>;
  getConnectedDevices: () => Promise<ConnectedDevice[]>;
  startDeviceRun: (deviceId: string, platformTarget: string, projectPath: string) => Promise<{ processId: number }>;
  onPreviewStatus: (callback: (session: PreviewSession) => void) => () => void;
  onDiagnostics: (callback: (diagnostics: Diagnostic[]) => void) => () => void;
  onPreviewLog: (callback: (line: string) => void) => () => void;
  onAgentStream: (callback: (event: AgentStreamEvent) => void) => () => void;
  onAgentActivity: (callback: (event: AgentActivityEvent) => void) => () => void;
  onAgentTimeline: (callback: (activity: AgentTimelineActivity) => void) => () => void;
  onAgentPhase: (callback: (phase: AgentPhase) => void) => () => void;
  onProposedEdits: (callback: (edits: ProposedEdit[]) => void) => () => void;
  onTerminalOutput: (callback: (payload: { id: string; data: string }) => void) => () => void;
  onTerminalExit: (callback: (payload: { id: string; code: number }) => void) => () => void;
  onGitChanged: (callback: () => void) => () => void;
  onUpdateStatus: (callback: (info: UpdateInfo) => void) => () => void;
  // Extensions
  searchExtensions: (query: string, offset?: number, size?: number) => Promise<ExtensionSearchResult>;
  claudeIdeRespond: (requestId: string, result: ClaudeIdeToolResult) => Promise<void>;
  claudeIdeNotify: (method: string, params: unknown) => Promise<void>;
  claudeIdeSetWorkspace: (folders: string[]) => Promise<void>;
  getClaudeIdeStatus: () => Promise<ClaudeIdeStatus>;
  listAgents: () => Promise<AgentInfo[]>;
  /** The agent's CLI path; reinstalls the extension for this platform if needed. */
  resolveAgentCli: (extensionId: string) => Promise<string | null>;
  onClaudeIdeRequest: (callback: (request: ClaudeIdeRequest) => void) => () => void;
  getInstalledExtensions: () => Promise<ExtensionInfo[]>;
  installExtension: (extensionId: string, downloadUrl?: string) => Promise<void>;
  uninstallExtension: (extensionId: string) => Promise<void>;
  getExtensionDetails: (extensionId: string) => Promise<any>;
  // Auth
  authSignIn: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  authSignUp: (email: string, password: string) => Promise<{ success: boolean; error?: string }>;
  authLogout: () => Promise<void>;
  authGetAccount: () => Promise<{
    email: string;
    tier?: string;
    plan?: string;
    usedCost?: number;
    budgetCost?: number;
    usedTokens?: number;
    budgetTokens?: number;
    usage?: number;
    limit?: number;
    gatewayConnected?: boolean;
    /** Weekly usage pool (see packages/agent usage-limits.ts). */
    weeklyPoolUsd?: number;
    weeklyUsedUsd?: number;
    weekResetsAt?: string;
    /** Tab completions this month; `monthlyCompletions` null = unlimited. */
    monthlyCompletions?: number | null;
    completionsUsed?: number;
    completionsResetAt?: string;
  } | null>;
  onPublishStatus: (callback: (status: any) => void) => () => void;
  onPublishLog: (callback: (line: string) => void) => () => void;
  onOpenFile: (callback: (file: any) => void) => () => void;
  onAuthSessionExpired: (callback: () => void) => () => void;
  onPlanUpdated: (callback: (plan: AgentPlan) => void) => () => void;
  onWorkspaceChanged?: (callback: (payload: { event: string; path: string }) => void) => () => void;
  onWorkspaceChangedBatch?: (callback: (payload: { events: WorkspaceChangeEvent[] }) => void) => () => void;
  pocToggle?: (visible: boolean) => Promise<void>;
  pocBounds?: (bounds: any) => void;
  // Cloud Build
  startCloudBuild?: (workspacePath: string, framework: string, target: string) => Promise<any>;
  getCloudBuild?: (id: string) => Promise<any>;
  cancelCloudBuild?: (id: string) => Promise<any>;
  getCloudBuildHistory?: () => Promise<any[]>;
  getCloudBuildDownloadToken?: (id: string) => Promise<{ token: string; downloadUrl: string; expiresAt: number }>;
  onBuildLogChunk?: (callback: (payload: { id: string; chunk: string }) => void) => () => void;
  openSettingsWindow?: (section?: string) => Promise<void>;
  onSettingsUpdated?: (callback: (settings: Partial<Settings>) => void) => () => void;
  onSettingsSection?: (callback: (section: string) => void) => () => void;
}

declare global {
  interface Window {
    peep: IpcApi;
  }
}

export type ModelTier = 'fast' | 'reasoning' | 'premium';

export interface AIToolCall {
  id: string;
  name: string;
  arguments: any;
}

export interface AIUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface CostEstimate {
  cost: number;
  currency: string;
}

export interface AIError {
  code: string;
  message: string;
  status?: number;
}

export type CapabilityTier = 'fast' | 'reasoning' | 'premium';

export interface AIRequest {
  tier: CapabilityTier;
  manualModel?: string;
  messages: any[];
  tools?: any[];
  /** What the request is for; Tab completions have their own limits and don't draw from the usage pool on paid plans. */
  purpose?: 'chat' | 'completion';
}

export interface AIResponse {
  content: string;
  toolCalls?: AIToolCall[];
  usage?: AIUsage;
  cost?: CostEstimate;
}

export interface AIStreamEvent {
  type: 'delta' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: AIToolCall;
  usage?: AIUsage;
  cost?: CostEstimate;
  error?: AIError;
}

export interface AIGateway {
  generate(request: AIRequest, options?: { signal?: AbortSignal }): Promise<AIResponse>;
  stream(request: AIRequest, options?: { signal?: AbortSignal }): AsyncIterable<AIStreamEvent>;
  estimateCost(request: AIRequest): Promise<CostEstimate>;
  getContextLimit(tier: CapabilityTier): number;
}

export { ProviderError } from './provider-error';
