import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDIT_UNIT_USD,
  MODEL_PRICING_TABLE,
  getModelPriceRates,
  resolveModelPricing,
  calculateModelCostUsd,
  costUsdToCredits,
} from '../src/models/pricing';
import { ServerModelRouter } from '../src/models/server-router';
import { ModelRegistry } from '../src/models/registry';
import { GoogleGeminiAdapter } from '../src/models/google-adapter';
import { BackendAIGateway } from '../src/models/backend-gateway';
import { db } from '../src/models/db';
import { creditLedgerService, isValidUuid } from '../src/models/credit-ledger';
import { ServerBudgetGuard, reconcileDailySpend } from '../src/models/budget-guard';
import { ServerUsageStore } from '../src/models/usage-store';
import {
  PLAN_POLICIES,
  GLOBAL_FREE_DAILY_SPEND_CAP_USD,
  GLOBAL_SERVER_DAILY_SPEND_CAP_USD,
  dayStart,
  nextDayStart,
} from '../src/models/usage-limits';
import { normalizeWebhookPayload } from '../../../apps/server/src/billing-router';

export default async function runTests() {
  console.log('  Running Credits & AI Pricing Unit Tests (Card #135)...');

  const createdUserIds: string[] = [];

  try {
    // -------------------------------------------------------------------------
    // 1. Authoritative Pricing Table & Scheduled Doubling / Sunsets
    // -------------------------------------------------------------------------
    console.log('  [1/9] Testing Authoritative Pricing Table Parity & Dates...');

    assert.strictEqual(CREDIT_UNIT_USD, 0.002, '1 credit must equal $0.002 real cost');

    // 1.1 Gemini 3.6 Flash base vs 2027-01-01 scheduled doubling
    const flashBefore = resolveModelPricing('gemini-3.6-flash', {
      now: new Date('2026-12-31T23:59:59Z'),
    });
    assert.strictEqual(flashBefore.rates.inputPerMillion, 0.75);
    assert.strictEqual(flashBefore.rates.cachedPerMillion, 0.075);
    assert.strictEqual(flashBefore.rates.outputPerMillion, 3.75);

    const flashAfter = resolveModelPricing('gemini-3.6-flash', {
      now: new Date('2027-01-01T00:00:00Z'),
    });
    assert.strictEqual(flashAfter.rates.inputPerMillion, 1.50, 'Flash input price must double on 2027-01-01');
    assert.strictEqual(flashAfter.rates.cachedPerMillion, 0.15);
    assert.strictEqual(flashAfter.rates.outputPerMillion, 7.50, 'Flash output price must double on 2027-01-01');

    // 1.2 Gemini 4 Argon base vs 2026-12-01 scheduled doubling
    const argonBefore = resolveModelPricing('gemini-4-argon', {
      now: new Date('2026-11-30T23:59:59Z'),
    });
    assert.strictEqual(argonBefore.rates.inputPerMillion, 2.00);
    assert.strictEqual(argonBefore.rates.cachedPerMillion, 0.10);
    assert.strictEqual(argonBefore.rates.outputPerMillion, 10.00);

    const argonAfter = resolveModelPricing('gemini-4-argon', {
      now: new Date('2026-12-01T00:00:00Z'),
    });
    assert.strictEqual(argonAfter.rates.inputPerMillion, 4.00, 'Argon input price must double on 2026-12-01');
    assert.strictEqual(argonAfter.rates.cachedPerMillion, 0.20);
    assert.strictEqual(argonAfter.rates.outputPerMillion, 20.00, 'Argon output price must double on 2026-12-01');

    // 1.3 Gemini 3.1 Flash-Lite Sunset on 2027-05-07
    const liteBefore = resolveModelPricing('gemini-3.1-flash-lite', {
      now: new Date('2027-05-06T23:59:59Z'),
    });
    assert.strictEqual(liteBefore.modelId, 'gemini-3.1-flash-lite');
    assert.strictEqual(liteBefore.rates.inputPerMillion, 0.25);
    assert.strictEqual(liteBefore.rates.outputPerMillion, 1.50);

    const liteAfter = resolveModelPricing('gemini-3.1-flash-lite', {
      now: new Date('2027-05-07T00:00:00Z'),
    });
    assert.strictEqual(liteAfter.modelId, 'gemini-3.5-flash-lite', 'Sunset 3.1-flash-lite must redirect to 3.5-flash-lite');
    assert.strictEqual(liteAfter.rates.inputPerMillion, 0.30);
    assert.strictEqual(liteAfter.rates.outputPerMillion, 2.50);

    // 1.4 Gemini 3.1 Pro: <=200k vs >200k prompt tokens
    const proStandard = resolveModelPricing('gemini-3.1-pro', { promptTokens: 100_000 });
    assert.strictEqual(proStandard.rates.inputPerMillion, 2.00);
    assert.strictEqual(proStandard.rates.cachedPerMillion, 0.20);
    assert.strictEqual(proStandard.rates.outputPerMillion, 12.00);

    const proLongContext = resolveModelPricing('gemini-3.1-pro', { promptTokens: 200_001 });
    assert.strictEqual(proLongContext.rates.inputPerMillion, 4.00, '>200k prompt tokens uses tier rate');
    assert.strictEqual(proLongContext.rates.cachedPerMillion, 0.40);
    assert.strictEqual(proLongContext.rates.outputPerMillion, 18.00);

    // -------------------------------------------------------------------------
    // 2. Credit Calculation & Token Cost Formulas
    // -------------------------------------------------------------------------
    console.log('  [2/9] Testing Cost & Credit Math Formulas...');

    // Formula: cost_usd = ((input - cached) * p_in + cached * p_cache + (output + thinking) * p_out) / 10^6
    // Using gemini-3.6-flash base: p_in = 0.75, p_cache = 0.075, p_out = 3.75
    // 1,000 uncached in ($0.00075) + 1,000 cached in ($0.000075) + 300 output ($0.001125) + 100 thinking ($0.000375)
    // Total = 0.00075 + 0.000075 + 0.001125 + 0.000375 = $0.002325
    const computedCost = calculateModelCostUsd(
      'gemini-3.6-flash',
      {
        inputTokens: 2000,
        cachedTokens: 1000,
        outputTokens: 300,
        thinkingTokens: 100,
      },
      new Date('2026-11-01T00:00:00Z')
    );
    assert.strictEqual(computedCost, 0.002325);

    // 1 credit = $0.002
    // ceil(0.002325 / 0.002) = ceil(1.1625) = 2 credits
    const credits = costUsdToCredits(computedCost, 2400);
    assert.strictEqual(credits, 2);

    // Boundary conditions
    assert.strictEqual(costUsdToCredits(0, 0), 0, 'Zero cost with zero tokens is 0 credits');
    assert.strictEqual(costUsdToCredits(0.0001, 10), 1, 'Smallest non-zero request is at least 1 credit');
    assert.strictEqual(costUsdToCredits(0.002, 1000), 1, 'Exactly $0.002 is 1 credit');
    assert.strictEqual(costUsdToCredits(1.0, 500_000), 500, '$1.00 is exactly 500 credits');

    // -------------------------------------------------------------------------
    // 3. Server Model Router & OpenAI-Absent Failover
    // -------------------------------------------------------------------------
    console.log('  [3/9] Testing ServerModelRouter & Failover Routing...');

    const router = new ServerModelRouter();

    // Default fast route (pro plan) uses gemini-3.6-flash
    const defaultFast = router.route('fast');
    assert.strictEqual(defaultFast.modelId, 'gemini-3.6-flash');
    assert.strictEqual(defaultFast.costInputPerMillion, 0.75);
    assert.strictEqual(defaultFast.costOutputPerMillion, 3.75);

    // Free plan fast route maps to gemini-3.5-flash-lite
    const freeFast = router.route('fast', 'free');
    assert.strictEqual(freeFast.modelId, 'gemini-3.5-flash-lite');
    assert.strictEqual(freeFast.costInputPerMillion, 0.30);
    assert.strictEqual(freeFast.costOutputPerMillion, 2.50);

    // Out-of-credits fallback maps to gemini-3.5-flash-lite
    const fallbackFast = router.route('fast', 'pro', undefined, { outOfCreditsFallback: true });
    assert.strictEqual(fallbackFast.modelId, 'gemini-3.5-flash-lite');

    // Fallback resolution when OpenAI key is absent
    const failoverFast = router.resolveFallbackConfig('fast', false);
    assert.strictEqual(failoverFast?.providerId, 'google');
    assert.strictEqual(failoverFast?.modelId, 'gemini-3.5-flash-lite');

    const failoverPremium = router.resolveFallbackConfig('premium', false);
    assert.strictEqual(failoverPremium?.providerId, 'google');
    assert.strictEqual(failoverPremium?.modelId, 'gemini-3.6-flash');

    const failoverReasoning = router.resolveFallbackConfig('reasoning', false);
    assert.strictEqual(failoverReasoning?.providerId, 'google');
    assert.strictEqual(failoverReasoning?.modelId, 'gemini-3.6-flash');

    // Single-source pricing checks:
    // 1) ServerModelRouter picks up scheduled 2027-01-01 doubling via getModelPriceRates
    const futureFast = router.route('fast', 'pro', undefined, {
      now: new Date('2027-01-02T00:00:00Z'),
    });
    assert.strictEqual(futureFast.costInputPerMillion, 1.50, 'Router must reflect 2027-01-01 Flash doubling');
    assert.strictEqual(futureFast.costOutputPerMillion, 7.50);

    // 2) Reasoning tier with no OpenAI key routes to gemini-3.6-flash with Gemini rates
    const reasoningNoOpenAi = router.route('reasoning', 'pro', undefined, {
      hasOpenAiKey: false,
      now: new Date('2026-11-01T00:00:00Z'),
    });
    assert.strictEqual(reasoningNoOpenAi.providerId, 'google');
    assert.strictEqual(reasoningNoOpenAi.modelId, 'gemini-3.6-flash');
    assert.strictEqual(reasoningNoOpenAi.costInputPerMillion, 0.75);
    assert.strictEqual(reasoningNoOpenAi.costOutputPerMillion, 3.75);

    // 3) ModelRegistry derives rates dynamically from authoritative pricing table
    const registry = new ModelRegistry();
    const regFlash = registry.get('gemini-3.6-flash');
    const authFlash = getModelPriceRates('gemini-3.6-flash');
    assert.ok(regFlash, 'gemini-3.6-flash must be registered in ModelRegistry');
    assert.strictEqual(regFlash?.costInput, authFlash.inputPerMillion);
    assert.strictEqual(regFlash?.costOutput, authFlash.outputPerMillion);

    // -------------------------------------------------------------------------
    // 4. GoogleGeminiAdapter Usage Extraction & Context Caching End-to-End
    // -------------------------------------------------------------------------
    console.log('  [4/9] Testing GoogleGeminiAdapter Usage Extraction & Context Caching...');

    const adapter = new GoogleGeminiAdapter('mock-test-key');
    assert.strictEqual(typeof (adapter as any).createContextCache, 'function', 'createContextCache method must be defined');
    assert.strictEqual(typeof (adapter as any).getOrCreateContextCache, 'function', 'getOrCreateContextCache method must be defined');

    // Verify deprecated models are removed from default list
    const models = await (adapter as any).getAvailableModels();
    assert.strictEqual(models.includes('gemini-2.0-flash'), false, 'gemini-2.0-flash must be removed');
    assert.strictEqual(models.includes('gemini-1.5-flash'), false, 'gemini-1.5-flash must be removed');
    assert.strictEqual(models.includes('gemini-3.5-flash-lite'), true, 'gemini-3.5-flash-lite must be present');

    // Test real usage extraction & end-to-end context caching cost reduction
    const originalFetch = globalThis.fetch;
    try {
      let cacheCreateCount = 0;
      let capturedCachedContentField: string | undefined;

      globalThis.fetch = async (url: any, init?: any) => {
        const urlStr = String(url);
        if (urlStr.includes('/cachedContents')) {
          cacheCreateCount++;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              name: 'cachedContents/mock-cache-123',
              expireTime: new Date(Date.now() + 1800_000).toISOString(),
            }),
          } as any;
        }
        if (urlStr.includes(':generateContent')) {
          const parsedBody = init?.body ? JSON.parse(init.body) : {};
          if (parsedBody.cachedContent) {
            capturedCachedContentField = parsedBody.cachedContent;
            return {
              ok: true,
              status: 200,
              json: async () => ({
                candidates: [{ content: { parts: [{ text: 'Cached context response' }] } }],
                usageMetadata: {
                  promptTokenCount: 10000,
                  cachedContentTokenCount: 8000,
                  candidatesTokenCount: 200,
                  thoughtsTokenCount: 0,
                  totalTokenCount: 10200,
                },
              }),
            } as any;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              candidates: [{ content: { parts: [{ text: 'Calculated credit response' }] } }],
              usageMetadata: {
                promptTokenCount: 1200,
                cachedContentTokenCount: 400,
                candidatesTokenCount: 250,
                thoughtsTokenCount: 50,
                totalTokenCount: 1500,
              },
            }),
          } as any;
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [{ name: 'models/gemini-3.6-flash' }, { name: 'models/gemini-3.5-flash-lite' }],
          }),
        } as any;
      };

      const genRes = await adapter.generate({
        tier: 'fast',
        messages: [{ role: 'user', content: 'test credit usage' }],
      });

      assert.strictEqual(genRes.content, 'Calculated credit response');
      assert.strictEqual(genRes.usage?.inputTokens, 1200);
      assert.strictEqual((genRes.usage as any)?.cachedTokens, 400);
      assert.strictEqual(genRes.usage?.outputTokens, 250);
      assert.strictEqual((genRes.usage as any)?.thinkingTokens, 50);
      assert.strictEqual(genRes.usage?.totalTokens, 1500);
      assert.ok(genRes.cost?.cost && genRes.cost.cost > 0, 'Cost must be calculated');
      assert.ok((genRes.cost as any)?.credits >= 1, 'Credits must be at least 1');

      // Context caching: create once, reuse from registry on second turn
      const cacheName1 = await adapter.getOrCreateContextCache({
        model: 'gemini-3.6-flash',
        systemPrompt: 'Static system instructions for Synkro workspace ' + 'x'.repeat(200),
      });
      const cacheName2 = await adapter.getOrCreateContextCache({
        model: 'gemini-3.6-flash',
        systemPrompt: 'Static system instructions for Synkro workspace ' + 'x'.repeat(200),
      });
      assert.strictEqual(cacheName1, 'cachedContents/mock-cache-123');
      assert.strictEqual(cacheName2, 'cachedContents/mock-cache-123');
      assert.strictEqual(cacheCreateCount, 1, 'Repeated identical prefix must reuse cached resource name');

      const cachedGenRes = await adapter.generate({
        tier: 'fast',
        model: 'gemini-3.6-flash',
        cachedContent: cacheName1,
        messages: [{ role: 'user', content: 'follow-up turn' }],
      });
      assert.strictEqual(capturedCachedContentField, 'cachedContents/mock-cache-123', 'Request must pass cachedContent');
      assert.strictEqual((cachedGenRes.usage as any)?.cachedTokens, 8000);

      const uncachedEquivalentCost = calculateModelCostUsd('gemini-3.6-flash', {
        inputTokens: 10000,
        cachedTokens: 0,
        outputTokens: 200,
        thinkingTokens: 0,
      });
      const cachedActualCost = cachedGenRes.cost?.cost || 0;
      assert.ok(
        cachedActualCost > 0 && cachedActualCost < uncachedEquivalentCost * 0.5,
        `Cached cost (${cachedActualCost}) must be less than half of uncached cost (${uncachedEquivalentCost})`
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    // -------------------------------------------------------------------------
    // 5. Database Schema & CreditLedgerService Grants, Expiration, Anti-Abuse & FIFO
    // -------------------------------------------------------------------------
    console.log('  [5/9] Testing CreditLedgerService Grants, Expiration, Anti-Abuse & FIFO...');

    const testEmail = `credit_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`;
    const testUserId = randomUUID();
    createdUserIds.push(testUserId);
    const testDeviceId = `device_test_${Date.now()}`;

    await db.query(
      `INSERT INTO users (id, email, password_hash, plan, email_verified, credit_balance)
       VALUES ($1, $2, 'mock_hash', 'free', TRUE, 0)`,
      [testUserId, testEmail]
    );

    // 5.1 Welcome Credits: 250 credits with 14d expiry
    const welcomeGrant = await creditLedgerService.grantWelcomeCredits(testUserId, testEmail, testDeviceId);
    assert.strictEqual(welcomeGrant.granted, true);
    assert.strictEqual(welcomeGrant.credits, 250);

    const balAfterWelcome = await creditLedgerService.getBalance(testUserId);
    assert.strictEqual(balAfterWelcome.balance, 250);

    // Second welcome attempt for same user is rejected
    const secondWelcome = await creditLedgerService.grantWelcomeCredits(testUserId, testEmail);
    assert.strictEqual(secondWelcome.granted, false);
    assert.strictEqual(secondWelcome.reason, 'ALREADY_GRANTED');

    // Second user with the SAME deviceId is rejected (deviceId anti-abuse)
    const dupDeviceUserId = randomUUID();
    const dupDeviceEmail = `dup_dev_${Date.now()}@example.com`;
    createdUserIds.push(dupDeviceUserId);
    await db.query(
      `INSERT INTO users (id, email, password_hash, plan, email_verified, credit_balance)
       VALUES ($1, $2, 'mock_hash', 'free', TRUE, 0)`,
      [dupDeviceUserId, dupDeviceEmail]
    );
    const dupDeviceGrant = await creditLedgerService.grantWelcomeCredits(dupDeviceUserId, dupDeviceEmail, testDeviceId);
    assert.strictEqual(dupDeviceGrant.granted, false, 'Second user on same device must not receive welcome credits');
    assert.strictEqual(dupDeviceGrant.reason, 'DEVICE_ALREADY_RECEIVED_WELCOME');
    const dupDeviceBal = await creditLedgerService.getBalance(dupDeviceUserId);
    assert.strictEqual(dupDeviceBal.balance, 0);

    // Bucket expiration test: expired welcome bucket must not return stale spendable balance
    const expUserId = randomUUID();
    const expEmail = `exp_user_${Date.now()}@example.com`;
    createdUserIds.push(expUserId);
    await db.query(
      `INSERT INTO users (id, email, password_hash, plan, email_verified, credit_balance)
       VALUES ($1, $2, 'mock_hash', 'free', TRUE, 0)`,
      [expUserId, expEmail]
    );
    await creditLedgerService.grantWelcomeCredits(expUserId, expEmail);
    const futureDate = new Date(Date.now() + 16 * 24 * 60 * 60 * 1000); // 16 days later (> 14d expiry)
    const expiredBal = await creditLedgerService.getBalance(expUserId, futureDate);
    assert.strictEqual(expiredBal.balance, 0, 'Expired welcome credits must return 0 live balance');
    const syncedUserRow = await db.query('SELECT credit_balance FROM users WHERE id = $1', [expUserId]);
    assert.strictEqual(Number(syncedUserRow.rows[0].credit_balance), 0, 'users.credit_balance must sync to 0 on expiry');

    // 5.2 Monthly Plan Grant
    const planGrant = await creditLedgerService.ensureMonthlyPlanGrant(testUserId, 'free');
    assert.strictEqual(planGrant.granted, true);
    assert.strictEqual(planGrant.credits, 100);

    // Idempotent for same month
    const dupPlanGrant = await creditLedgerService.ensureMonthlyPlanGrant(testUserId, 'free');
    assert.strictEqual(dupPlanGrant.granted, false);
    assert.strictEqual(dupPlanGrant.reason, 'ALREADY_GRANTED_THIS_MONTH');

    // 5.3 Credit Pack Grant: 500 credits with 12m expiry
    const packEventId = `pack_evt_${Date.now()}`;
    const packGrant = await creditLedgerService.grantCreditPack(testUserId, packEventId, 500);
    assert.strictEqual(packGrant.granted, true);
    assert.strictEqual(packGrant.credits, 500);

    // Total balance: 250 (welcome) + 100 (plan) + 500 (pack) = 850
    const balTotal = await creditLedgerService.getBalance(testUserId);
    assert.strictEqual(balTotal.balance, 850);

    // 5.4 FIFO Expiry-First Deduction
    // Welcome expires in 14d, Plan in 30d, Pack in 365d.
    // Spending 300 credits should fully consume Welcome (250) and take 50 from Plan (leaving 50 in Plan).
    const deduct1 = await creditLedgerService.deductCredits(testUserId, 300, 'req_fifo_1');
    assert.strictEqual(deduct1.deducted, 300);
    assert.strictEqual(deduct1.remainingBalance, 550);

    const welcomeRemainingRes = await db.query(
      `SELECT remaining FROM credit_ledger WHERE user_id = $1 AND bucket = 'welcome'`,
      [testUserId]
    );
    assert.strictEqual(Number(welcomeRemainingRes.rows[0].remaining), 0, 'Welcome credits (soonest expiry) must be exhausted first');

    const planRemainingRes = await db.query(
      `SELECT remaining FROM credit_ledger WHERE user_id = $1 AND bucket = 'plan'`,
      [testUserId]
    );
    assert.strictEqual(Number(planRemainingRes.rows[0].remaining), 50, 'Plan credits must have 50 remaining after 300 spend');

    // 5.5 Safe handling of non-UUID user ID
    assert.strictEqual(isValidUuid('mock-user-non-uuid'), false);
    const safeBal = await creditLedgerService.getBalance('mock-user-non-uuid');
    assert.strictEqual(safeBal.balance, 0);

    const safeDeduct = await creditLedgerService.deductCredits('mock-user-non-uuid', 10, 'req_safe');
    assert.strictEqual(safeDeduct.deducted, 0);

    // -------------------------------------------------------------------------
    // 6. Profitability Guards 1–5 & Daily Reconcile
    // -------------------------------------------------------------------------
    console.log('  [6/9] Testing Profitability Guards 1–5 & Reconciliation...');

    const budgetGuard = new ServerBudgetGuard();

    // Guard 3: Per-Request Pre-Flight Cap
    // Free max is $0.05 / 20 credits ($0.04)
    const oversizedFree = await budgetGuard.checkUsage(testUserId, 'free', 'chat', 0.06);
    assert.strictEqual(oversizedFree.action, 'block');
    if (oversizedFree.action === 'block') {
      assert.strictEqual(oversizedFree.error.code, 'BUDGET_EXCEEDED');
    }

    // Bug 1C: enforce maxRequestCredits (20 credits = $0.04) on real DB credit path even when cost <= $0.05
    const oversizedFreeCredits = await budgetGuard.checkUsage(testUserId, 'free', 'chat', 0.045);
    assert.strictEqual(oversizedFreeCredits.action, 'block');
    if (oversizedFreeCredits.action === 'block') {
      assert.strictEqual(oversizedFreeCredits.error.code, 'BUDGET_EXCEEDED');
    }

    // Bug 1A: Global Free Daily Cap ($10/day) must NOT count Pro/Pro+ fast-tier spend
    const heavyProUserId = randomUUID();
    createdUserIds.push(heavyProUserId);
    await db.query(
      `INSERT INTO users (id, email, password_hash, plan, email_verified, credit_balance, welcome_credits_granted)
       VALUES ($1, $2, 'hash', 'pro', TRUE, 5000, TRUE)`,
      [heavyProUserId, `heavy_pro_${Date.now()}@example.com`]
    );
    await db.query(
      `INSERT INTO usage_records (
         user_id, request_id, model_tier, resolved_model, input_tokens, output_tokens,
         total_tokens, estimated_cost, credits_used, status, timestamp
       ) VALUES ($1, $2, 'fast', 'gemini-3.6-flash', 100000, 50000, 150000, 15.00, 7500, 'success', NOW())`,
      [heavyProUserId, `req_pro_heavy_fast_${Date.now()}`]
    );
    const freeAllowedDespiteProSpend = await budgetGuard.checkUsage(testUserId, 'free', 'chat', 0.001);
    assert.strictEqual(
      freeAllowedDespiteProSpend.action,
      'allow',
      'Pro fast-tier spend ($15) must NOT trigger the $10/day Global Free Daily Cap'
    );
    // Clean up heavy Pro spend row immediately so it doesn't affect other assertions
    await db.query('DELETE FROM usage_records WHERE user_id = $1', [heavyProUserId]);

    // Bug 1B: Guard 2 — Free tier blocked at 0 credits even when welcome_credits_granted = FALSE
    const zeroUnwelcomedFreeUserId = randomUUID();
    createdUserIds.push(zeroUnwelcomedFreeUserId);
    await db.query(
      `INSERT INTO users (id, email, password_hash, plan, email_verified, credit_balance, welcome_credits_granted)
       VALUES ($1, $2, 'hash', 'free', TRUE, 0, FALSE)`,
      [zeroUnwelcomedFreeUserId, `zero_unwelcomed_${Date.now()}@example.com`]
    );
    const zeroUnwelcomedBlock = await budgetGuard.checkUsage(zeroUnwelcomedFreeUserId, 'free', 'chat', 0.001);
    assert.strictEqual(zeroUnwelcomedBlock.action, 'block', '0-credit Free user must be blocked even if welcome_credits_granted=FALSE');
    if (zeroUnwelcomedBlock.action === 'block') {
      assert.strictEqual(zeroUnwelcomedBlock.error.code, 'BUDGET_EXCEEDED');
    }

    // Guard 2: Free tier blocked at 0 credits (welcome_credits_granted = TRUE)
    const zeroCreditUserId = randomUUID();
    createdUserIds.push(zeroCreditUserId);
    await db.query(
      `INSERT INTO users (id, email, password_hash, plan, email_verified, credit_balance, welcome_credits_granted)
       VALUES ($1, $2, 'hash', 'free', TRUE, 0, TRUE)`,
      [zeroCreditUserId, `zero_${Date.now()}@example.com`]
    );

    const zeroCreditBlock = await budgetGuard.checkUsage(zeroCreditUserId, 'free', 'chat', 0.001);
    assert.strictEqual(zeroCreditBlock.action, 'block');
    if (zeroCreditBlock.action === 'block') {
      assert.strictEqual(zeroCreditBlock.error.code, 'BUDGET_EXCEEDED');
    }

    // Guard 1: Paid fallback to 3.5-flash-lite capped at 50 credits/day + no negative ledger drift
    const zeroCreditProUserId = randomUUID();
    createdUserIds.push(zeroCreditProUserId);
    await db.query(
      `INSERT INTO users (id, email, password_hash, plan, email_verified, credit_balance, welcome_credits_granted)
       VALUES ($1, $2, 'hash', 'pro', TRUE, 0, TRUE)`,
      [zeroCreditProUserId, `pro_zero_${Date.now()}@example.com`]
    );

    // Under 50 fallback credits: fallback allowed
    const paidFallbackAllowed = await budgetGuard.checkUsage(zeroCreditProUserId, 'pro', 'chat', 0.001);
    assert.strictEqual(paidFallbackAllowed.action, 'fallback');

    // Paid fallback deduction must record delta=0, bucket='fallback' and never drag SUM(delta) negative
    const fallbackDeduct = await creditLedgerService.deductCredits(
      zeroCreditProUserId,
      10,
      `req_fb_drift_${Date.now()}`,
      'ai_stream',
      new Date(),
      { isFallback: true }
    );
    assert.strictEqual(fallbackDeduct.deducted, 0);
    assert.strictEqual(fallbackDeduct.remainingBalance, 0);
    const fbLedgerRes = await db.query(
      `SELECT COALESCE(SUM(delta), 0) AS total_delta, MAX(bucket) AS bucket
       FROM credit_ledger WHERE user_id = $1`,
      [zeroCreditProUserId]
    );
    assert.strictEqual(Number(fbLedgerRes.rows[0].total_delta), 0, 'Fallback requests must not drag credit_ledger SUM(delta) negative');
    assert.strictEqual(fbLedgerRes.rows[0].bucket, 'fallback');

    // Simulate user having consumed 50 fallback credits today
    await db.query(
      `INSERT INTO usage_records (
         user_id, request_id, model_tier, resolved_model, input_tokens, output_tokens,
         total_tokens, estimated_cost, credits_used, status, timestamp
       ) VALUES ($1, $2, 'fast', 'gemini-3.5-flash-lite', 1000, 500, 1500, 0.05, 50, 'success', NOW())`,
      [zeroCreditProUserId, `req_fallback_cap_${Date.now()}`]
    );

    const paidFallbackBlocked = await budgetGuard.checkUsage(zeroCreditProUserId, 'pro', 'chat', 0.001);
    assert.strictEqual(paidFallbackBlocked.action, 'block');
    if (paidFallbackBlocked.action === 'block') {
      assert.strictEqual(paidFallbackBlocked.error.code, 'FALLBACK_LIMIT_REACHED');
    }

    // Guard 5: Server Kill Switch
    await db.query(
      `INSERT INTO system_config (key, value)
       VALUES ('global_kill_switch', '{"is_active": true}')
       ON CONFLICT (key) DO UPDATE SET value = '{"is_active": true}'`
    );

    const killSwitchDecision = await budgetGuard.checkUsage(testUserId, 'pro', 'chat', 0.001);
    assert.strictEqual(killSwitchDecision.action, 'block');
    if (killSwitchDecision.action === 'block') {
      assert.strictEqual(killSwitchDecision.error.code, 'SERVER_KILL_SWITCH_ACTIVE');
    }

    // Reset kill switch
    await db.query(
      `UPDATE system_config SET value = '{"is_active": false}' WHERE key = 'global_kill_switch'`
    );

    // Daily Reconcile Helper Test
    const reconcileResult = await reconcileDailySpend(new Date());
    assert.strictEqual(typeof reconcileResult.ok, 'boolean');
    assert.strictEqual(typeof reconcileResult.discrepancyPct, 'number');

    // Test alert triggering on >10% discrepancy vs Google billing
    const alertTest = await reconcileDailySpend(new Date(), 999.0);
    assert.strictEqual(alertTest.alertTriggered, true, 'Discrepancy > 10% must trigger alert');

    // -------------------------------------------------------------------------
    // 7. Billing Webhooks: pro_plus & 500-Credit Packs (Lemon Squeezy & Stripe)
    // -------------------------------------------------------------------------
    console.log('  [7/9] Testing Billing Webhook Normalization & Credit Grants...');

    // 7.1 Lemon Squeezy pro_plus subscription
    const lsProPlus = normalizeWebhookPayload('lemonsqueezy', {
      meta: {
        event_name: 'subscription_created',
        webhook_id: `ls_pp_${Date.now()}`,
        custom_data: { user_id: testUserId, plan: 'pro_plus' },
      },
      data: {
        id: 'sub_pp_1',
        attributes: {
          status: 'active',
          variant_name: 'Synkro Pro+',
          user_email: testEmail,
          customer_id: 1001,
        },
      },
    });
    assert.ok(lsProPlus, 'Lemon Squeezy pro_plus payload must normalize');
    assert.strictEqual(lsProPlus?.targetPlan, 'pro_plus');
    assert.strictEqual(Boolean(lsProPlus?.isCreditPack), false);

    // Verify pro_plus monthly plan grant yields 12,000 credits
    const proPlusUserId = randomUUID();
    createdUserIds.push(proPlusUserId);
    await db.query(
      `INSERT INTO users (id, email, password_hash, plan, email_verified, credit_balance)
       VALUES ($1, $2, 'hash', 'pro_plus', TRUE, 0)`,
      [proPlusUserId, `pro_plus_${Date.now()}@example.com`]
    );
    const proPlusGrant = await creditLedgerService.ensureMonthlyPlanGrant(proPlusUserId, 'pro_plus');
    assert.strictEqual(proPlusGrant.granted, true);
    assert.strictEqual(proPlusGrant.credits, 12000, 'Pro+ plan must grant 12,000 monthly credits');

    // 7.2 Lemon Squeezy 500-credit pack order_created
    const lsPack = normalizeWebhookPayload('lemonsqueezy', {
      meta: {
        event_name: 'order_created',
        webhook_id: `ls_pack_${Date.now()}`,
        custom_data: { user_id: proPlusUserId, type: 'credit_pack', pack_credits: 500 },
      },
      data: {
        id: 'ord_pack_1',
        attributes: {
          status: 'paid',
          user_email: `pro_plus_${Date.now()}@example.com`,
          first_order_item: { variant_name: '500 Credit Pack' },
        },
      },
    });
    assert.ok(lsPack, 'Lemon Squeezy credit pack order must normalize');
    assert.strictEqual(lsPack?.isCreditPack, true);
    assert.strictEqual(lsPack?.packCredits, 500);

    // 7.3 Stripe pro_plus subscription
    const stripeProPlus = normalizeWebhookPayload('stripe', {
      id: `evt_stripe_pp_${Date.now()}`,
      type: 'customer.subscription.created',
      data: {
        object: {
          id: 'sub_stripe_pp_1',
          status: 'active',
          customer: 'cus_pp_1',
          metadata: { user_id: proPlusUserId, plan: 'pro_plus' },
        },
      },
    });
    assert.ok(stripeProPlus, 'Stripe pro_plus payload must normalize');
    assert.strictEqual(stripeProPlus?.targetPlan, 'pro_plus');

    // 7.4 Stripe one-time 500-credit pack checkout.session.completed
    const stripePack = normalizeWebhookPayload('stripe', {
      id: `evt_stripe_pack_${Date.now()}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_pack_1',
          mode: 'payment',
          payment_status: 'paid',
          customer: 'cus_pp_1',
          metadata: { user_id: proPlusUserId, type: 'credit_pack' },
        },
      },
    });
    assert.ok(stripePack, 'Stripe credit pack checkout must normalize');
    assert.strictEqual(stripePack?.isCreditPack, true);
    assert.strictEqual(stripePack?.packCredits, 500);

    const stripePackGrant = await creditLedgerService.grantCreditPack(
      proPlusUserId,
      stripePack!.eventId,
      stripePack!.packCredits || 500
    );
    assert.strictEqual(stripePackGrant.granted, true);
    assert.strictEqual(stripePackGrant.credits, 500);
    const proPlusBalAfterPack = await creditLedgerService.getBalance(proPlusUserId);
    assert.strictEqual(proPlusBalAfterPack.balance, 12500);

    // -------------------------------------------------------------------------
    // 8. Streaming Zero-Output Failure Charges 0 Credits
    // -------------------------------------------------------------------------
    console.log('  [8/9] Testing Zero-Output Streaming Failure Charges 0 Credits...');

    const streamFailUserId = randomUUID();
    const streamFailEmail = `stream_fail_${Date.now()}@example.com`;
    createdUserIds.push(streamFailUserId);
    await db.query(
      `INSERT INTO users (id, email, password_hash, plan, email_verified, credit_balance)
       VALUES ($1, $2, 'hash', 'pro', TRUE, 0)`,
      [streamFailUserId, streamFailEmail]
    );
    await creditLedgerService.ensureMonthlyPlanGrant(streamFailUserId, 'pro');
    const balBeforeFail = (await creditLedgerService.getBalance(streamFailUserId)).balance;
    assert.strictEqual(balBeforeFail, 4000);

    const failGateway = new BackendAIGateway();
    failGateway.budgetGuard.checkUsage = async () => ({ action: 'allow' });
    failGateway.authService.validateSession = async () => ({ userId: streamFailUserId, email: streamFailEmail });
    (failGateway as any).adapters.set('google', {
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          throw new Error('Upstream provider failed before first token');
        },
      }),
      generate: async () => ({ content: '', usage: {} }),
    });
    (failGateway as any).router.route = () => ({
      providerId: 'google',
      modelId: 'gemini-3.6-flash',
      costInputPerMillion: 0.75,
      costOutputPerMillion: 3.75,
    });

    const failReqId = `req_stream_fail_${randomUUID()}`;
    const failRes = await failGateway.handleRequest(
      'POST',
      '/v1/ai/stream',
      { authorization: 'Bearer mock', 'x-request-id': failReqId },
      { tier: 'fast', messages: [{ role: 'user', content: 'trigger failure before any output' }] }
    );
    const failStream = failRes.body as AsyncIterable<any>;
    let caughtStreamErr = false;
    try {
      for await (const _chunk of failStream) {
        // Should throw before any chunk
      }
    } catch {
      caughtStreamErr = true;
    }
    assert.strictEqual(caughtStreamErr, true, 'Stream must propagate upstream error');
    await new Promise(r => setTimeout(r, 80));

    const failRecordRes = await db.query(
      'SELECT status, estimated_cost, credits_used FROM usage_records WHERE request_id = $1',
      [failReqId]
    );
    assert.strictEqual(failRecordRes.rows.length, 1);
    assert.strictEqual(failRecordRes.rows[0].status, 'failed');
    assert.strictEqual(Number(failRecordRes.rows[0].estimated_cost), 0, 'Zero-output failed stream must record $0 cost');
    assert.strictEqual(Number(failRecordRes.rows[0].credits_used), 0, 'Zero-output failed stream must charge 0 credits');

    const balAfterFail = (await creditLedgerService.getBalance(streamFailUserId)).balance;
    assert.strictEqual(balAfterFail, balBeforeFail, 'User credit balance must remain unchanged after zero-output stream failure');

    // -------------------------------------------------------------------------
    // 9. Desktop UI & i18n Localization Verification (en, ar, tr)
    // -------------------------------------------------------------------------
    console.log('  [9/9] Testing Desktop UI & i18n Translations (en, ar, tr)...');

    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(testDir, '../../..');
    const loadJson = (relPath: string) => JSON.parse(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));

    const enLocale = loadJson('apps/desktop/src/renderer/src/i18n/locales/en.json');
    const arLocale = loadJson('apps/desktop/src/renderer/src/i18n/locales/ar.json');
    const trLocale = loadJson('apps/desktop/src/renderer/src/i18n/locales/tr.json');

    for (const [lang, loc] of [['en', enLocale], ['ar', arLocale], ['tr', trLocale]] as const) {
      assert.ok(loc.settings?.usage?.creditsRemaining, `${lang} must have settings.usage.creditsRemaining`);
      assert.ok(loc.settings?.usage?.creditsLeftValue, `${lang} must have settings.usage.creditsLeftValue`);
      assert.strictEqual(
        loc.settings.usage.creditsLeftValue.includes('{remaining}') && loc.settings.usage.creditsLeftValue.includes('{total}'),
        true,
        `${lang} settings.usage.creditsLeftValue must include {remaining} and {total}`
      );
      assert.ok(loc.chat?.usedCredits, `${lang} must have chat.usedCredits`);
      assert.ok(loc.chat?.usedCredit, `${lang} must have chat.usedCredit`);
      assert.strictEqual(loc.chat.usedCredits.includes('{count}'), true, `${lang} chat.usedCredits must include {count}`);
    }

    // Verify SettingsModal & ChatPane use localized keys with no hardcoded English "credits left"
    const settingsModalSrc = fs.readFileSync(
      path.join(repoRoot, 'apps/desktop/src/renderer/src/features/settings/SettingsModal.tsx'),
      'utf8'
    );
    assert.strictEqual(settingsModalSrc.includes('credits left'), false, 'SettingsModal must not hardcode "credits left"');
    assert.strictEqual(
      settingsModalSrc.includes("t('settings.usage.creditsLeftValue'"),
      true,
      'SettingsModal must use settings.usage.creditsLeftValue'
    );

    const chatPaneSrc = fs.readFileSync(
      path.join(repoRoot, 'apps/desktop/src/renderer/src/layout/ChatPane.tsx'),
      'utf8'
    );
    assert.strictEqual(chatPaneSrc.includes('message.creditsUsed === 1'), true, 'ChatPane must check singular credit count === 1');
    assert.strictEqual(chatPaneSrc.includes("t('chat.usedCredit'"), true, 'ChatPane must use chat.usedCredit for singular');

    console.log('  🟢 All Credits & AI Pricing Tests Passed Successfully!');
  } finally {
    // Cleanup test database entries
    try {
      if (createdUserIds.length > 0) {
        await db.query('DELETE FROM usage_records WHERE user_id = ANY($1)', [createdUserIds]);
        await db.query('DELETE FROM credit_ledger WHERE user_id = ANY($1)', [createdUserIds]);
        await db.query('DELETE FROM users WHERE id = ANY($1)', [createdUserIds]);
      }
      await db.query(
        `UPDATE system_config SET value = '{"is_active": false}' WHERE key = 'global_kill_switch'`
      );
    } catch (cleanupErr) {
      console.warn('  ⚠️ Test cleanup warning:', cleanupErr);
    }
  }
}
