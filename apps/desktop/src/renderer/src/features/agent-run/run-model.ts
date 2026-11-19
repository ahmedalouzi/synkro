import type { AgentTimelineActivity } from '@peep/shared';

/** The pure parts of an agent run's display (no React, no CSS), so they can be tested on their own. */

export const norm = (p: string) => p.replace(/\\/g, '/');
export const baseName = (p: string) => norm(p).split('/').pop() ?? p;
export const isNote = (file?: string) => !!file && /(^|[/\s"'`(])\.peep\//.test(norm(file));
/** Bookkeeping tools the user does not need to see. */
const HIDDEN = /^Running (manage_plan|manage_memory|verify_criterion|update_design_manifest)/;

/** The same file? Tool args are often relative ("src/a.ts"), edits are absolute. Exported for tests. */
export function sameFile(a: string, b: string): boolean {
  const x = norm(a).toLowerCase();
  const y = norm(b).toLowerCase();
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

export function absolute(file: string, projectPath?: string): string {
  if (/^([a-zA-Z]:)?[\\/]/.test(file) || !projectPath) return file;
  return `${norm(projectPath).replace(/\/+$/, '')}/${norm(file).replace(/^\.\//, '')}`;
}

export type Item =
  | { kind: 'step'; a: AgentTimelineActivity }
  | { kind: 'file'; a: AgentTimelineActivity };

/** One item per tool call (the resolved event replaces its in-progress twin), in order. Exported for tests. */
export function runItems(activities: AgentTimelineActivity[]): Item[] {
  const byKey = new Map<string, AgentTimelineActivity>();
  for (const a of activities) {
    // The agent's own bookkeeping (.peep/plan.md, plan.json, walkthrough.md…) is not part of the user's project.
    if (a.type === 'understanding' || a.type === 'completed' || HIDDEN.test(a.message) || isNote(a.file) || isNote(a.message)) continue;
    byKey.set(a.id.replace(/:(in_progress|resolved)$/, ''), a);
  }
  return [...byKey.values()].map((a) => (
    (a.type === 'editing' || a.type === 'creating') && a.file ? { kind: 'file', a } : { kind: 'step', a }
  ));
}

/** Seconds from the start of the run to its first step ("Thought for Ns"). Exported for tests. */
export function thoughtSeconds(activities: AgentTimelineActivity[]): number | null {
  const start = activities.find((a) => a.type === 'understanding');
  const first = activities.find((a) => a.type !== 'understanding' && a.type !== 'completed');
  if (!start || !first) return null;
  const s = (Date.parse(first.timestamp) - Date.parse(start.timestamp)) / 1000;
  return Number.isFinite(s) && s >= 0 ? Math.max(1, Math.round(s)) : null;
}
