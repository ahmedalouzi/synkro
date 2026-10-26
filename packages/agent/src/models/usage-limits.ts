/**
 * Plan usage policy, modelled on Cursor's:
 * - Each plan has a usage pool measured in dollars of model cost that refreshes weekly.
 * - Tab completions are unlimited on paid plans and don't draw from the pool;
 *   the free plan gets a monthly completion allowance instead.
 * - When the pool runs out, paid plans fall back to the cheap model (like Cursor's Auto)
 *   and the free plan is blocked until the reset.
 * - Short per-minute burst limits stop scripts and runaway loops on every plan.
 */

export type RequestPurpose = 'chat' | 'completion';

export interface PlanPolicy {
  /** Dollars of model cost per week for chat/agent requests. */
  weeklyPoolUsd: number;
  /** Largest estimated cost a single request may have. */
  maxRequestCostUsd: number;
  chatPerMinute: number;
  completionsPerMinute: number;
  /** Tab completions per calendar month (UTC); null = unlimited. */
  monthlyCompletions: number | null;
  /** What happens to chat requests once the weekly pool is spent. */
  whenPoolExhausted: 'block' | 'fallback';
  /** Whether the user may pick a specific model; otherwise requests always use Auto routing. */
  allowModelSelection: boolean;
}

export const PLAN_POLICIES: Record<string, PlanPolicy> = {
  free: {
    weeklyPoolUsd: 0.5,
    maxRequestCostUsd: 0.05,
    chatPerMinute: 10,
    completionsPerMinute: 30,
    monthlyCompletions: 2000,
    whenPoolExhausted: 'block',
    allowModelSelection: false,
  },
  pro: {
    weeklyPoolUsd: 5,
    maxRequestCostUsd: 0.5,
    chatPerMinute: 40,
    completionsPerMinute: 120,
    monthlyCompletions: null,
    whenPoolExhausted: 'fallback',
    allowModelSelection: true,
  },
};

export function getPlanPolicy(plan: string | undefined): PlanPolicy {
  return PLAN_POLICIES[plan ?? 'free'] ?? PLAN_POLICIES.free;
}

/** Start of the current usage week: Monday 00:00 UTC. */
export function weekStart(now = new Date(Date.now())): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  return start;
}

export function nextWeekStart(now = new Date(Date.now())): Date {
  const next = weekStart(now);
  next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

export function monthStart(now = new Date(Date.now())): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function nextMonthStart(now = new Date(Date.now())): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

/** Dollar cost of a request from its token counts and the model's per-million prices. */
export function tokenCost(
  prices: { costInputPerMillion?: number; costOutputPerMillion?: number },
  inputTokens: number,
  outputTokens: number,
): number {
  return (inputTokens * (prices.costInputPerMillion ?? 0) + outputTokens * (prices.costOutputPerMillion ?? 0)) / 1_000_000;
}

/** Rough pre-flight estimate: ~4 characters per input token plus a typical reply. */
export function estimateRequestCost(
  prices: { costInputPerMillion?: number; costOutputPerMillion?: number },
  messages: unknown,
  expectedOutputTokens = 1000,
): number {
  const inputTokens = Math.ceil(JSON.stringify(messages ?? '').length / 4);
  return tokenCost(prices, inputTokens, expectedOutputTokens);
}

/** In-memory sliding-window counter for per-minute burst limits. */
export class BurstLimiter {
  private hits = new Map<string, number[]>();

  constructor(private windowMs = 60_000) {}

  /** Records a hit; returns 0 when allowed, otherwise the seconds until a slot frees up. */
  hit(key: string, limit: number): number {
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return Math.max(1, Math.ceil((recent[0] + this.windowMs - now) / 1000));
    }
    recent.push(now);
    this.hits.set(key, recent);
    return 0;
  }

  /** Drops keys with no hits in the current window. */
  prune(): void {
    const now = Date.now();
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }
}
