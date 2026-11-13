import { useState, type ReactNode } from 'react';
import type { AgentTimelineActivity, ProposedEdit } from '@peep/shared';
import type { PreviewRefreshEvent } from '../../stores/run-events-store';
import { absolute, baseName, runItems, sameFile, thoughtSeconds } from './run-model';
import { useFollowStore } from '../../stores/follow-store';
import './agent-run.css';

/*
 * One agent run inside its reply, as on the website's LiveDemo: "Thought for Ns", compact tool rows as they
 * happen, a card per file the agent writes ("Writing…" → "Ready to review" with Undo / Keep / Review), and the
 * preview's "Fast Refresh 412 ms · iPhone 15". The final answer (markdown) follows in ChatPane.
 */

const ICON = {
  file: 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v5h6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  run: 'M4 17l6-6-6-6M12 19h8',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  check: 'M20 6 9 17l-5-5',
  phone: 'M7 2h10v20H7zM11 18h2',
  zap: 'M13 2 3 14h9l-1 8 10-12h-9z',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14',
  note: 'M4 4h16v16H4zM8 9h8M8 13h8M8 17h5',
};

function Icon({ d, size = 13 }: { d: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** The React logo for .tsx/.jsx, as in the demo's file card; a plain file icon otherwise. */
function FileIcon({ name }: { name: string }) {
  if (/\.(tsx|jsx)$/.test(name)) {
    return (
      <svg width={13} height={13} viewBox="-11.5 -10.2 23 20.5" aria-hidden="true" style={{ flexShrink: 0 }}>
        <circle r="2.05" fill="#61dafb" />
        <g stroke="#61dafb" strokeWidth="1" fill="none">
          <ellipse rx="11" ry="4.2" /><ellipse rx="11" ry="4.2" transform="rotate(60)" /><ellipse rx="11" ry="4.2" transform="rotate(120)" />
        </g>
      </svg>
    );
  }
  return <Icon d={ICON.file} />;
}

export type CardResolution = 'kept' | 'undone';

export interface AgentRunProps {
  /** This run's timeline events (in_progress and resolved twins). */
  activities: AgentTimelineActivity[];
  isLive: boolean;
  projectPath?: string;
  /** Edits still waiting for Keep / Undo (all runs; matched to this run's cards by path). */
  pendingEdits: ProposedEdit[];
  /** +/- counts per file path, remembered while the edits were pending. */
  counts: Record<string, { added: number; removed: number }>;
  resolutions: Record<string, CardResolution>;
  refresh?: PreviewRefreshEvent;
  onOpenFile: (absolutePath: string) => void;
  onUndo: (edit: ProposedEdit) => void;
  onKeep: (edit: ProposedEdit) => void;
  onReview: (edit: ProposedEdit) => void;
}

function stepRow(a: AgentTimelineActivity, projectPath: string | undefined, onOpenFile: (p: string) => void) {
  const done = a.status !== 'in_progress';
  const failed = a.status === 'failed';
  const fileLink = (file: string) => (
    <button type="button" className="ar-step__target" onClick={() => onOpenFile(absolute(file, projectPath))} title={file}>{file}</button>
  );
  let icon = ICON.file;
  let verb: string;
  let target: ReactNode = null;
  if (/^(Checking|Restarting) preview/.test(a.message)) {
    icon = ICON.phone;
    verb = a.message.startsWith('Checking') ? (done ? 'Checked preview' : 'Checking preview') : (done ? 'Restarted preview' : 'Restarting preview');
  } else if (a.message.startsWith('Checking types')) {
    icon = ICON.check;
    verb = done ? 'Checked types' : 'Checking types';
  } else {
    switch (a.type) {
      case 'reading': verb = done ? 'Read' : 'Reading'; target = a.file ? fileLink(a.file) : null; break;
      case 'searching':
        icon = ICON.search; verb = done ? 'Searched' : 'Searching';
        target = <span className="ar-step__target">{`“${a.message.replace(/^Searching (files|codebase): /, '').replace(/^"|"$/g, '')}”`}</span>;
        break;
      case 'exploring': icon = ICON.folder; verb = done ? 'Listed' : 'Listing'; target = a.file ? fileLink(a.file) : null; break;
      case 'running': icon = ICON.run; verb = done ? 'Ran' : 'Running'; target = <span className="ar-step__target">{a.command ?? ''}</span>; break;
      case 'deleting': icon = ICON.trash; verb = done ? 'Deleted' : 'Deleting'; target = a.file ? <span className="ar-step__target">{a.file}</span> : null; break;
      case 'editing': case 'creating': icon = ICON.note; verb = done ? 'Updated' : 'Updating'; target = a.file ? fileLink(a.file) : null; break;
      default: verb = a.message.replace(/…$/, '');
    }
  }
  return (
    <div key={a.id} className={`ar-step${done ? '' : ' is-live'}${failed ? ' is-failed' : ''}`} title={a.message}>
      <Icon d={icon} size={12} />
      <span className="ar-step__verb">{verb}</span>
      {target}
      {failed && <span className="ar-step__verb">failed</span>}
    </div>
  );
}

/** Steps shown after a run before "+N more". */
const VISIBLE_STEPS = 8;

export function AgentRun(props: AgentRunProps) {
  const { activities, isLive, projectPath, refresh, onOpenFile } = props;
  const [showAll, setShowAll] = useState(false);
  const items = runItems(activities);
  const seconds = thoughtSeconds(activities);
  const steps = items.filter((i) => i.kind === 'step');
  const hiddenSteps = !isLive && !showAll && steps.length > VISIBLE_STEPS ? steps.length - VISIBLE_STEPS : 0;
  const shown = hiddenSteps > 0 ? new Set(steps.slice(-VISIBLE_STEPS)) : null;

  return (
    <div className="ar-run">
      {seconds === null
        ? (isLive && <div className="ar-thinking">Thinking</div>)
        : <div className="ar-thought">Thought for {seconds}s</div>}

      {hiddenSteps > 0 && (
        <button type="button" className="ar-more" onClick={() => setShowAll(true)}>+{hiddenSteps} more steps</button>
      )}

      {(() => {
        // Consecutive steps share one list; each file card stands on its own.
        const out: ReactNode[] = [];
        let group: ReactNode[] = [];
        const flush = () => {
          if (group.length) out.push(<div key={`g${out.length}`} className="ar-steps">{group}</div>);
          group = [];
        };
        for (const item of items) {
          if (item.kind === 'step') {
            if (!shown || shown.has(item)) group.push(stepRow(item.a, projectPath, onOpenFile));
            continue;
          }
          flush();
          out.push(<FileCard key={item.a.id} {...props} a={item.a} />);
        }
        flush();
        return out;
      })()}

      {refresh && (
        <div className="ar-step is-ok">
          <Icon d={ICON.zap} size={12} />
          <span className="ar-step__verb">{refresh.kind === 'fast-refresh' ? 'Fast Refresh' : 'Preview reloaded'}</span>
          <span className="ar-step__target">{refresh.ms} ms · {refresh.device}</span>
        </div>
      )}
    </div>
  );
}

function FileCard({ a, projectPath, pendingEdits, counts, resolutions, onOpenFile, onUndo, onKeep, onReview }: AgentRunProps & { a: AgentTimelineActivity }) {
  const file = a.file ?? '';
  const edit = pendingEdits.find((e) => sameFile(e.path, file));
  const countKey = Object.keys(counts).find((p) => sameFile(p, file));
  const c = edit ? counts[edit.path] : countKey ? counts[countKey] : undefined;
  const resolvedKey = Object.keys(resolutions).find((p) => sameFile(p, file));
  const resolution = resolvedKey ? resolutions[resolvedKey] : undefined;
  // "Writing…" while the tool runs, and while follow mode plays the same edit in the editor.
  const playing = useFollowStore((st) => [...st.playing].some((p) => sameFile(p, file)));
  const writing = a.status === 'in_progress' || playing;
  const failed = a.status === 'failed';
  const state = writing ? 'Writing…' : failed ? 'Failed' : resolution === 'kept' ? 'Kept' : resolution === 'undone' ? 'Undone' : edit ? 'Ready to review' : 'Applied';

  return (
    <div className={`ar-edit${writing ? ' is-writing' : ''}${resolution === 'kept' ? ' is-kept' : ''}${resolution === 'undone' ? ' is-undone' : ''}`}>
      <div className="ar-edit__head">
        <FileIcon name={file} />
        <button type="button" className="ar-edit__name" title={file} onClick={() => onOpenFile(edit?.path ?? absolute(file, projectPath))}>{baseName(file)}</button>
        {c && c.added > 0 && <span className="ar-edit__add">+{c.added}</span>}
        {c && c.removed > 0 && <span className="ar-edit__del">-{c.removed}</span>}
        <span className="ar-edit__state">{state}</span>
      </div>
      <div className="ar-edit__bar"><span /></div>
      {!writing && edit && !resolution && (
        <div className="ar-edit__actions">
          <button type="button" className="ar-btn" onClick={() => onUndo(edit)}>Undo</button>
          <button type="button" className="ar-btn ar-btn--primary" onClick={() => onKeep(edit)}>Keep</button>
          <button type="button" className="ar-btn" onClick={() => onReview(edit)}>Review</button>
        </div>
      )}
    </div>
  );
}
