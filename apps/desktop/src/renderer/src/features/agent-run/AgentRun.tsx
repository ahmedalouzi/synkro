import { useState, type ReactNode } from 'react';
import type { AgentTimelineActivity, ApprovalRequest, ProposedEdit } from '@peep/shared';
import { useI18n } from '../../i18n';
import { ApprovalCard } from '../chat/ApprovalCard';
import type { PreviewRefreshEvent } from '../../stores/run-events-store';
import { absolute, baseName, runItems, sameFile, thoughtSeconds } from './run-model';
import { useFollowStore } from '../../stores/follow-store';
import './agent-run.css';

/*
 * One agent run inside its reply, as on the website's LiveDemo: "Thought for Ns", the one-line plan, compact tool
 * rows as they happen (Blocked / Waiting for your approval / Added package included, with the approval cards), ONE
 * card for all the files the run changed (N files, +/-, a list that opens, Undo All / Keep All / Review), and the
 * preview's "Fast Refresh 412 ms · iPhone 15". The short final answer (markdown) follows in ChatPane.
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
  onUndo: (edits: ProposedEdit[]) => void;
  onKeep: (edits: ProposedEdit[]) => void;
  onReview: () => void;
  /** The agent's one sentence before it started working. */
  plan?: string;
  /** Approval cards waiting in this run (live run only). */
  approvals?: ApprovalRequest[];
}

function stepRow(
  a: AgentTimelineActivity, projectPath: string | undefined, onOpenFile: (p: string) => void,
  t: (key: string, params?: Record<string, string | number>) => string, waiting: boolean,
) {
  const done = a.status !== 'in_progress';
  const failed = a.status === 'failed';
  const blocked = a.status === 'blocked';
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
  // Refused by a safety rule or not answered: it did not run, so never "Ran" / "Deleted".
  if (blocked) verb = 'Blocked';
  // Its approval card is open below.
  if (waiting) verb = t('approval.waiting');
  return (
    <div key={a.id} className={`ar-step${done ? '' : ' is-live'}${failed ? ' is-failed' : ''}${blocked ? ' is-blocked' : ''}${waiting ? ' is-waiting' : ''}`} title={a.message}>
      <Icon d={icon} size={12} />
      <span className="ar-step__verb">{verb}</span>
      {target}
      {failed && <span className="ar-step__verb">failed</span>}
      {blocked && <span className="ar-step__note">{a.message.replace(/^Blocked: /, '')}</span>}
      {a.packages?.map((name) => <span key={name} className="ar-step__note ar-step__note--ok">{t('approval.addedPackage', { name })}</span>)}
    </div>
  );
}

/** Steps shown after a run before "+N more". */
const VISIBLE_STEPS = 8;

export function AgentRun(props: AgentRunProps) {
  const { activities, isLive, projectPath, refresh, onOpenFile, plan, approvals = [] } = props;
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  const items = runItems(activities);
  const seconds = thoughtSeconds(activities);
  const steps = items.filter((i) => i.kind === 'step');
  // Each file once (a file written twice in a run is one row), in the order the run first touched it.
  const files: AgentTimelineActivity[] = [];
  for (const item of items) {
    if (item.kind !== 'file' || !item.a.file) continue;
    const at = files.findIndex((f) => sameFile(f.file!, item.a.file!));
    if (at === -1) files.push(item.a);
    else files[at] = item.a;
  }
  const hiddenSteps = !isLive && !showAll && steps.length > VISIBLE_STEPS ? steps.length - VISIBLE_STEPS : 0;
  const shown = hiddenSteps > 0 ? new Set(steps.slice(-VISIBLE_STEPS)) : null;

  return (
    <div className="ar-run">
      {seconds === null
        ? (isLive && <div className="ar-thinking">Thinking</div>)
        : <div className="ar-thought">Thought for {seconds}s</div>}
      {plan && <div className="ar-plan">{plan}</div>}

      {hiddenSteps > 0 && (
        <button type="button" className="ar-more" onClick={() => setShowAll(true)}>+{hiddenSteps} more steps</button>
      )}

      {steps.length > 0 && (
        <div className="ar-steps">
          {steps.filter((item) => !shown || shown.has(item)).map((item) => {
            const waiting = item.a.status === 'in_progress'
              && approvals.some((r) => r.subject === (item.a.command ?? item.a.file) || (!!item.a.file && sameFile(r.subject, item.a.file)));
            return stepRow(item.a, projectPath, onOpenFile, t, waiting);
          })}
        </div>
      )}

      {approvals.map((request) => <ApprovalCard key={request.id} request={request} />)}

      {/* One card for every file this run changed, not a card per file. */}
      {files.length > 0 && <FilesCard {...props} files={files} />}

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

/** Opens by itself while a file is being written or there are only a few; otherwise one line until clicked. */
const OPEN_UP_TO = 3;

function FilesCard({ files, projectPath, pendingEdits, counts, resolutions, onOpenFile, onUndo, onKeep, onReview }: AgentRunProps & { files: AgentTimelineActivity[] }) {
  const playing = useFollowStore((st) => st.playing);
  const [open, setOpen] = useState<boolean | null>(null);
  const rows = files.map((a) => {
    const file = a.file ?? '';
    const edit = pendingEdits.find((e) => sameFile(e.path, file));
    const countKey = Object.keys(counts).find((p) => sameFile(p, file));
    const c = edit ? counts[edit.path] : countKey ? counts[countKey] : undefined;
    const resolvedKey = Object.keys(resolutions).find((p) => sameFile(p, file));
    const resolution = resolvedKey ? resolutions[resolvedKey] : undefined;
    // "Writing…" while the tool runs, and while follow mode plays the same edit in the editor.
    const writing = a.status === 'in_progress' || [...playing].some((p) => sameFile(p, file));
    const failed = a.status === 'failed';
    const state = writing ? 'Writing…' : failed ? 'Failed' : resolution === 'kept' ? 'Kept' : resolution === 'undone' ? 'Undone' : edit ? '' : 'Applied';
    return { a, file, edit, c, resolution, writing, state };
  });
  const pending = rows.filter((r) => r.edit && !r.resolution && !r.writing).map((r) => r.edit!);
  const added = rows.reduce((n, r) => n + (r.c?.added ?? 0), 0);
  const removed = rows.reduce((n, r) => n + (r.c?.removed ?? 0), 0);
  const writing = rows.find((r) => r.writing);
  const allKept = rows.every((r) => r.resolution === 'kept' || (!r.edit && !r.writing));
  const allUndone = rows.length > 0 && rows.every((r) => r.resolution === 'undone');
  const isOpen = open ?? (rows.length <= OPEN_UP_TO);

  return (
    <div className={`ar-files${writing ? ' is-writing' : ''}${allUndone ? ' is-undone' : ''}`}>
      <button type="button" className="ar-files__head" onClick={() => setOpen(!isOpen)} aria-expanded={isOpen}>
        <span className={`ar-files__chevron${isOpen ? ' is-open' : ''}`}><Icon d="M9 6l6 6-6 6" size={11} /></span>
        <span className="ar-files__title">{rows.length} {rows.length === 1 ? 'file' : 'files'} changed</span>
        {added > 0 && <span className="ar-edit__add">+{added}</span>}
        {removed > 0 && <span className="ar-edit__del">-{removed}</span>}
        <span className="ar-edit__state">
          {writing ? `Writing ${baseName(writing.file)}…` : allUndone ? 'Undone' : pending.length ? 'Ready to review' : allKept ? 'Kept' : ''}
        </span>
      </button>
      {writing && <div className="ar-edit__bar"><span /></div>}
      {isOpen && (
        <div className="ar-files__list">
          {rows.map((r) => (
            <div key={r.a.id} className={`ar-files__row${r.resolution ? ` is-${r.resolution}` : ''}`}>
              <FileIcon name={r.file} />
              <button type="button" className="ar-edit__name" title={r.file} onClick={() => onOpenFile(r.edit?.path ?? absolute(r.file, projectPath))}>{baseName(r.file)}</button>
              {r.c && r.c.added > 0 && <span className="ar-edit__add">+{r.c.added}</span>}
              {r.c && r.c.removed > 0 && <span className="ar-edit__del">-{r.c.removed}</span>}
              <span className="ar-edit__state">{r.state}</span>
              {r.edit && !r.resolution && !r.writing && (
                <span className="ar-files__row-actions">
                  <button type="button" className="ar-link" onClick={() => onUndo([r.edit!])}>Undo</button>
                  <button type="button" className="ar-link" onClick={() => onKeep([r.edit!])}>Keep</button>
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <div className="ar-edit__actions">
          <button type="button" className="ar-btn" onClick={() => onUndo(pending)}>Undo All</button>
          <button type="button" className="ar-btn ar-btn--primary" onClick={() => onKeep(pending)}>Keep All</button>
          <button type="button" className="ar-btn" onClick={onReview}>Review</button>
        </div>
      )}
    </div>
  );
}
