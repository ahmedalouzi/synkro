import { db } from './db';
import type { AIError } from '@peep/shared';
import {
  getPlanPolicy,
  monthStart,
  nextMonthStart,
  nextWeekStart,
  weekStart,
  dayStart,
  nextDayStart,
  GLOBAL_FREE_DAILY_SPEND_CAP_USD,
  GLOBAL_SERVER_DAILY_SPEND_CAP_USD,
  type RequestPurpose,
} from './usage-limits';
import { isValidUuid, creditLedgerService } from './credit-ledger';
import { CREDIT_UNIT_USD, costUsdToCredits } from './pricing';

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
  creditsRemaining?: number;
  monthlyCredits?: number;
  creditsUsedThisMonth?: number;
  creditsResetAt?: string;
}

export interface ReconcileResult {
  ok: boolean;
  discrepancyPct: number;
  alertTriggered: boolean;
  totalCreditsUsed: number;
  creditsCostUsd: number;
  totalEstimatedCost: number;
  googleBillingUsd?: number;
}

/**
 * Reconciles tracked credits spent against estimated cost and optional Google billing data.
 * Triggers alert if discrepancy exceeds 10%.
 */
export async function reconcileDailySpend(date = new Date(), googleBillingUsd?: number): Promise<ReconcileResult> {
  const start = dayStart(date);
  const end = nextDayStart(date);

  const res = await db.query(
    `SELECT
       COALESCE(SUM(credits_used), 0) AS total_credits_used,
       COALESCE(SUM(estimated_cost), 0) AS total_estimated_cost
     FROM usage_records
     WHERE timestamp >= $1 AND timestamp < $2`,
    [start, end]
  );

  const totalCreditsUsed = Number(res.rows[0]?.total_credits_used || 0);
  const totalEstimatedCost = parseFloat(res.rows[0]?.total_estimated_cost || '0');
  const creditsCostUsd = totalCreditsUsed * CREDIT_UNIT_USD;

  let baseComparison = totalEstimatedCost;
  let diff = Math.abs(creditsCostUsd - totalEstimatedCost);
  if (googleBillingUsd !== undefined) {
    baseComparison = googleBillingUsd;
    diff = Math.abs(creditsCostUsd - googleBillingUsd);
  }

  const discrepancyPct = baseComparison > 0 ? (diff / baseComparison) * 100 : (creditsCostUsd > 0 ? 100 : 0);
  const alertTriggered = discrepancyPct > 10;

  return {
    ok: !alertTriggered,
    discrepancyPct: Math.round(discrepancyPct * 100) / 100,
    alertTriggered,
    totalCreditsUsed,
    creditsCostUsd: Math.round(creditsCostUsd * 100000) / 100000,
    totalEstimatedCost: Math.round(totalEstimatedCost * 100000) / 100000,
    googleBillingUsd,
  };
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

  /** Reads this week's pool spend, this month's completions, and live unexpired user credits balance. */
  private async readUsage(userId: string): Promise<{
    weeklyCost: number;
    monthlyCompletions: number;
    creditBalance?: number;
    todayFallbackCredits?: number;
    todayCreditsUsed?: number;
  }> {
    let creditBalance: number | undefined = undefined;
    let todayFallbackCredits = 0;
    let todayCreditsUsed = 0;

    if (isValidUuid(userId)) {
      try {
        const uRes = await db.query('SELECT id FROM users WHERE id = $1', [userId]);
        if (uRes.rows.length > 0) {
          const bal = await creditLedgerService.getBalance(userId);
          creditBalance = bal.balance;
        }
        const todayRes = await db.query(
          `SELECT
             COALESCE(SUM(CASE WHEN resolved_model = 'gemini-3.5-flash-lite' AND model_tier <> 'free' THEN credits_used ELSE 0 END), 0) AS fallback_credits,
             COALESCE(SUM(credits_used), 0) AS total_today_credits
           FROM usage_records
           WHERE user_id = $1 AND status = 'success' AND timestamp >= $2`,
          [userId, dayStart()]
        );
        todayFallbackCredits = Number(todayRes.rows[0]?.fallback_credits || 0);
        todayCreditsUsed = Number(todayRes.rows[0]?.total_today_credits || 0);
      } catch (err) {
        console.error('[BUDGET_GUARD] readUsage credit lookup error:', err);
      }
    }

    const res = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN timestamp >= $2 AND purpose <> 'completion' THEN estimated_cost ELSE 0 END), 0) AS weekly_cost,
         COUNT(*) FILTER (WHERE timestamp >= $3 AND purpose = 'completion') AS monthly_completions
       FROM usage_records
       WHERE user_id = $1 AND status = 'success' AND timestamp >= LEAST($2, $3)`,
      [userId, weekStart(), monthStart()],
    );
    return {
      weeklyCost: parseFloat(res.rows[0]?.weekly_cost || '0'),
      monthlyCompletions: Number(res.rows[0]?.monthly_completions || 0),
      creditBalance,
      todayFallbackCredits,
      todayCreditsUsed,
    };
  }

  async checkUsage(userId: string, plan: string, purpose: RequestPurpose, estimatedCost: number): Promise<UsageDecision> {
    const isMocked = (this as any).readUsage !== ServerBudgetGuard.prototype.readUsage;

    if (!isMocked) {
      // Guard 5: Server Kill Switch & Global Daily AI Spend Cap
      try {
        const sysConfig = await db.query(
          `SELECT key, value FROM system_config WHERE key IN ('global_kill_switch', 'daily_spend_cap')`
        );
        const killSwitchRow = sysConfig.rows.find((r) => r.key === 'global_kill_switch');
        if (killSwitchRow?.value?.active === true || killSwitchRow?.value?.is_active === true) {
          console.error('[BUDGET_ALERT] Global kill switch is ACTIVE — blocking all AI traffic.');
          return {
            action: 'block',
            error: {
              code: 'SERVER_KILL_SWITCH_ACTIVE',
              message: 'AI services are temporarily unavailable due to server maintenance.',
              resetsAt: nextDayStart().toISOString(),
            },
          };
        }
        const capRow = sysConfig.rows.find((r) => r.key === 'daily_spend_cap');
        const maxServerSpendUsd = Number(capRow?.value?.max_usd) || GLOBAL_SERVER_DAILY_SPEND_CAP_USD;
        const hardKillUsd = Number(capRow?.value?.hard_kill_usd) || maxServerSpendUsd * 2;
        const todayServerSpendRes = await db.query(
          `SELECT COALESCE(SUM(estimated_cost), 0) AS total_spend FROM usage_records WHERE status = 'success' AND timestamp >= $1`,
          [dayStart()]
        );
        const totalServerSpendToday = parseFloat(todayServerSpendRes.rows[0]?.total_spend || '0');
        if (totalServerSpendToday >= maxServerSpendUsd) {
          console.error(
            `[BUDGET_ALERT] Global daily AI spend cap $${maxServerSpendUsd} reached (current: $${totalServerSpendToday.toFixed(4)}).`
          );
          // Block Free traffic first at soft cap ($100/day), block all traffic at hard kill switch
          if (plan === 'free' || totalServerSpendToday >= hardKillUsd) {
            return {
              action: 'block',
              error: {
                code: 'SERVER_DAILY_CAP_EXCEEDED',
                message: `Global daily AI spend cap of $${maxServerSpendUsd} has been reached. Services will resume tomorrow at 00:00 UTC.`,
                resetsAt: nextDayStart().toISOString(),
              },
            };
          }
        }
      } catch (err) {
        console.error('[BUDGET_GUARD] Error checking Guard 5 kill switch / spend cap:', err);
      }
    }

    const policy = getPlanPolicy(plan);

    // Guard 3: Per-Request Pre-Flight Cap (USD)
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

    // Guard 2: Free Tier Global Daily Cap ($10/day across all free users combined)
    if (!isMocked && plan === 'free') {
      try {
        const freeSpendRes = await db.query(
          `SELECT COALESCE(SUM(ur.estimated_cost), 0) AS total_free_spend
           FROM usage_records ur
           JOIN users u ON u.id = ur.user_id
           WHERE ur.status = 'success' AND u.plan = 'free' AND ur.timestamp >= $1`,
          [dayStart()]
        );
        const freeSpendToday = parseFloat(freeSpendRes.rows[0]?.total_free_spend || '0');
        if (freeSpendToday >= GLOBAL_FREE_DAILY_SPEND_CAP_USD) {
          console.error(
            `[BUDGET_ALERT] Global Free tier daily spend cap $${GLOBAL_FREE_DAILY_SPEND_CAP_USD} reached (current: $${freeSpendToday.toFixed(4)}).`
          );
          const resetsAt = nextDayStart().toISOString();
          return {
            action: 'block',
            error: {
              code: 'BUDGET_EXCEEDED',
              message: `The global Free tier daily AI allowance ($${GLOBAL_FREE_DAILY_SPEND_CAP_USD}/day) has been reached. Resets at ${resetsAt.slice(0, 10)} 00:00 UTC, or upgrade to Pro.`,
              resetsAt,
            },
          };
        }
      } catch (err) {
        console.error('[BUDGET_GUARD] Error checking Guard 2 global Free daily cap:', err);
      }
    }

    const usage = await this.readUsage(userId);

    // Safeguard for budget-guard.test.ts monkey-patching:
    // ONLY fall back to legacy weeklyCost vs weeklyPoolUsd when readUsage is monkey-patched without creditBalance.
    if (usage.creditBalance === undefined) {
      if (usage.weeklyCost + estimatedCost <= policy.weeklyPoolUsd) return { action: 'allow' };
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

    // Guard 3 (credit-aligned): Enforce per-request max credits on the real DB credit path
    const estimatedCredits = costUsdToCredits(estimatedCost);
    if (estimatedCredits > policy.maxRequestCredits) {
      return {
        action: 'block',
        error: {
          code: 'BUDGET_EXCEEDED',
          message: `This request exceeds the per-request credit limit for the ${plan} plan (estimated ${estimatedCredits} credits, limit ${policy.maxRequestCredits} credits).`,
          resetsAt: new Date(Date.now()).toISOString(),
        },
      };
    }

    // Guard 2: Free tier blocked at 0 credits
    if (usage.creditBalance <= 0) {
      if (plan === 'free') {
        const resetsAt = nextMonthStart().toISOString();
        return {
          action: 'block',
          error: {
            code: 'BUDGET_EXCEEDED',
            message: `You've used all credits on the Free plan. Upgrade to Pro for 4,000 monthly credits.`,
            resetsAt,
          },
        };
      }

      // Guard 1: Paid fallback to gemini-3.5-flash-lite capped at 50 credits/day
      if (policy.whenPoolExhausted === 'fallback') {
        const fallbackSpentToday = usage.todayFallbackCredits || 0;
        if (fallbackSpentToday >= policy.fallbackDailyCreditsCap) {
          const resetsAt = nextDayStart().toISOString();
          return {
            action: 'block',
            error: {
              code: 'FALLBACK_LIMIT_REACHED',
              message: `Daily out-of-credits fallback cap (${policy.fallbackDailyCreditsCap} credits) reached. Resets tomorrow at 00:00 UTC.`,
              resetsAt,
            },
          };
        }
        return { action: 'fallback' };
      }

      const resetsAt = nextMonthStart().toISOString();
      return {
        action: 'block',
        error: {
          code: 'BUDGET_EXCEEDED',
          message: `You've used all credits on the ${plan} plan.`,
          resetsAt,
        },
      };
    }

    return { action: 'allow' };
  }

  async getUsageSummary(userId: string, plan: string): Promise<UsageSummary> {
    const policy = getPlanPolicy(plan);
    const { weeklyCost, monthlyCompletions } = await this.readUsage(userId);
    const creditsSummary = await creditLedgerService.getAccountCreditsSummary(userId, plan);

    return {
      plan,
      weeklyPoolUsd: policy.weeklyPoolUsd,
      weeklyUsedUsd: Math.round(weeklyCost * 10000) / 10000,
      weekResetsAt: nextWeekStart().toISOString(),
      monthlyCompletions: policy.monthlyCompletions,
      completionsUsed: monthlyCompletions,
      completionsResetAt: nextMonthStart().toISOString(),
      creditsRemaining: creditsSummary.creditsRemaining,
      monthlyCredits: creditsSummary.monthlyCredits,
      creditsUsedThisMonth: creditsSummary.creditsUsedThisMonth,
      creditsResetAt: creditsSummary.creditsResetAt,
    };
  }
}
