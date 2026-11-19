import { db } from './db';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(id: unknown): id is string {
  return typeof id === 'string' && UUID_REGEX.test(id);
}

export type CreditBucket = 'welcome' | 'plan' | 'pack' | 'usage' | 'fallback' | 'adjustment';

export interface CreditLedgerEntry {
  id: string;
  userId: string;
  delta: number;
  bucket: CreditBucket;
  reason: string;
  requestId?: string;
  expiresAt?: Date | null;
  remaining: number;
  createdAt: Date;
}

export interface CreditBalanceInfo {
  balance: number;
  expiringSoon: number;
}

export interface AccountCreditsSummary {
  creditsRemaining: number;
  monthlyCredits: number;
  creditsUsedThisMonth: number;
  creditsResetAt: string;
}

export interface DeductCreditsOptions {
  isFallback?: boolean;
}

export class CreditLedgerService {
  /**
   * Retrieves the current live unexpired credit balance for a user.
   * Expire any overdue buckets first and syncs users.credit_balance in the same transaction.
   */
  async getBalance(userId: string, now = new Date()): Promise<CreditBalanceInfo> {
    if (!isValidUuid(userId)) {
      return { balance: 0, expiringSoon: 0 };
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE api_user');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);

      // 1. Expire any overdue buckets
      await client.query(
        `UPDATE credit_ledger
         SET remaining = 0
         WHERE user_id = $1
           AND delta > 0
           AND remaining > 0
           AND expires_at IS NOT NULL
           AND expires_at <= $2`,
        [userId, now]
      );

      // 2. Compute live unexpired balance
      const balRes = await client.query(
        `SELECT COALESCE(SUM(remaining), 0) AS balance
         FROM credit_ledger
         WHERE user_id = $1
           AND delta > 0
           AND remaining > 0
           AND (expires_at IS NULL OR expires_at > $2)`,
        [userId, now]
      );
      const balance = Number(balRes.rows[0]?.balance || 0);

      // 3. Sync to users table
      await client.query(
        'UPDATE users SET credit_balance = $1 WHERE id = $2',
        [balance, userId]
      );

      // 4. Credits expiring within the next 7 days
      const expiringRes = await client.query(
        `SELECT COALESCE(SUM(remaining), 0) AS expiring_soon
         FROM credit_ledger
         WHERE user_id = $1
           AND remaining > 0
           AND expires_at IS NOT NULL
           AND expires_at > $2
           AND expires_at <= $2 + INTERVAL '7 days'`,
        [userId, now]
      );
      const expiringSoon = Number(expiringRes.rows[0]?.expiring_soon || 0);

      await client.query('COMMIT');
      return { balance, expiringSoon };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[CreditLedgerService] getBalance error:', err);
      return { balance: 0, expiringSoon: 0 };
    } finally {
      client.release();
    }
  }

  /**
   * Grants 250 welcome credits (expires in 14 days) once per verified email/device.
   */
  async grantWelcomeCredits(
    userId: string,
    _email: string,
    deviceId?: string,
    now = new Date()
  ): Promise<{ granted: boolean; credits?: number; reason?: string }> {
    if (!isValidUuid(userId)) {
      return { granted: false, reason: 'INVALID_USER_ID' };
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE api_user');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);

      const userRes = await client.query(
        'SELECT id, welcome_credits_granted, welcome_device_id FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { granted: false, reason: 'USER_NOT_FOUND' };
      }

      const user = userRes.rows[0];
      if (user.welcome_credits_granted) {
        await client.query('ROLLBACK');
        return { granted: false, reason: 'ALREADY_GRANTED' };
      }

      if (deviceId) {
        const deviceCheck = await client.query(
          'SELECT id FROM users WHERE welcome_device_id = $1 AND welcome_credits_granted = TRUE AND id <> $2 LIMIT 1',
          [deviceId, userId]
        );
        if (deviceCheck.rows.length > 0) {
          // Device has already claimed welcome credits on another account: set deviceId but do not grant credits
          await client.query(
            'UPDATE users SET welcome_device_id = $1 WHERE id = $2',
            [deviceId, userId]
          );
          await client.query('COMMIT');
          return { granted: false, reason: 'DEVICE_ALREADY_RECEIVED_WELCOME' };
        }
      }

      const credits = 250;
      const expiresAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000); // 14 days

      await client.query(
        `INSERT INTO credit_ledger (
           user_id, delta, bucket, reason, request_id, expires_at, remaining, created_at
         ) VALUES ($1, $2, 'welcome', 'welcome_bonus', 'welcome_grant', $3, $4, $5)`,
        [userId, credits, expiresAt, credits, now]
      );

      await client.query(
        `UPDATE users
         SET credit_balance = credit_balance + $1,
             welcome_credits_granted = TRUE,
             welcome_device_id = COALESCE($2, welcome_device_id)
         WHERE id = $3`,
        [credits, deviceId ?? null, userId]
      );

      await client.query('COMMIT');
      return { granted: true, credits };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[CreditLedgerService] grantWelcomeCredits error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Idempotently grants monthly plan credits for the specified month (e.g. Free 100, Pro 4,000, Pro+ 12,000).
   */
  async ensureMonthlyPlanGrant(
    userId: string,
    plan = 'free',
    now = new Date()
  ): Promise<{ granted: boolean; credits?: number; reason?: string }> {
    if (!isValidUuid(userId)) {
      return { granted: false, reason: 'INVALID_USER_ID' };
    }

    const freeCredits = Number(process.env.SYNKRO_FREE_MONTHLY_CREDITS) || 100;
    const planCreditsMap: Record<string, number> = {
      free: freeCredits,
      pro: 4000,
      pro_plus: 12000,
    };
    const credits = planCreditsMap[plan.toLowerCase()] ?? freeCredits;

    const monthKey = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const requestId = `plan_grant_${monthKey}`;
    const reason = `monthly_plan_grant_${monthKey}`;

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE api_user');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);

      // Check if user exists
      const userRes = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { granted: false, reason: 'USER_NOT_FOUND' };
      }

      // Check idempotency for this user and month
      const existing = await client.query(
        `SELECT id FROM credit_ledger WHERE user_id = $1 AND bucket = 'plan' AND request_id = $2`,
        [userId, requestId]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return { granted: false, reason: 'ALREADY_GRANTED_THIS_MONTH' };
      }

      const expiresAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000); // 30 days

      await client.query(
        `INSERT INTO credit_ledger (
           user_id, delta, bucket, reason, request_id, expires_at, remaining, created_at
         ) VALUES ($1, $2, 'plan', $3, $4, $5, $6, $7)`,
        [userId, credits, reason, requestId, expiresAt, credits, now]
      );

      await client.query(
        `UPDATE users
         SET credit_balance = credit_balance + $1
         WHERE id = $2`,
        [credits, userId]
      );

      await client.query('COMMIT');
      return { granted: true, credits };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[CreditLedgerService] ensureMonthlyPlanGrant error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Batch cron job to grant monthly credits to all active users.
   * Runs under pool credentials so it can iterate all users.
   */
  async runMonthlyCreditGrantJob(now = new Date()): Promise<{ processed: number; granted: number }> {
    try {
      const res = await db.query('SELECT id, plan FROM users');
      let granted = 0;
      for (const row of res.rows) {
        const result = await this.ensureMonthlyPlanGrant(row.id, row.plan || 'free', now);
        if (result.granted) granted++;
      }
      return { processed: res.rows.length, granted };
    } catch (err) {
      console.error('[CreditLedgerService] runMonthlyCreditGrantJob error:', err);
      throw err;
    }
  }

  /**
   * Grants a pack of 500 credits (valid for 12 months) upon pack purchase.
   */
  async grantCreditPack(
    userId: string,
    eventId: string,
    credits = 500,
    now = new Date()
  ): Promise<{ granted: boolean; credits?: number; reason?: string }> {
    if (!isValidUuid(userId)) {
      return { granted: false, reason: 'INVALID_USER_ID' };
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE api_user');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);

      const userRes = await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { granted: false, reason: 'USER_NOT_FOUND' };
      }

      // Idempotency check on eventId
      const existing = await client.query(
        `SELECT id FROM credit_ledger WHERE user_id = $1 AND request_id = $2`,
        [userId, eventId]
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        return { granted: false, reason: 'ALREADY_PROCESSED' };
      }

      const expiresAt = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000); // 12 months

      await client.query(
        `INSERT INTO credit_ledger (
           user_id, delta, bucket, reason, request_id, expires_at, remaining, created_at
         ) VALUES ($1, $2, 'pack', 'credit_pack_purchase', $3, $4, $5, $6)`,
        [userId, credits, eventId, expiresAt, credits, now]
      );

      await client.query(
        `UPDATE users
         SET credit_balance = credit_balance + $1
         WHERE id = $2`,
        [credits, userId]
      );

      await client.query('COMMIT');
      return { granted: true, credits };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[CreditLedgerService] grantCreditPack error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Deducts credits using FIFO expiry-first ordering (welcome 14d -> plan 30d -> pack 12m).
   * For paid fallback requests when credit balance is exhausted, records audit entry with delta = 0
   * to prevent ledger vs balance drift.
   */
  async deductCredits(
    userId: string,
    creditsToSpend: number,
    requestId: string,
    reason = 'ai_spend',
    now = new Date(),
    options?: DeductCreditsOptions
  ): Promise<{ deducted: number; remainingBalance: number }> {
    if (!isValidUuid(userId)) {
      return { deducted: 0, remainingBalance: 0 };
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE api_user');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [userId]);

      const userRes = await client.query(
        'SELECT id, credit_balance FROM users WHERE id = $1 FOR UPDATE',
        [userId]
      );
      if (userRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return { deducted: 0, remainingBalance: 0 };
      }

      const currentBalance = Number(userRes.rows[0].credit_balance || 0);

      // Handle paid fallback request: do not deduct below zero or corrupt ledger
      if (options?.isFallback || creditsToSpend <= 0 || (currentBalance <= 0 && options?.isFallback)) {
        await client.query(
          `INSERT INTO credit_ledger (
             user_id, delta, bucket, reason, request_id, expires_at, remaining, created_at
           ) VALUES ($1, 0, 'fallback', $2, $3, NULL, 0, $4)`,
          [userId, reason, requestId, now]
        );
        await client.query('COMMIT');
        return { deducted: 0, remainingBalance: currentBalance };
      }

      // Expire overdue buckets first
      await client.query(
        `UPDATE credit_ledger
         SET remaining = 0
         WHERE user_id = $1
           AND delta > 0
           AND remaining > 0
           AND expires_at IS NOT NULL
           AND expires_at <= $2`,
        [userId, now]
      );

      // Fetch active grant rows ordered by expiry (soonest expiry consumed first)
      const grantsRes = await client.query(
        `SELECT id, remaining
         FROM credit_ledger
         WHERE user_id = $1
           AND remaining > 0
           AND (expires_at IS NULL OR expires_at > $2)
         ORDER BY expires_at ASC NULLS LAST, created_at ASC
         FOR UPDATE`,
        [userId, now]
      );

      let toSpend = creditsToSpend;
      for (const row of grantsRes.rows) {
        if (toSpend <= 0) break;
        const available = Number(row.remaining);
        const take = Math.min(available, toSpend);
        await client.query(
          'UPDATE credit_ledger SET remaining = remaining - $1 WHERE id = $2',
          [take, row.id]
        );
        toSpend -= take;
      }

      const actualDeducted = creditsToSpend - toSpend;

      // Record ledger entry only up to available balance so SUM(delta) never drifts negative
      if (actualDeducted > 0) {
        await client.query(
          `INSERT INTO credit_ledger (
             user_id, delta, bucket, reason, request_id, expires_at, remaining, created_at
           ) VALUES ($1, $2, 'usage', $3, $4, NULL, 0, $5)`,
          [userId, -actualDeducted, reason, requestId, now]
        );
      } else {
        await client.query(
          `INSERT INTO credit_ledger (
             user_id, delta, bucket, reason, request_id, expires_at, remaining, created_at
           ) VALUES ($1, 0, 'fallback', $2, $3, NULL, 0, $4)`,
          [userId, reason, requestId, now]
        );
      }

      // Compute exact live balance from remaining unexpired buckets and sync users.credit_balance
      const balRes = await client.query(
        `SELECT COALESCE(SUM(remaining), 0) AS balance
         FROM credit_ledger
         WHERE user_id = $1
           AND delta > 0
           AND remaining > 0
           AND (expires_at IS NULL OR expires_at > $2)`,
        [userId, now]
      );
      const remainingBalance = Number(balRes.rows[0]?.balance || 0);

      await client.query(
        `UPDATE users
         SET credit_balance = $1
         WHERE id = $2`,
        [remainingBalance, userId]
      );

      await client.query('COMMIT');
      return { deducted: actualDeducted, remainingBalance };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error('[CreditLedgerService] deductCredits error:', err);
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves summary for desktop UI and status endpoints.
   */
  async getAccountCreditsSummary(userId: string, plan = 'free', now = new Date()): Promise<AccountCreditsSummary> {
    const freeCredits = Number(process.env.SYNKRO_FREE_MONTHLY_CREDITS) || 100;
    const planCreditsMap: Record<string, number> = {
      free: freeCredits,
      pro: 4000,
      pro_plus: 12000,
    };
    const monthlyCredits = planCreditsMap[plan.toLowerCase()] ?? freeCredits;

    if (!isValidUuid(userId)) {
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return {
        creditsRemaining: 0,
        monthlyCredits,
        creditsUsedThisMonth: 0,
        creditsResetAt: nextMonth.toISOString(),
      };
    }

    try {
      const balanceInfo = await this.getBalance(userId, now);

      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

      const usedRes = await db.query(
        `SELECT COALESCE(SUM(credits_used), 0) AS credits_used
         FROM usage_records
         WHERE user_id = $1 AND timestamp >= $2`,
        [userId, monthStart]
      );
      const creditsUsedThisMonth = Number(usedRes.rows[0]?.credits_used || 0);

      return {
        creditsRemaining: balanceInfo.balance,
        monthlyCredits,
        creditsUsedThisMonth,
        creditsResetAt: nextMonthStart.toISOString(),
      };
    } catch (err) {
      console.error('[CreditLedgerService] getAccountCreditsSummary error:', err);
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      return {
        creditsRemaining: 0,
        monthlyCredits,
        creditsUsedThisMonth: 0,
        creditsResetAt: nextMonth.toISOString(),
      };
    }
  }
}

export const creditLedgerService = new CreditLedgerService();
