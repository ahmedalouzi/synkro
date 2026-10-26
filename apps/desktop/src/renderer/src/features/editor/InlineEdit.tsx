import { useEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { diffLines } from 'diff';
import type * as Monaco from 'monaco-editor';
import { useWorkspaceStore } from '../../stores/workspace-store';
import './InlineEdit.css';

/**
 * Ctrl+K inline edit (Cursor's "Edit"): a prompt box inside the editor above the
 * selected lines; the AI's rewrite is applied in place and shown as a diff
 * (green = added, red = removed) until accepted (Ctrl+Enter) or rejected (Esc).
 */

type Editor = Monaco.editor.IStandaloneCodeEditor;
type Phase = 'input' | 'loading' | 'review' | 'error';

const REVIEW_CONTEXT_KEY = 'synkroInlineEditReview';
export const INLINE_EDIT_ACTION_ID = 'synkro.inlineEdit';
const sessions = new WeakMap<Editor, InlineEditSession>();
const reviewKeys = new WeakMap<Editor, Monaco.editor.IContextKey<boolean>>();

interface WidgetProps {
  session: InlineEditSession;
}

function InlineEditWidget({ session }: WidgetProps) {
  const [phase, setPhase] = useState<Phase>('input');
  const [error, setError] = useState('');
  const [instruction, setInstruction] = useState(session.initialInstruction ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    session.onPhase = (next, message) => {
      setPhase(next);
      setError(message ?? '');
      if (next === 'review' || next === 'error') requestAnimationFrame(() => inputRef.current?.focus());
    };
    requestAnimationFrame(() => inputRef.current?.focus());
    // Opened with a ready-made instruction (e.g. "Fix with AI"): run immediately.
    if (session.initialInstruction) void session.run(session.initialInstruction);
  }, [session]);

  const submit = () => {
    if (instruction.trim() && phase !== 'loading') void session.run(instruction.trim());
  };

  return (
    <div className="inline-edit-widget" onMouseDown={(e) => e.stopPropagation()}>
      <div className="inline-edit-row">
        <span className="inline-edit-badge">✦</span>
        <input
          ref={inputRef}
          className="inline-edit-input"
          placeholder={phase === 'review' ? 'Follow-up instructions… (Enter to regenerate)' : session.isInsert ? 'Generate code… (Enter)' : 'Edit selected code… (Enter)'}
          value={instruction}
          disabled={phase === 'loading'}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            // Keep keys away from Monaco while typing in the prompt.
            e.stopPropagation();
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && phase === 'review') {
              e.preventDefault();
              session.accept();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              if (phase === 'review') session.reject();
              else session.close();
            }
          }}
        />
        {phase === 'loading' && (
          <>
            <span className="inline-edit-spinner" />
            <button className="inline-edit-btn" onClick={() => session.close()}>Cancel</button>
          </>
        )}
        {phase === 'review' && (
          <>
            <button className="inline-edit-btn accept" onClick={() => session.accept()}>Accept <kbd>Ctrl+⏎</kbd></button>
            <button className="inline-edit-btn" onClick={() => session.reject()}>Reject <kbd>Esc</kbd></button>
          </>
        )}
        {(phase === 'input' || phase === 'error') && (
          <button className="inline-edit-btn" onClick={() => session.close()} title="Close (Esc)">✕</button>
        )}
      </div>
      {phase === 'error' && <div className="inline-edit-error">{error}</div>}
    </div>
  );
}

class InlineEditSession {
  onPhase: (phase: Phase, message?: string) => void = () => undefined;
  readonly isInsert: boolean;
  readonly initialInstruction?: string;

  private readonly startLine: number;
  private readonly original: string;
  private readonly before: string;
  private readonly after: string;
  private readonly overlayNode = document.createElement('div');
  private readonly root: Root;
  private promptZoneId: string | null = null;
  private diffZoneIds: string[] = [];
  private decorations: Monaco.editor.IEditorDecorationsCollection;
  /** Tracks the rewritten block so reject can restore it even after the user edits around it. */
  private block: Monaco.editor.IEditorDecorationsCollection;
  private applied = false;
  private closed = false;
  private request = 0;
  private readonly overlay: Monaco.editor.IOverlayWidget;

  constructor(private editor: Editor, private monaco: typeof Monaco, options: InlineEditOptions = {}) {
    this.initialInstruction = options.instruction;
    const model = editor.getModel()!;
    const selection = options.range ?? editor.getSelection()!;
    // Cursor-style: always operate on whole lines.
    let endLine = selection.endLineNumber;
    if (endLine > selection.startLineNumber && selection.endColumn === 1) endLine -= 1;
    this.startLine = selection.startLineNumber;
    const range = new monaco.Range(this.startLine, 1, endLine, model.getLineMaxColumn(endLine));
    this.original = model.getValueInRange(range);
    this.isInsert = this.original.trim() === '';
    this.before = model.getValueInRange(new monaco.Range(1, 1, this.startLine, 1));
    const lastLine = model.getLineCount();
    this.after = model.getValueInRange(new monaco.Range(endLine, model.getLineMaxColumn(endLine), lastLine, model.getLineMaxColumn(lastLine)));

    this.decorations = editor.createDecorationsCollection();
    this.block = editor.createDecorationsCollection([{
      range,
      options: { stickiness: monaco.editor.TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges },
    }]);

    this.overlayNode.className = 'inline-edit-overlay';
    this.overlay = {
      getId: () => 'synkro.inlineEdit',
      getDomNode: () => this.overlayNode,
      getPosition: () => null,
    };
    editor.addOverlayWidget(this.overlay);
    this.layoutOverlay();
    editor.changeViewZones((acc) => {
      this.promptZoneId = acc.addZone({
        afterLineNumber: this.startLine - 1,
        heightInPx: 46,
        domNode: document.createElement('div'),
        onDomNodeTop: (top) => { this.overlayNode.style.top = `${top + 4}px`; },
      });
    });
    this.root = createRoot(this.overlayNode);
    this.root.render(<InlineEditWidget session={this} />);
  }

  private layoutOverlay() {
    const layout = this.editor.getLayoutInfo();
    this.overlayNode.style.left = `${layout.contentLeft}px`;
    this.overlayNode.style.width = `${Math.max(280, Math.min(620, layout.contentWidth - layout.verticalScrollbarWidth - 24))}px`;
  }

  private currentBlockRange(): Monaco.Range | null {
    return this.block.getRange(0);
  }

  /** Restores the original code if a rewrite is currently applied. */
  private revert() {
    const range = this.currentBlockRange();
    if (!this.applied || !range) return;
    this.editor.executeEdits('synkro-inline-edit', [{ range, text: this.original }]);
    this.applied = false;
    this.clearDiff();
  }

  private clearDiff() {
    this.decorations.clear();
    if (this.diffZoneIds.length) {
      const ids = this.diffZoneIds;
      this.editor.changeViewZones((acc) => ids.forEach((id) => acc.removeZone(id)));
      this.diffZoneIds = [];
    }
  }

  async run(instruction: string) {
    if (this.closed) return;
    // A follow-up instruction regenerates from the original code.
    this.revert();
    reviewKeys.get(this.editor)?.set(false);
    this.onPhase('loading');
    const id = ++this.request;

    const filePath = useWorkspaceStore.getState().activeFilePath ?? 'untitled';
    const result = await window.peep.inlineEdit({
      projectPath: useWorkspaceStore.getState().project?.path,
      filePath,
      language: this.editor.getModel()?.getLanguageId() ?? 'plaintext',
      instruction,
      before: this.before,
      selection: this.original,
      after: this.after,
    });
    if (this.closed || id !== this.request) return;
    if ('error' in result) {
      this.onPhase('error', result.error === 'cancelled' ? 'Cancelled.' : result.error);
      return;
    }
    this.apply(result.text);
  }

  private apply(text: string) {
    const range = this.currentBlockRange();
    if (!range) return this.close();
    const eol = this.editor.getModel()!.getEOL();
    const newText = text.replace(/\r?\n/g, eol);

    this.editor.pushUndoStop();
    this.editor.executeEdits('synkro-inline-edit', [{ range, text: newText, forceMoveMarkers: true }]);
    this.editor.pushUndoStop();
    this.applied = true;
    this.showDiff(text);
    reviewKeys.get(this.editor)?.set(true);
    this.onPhase('review');
  }

  /** Green whole-line highlights for added lines, red view zones for removed lines. */
  private showDiff(newText: string) {
    const monaco = this.monaco;
    const fontInfo = this.editor.getOption(monaco.editor.EditorOption.fontInfo);
    const lineHeight = this.editor.getOption(monaco.editor.EditorOption.lineHeight);
    const contentLeft = this.editor.getLayoutInfo().contentLeft;
    const added: Monaco.editor.IModelDeltaDecoration[] = [];
    const removed: { afterLine: number; lines: string[] }[] = [];

    let line = this.startLine;
    for (const part of diffLines(this.original.replace(/\r\n/g, '\n'), newText.replace(/\r\n/g, '\n'))) {
      const lines = part.value.replace(/\n$/, '').split('\n');
      if (part.added) {
        added.push({
          range: new monaco.Range(line, 1, line + lines.length - 1, 1),
          options: { isWholeLine: true, className: 'inline-edit-added', linesDecorationsClassName: 'inline-edit-added-gutter' },
        });
        line += lines.length;
      } else if (part.removed) {
        removed.push({ afterLine: line - 1, lines });
      } else {
        line += lines.length;
      }
    }

    this.decorations.set(added);
    this.editor.changeViewZones((acc) => {
      for (const block of removed) {
        const node = document.createElement('div');
        node.className = 'inline-edit-removed';
        node.style.paddingLeft = `${contentLeft}px`;
        node.style.fontFamily = fontInfo.fontFamily;
        node.style.fontSize = `${fontInfo.fontSize}px`;
        node.style.lineHeight = `${lineHeight}px`;
        node.textContent = block.lines.join('\n');
        this.diffZoneIds.push(acc.addZone({ afterLineNumber: block.afterLine, heightInLines: block.lines.length, domNode: node }));
      }
    });
  }

  accept() {
    this.applied = false; // keep the new code
    this.close();
  }

  reject() {
    this.revert();
    this.close();
  }

  close() {
    if (this.closed) return;
    if (this.request > 0) void window.peep.cancelInlineEdit();
    this.closed = true;
    this.clearDiff();
    this.block.clear();
    reviewKeys.get(this.editor)?.set(false);
    if (this.promptZoneId) {
      const id = this.promptZoneId;
      this.editor.changeViewZones((acc) => acc.removeZone(id));
    }
    this.editor.removeOverlayWidget(this.overlay);
    // Unmount after the current React event finishes.
    setTimeout(() => this.root.unmount(), 0);
    sessions.delete(this.editor);
    this.editor.focus();
  }

  focus() {
    (this.overlayNode.querySelector('input') as HTMLInputElement | null)?.focus();
  }
}

/** Registers Ctrl+K and the review keybindings on an editor (call once per editor instance). */
export function setupInlineEdit(editor: Editor, monaco: typeof Monaco): void {
  reviewKeys.set(editor, editor.createContextKey(REVIEW_CONTEXT_KEY, false));
  editor.addAction({
    id: INLINE_EDIT_ACTION_ID,
    label: 'Edit with AI…',
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK],
    contextMenuGroupId: '0_synkro',
    contextMenuOrder: 0,
    run: () => startInlineEdit(editor, monaco),
  });
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => sessions.get(editor)?.accept(), REVIEW_CONTEXT_KEY);
  editor.addCommand(monaco.KeyCode.Escape, () => sessions.get(editor)?.reject(), REVIEW_CONTEXT_KEY);
  editor.onDidDispose(() => sessions.get(editor)?.close());
}

export interface InlineEditOptions {
  /** Lines to edit instead of the current selection. */
  range?: Monaco.IRange & { startLineNumber: number; endLineNumber: number; endColumn: number };
  /** Pre-filled instruction that runs immediately. */
  instruction?: string;
}

export function startInlineEdit(editor: Editor, monaco: typeof Monaco, options: InlineEditOptions = {}): void {
  if (!editor.getModel() || !editor.getSelection()) return;
  const existing = sessions.get(editor);
  if (existing) {
    if (!options.instruction) {
      existing.focus();
      return;
    }
    existing.reject();
  }
  sessions.set(editor, new InlineEditSession(editor, monaco, options));
}

let fixProviderRegistered = false;

/** "✦ Fix with AI" in the lightbulb / Ctrl+. menu for every error and warning. */
export function registerFixWithAI(monaco: typeof Monaco): void {
  if (fixProviderRegistered) return;
  fixProviderRegistered = true;

  monaco.editor.registerCommand('synkro.fixWithAI', (_accessor, uri: string, marker: Monaco.editor.IMarkerData) => {
    const editor = monaco.editor.getEditors().find((e) => e.getModel()?.uri.toString() === uri) as Editor | undefined;
    if (!editor) return;
    const model = editor.getModel()!;
    startInlineEdit(editor, monaco, {
      range: {
        startLineNumber: marker.startLineNumber,
        startColumn: 1,
        endLineNumber: marker.endLineNumber,
        endColumn: model.getLineMaxColumn(marker.endLineNumber),
      },
      instruction: `Fix this ${marker.severity >= monaco.MarkerSeverity.Error ? 'error' : 'warning'}: ${marker.message}`,
    });
  });

  monaco.languages.registerCodeActionProvider('*', {
    provideCodeActions(model, _range, context) {
      const markers = context.markers.filter((m) => m.severity >= monaco.MarkerSeverity.Warning);
      return {
        actions: markers.slice(0, 3).map((marker) => ({
          title: `✦ Fix with AI: ${marker.message.length > 60 ? `${marker.message.slice(0, 57)}…` : marker.message}`,
          kind: 'quickfix',
          diagnostics: [marker],
          isPreferred: false,
          command: { id: 'synkro.fixWithAI', title: 'Fix with AI', arguments: [model.uri.toString(), marker] },
        })),
        dispose: () => undefined,
      };
    },
  });
}
