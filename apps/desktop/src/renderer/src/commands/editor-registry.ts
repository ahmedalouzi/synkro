import type { editor, IDisposable } from 'monaco-editor';

/**
 * Tracks the mounted Monaco editor so menu bar / command palette commands
 * can target it (VS Code's "active text editor"), and publishes its state
 * to the status bar.
 */
let activeEditor: editor.IStandaloneCodeEditor | null = null;
let columnSelection = false;
let editorSubscriptions: IDisposable[] = [];

export interface EditorStatus {
  line: number;
  column: number;
  /** Selected characters across all selections. */
  selected: number;
  cursors: number;
  tabSize: number;
  insertSpaces: boolean;
  eol: 'LF' | 'CRLF';
  language: string;
}

const listeners = new Set<() => void>();
let cachedStatus: EditorStatus | null = null;

function computeStatus(): EditorStatus | null {
  const ed = activeEditor;
  const model = ed?.getModel();
  if (!ed || !model) return null;
  const position = ed.getPosition();
  const selections = ed.getSelections() ?? [];
  const options = model.getOptions();
  return {
    line: position?.lineNumber ?? 1,
    column: position?.column ?? 1,
    selected: selections.reduce((sum, s) => sum + model.getValueLengthInRange(s), 0),
    cursors: selections.length,
    tabSize: options.tabSize,
    insertSpaces: options.insertSpaces,
    eol: model.getEOL() === '\r\n' ? 'CRLF' : 'LF',
    language: model.getLanguageId(),
  };
}

function notify(): void {
  cachedStatus = computeStatus();
  listeners.forEach((l) => l());
}

/** useSyncExternalStore-compatible subscription to the active editor's status. */
export function subscribeEditorStatus(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getEditorStatus(): EditorStatus | null {
  return cachedStatus;
}

export function setActiveEditor(ed: editor.IStandaloneCodeEditor): void {
  editorSubscriptions.forEach((d) => d.dispose());
  activeEditor = ed;
  ed.updateOptions({ columnSelection });
  editorSubscriptions = [
    ed.onDidChangeCursorSelection(notify),
    ed.onDidChangeModel(notify),
    ed.onDidChangeModelOptions(notify),
    ed.onDidChangeModelLanguage(notify),
    // EOL changes arrive as content changes.
    ed.onDidChangeModelContent((e) => { if (e.eol) notify(); }),
  ];
  notify();
}

export function clearActiveEditor(ed: editor.IStandaloneCodeEditor): void {
  if (activeEditor !== ed) return;
  editorSubscriptions.forEach((d) => d.dispose());
  editorSubscriptions = [];
  activeEditor = null;
  notify();
}

export function getActiveEditor(): editor.IStandaloneCodeEditor | null {
  return activeEditor;
}

export function editorHasFocus(): boolean {
  return !!activeEditor && activeEditor.hasTextFocus();
}

/** Focuses the editor and runs a Monaco action / command by id (e.g. `actions.find`). */
export function runEditorAction(id: string): void {
  const ed = activeEditor;
  if (!ed) return;
  ed.focus();
  ed.trigger('menu', id, null);
}

/** Status bar EOL toggle: converts the document between LF and CRLF. */
export function toggleEndOfLine(): void {
  const model = activeEditor?.getModel();
  if (!model) return;
  // 0 = LF, 1 = CRLF (monaco.editor.EndOfLineSequence)
  model.pushEOL(model.getEOL() === '\r\n' ? 0 : 1);
}

export function isColumnSelection(): boolean {
  return columnSelection;
}

export function toggleColumnSelection(): void {
  columnSelection = !columnSelection;
  activeEditor?.updateOptions({ columnSelection });
}
