import { db } from './db';
import type { AIError } from '@peep/shared';
import {
  getPlanPolicy,
  monthStart,
  nextMonthStart,
  nextWeekStart,
  weekStart,
  type RequestPurpose,
} from './usage-limits';

export type UsageDecision =
  | { action: 'allow' }
  /** Pool spent on a paid plan: serve the request on the cheap model instead. */
  | { action: 'fallback' }
  | { action: 'block'; error: AIError & { resetsAt: string } };

export interface UsageSummary {
  plan: string;
  weeklyPoolUsd: number;
  weeklyUsedUsd: number;
  weekResetsAt: string;
  monthlyCompletions: number | null;
  completionsUsed: number;
  completionsResetAt: string;
}

export class ServerBudgetGuard {
  public locks = new Set<string>();

  constructor(_usageStore?: unknown) {}

  async acquireLock(key: string): Promise<boolean> {
    this.locks.add(key);
    return true;
  }

  releaseLock(key: string): void {
    this.locks.delete(key);
  }

  async checkBudget(userId: string, plan: string, estimatedCost: number): Promise<void> {
    const decision = await this.checkUsage(userId, plan, 'chat', estimatedCost);
    if (decision.action === 'block') {
      const err = new Error(decision.error.message) as any;
      err.code = decision.error.code;
      err.resetsAt = decision.error.resetsAt;
      throw err;
    }
  }

  /** Reads this week's pool spend and this month's completion count in one query. */
  private async readUsage(userId: string): Promise<{ weeklyCost: number; monthlyCompletions: number }> {
    const res = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN timestamp >= $2 AND purpose <> 'completion' THEN estimated_cost ELSE 0 END), 0) AS weekly_cost,
         COUNT(*) FILTER (WHERE timestamp >= $3 AND purpose = 'completion') AS monthly_completions
       FROM usage_records
       WHERE user_id = $1 AND status = 'success' AND timestamp >= LEAST($2, $3)`,
      [userId, weekStart(), monthStart()],
    );
    return {
      weeklyCost: parseFloat(res.rows[0].weekly_cost),
      monthlyCompletions: Number(res.rows[0].monthly_completions),
    };
  }

  async checkUsage(userId: string, plan: string, purpose: RequestPurpose, estimatedCost: number): Promise<UsageDecision> {
    const policy = getPlanPolicy(plan);

    if (estimatedCost > policy.maxRequestCostUsd) {
      return {
        action: 'block',
        error: {
          code: 'BUDGET_EXCEEDED',
          message: `This request is too large for the ${plan} plan (estimated $${estimatedCost.toFixed(3)}, limit $${policy.maxRequestCostUsd}). Try attaching less context.`,
          resetsAt: new Date(Date.now()).toISOString(),
        },
      };
    }

    if (purpose === 'completion') {
      if (policy.monthlyCompletions === null) return { action: 'allow' };
      const { monthlyCompletions } = await this.readUsage(userId);
      if (monthlyCompletions < policy.monthlyCompletions) return { action: 'allow' };
      const resetsAt = nextMonthStart().toISOString();
      return {
        action: 'block',
        error: {
          code: 'BUDGET_EXCEEDED',
          message: `You've used all ${policy.monthlyCompletions} Tab completions for this month. They reset on ${resetsAt.slice(0, 10)}, or upgrade to Pro for unlimited completions.`,
          resetsAt,
        },
      };
    }

    const { weeklyCost } = await this.readUsage(userId);
    if (weeklyCost + estimatedCost <= policy.weeklyPoolUsd) return { action: 'allow' };
    if (policy.whenPoolExhausted === 'fallback') return { action: 'fallback' };

    const resetsAt = nextWeekStart().toISOString();
    return {
      action: 'block',
      error: {
        code: 'BUDGET_EXCEEDED',
        message: `You've used this week's included AI usage on the ${plan} plan. It resets on ${resetsAt.slice(0, 10)}, or upgrade for more.`,
        resetsAt,
      },
    };
  }

  async getUsageSummary(userId: string, plan: string): Promise<UsageSummary> {
    const policy = getPlanPolicy(plan);
    const { weeklyCost, monthlyCompletions } = await this.readUsage(userId);
    return {
      plan,
      weeklyPoolUsd: policy.weeklyPoolUsd,
      weeklyUsedUsd: Math.round(weeklyCost * 10000) / 10000,
      weekResetsAt: nextWeekStart().toISOString(),
      monthlyCompletions: policy.monthlyCompletions,
      completionsUsed: monthlyCompletions,
      completionsResetAt: nextMonthStart().toISOString(),
    };
  }
}
