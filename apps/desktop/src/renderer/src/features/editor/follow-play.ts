import type { editor } from 'monaco-editor';
import type { FollowEdit } from '../../stores/follow-store';
import { lf, lineChanges } from './line-changes';
import './follow.css';

type Monaco = typeof import('monaco-editor');

/** New lines in view that type in one after another; the rest just glow. */
const TYPED_LINES = 60;
/** Glow at most this many lines (a huge generated file must not cost thousands of decorations). */
const GLOWED_LINES = 1500;
const STEP_MS = 14;

// One rule per position: line k starts typing k × STEP_MS after the first.
(function addDelayRules() {
  if (typeof document === 'undefined' || document.getElementById('follow-delays')) return;
  const style = document.createElement('style');
  style.id = 'follow-delays';
  style.textContent = Array.from({ length: TYPED_LINES }, (_, k) => `.follow-d${k}{animation-delay:${k * STEP_MS}ms}`).join('');
  document.head.appendChild(style);
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Plays an agent edit in the editor showing the file's old text: removed lines flash red, then the new text
 * replaces it (through `apply`, the editor's normal content path) and new lines stream in with a green glow
 * that fades. With "reduce motion": no flash or typing, a short static highlight only.
 */
export async function playFollowEdit(ed: editor.IStandaloneCodeEditor, monaco: Monaco, edit: FollowEdit, apply: (content: string) => void): Promise<void> {
  const model = ed.getModel();
  if (!model) { apply(edit.newContent); return; }
  const reduce = prefersReducedMotion();
  const smooth = reduce ? monaco.editor.ScrollType.Immediate : monaco.editor.ScrollType.Smooth;
  const { removed, added } = lineChanges(model.getValue(), edit.newContent);

  if (removed.length > 0 && !reduce) {
    ed.revealLineInCenterIfOutsideViewport(removed[0][0], smooth);
    const flash = ed.deltaDecorations([], removed.slice(0, 200).map(([from, to]) => ({
      range: new monaco.Range(from, 1, to, 1),
      options: { isWholeLine: true, className: 'follow-del' },
    })));
    await sleep(380);
    ed.deltaDecorations(flash, []);
  }

  // The editor keeps its own line ends (a CRLF file stays CRLF), so compare the text without them.
  const applied = () => lf(model.getValue()) === lf(edit.newContent);
  apply(edit.newContent);
  for (let i = 0; i < 60 && !applied(); i++) await frame();
  if (added.length === 0 || !applied()) return;

  ed.revealLineInCenterIfOutsideViewport(added[0][0], smooth);
  await frame();
  const view = ed.getVisibleRanges()[0];
  const decorations: editor.IModelDeltaDecoration[] = [];
  let typed = 0;
  for (const [from, to] of added) {
    for (let line = from; line <= to && decorations.length < GLOWED_LINES; line++) {
      const inView = !!view && line >= view.startLineNumber && line <= view.endLineNumber;
      const typing = !reduce && inView && typed < TYPED_LINES ? `follow-type follow-d${typed++}` : undefined;
      decorations.push({
        range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
        options: { isWholeLine: true, className: reduce ? 'follow-add follow-add--still' : 'follow-add', inlineClassName: typing },
      });
    }
  }
  const glow = ed.deltaDecorations([], decorations);
  await sleep(reduce ? 1200 : 2600 + typed * STEP_MS);
  if (ed.getModel() === model) ed.deltaDecorations(glow, []);
}
