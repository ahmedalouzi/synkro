import type { ClaudeIdeRequest, ClaudeIdeToolResult } from '@peep/shared';
import { getActiveEditor, subscribeEditorStatus } from '../../commands/editor-registry';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useDiagnosticsStore } from '../../stores/preview-store';
import { languageForPath } from '../editor/MonacoEditor';
import { CLAUDE_DIFF_PREFIX, claudeDiffTabPath, useClaudeDiffStore } from './claude-diff-store';

/**
 * The editor half of the Claude Code IDE integration: answers the tool calls the CLI makes
 * (see ClaudeIdeServer in the main process) from Synkro's editor state.
 */

const text = (value: string): ClaudeIdeToolResult => ({ content: [{ type: 'text', text: value }] });
const json = (value: unknown): ClaudeIdeToolResult => text(JSON.stringify(value, null, 2));
const fail = (message: string): ClaudeIdeToolResult => json({ success: false, message });

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;
const toUri = (p: string) => `file:///${p.replace(/\\/g, '/').replace(/^\//, '')}`;
const fromUri = (uri: string) => {
  if (!uri.startsWith('file://')) return uri;
  const p = decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''));
  // Windows drive paths ("C:/...") keep no leading slash; POSIX paths need it back.
  return /^[a-zA-Z]:/.test(p) ? p : `/${p}`;
};
const samePath = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();

type Selection = {
  success: true;
  text: string;
  filePath: string;
  fileUrl: string;
  selection: { start: { line: number; character: number }; end: { line: number; character: number }; isEmpty: boolean };
};

let latestSelection: Selection | null = null;

/** The active editor's selection in Claude's shape (0-based lines and characters). */
export function currentSelection(): Selection | null {
  const ed = getActiveEditor();
  const model = ed?.getModel();
  const sel = ed?.getSelection();
  const filePath = useWorkspaceStore.getState().activeFilePath;
  if (!ed || !model || !sel || !filePath || filePath.includes('://')) return null;
  const result: Selection = {
    success: true,
    text: model.getValueInRange(sel),
    filePath,
    fileUrl: toUri(filePath),
    selection: {
      start: { line: sel.startLineNumber - 1, character: sel.startColumn - 1 },
      end: { line: sel.endLineNumber - 1, character: sel.endColumn - 1 },
      isEmpty: sel.isEmpty(),
    },
  };
  latestSelection = result;
  return result;
}

async function openInEditor(filePath: string): Promise<boolean> {
  const store = useWorkspaceStore.getState();
  const existing = store.openFiles.find((f) => samePath(f.path, filePath));
  if (existing) {
    store.setActiveFile(existing.path);
    return true;
  }
  try {
    const content = await window.peep.readFile(filePath);
    store.openFile({ path: filePath, name: baseName(filePath), content, dirty: false });
    return true;
  } catch {
    return false;
  }
}

/** True when the active editor shows `filePath` (models are keyed by the raw path or a file URI). */
function editorShows(filePath: string): boolean {
  const uri = getActiveEditor()?.getModel()?.uri.toString();
  return !!uri && samePath(decodeURIComponent(uri).replace(/^file:\/\/\/?/, ''), filePath);
}

/** Waits (up to a second) for the editor to show `filePath`; the model mounts after the tab switch. */
async function editorFor(filePath: string) {
  if (!editorShows(filePath)) {
    await new Promise<void>((resolve) => {
      const done = () => { unsubscribe(); clearTimeout(timer); resolve(); };
      const unsubscribe = subscribeEditorStatus(() => { if (editorShows(filePath)) done(); });
      const timer = setTimeout(done, 1000);
    });
  }
  return getActiveEditor();
}

async function openFile(args: Record<string, unknown>): Promise<ClaudeIdeToolResult> {
  const filePath = String(args.filePath ?? '');
  if (!filePath || !(await openInEditor(filePath))) return fail(`File not found: ${filePath}`);

  const startText = typeof args.startText === 'string' ? args.startText : '';
  const ed = await editorFor(filePath);
  const model = ed?.getModel();
  if (ed && model && startText) {
    const start = model.findNextMatch(startText, { lineNumber: 1, column: 1 }, false, true, null, false);
    if (start) {
      let end = start.range;
      const endText = typeof args.endText === 'string' ? args.endText : '';
      if (endText) {
        const match = model.findNextMatch(endText, start.range.getEndPosition(), false, true, null, false);
        if (match) end = match.range;
      }
      const endColumn = args.selectToEndOfLine ? model.getLineMaxColumn(end.endLineNumber) : end.endColumn;
      const range = { startLineNumber: start.range.startLineNumber, startColumn: start.range.startColumn, endLineNumber: end.endLineNumber, endColumn };
      ed.setSelection(range);
      ed.revealRangeInCenter(range);
    }
  }
  if (args.makeFrontmost === false) {
    return json({ success: true, filePath, languageId: model?.getLanguageId() ?? 'plaintext', lineCount: model?.getLineCount() ?? 0 });
  }
  ed?.focus();
  return text(`Opened file: ${filePath}`);
}

/** Pending openDiff calls: resolved when the user accepts or rejects (or closes the tab). */
const diffResolvers = new Map<string, (result: ClaudeIdeToolResult) => void>();

async function openDiff(requestId: string, args: Record<string, unknown>): Promise<ClaudeIdeToolResult> {
  const oldPath = String(args.old_file_path ?? '');
  const filePath = String(args.new_file_path ?? oldPath);
  const newContents = String(args.new_file_contents ?? '');
  const tabName = String(args.tab_name ?? `${baseName(filePath)} (Claude)`);

  // Diff against what the user sees, including unsaved edits.
  const open = useWorkspaceStore.getState().openFiles.find((f) => samePath(f.path, oldPath));
  let oldContents = open?.content ?? '';
  if (!open && oldPath) {
    try { oldContents = await window.peep.readFile(oldPath); } catch { oldContents = ''; }
  }

  useClaudeDiffStore.getState().add({ requestId, filePath, tabName, oldContents, newContents });
  useWorkspaceStore.getState().openFile({ path: claudeDiffTabPath(requestId), name: `✻ ${tabName}`, content: '', dirty: false });

  return new Promise((resolve) => diffResolvers.set(requestId, resolve));
}

function settleDiff(requestId: string, result: ClaudeIdeToolResult): void {
  const resolve = diffResolvers.get(requestId);
  diffResolvers.delete(requestId);
  useClaudeDiffStore.getState().remove(requestId);
  const store = useWorkspaceStore.getState();
  if (store.openFiles.some((f) => f.path === claudeDiffTabPath(requestId))) store.closeFile(claudeDiffTabPath(requestId));
  resolve?.(result);
}

/** Writes the accepted contents and tells Claude the file was saved. */
export async function acceptClaudeDiff(requestId: string, finalContents: string): Promise<void> {
  const diff = useClaudeDiffStore.getState().diffs[requestId];
  if (!diff) return;
  await window.peep.writeFile(diff.filePath, finalContents);
  const store = useWorkspaceStore.getState();
  if (store.openFiles.some((f) => samePath(f.path, diff.filePath))) {
    const open = store.openFiles.find((f) => samePath(f.path, diff.filePath))!;
    store.syncFileContent(open.path, finalContents);
  }
  settleDiff(requestId, { content: [{ type: 'text', text: 'FILE_SAVED' }, { type: 'text', text: finalContents }] });
}

export function rejectClaudeDiff(requestId: string): void {
  if (!diffResolvers.has(requestId)) return;
  settleDiff(requestId, text('DIFF_REJECTED'));
}

/** Closing a Claude diff tab with its × counts as rejecting the change. */
export function rejectClosedDiffTabs(openPaths: string[]): void {
  for (const requestId of diffResolvers.keys()) {
    if (!openPaths.includes(claudeDiffTabPath(requestId))) rejectClaudeDiff(requestId);
  }
}

async function saveDocument(filePath: string): Promise<ClaudeIdeToolResult> {
  const store = useWorkspaceStore.getState();
  const file = store.openFiles.find((f) => samePath(f.path, filePath));
  if (!file) return fail(`Document not open: ${filePath}`);
  if (!file.dirty) return json({ success: true, filePath, saved: false, message: 'Document has no unsaved changes' });
  await window.peep.writeFile(file.path, file.content);
  store.markFileSaved(file.path, file.content);
  return json({ success: true, filePath, saved: true, message: 'Document saved successfully' });
}

export async function handleClaudeIdeRequest({ requestId, tool, args }: ClaudeIdeRequest): Promise<ClaudeIdeToolResult> {
  const store = useWorkspaceStore.getState();
  switch (tool) {
    case 'openFile':
      return openFile(args);
    case 'openDiff':
      return openDiff(requestId, args);
    case 'getCurrentSelection':
      return currentSelection() ? json(currentSelection()) : fail('No active editor found');
    case 'getLatestSelection':
      return latestSelection ? json(latestSelection) : fail('No selection available');
    case 'getOpenEditors':
      return json({
        tabs: store.openFiles
          .filter((f) => !f.path.includes('://'))
          .map((f) => ({
            uri: toUri(f.path),
            isActive: f.path === store.activeFilePath,
            label: f.name,
            languageId: languageForPath(f.path),
            isDirty: f.dirty,
          })),
      });
    case 'getDiagnostics': {
      const only = typeof args.uri === 'string' && args.uri ? fromUri(args.uri) : null;
      const byFile = new Map<string, Array<{ message: string; severity: string; range: object; source: string }>>();
      for (const d of useDiagnosticsStore.getState().items) {
        if (only && !samePath(d.file, only)) continue;
        const list = byFile.get(d.file) ?? [];
        list.push({
          message: d.message,
          severity: d.severity === 'error' ? 'Error' : d.severity === 'warning' ? 'Warning' : 'Information',
          range: { start: { line: d.line - 1, character: d.column - 1 }, end: { line: d.line - 1, character: d.column - 1 } },
          source: 'synkro',
        });
        byFile.set(d.file, list);
      }
      return json([...byFile].map(([file, diagnostics]) => ({ uri: toUri(file), diagnostics })));
    }
    case 'checkDocumentDirty': {
      const filePath = String(args.filePath ?? '');
      const file = store.openFiles.find((f) => samePath(f.path, filePath));
      return file ? json({ success: true, filePath, isDirty: file.dirty, isUntitled: false }) : fail(`Document not open: ${filePath}`);
    }
    case 'saveDocument':
      return saveDocument(String(args.filePath ?? ''));
    case 'close_tab': {
      const tabName = String(args.tab_name ?? '');
      const diff = Object.values(useClaudeDiffStore.getState().diffs).find((d) => d.tabName === tabName);
      if (diff) rejectClaudeDiff(diff.requestId);
      else {
        const file = store.openFiles.find((f) => f.name === tabName || f.name === `✻ ${tabName}`);
        if (file) store.closeFile(file.path);
      }
      return text('TAB_CLOSED');
    }
    case 'closeAllDiffTabs': {
      const ids = [...diffResolvers.keys()];
      ids.forEach(rejectClaudeDiff);
      return text(`CLOSED_${ids.length}_DIFF_TABS`);
    }
    default:
      return { ...fail(`Unknown tool: ${tool}`), isError: true };
  }
}

export const isClaudeDiffPath = (path: string) => path.startsWith(CLAUDE_DIFF_PREFIX);
