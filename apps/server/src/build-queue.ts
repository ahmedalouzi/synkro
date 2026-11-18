/**
 * Queue position and a rough ETA for a queued Cloud Build. The worker runs one build at a time, oldest first
 * (build-worker.ts), so a queued build waits for the running one and for every queued build created before it.
 * The numbers come from the build_queue_info() database function (db.ts), which returns aggregates only.
 */

type Framework = 'react-native' | 'flutter';

/** One row of build_queue_info(). */
export interface QueueInfoRow {
  own_framework: Framework;
  ahead_react_native: number;
  ahead_flutter: number;
  running_framework: Framework | null;
  running_elapsed_ms: string | number | null; // BIGINT arrives as a string from pg
  avg_react_native_ms: string | number | null;
  avg_flutter_ms: string | number | null;
}

export interface QueueEstimate {
  /** 1 = next to start. */
  position: number;
  /** Until this build is done, in seconds; null without enough history to guess. */
  etaSeconds: number | null;
}

/** An overdue running build is still counted as at least this much more. */
const MIN_REMAINING_MS = 60_000;

const num = (v: string | number | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));

/**
 * Position: queued builds ahead + 1. ETA: what is left of the running build (its framework's average minus how long
 * it has run, at least a minute), plus the average of every build ahead, plus this build's own average. The averages
 * are the last 10 successful builds per framework; if one that is needed has no history yet, there is no ETA (only
 * the position), rather than a made-up number. Exported for tests.
 */
export function estimateQueue(row: QueueInfoRow): QueueEstimate {
  const avg: Record<Framework, number | null> = {
    'react-native': num(row.avg_react_native_ms),
    'flutter': num(row.avg_flutter_ms),
  };
  const ahead = row.ahead_react_native + row.ahead_flutter;
  const position = ahead + 1;

  const parts: Array<number | null> = [];
  if (row.running_framework) {
    const runAvg = avg[row.running_framework];
    const elapsed = num(row.running_elapsed_ms) ?? 0;
    parts.push(runAvg === null ? null : Math.max(runAvg - elapsed, MIN_REMAINING_MS));
  }
  if (row.ahead_react_native > 0) parts.push(avg['react-native'] === null ? null : avg['react-native'] * row.ahead_react_native);
  if (row.ahead_flutter > 0) parts.push(avg['flutter'] === null ? null : avg['flutter'] * row.ahead_flutter);
  parts.push(avg[row.own_framework]);

  if (parts.some((p) => p === null)) return { position, etaSeconds: null };
  const totalMs = (parts as number[]).reduce((a, b) => a + b, 0);
  return { position, etaSeconds: Math.round(totalMs / 1000) };
}

/**
 * For a queued job of the current user: { position, etaSeconds }, or null (not queued any more, or not theirs).
 * Run inside the request's transaction, after SET LOCAL ROLE api_user and app.current_user_id.
 */
export async function queueEstimate(dbClient: { query: (sql: string, params: unknown[]) => Promise<{ rows: QueueInfoRow[] }> }, jobId: string): Promise<QueueEstimate | null> {
  const { rows } = await dbClient.query('SELECT * FROM build_queue_info($1)', [jobId]);
  return rows.length > 0 ? estimateQueue(rows[0]) : null;
}
