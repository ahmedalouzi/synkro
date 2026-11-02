import type { AgentTimelineActivity } from '@peep/shared';

export type PlanState = 'in_progress' | 'done' | 'waiting' | 'unknown';

/** The parts of .peep/plan.json (written by the agent's manage_plan tool) the status needs. */
export interface PlanFile {
  status?: string;
  steps?: Array<{ status?: string }>;
}

const isPlanFile = (file?: string) => !!file && /(^|[\\/])\.peep[\\/]plan\.md$/.test(file);
const isNote = (file?: string) => !!file && /(^|[\\/])\.peep[\\/]/.test(file);

/**
 * Where the plan stands, so the plan tab shows "Proceed" only when the agent actually stopped to ask:
 * - the agent is working: in progress;
 * - plan.json says completed, or the last run changed the app's files: done;
 * - the last run wrote the plan and changed nothing else: it stopped to ask (waiting);
 * - nothing known (a plan from an earlier session): unknown, no button.
 * Exported for tests.
 */
export function planState(input: { busy: boolean; lastRun: AgentTimelineActivity[]; plan: PlanFile | null }): PlanState {
  if (input.busy) return 'in_progress';
  if (input.plan?.status === 'completed') return 'done';
  const changes = input.lastRun.filter((a) => (a.type === 'editing' || a.type === 'deleting') && a.status === 'completed');
  if (changes.some((a) => !isNote(a.file))) return 'done';
  if (changes.some((a) => isPlanFile(a.file))) return 'waiting';
  return 'unknown';
}

/** "3 of 5 steps done", from plan.json, or null. */
export function stepsDone(plan: PlanFile | null): string | null {
  const steps = plan?.steps ?? [];
  if (steps.length === 0) return null;
  return `${steps.filter((s) => s.status === 'completed').length} of ${steps.length} steps done`;
}
