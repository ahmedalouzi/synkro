import type { ProjectInfo } from '@peep/shared';
import { useWorkspaceStore, type OpenFile } from '../stores/workspace-store';
import { useComposerStore } from '../stores/composer-store';
import { useBuildStore } from '../stores/build-store';
import { buildApi } from '../services/build-api';
import { isAICompletionsEnabled, toggleAICompletions } from '../features/editor/inline-completions';
import { openAgentTab, useAgentsStore } from '../features/agents/agents-store';
import { addSelectionToChat } from '../features/chat/ask-agent';
import {
  editorHasFocus,
  getActiveEditor,
  isColumnSelection,
  runEditorAction,
  toggleColumnSelection,
} from './editor-registry';

/**
 * Central command registry — the single source of truth for the menu bar,
 * the command palette, global keybindings and the keyboard shortcuts reference.
 * Command ids and keybindings mirror VS Code's (microsoft/vscode) defaults.
 */
export interface Command {
  id: string;
  title: string;
  /** Palette prefix, e.g. "View" → "View: Toggle Word Wrap". */
  category?: string;
  /** Display keybinding; chords are space separated ("Ctrl+K Ctrl+O"). */
  keybinding?: string;
  /** Extra bindings that trigger the command but are not displayed. */
  altKeybindings?: string[];
  /**
   * The keybinding is owned by Monaco and only works while the editor has focus.
   * It is displayed in menus but not registered globally.
   */
  editorKeybinding?: boolean;
  run: () => void | Promise<void>;
  enabled?: () => boolean;
  checked?: () => boolean;
}

const ws = () => useWorkspaceStore.getState();
const emit = (name: string, detail?: unknown): void => {
  window.dispatchEvent(new CustomEvent(name, { detail }));
};
/** Fires after React has mounted a panel that was just opened. */
const emitAfterRender = (name: string, detail?: unknown) => setTimeout(() => emit(name, detail), 30);

const hasProject = () => !!ws().project;
const hasEditor = () => !!getActiveEditor();
const activeFile = (): OpenFile | null => ws().openFiles.find((f) => f.path === ws().activeFilePath) ?? null;
const isUntitled = (path: string) => path.startsWith('untitled-');
const isVirtual = (path: string) => /^[a-z-]+:\/\//.test(path);
const isSavable = (file: OpenFile | null) => !!file && !isVirtual(file.path);
const baseName = (p: string) => p.split(/[\\/]/).pop() || p;

/* ── Workspace actions ─────────────────────────────────────────── */

async function loadProject(project: ProjectInfo) {
  const store = ws();
  store.closeAllFiles();
  store.setProject(project);
  const [tree, recent] = await Promise.all([
    window.peep.listDir(project.path, 1),
    window.peep.getRecentProjects(),
  ]);
  store.setFileTree(tree);
  store.setRecentProjects(recent);
}

export function confirmDiscard(files: OpenFile[]): boolean {
  const dirty = files.filter((f) => f.dirty);
  if (dirty.length === 0) return true;
  const names = dirty.map((f) => f.name).join(', ');
  return window.confirm(`You have unsaved changes in: ${names}.\n\nDiscard them and continue?`);
}

export async function openFolder() {
  if (!confirmDiscard(ws().openFiles)) return;
  const project = await window.peep.openFolder();
  if (project) await loadProject(project);
}

export async function openRecent(path: string) {
  if (!confirmDiscard(ws().openFiles)) return;
  const project = await window.peep.openProjectByPath(path);
  await loadProject(project);
}

let untitledCounter = 0;
function newTextFile() {
  untitledCounter += 1;
  ws().openFile({
    path: `untitled-${Date.now()}.txt`,
    name: `Untitled-${untitledCounter}`,
    content: '',
    dirty: false,
  });
}

async function openFileDialog() {
  const result = await window.peep.openFile();
  if (!result) return;
  if (!ws().project) {
    // Editors live inside a workspace, so with no project open the file's folder becomes it.
    const folder = result.path.replace(/[\\/][^\\/]+$/, '');
    await loadProject(await window.peep.openProjectByPath(folder));
  }
  ws().openFile({ path: result.path, name: baseName(result.path), content: result.content, dirty: false });
}

/** Command used by "Run Active File", by file extension. */
const FILE_RUNNERS: Record<string, string> = {
  js: 'node', mjs: 'node', cjs: 'node',
  ts: 'npx tsx', mts: 'npx tsx',
  py: 'python',
  dart: 'dart run',
  sh: 'bash',
  ps1: 'powershell -ExecutionPolicy Bypass -File',
  rb: 'ruby',
  go: 'go run',
};

const runnerFor = (path: string) => FILE_RUNNERS[path.split('.').pop()?.toLowerCase() ?? ''];

async function runActiveFile() {
  const file = activeFile();
  if (!file || !isSavable(file) || isUntitled(file.path)) return;
  const runner = runnerFor(file.path);
  if (!runner) return;
  if (file.dirty) await writeFile(file);
  terminalAction('run-text', `${runner} "${file.path}"`);
}

async function writeFile(file: OpenFile) {
  try {
    await window.peep.writeFile(file.path, file.content);
    ws().markFileSaved(file.path, file.content);
  } catch (err) {
    console.error('Save failed:', err);
    window.alert(`Failed to save '${file.name}': ${(err as Error).message ?? err}`);
  }
}

async function saveAs(file: OpenFile) {
  const newPath = await window.peep.saveFileAs(isUntitled(file.path) ? file.name : file.path, file.content);
  if (!newPath) return;
  const store = ws();
  store.closeFile(file.path);
  store.openFile({ path: newPath, name: baseName(newPath), content: file.content, dirty: false });
}

async function save() {
  const file = activeFile();
  if (!isSavable(file)) return;
  if (isUntitled(file!.path)) return saveAs(file!);
  await writeFile(file!);
}

async function saveAll() {
  for (const file of ws().openFiles) {
    if (file.dirty && !isVirtual(file.path) && !isUntitled(file.path)) await writeFile(file);
  }
}

/* ── Auto Save (files.autoSave: "afterDelay", 1000ms like VS Code's default delay) ── */

const AUTO_SAVE_KEY = 'peep.files.autoSave';
const AUTO_SAVE_DELAY = 1000;

let autoSave = (() => {
  try {
    return localStorage.getItem(AUTO_SAVE_KEY) === 'afterDelay';
  } catch {
    return false;
  }
})();
let autoSaveTimer: ReturnType<typeof setTimeout> | undefined;

function toggleAutoSave() {
  autoSave = !autoSave;
  try {
    localStorage.setItem(AUTO_SAVE_KEY, autoSave ? 'afterDelay' : 'off');
  } catch {
    // Not persisted; the toggle still applies to this session.
  }
  if (autoSave) void saveAll();
}

useWorkspaceStore.subscribe((state, prev) => {
  if (!autoSave || state.openFiles === prev.openFiles) return;
  if (!state.openFiles.some((f) => f.dirty && !isUntitled(f.path) && !isVirtual(f.path))) return;
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => void saveAll(), AUTO_SAVE_DELAY);
});

async function revertFile() {
  const file = activeFile();
  if (!file || isUntitled(file.path) || isVirtual(file.path)) return;
  const content = await window.peep.readFile(file.path);
  ws().syncFileContent(file.path, content);
}

function closeEditor() {
  const file = activeFile();
  if (file && confirmDiscard([file])) ws().closeFile(file.path);
}

function closeAllEditors() {
  if (confirmDiscard(ws().openFiles)) ws().closeAllFiles();
}

function closeFolder() {
  if (!confirmDiscard(ws().openFiles)) return;
  const store = ws();
  store.closeAllFiles();
  store.setProject(null);
  store.setFileTree([]);
}

/* ── Project rules (.synkro/rules.md — also reads .cursorrules, .cursor/rules, AGENTS.md) ── */

const RULES_TEMPLATE = `# Project Rules

Instructions the AI follows in this project (agent chat and Ctrl+K edits).
Synkro also reads .cursorrules, .cursor/rules/*.mdc and AGENTS.md.

## Stack
-

## Conventions
-

## Don't
-
`;

async function openProjectRules() {
  const project = ws().project;
  if (!project) return;
  const sep = project.path.includes('\\') ? '\\' : '/';
  const dir = `${project.path}${sep}.synkro`;
  const path = `${dir}${sep}rules.md`;
  let content: string;
  try {
    content = await window.peep.readFile(path);
  } catch {
    content = RULES_TEMPLATE;
    await window.peep.createDir(dir).catch(() => undefined);
    await window.peep.writeFile(path, content);
  }
  ws().openFile({ path, name: 'rules.md', content, dirty: false });
}

/* ── Edit actions: Monaco when it has focus, otherwise the focused DOM element ── */

function editAction(action: 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'selectAll', monacoId?: string) {
  if (monacoId && editorHasFocus()) {
    runEditorAction(monacoId);
  } else {
    void window.peep.editAction(action);
  }
}

/* ── Layout ────────────────────────────────────────────────────── */

type PanelTab = 'problems' | 'logs' | 'terminal' | 'git' | 'build';

function showPanel(tab: PanelTab) {
  const store = ws();
  store.setBottomPanelTab(tab);
  if (!store.bottomPanelOpen) store.toggleBottomPanel();
}

/** VS Code semantics: hide the panel if the tab is already showing, else reveal it. */
function togglePanelTab(tab: PanelTab) {
  const store = ws();
  if (store.bottomPanelOpen && store.bottomPanelTab === tab) store.toggleBottomPanel();
  else showPanel(tab);
}

function showSidebarView(view: 'explorer' | 'extensions' | 'search' | 'git') {
  ws().setSidebarView(view);
}

/* ── Editor navigation history (Go › Back / Forward) ─────────────── */

const history = { back: [] as string[], forward: [] as string[], navigating: false };

useWorkspaceStore.subscribe((state, prev) => {
  if (state.activeFilePath === prev.activeFilePath || history.navigating) return;
  if (prev.activeFilePath) {
    history.back.push(prev.activeFilePath);
    history.forward = [];
  }
});

function navigate(from: string[], to: string[]) {
  const isOpen = (p: string) => ws().openFiles.some((f) => f.path === p);
  let target: string | undefined;
  while ((target = from.pop()) !== undefined && !isOpen(target));
  if (!target) return;
  const current = ws().activeFilePath;
  if (current) to.push(current);
  history.navigating = true;
  ws().setActiveFile(target);
  history.navigating = false;
}

function cycleEditor(delta: number) {
  const { openFiles, activeFilePath } = ws();
  if (openFiles.length < 2) return;
  const index = openFiles.findIndex((f) => f.path === activeFilePath);
  ws().setActiveFile(openFiles[(index + delta + openFiles.length) % openFiles.length].path);
}

/* ── Run ───────────────────────────────────────────────────────── */

const APK_PLATFORMS = ['flutter', 'react-native', 'react-native-local', 'expo'];

export function canBuildApk(): boolean {
  const project = ws().project;
  const status = useBuildStore.getState().currentBuild?.status;
  return !!project && APK_PLATFORMS.includes(project.platform as string) && status !== 'queued' && status !== 'running';
}

export async function buildApk() {
  const project = ws().project;
  if (!project || !canBuildApk()) return;
  showPanel('build');
  try {
    const platform = project.platform === 'expo' || project.platform.startsWith('react-native') ? 'react-native' : 'flutter';
    const build = await buildApi.startBuild(project.path, platform, 'apk');
    useBuildStore.getState().setCurrentBuild(build);
  } catch (err) {
    console.error('BUILD START FAILED:', err);
  }
}

function previewAction(action: 'start' | 'stop' | 'reload') {
  const store = ws();
  if (!store.previewPaneOpen) store.setPreviewPaneOpen(true);
  emitAfterRender(`peep:preview-${action}`);
}

function terminalAction(action: 'new' | 'kill' | 'clear' | 'run-text', detail?: unknown) {
  showPanel('terminal');
  emitAfterRender(`peep:terminal-${action}`, detail);
}

/** Opens Claude Code in its own editor tab (like VS Code's Claude Code panel). */
async function openClaudeCode() {
  await useAgentsStore.getState().refresh();
  const agent = useAgentsStore.getState().agents.find((a) => a.extensionId.toLowerCase() === 'anthropic.claude-code');
  if (!agent) {
    ws().openFile({ path: 'extension://Anthropic.claude-code', name: 'Extension: Claude Code', content: '', dirty: false });
    alert('Claude Code is not installed. Install "Claude Code for VS Code" from the Extensions view, then run this command again.');
    return;
  }
  openAgentTab(agent);
}

/* ── Registry ──────────────────────────────────────────────────── */

const commandList: Command[] = [
  // File
  { id: 'workbench.action.files.newUntitledFile', category: 'File', title: 'New Text File', keybinding: 'Ctrl+N', run: newTextFile, enabled: hasProject },
  { id: 'peep.newProject', category: 'File', title: 'New Project...', keybinding: 'Ctrl+Alt+N', run: () => emit('peep:new-project') },
  { id: 'git.clone', category: 'Git', title: 'Clone Repository...', run: () => emit('peep:clone-repo') },
  { id: 'peep.connectSsh', category: 'Remote', title: 'Connect to Host via SSH...', run: () => emit('peep:ssh-connect') },
  { id: 'workbench.action.newWindow', category: 'File', title: 'New Window', keybinding: 'Ctrl+Shift+N', run: () => window.peep.newWindow() },
  { id: 'workbench.action.files.openFile', category: 'File', title: 'Open File...', keybinding: 'Ctrl+O', run: openFileDialog },
  { id: 'workbench.action.files.openFolder', category: 'File', title: 'Open Folder...', keybinding: 'Ctrl+K Ctrl+O', run: openFolder },
  { id: 'workbench.action.files.save', category: 'File', title: 'Save', keybinding: 'Ctrl+S', run: save, enabled: () => isSavable(activeFile()) },
  { id: 'workbench.action.files.saveAs', category: 'File', title: 'Save As...', keybinding: 'Ctrl+Shift+S', run: () => { const f = activeFile(); if (isSavable(f)) return saveAs(f!); }, enabled: () => isSavable(activeFile()) },
  { id: 'workbench.action.files.saveAll', category: 'File', title: 'Save All', keybinding: 'Ctrl+K S', run: saveAll, enabled: () => ws().openFiles.some((f) => f.dirty) },
  { id: 'workbench.action.toggleAutoSave', category: 'File', title: 'Auto Save', run: toggleAutoSave, checked: () => autoSave },
  { id: 'workbench.action.files.revert', category: 'File', title: 'Revert File', run: revertFile, enabled: () => { const f = activeFile(); return !!f && !isUntitled(f.path) && !isVirtual(f.path); } },
  { id: 'workbench.action.closeActiveEditor', category: 'View', title: 'Close Editor', keybinding: 'Ctrl+F4', altKeybindings: ['Ctrl+W'], run: closeEditor, enabled: () => !!activeFile() },
  { id: 'workbench.action.closeAllEditors', category: 'View', title: 'Close All Editors', keybinding: 'Ctrl+K Ctrl+W', run: closeAllEditors, enabled: () => ws().openFiles.length > 0 },
  { id: 'workbench.action.closeFolder', category: 'Workspaces', title: 'Close Folder', keybinding: 'Ctrl+K F', run: closeFolder, enabled: hasProject },
  { id: 'workbench.action.closeWindow', category: 'View', title: 'Close Window', keybinding: 'Alt+F4', run: () => window.peep.closeWindow() },
  { id: 'workbench.action.quit', category: 'File', title: 'Exit', run: () => window.peep.exitApp() },
  { id: 'workbench.action.openSettings', category: 'Preferences', title: 'Open Settings', keybinding: 'Ctrl+,', run: () => emit('peep:open-settings') },
  { id: 'workbench.action.openGlobalKeybindings', category: 'Preferences', title: 'Keyboard Shortcuts', keybinding: 'Ctrl+K Ctrl+S', run: () => emit('peep:open-keyboard-help') },

  // Edit
  { id: 'undo', category: 'Edit', title: 'Undo', keybinding: 'Ctrl+Z', editorKeybinding: true, run: () => editAction('undo', 'undo') },
  { id: 'redo', category: 'Edit', title: 'Redo', keybinding: 'Ctrl+Y', editorKeybinding: true, run: () => editAction('redo', 'redo') },
  { id: 'editor.action.clipboardCutAction', category: 'Edit', title: 'Cut', keybinding: 'Ctrl+X', editorKeybinding: true, run: () => editAction('cut') },
  { id: 'editor.action.clipboardCopyAction', category: 'Edit', title: 'Copy', keybinding: 'Ctrl+C', editorKeybinding: true, run: () => editAction('copy') },
  { id: 'editor.action.clipboardPasteAction', category: 'Edit', title: 'Paste', keybinding: 'Ctrl+V', editorKeybinding: true, run: () => editAction('paste') },
  { id: 'actions.find', category: 'Edit', title: 'Find', keybinding: 'Ctrl+F', editorKeybinding: true, run: () => runEditorAction('actions.find'), enabled: hasEditor },
  { id: 'editor.action.startFindReplaceAction', category: 'Edit', title: 'Replace', keybinding: 'Ctrl+H', editorKeybinding: true, run: () => runEditorAction('editor.action.startFindReplaceAction'), enabled: hasEditor },
  { id: 'workbench.action.findInFiles', category: 'Search', title: 'Find in Files', keybinding: 'Ctrl+Shift+F', run: () => { showSidebarView('search'); emitAfterRender('peep:search-focus'); }, enabled: hasProject },
  { id: 'workbench.action.replaceInFiles', category: 'Search', title: 'Replace in Files', keybinding: 'Ctrl+Shift+H', run: () => { showSidebarView('search'); emitAfterRender('peep:search-focus', { replace: true }); }, enabled: hasProject },
  { id: 'editor.action.commentLine', category: 'Edit', title: 'Toggle Line Comment', keybinding: 'Ctrl+/', editorKeybinding: true, run: () => runEditorAction('editor.action.commentLine'), enabled: hasEditor },
  { id: 'editor.action.blockComment', category: 'Edit', title: 'Toggle Block Comment', keybinding: 'Shift+Alt+A', editorKeybinding: true, run: () => runEditorAction('editor.action.blockComment'), enabled: hasEditor },
  { id: 'editor.action.formatDocument', category: 'Edit', title: 'Format Document', keybinding: 'Shift+Alt+F', editorKeybinding: true, run: () => runEditorAction('editor.action.formatDocument'), enabled: hasEditor },
  { id: 'editor.action.rename', category: 'Edit', title: 'Rename Symbol', keybinding: 'F2', editorKeybinding: true, run: () => runEditorAction('editor.action.rename'), enabled: hasEditor },
  { id: 'editor.action.changeAll', category: 'Edit', title: 'Change All Occurrences', keybinding: 'Ctrl+F2', editorKeybinding: true, run: () => runEditorAction('editor.action.changeAll'), enabled: hasEditor },

  // Selection
  { id: 'editor.action.selectAll', category: 'Selection', title: 'Select All', keybinding: 'Ctrl+A', editorKeybinding: true, run: () => editAction('selectAll', 'editor.action.selectAll') },
  { id: 'editor.action.smartSelect.expand', category: 'Selection', title: 'Expand Selection', keybinding: 'Shift+Alt+Right', editorKeybinding: true, run: () => runEditorAction('editor.action.smartSelect.expand'), enabled: hasEditor },
  { id: 'editor.action.smartSelect.shrink', category: 'Selection', title: 'Shrink Selection', keybinding: 'Shift+Alt+Left', editorKeybinding: true, run: () => runEditorAction('editor.action.smartSelect.shrink'), enabled: hasEditor },
  { id: 'editor.action.copyLinesUpAction', category: 'Selection', title: 'Copy Line Up', keybinding: 'Shift+Alt+Up', editorKeybinding: true, run: () => runEditorAction('editor.action.copyLinesUpAction'), enabled: hasEditor },
  { id: 'editor.action.copyLinesDownAction', category: 'Selection', title: 'Copy Line Down', keybinding: 'Shift+Alt+Down', editorKeybinding: true, run: () => runEditorAction('editor.action.copyLinesDownAction'), enabled: hasEditor },
  { id: 'editor.action.moveLinesUpAction', category: 'Selection', title: 'Move Line Up', keybinding: 'Alt+Up', editorKeybinding: true, run: () => runEditorAction('editor.action.moveLinesUpAction'), enabled: hasEditor },
  { id: 'editor.action.moveLinesDownAction', category: 'Selection', title: 'Move Line Down', keybinding: 'Alt+Down', editorKeybinding: true, run: () => runEditorAction('editor.action.moveLinesDownAction'), enabled: hasEditor },
  { id: 'editor.action.duplicateSelection', category: 'Selection', title: 'Duplicate Selection', run: () => runEditorAction('editor.action.duplicateSelection'), enabled: hasEditor },
  { id: 'editor.action.insertCursorAbove', category: 'Selection', title: 'Add Cursor Above', keybinding: 'Ctrl+Alt+Up', editorKeybinding: true, run: () => runEditorAction('editor.action.insertCursorAbove'), enabled: hasEditor },
  { id: 'editor.action.insertCursorBelow', category: 'Selection', title: 'Add Cursor Below', keybinding: 'Ctrl+Alt+Down', editorKeybinding: true, run: () => runEditorAction('editor.action.insertCursorBelow'), enabled: hasEditor },
  { id: 'editor.action.insertCursorAtEndOfEachLineSelected', category: 'Selection', title: 'Add Cursors to Line Ends', keybinding: 'Shift+Alt+I', editorKeybinding: true, run: () => runEditorAction('editor.action.insertCursorAtEndOfEachLineSelected'), enabled: hasEditor },
  { id: 'editor.action.addSelectionToNextFindMatch', category: 'Selection', title: 'Add Next Occurrence', keybinding: 'Ctrl+D', editorKeybinding: true, run: () => runEditorAction('editor.action.addSelectionToNextFindMatch'), enabled: hasEditor },
  { id: 'editor.action.addSelectionToPreviousFindMatch', category: 'Selection', title: 'Add Previous Occurrence', run: () => runEditorAction('editor.action.addSelectionToPreviousFindMatch'), enabled: hasEditor },
  { id: 'editor.action.selectHighlights', category: 'Selection', title: 'Select All Occurrences', keybinding: 'Ctrl+Shift+L', editorKeybinding: true, run: () => runEditorAction('editor.action.selectHighlights'), enabled: hasEditor },
  { id: 'editor.action.toggleColumnSelection', category: 'Selection', title: 'Column Selection Mode', run: toggleColumnSelection, checked: isColumnSelection },

  // View
  { id: 'workbench.action.showCommands', category: 'View', title: 'Command Palette...', keybinding: 'Ctrl+Shift+P', altKeybindings: ['F1'], run: () => emit('peep:open-command-palette') },
  { id: 'workbench.action.toggleFullScreen', category: 'View', title: 'Full Screen', keybinding: 'F11', run: () => window.peep.toggleFullScreen() },
  { id: 'workbench.action.toggleSidebarVisibility', category: 'View', title: 'Primary Side Bar', keybinding: 'Ctrl+B', run: () => (hasProject() ? ws().toggleSidebar() : ws().toggleHomeSidebar()), checked: () => (hasProject() ? ws().sidebarOpen : ws().homeSidebarOpen) },
  { id: 'workbench.action.toggleStatusbarVisibility', category: 'View', title: 'Status Bar', run: () => ws().toggleStatusBar(), checked: () => ws().statusBarVisible },
  { id: 'workbench.action.togglePanel', category: 'View', title: 'Panel', keybinding: 'Ctrl+J', run: () => ws().toggleBottomPanel(), checked: () => ws().bottomPanelOpen },
  { id: 'peep.toggleChat', category: 'View', title: 'Chat', keybinding: 'Ctrl+Alt+B', run: () => ws().toggleAgentPane(), checked: () => ws().agentPaneOpen },
  { id: 'peep.togglePreview', category: 'View', title: 'Preview', run: () => ws().setPreviewPaneOpen(!ws().previewPaneOpen), checked: () => ws().previewPaneOpen },
  { id: 'editor.action.toggleMinimap', category: 'View', title: 'Minimap', run: () => ws().toggleEditorMinimap(), checked: () => ws().editorMinimap },
  { id: 'workbench.action.zoomIn', category: 'View', title: 'Zoom In', keybinding: 'Ctrl+=', altKeybindings: ['Ctrl+Shift+=', 'Ctrl+NumpadAdd'], run: () => window.peep.zoom('in') },
  { id: 'workbench.action.zoomOut', category: 'View', title: 'Zoom Out', keybinding: 'Ctrl+-', altKeybindings: ['Ctrl+Shift+-', 'Ctrl+NumpadSubtract'], run: () => window.peep.zoom('out') },
  { id: 'workbench.action.zoomReset', category: 'View', title: 'Reset Zoom', keybinding: 'Ctrl+NumPad0', altKeybindings: ['Ctrl+0'], run: () => window.peep.zoom('reset') },
  { id: 'workbench.view.explorer', category: 'View', title: 'Explorer', keybinding: 'Ctrl+Shift+E', run: () => showSidebarView('explorer'), enabled: hasProject },
  { id: 'workbench.view.search', category: 'View', title: 'Search', run: () => { showSidebarView('search'); emitAfterRender('peep:search-focus'); }, enabled: hasProject },
  { id: 'workbench.view.scm', category: 'View', title: 'Source Control', keybinding: 'Ctrl+Shift+G', run: () => showSidebarView('git'), enabled: hasProject },
  { id: 'workbench.view.extensions', category: 'View', title: 'Extensions', keybinding: 'Ctrl+Shift+X', run: () => showSidebarView('extensions'), enabled: hasProject },
  { id: 'workbench.actions.view.problems', category: 'View', title: 'Problems', keybinding: 'Ctrl+Shift+M', run: () => togglePanelTab('problems') },
  { id: 'workbench.action.output.toggleOutput', category: 'View', title: 'Output', keybinding: 'Ctrl+Shift+U', run: () => togglePanelTab('logs') },
  { id: 'workbench.action.toggleMaximizedPanel', category: 'View', title: 'Toggle Maximized Panel', run: () => { showPanel(ws().bottomPanelTab); emit('peep:panel-toggle-maximize'); } },
  { id: 'workbench.action.terminal.toggleTerminal', category: 'View', title: 'Terminal', keybinding: 'Ctrl+`', run: () => (hasProject() ? togglePanelTab('terminal') : emit('peep:home-terminal', 'toggle')) },
  { id: 'editor.action.toggleWordWrap', category: 'View', title: 'Word Wrap', keybinding: 'Alt+Z', run: () => ws().toggleEditorWordWrap(), checked: () => ws().editorWordWrap },
  { id: 'synkro.inlineEdit', category: 'AI', title: 'Edit with AI (Inline)', keybinding: 'Ctrl+K', editorKeybinding: true, run: () => runEditorAction('synkro.inlineEdit'), enabled: hasEditor },
  { id: 'synkro.openProjectRules', category: 'AI', title: 'Configure Project Rules', run: openProjectRules, enabled: hasProject },
  { id: 'peep.toggleAICompletions', category: 'AI', title: 'Tab Autocomplete (AI)', run: toggleAICompletions, checked: isAICompletionsEnabled },
  { id: 'editor.action.inlineSuggest.trigger', category: 'AI', title: 'Trigger Inline Suggestion', keybinding: 'Alt+\\', editorKeybinding: true, run: () => runEditorAction('editor.action.inlineSuggest.trigger'), enabled: hasEditor },
  { id: 'peep.toggleComposer', category: 'Chat', title: 'Toggle Composer', keybinding: 'Ctrl+I', run: () => { const c = useComposerStore.getState(); c.setOpen(!c.isOpen); } },
  // Bound globally too, so Ctrl+L focuses the chat when the editor doesn't have focus.
  { id: 'aichat.addSelectionToChat', category: 'Chat', title: 'Add Selection to Chat', keybinding: 'Ctrl+L', run: addSelectionToChat, enabled: hasProject },

  // Go
  { id: 'workbench.action.navigateBack', category: 'Go', title: 'Back', keybinding: 'Alt+Left', run: () => navigate(history.back, history.forward), enabled: () => history.back.length > 0 },
  { id: 'workbench.action.navigateForward', category: 'Go', title: 'Forward', keybinding: 'Alt+Right', run: () => navigate(history.forward, history.back), enabled: () => history.forward.length > 0 },
  { id: 'workbench.action.nextEditor', category: 'View', title: 'Next Editor', keybinding: 'Ctrl+PageDown', altKeybindings: ['Ctrl+Tab'], run: () => cycleEditor(1), enabled: () => ws().openFiles.length > 1 },
  { id: 'workbench.action.previousEditor', category: 'View', title: 'Previous Editor', keybinding: 'Ctrl+PageUp', altKeybindings: ['Ctrl+Shift+Tab'], run: () => cycleEditor(-1), enabled: () => ws().openFiles.length > 1 },
  { id: 'workbench.action.quickOpen', category: 'Go', title: 'Go to File...', keybinding: 'Ctrl+P', run: () => emit('peep:open-picker'), enabled: hasProject },
  { id: 'editor.action.quickOutline', category: 'Go', title: 'Go to Symbol in Editor...', keybinding: 'Ctrl+Shift+O', editorKeybinding: true, run: () => runEditorAction('editor.action.quickOutline'), enabled: hasEditor },
  { id: 'editor.action.revealDefinition', category: 'Go', title: 'Go to Definition', keybinding: 'F12', editorKeybinding: true, run: () => runEditorAction('editor.action.revealDefinition'), enabled: hasEditor },
  { id: 'editor.action.goToReferences', category: 'Go', title: 'Go to References', keybinding: 'Shift+F12', editorKeybinding: true, run: () => runEditorAction('editor.action.goToReferences'), enabled: hasEditor },
  { id: 'editor.action.gotoLine', category: 'Go', title: 'Go to Line/Column...', keybinding: 'Ctrl+G', editorKeybinding: true, run: () => runEditorAction('editor.action.gotoLine'), enabled: hasEditor },
  { id: 'editor.action.jumpToBracket', category: 'Go', title: 'Go to Bracket', keybinding: 'Ctrl+Shift+\\', editorKeybinding: true, run: () => runEditorAction('editor.action.jumpToBracket'), enabled: hasEditor },
  { id: 'editor.action.marker.nextInFiles', category: 'Go', title: 'Next Problem', keybinding: 'F8', editorKeybinding: true, run: () => runEditorAction('editor.action.marker.nextInFiles'), enabled: hasEditor },
  { id: 'editor.action.marker.prevInFiles', category: 'Go', title: 'Previous Problem', keybinding: 'Shift+F8', editorKeybinding: true, run: () => runEditorAction('editor.action.marker.prevInFiles'), enabled: hasEditor },

  // Run
  { id: 'peep.preview.start', category: 'Run', title: 'Start Preview', keybinding: 'F5', run: () => previewAction('start'), enabled: hasProject },
  { id: 'peep.preview.reload', category: 'Run', title: 'Reload Preview', keybinding: 'Ctrl+Shift+F5', run: () => previewAction('reload'), enabled: hasProject },
  { id: 'peep.preview.stop', category: 'Run', title: 'Stop Preview', keybinding: 'Shift+F5', run: () => previewAction('stop'), enabled: hasProject },
  { id: 'peep.buildApk', category: 'Run', title: 'Build Android APK', keybinding: 'Ctrl+Shift+B', run: buildApk, enabled: canBuildApk },
  { id: 'peep.publish', category: 'Run', title: 'Publish Application...', run: () => emit('peep:open-publish'), enabled: hasProject },

  // Terminal
  { id: 'claude-code.open', category: 'Claude Code', title: 'Open in New Tab', keybinding: 'Ctrl+Escape', run: () => void openClaudeCode(), enabled: hasProject },
  { id: 'workbench.action.terminal.new', category: 'Terminal', title: 'New Terminal', keybinding: 'Ctrl+Shift+`', run: () => (hasProject() ? terminalAction('new') : emit('peep:home-terminal', 'new')) },
  { id: 'workbench.action.terminal.runActiveFile', category: 'Terminal', title: 'Run Active File', run: runActiveFile, enabled: () => { const f = activeFile(); return !!f && isSavable(f) && !isUntitled(f.path) && !!runnerFor(f.path); } },
  { id: 'workbench.action.terminal.runSelectedText', category: 'Terminal', title: 'Run Selected Text', run: () => { const sel = ws().activeSelection; if (sel) terminalAction('run-text', sel.text); }, enabled: () => !!ws().activeSelection },
  { id: 'workbench.action.terminal.clear', category: 'Terminal', title: 'Clear Terminal', run: () => terminalAction('clear'), enabled: hasProject },
  { id: 'workbench.action.terminal.kill', category: 'Terminal', title: 'Kill Terminal', run: () => terminalAction('kill'), enabled: hasProject },

  // Help
  { id: 'workbench.action.keybindingsReference', category: 'Help', title: 'Keyboard Shortcuts Reference', keybinding: 'Ctrl+K Ctrl+R', run: () => emit('peep:open-keyboard-help') },
  { id: 'workbench.action.toggleDevTools', category: 'Developer', title: 'Toggle Developer Tools', keybinding: 'Ctrl+Shift+I', run: () => window.peep.toggleDevTools() },
  { id: 'workbench.action.reloadWindow', category: 'Developer', title: 'Reload Window', run: () => window.peep.reloadWindow() },
  { id: 'update.checkForUpdates', category: 'Help', title: 'Check for Updates...', run: () => window.peep.checkForUpdates() },
  { id: 'workbench.action.showAboutDialog', category: 'Help', title: 'About', run: () => window.peep.showAbout() },
];

export const COMMANDS: ReadonlyMap<string, Command> = new Map(commandList.map((c) => [c.id, c]));

export function getCommand(id: string): Command | undefined {
  return COMMANDS.get(id);
}

export function isCommandEnabled(cmd: Command): boolean {
  return cmd.enabled ? cmd.enabled() : true;
}

export function runCommand(id: string): void {
  const cmd = COMMANDS.get(id);
  if (!cmd || !isCommandEnabled(cmd)) return;
  try {
    void Promise.resolve(cmd.run()).catch((err) => console.error(`Command '${id}' failed:`, err));
  } catch (err) {
    console.error(`Command '${id}' failed:`, err);
  }
}
