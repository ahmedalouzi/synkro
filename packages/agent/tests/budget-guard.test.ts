import assert from 'node:assert';
import { ServerBudgetGuard } from '../src/models/budget-guard';
import { BackendAIGateway } from '../src/models/backend-gateway';
import { PLAN_POLICIES, nextWeekStart, weekStart } from '../src/models/usage-limits';

/** A guard whose usage comes from the test instead of Postgres. */
function guardWithUsage(usage: { weeklyCost: number; monthlyCompletions: number }) {
  const guard = new ServerBudgetGuard();
  (guard as any).readUsage = async () => usage;
  return guard;
}

export default async function runTests() {
  console.log('  Running ServerBudgetGuard unit tests...');
  const free = PLAN_POLICIES.free;
  const pro = PLAN_POLICIES.pro;

  // Within the weekly pool → allowed.
  assert.deepStrictEqual(
    await guardWithUsage({ weeklyCost: 0, monthlyCompletions: 0 }).checkUsage('u', 'free', 'chat', 0.001),
    { action: 'allow' },
  );

  // A single oversized request is refused on any plan.
  const tooBig = await guardWithUsage({ weeklyCost: 0, monthlyCompletions: 0 }).checkUsage('u', 'pro', 'chat', pro.maxRequestCostUsd + 0.01);
  assert.strictEqual(tooBig.action, 'block');

  // Free plan with the pool spent → blocked until next week, with the reset date.
  const freeSpent = await guardWithUsage({ weeklyCost: free.weeklyPoolUsd, monthlyCompletions: 0 }).checkUsage('u', 'free', 'chat', 0.001);
  assert.strictEqual(freeSpent.action, 'block');
  if (freeSpent.action === 'block') {
    assert.strictEqual(freeSpent.error.code, 'BUDGET_EXCEEDED');
    assert.strictEqual(freeSpent.error.resetsAt, nextWeekStart().toISOString());
  }

  // Pro plan with the pool spent → falls back to the cheap model instead of blocking.
  assert.deepStrictEqual(
    await guardWithUsage({ weeklyCost: pro.weeklyPoolUsd, monthlyCompletions: 0 }).checkUsage('u', 'pro', 'chat', 0.001),
    { action: 'fallback' },
  );

  // Tab completions: unlimited on Pro even with the pool spent; monthly allowance on Free.
  assert.deepStrictEqual(
    await guardWithUsage({ weeklyCost: 999, monthlyCompletions: 1_000_000 }).checkUsage('u', 'pro', 'completion', 0.0001),
    { action: 'allow' },
  );
  assert.deepStrictEqual(
    await guardWithUsage({ weeklyCost: 999, monthlyCompletions: 0 }).checkUsage('u', 'free', 'completion', 0.0001),
    { action: 'allow' },
  );
  const freeCompletionsSpent = await guardWithUsage({ weeklyCost: 0, monthlyCompletions: free.monthlyCompletions! })
    .checkUsage('u', 'free', 'completion', 0.0001);
  assert.strictEqual(freeCompletionsSpent.action, 'block');

  // Unknown plans get the free policy.
  assert.strictEqual(
    (await guardWithUsage({ weeklyCost: free.weeklyPoolUsd, monthlyCompletions: 0 }).checkUsage('u', 'mystery', 'chat', 0.001)).action,
    'block',
  );

  // The week starts Monday 00:00 UTC.
  assert.strictEqual(weekStart(new Date('2026-10-25T12:00:00Z')).toISOString(), '2026-10-19T00:00:00.000Z'); // Sunday
  assert.strictEqual(weekStart(new Date('2026-10-26T00:00:00Z')).toISOString(), '2026-10-26T00:00:00.000Z'); // Monday

  // Gateway: an exhausted Pro pool serves the request on the fast tier and says so.
  const gateway = new BackendAIGateway();
  gateway.usageStore.recordUsage = async () => {};
  gateway.authService.validateSession = async (token: string) => ({ userId: token, email: 'pro@example.com', plan: 'pro' }) as any;
  (gateway as any).budgetGuard = guardWithUsage({ weeklyCost: pro.weeklyPoolUsd, monthlyCompletions: 0 });
  let servedTier = '';
  (gateway as any).router.route = (tier: string) => ({ providerId: 'test', modelId: `model-${tier}`, costInputPerMillion: 1, costOutputPerMillion: 1 });
  (gateway as any).adapters.set('test', {
    generate: async (req: any) => { servedTier = req.tier; return { content: 'ok', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; },
  });
  const fallbackRes = await gateway.handleRequest('POST', '/v1/ai/generate', { authorization: 'Bearer pro-user' }, {
    tier: 'premium',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.strictEqual(fallbackRes.status, 200);
  assert.strictEqual(servedTier, 'fast');
  assert.strictEqual(fallbackRes.headers['x-synkro-usage-fallback'], 'fast');

  // Gateway: an exhausted Free pool is refused with BUDGET_EXCEEDED.
  gateway.authService.validateSession = async (token: string) => ({ userId: token, email: 'free@example.com', plan: 'free' }) as any;
  (gateway as any).budgetGuard = guardWithUsage({ weeklyCost: free.weeklyPoolUsd, monthlyCompletions: 0 });
  const blockedRes = await gateway.handleRequest('POST', '/v1/ai/generate', { authorization: 'Bearer free-user' }, {
    tier: 'fast',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.strictEqual(blockedRes.status, 429);
  assert.strictEqual(blockedRes.body.code, 'BUDGET_EXCEEDED');

  // Model selection is a paid feature: Free requests for a specific model run on Auto routing.
  let servedManualModel: string | undefined = 'unset';
  (gateway as any).adapters.set('test', {
    generate: async (req: any) => { servedManualModel = req.manualModel; return { content: 'ok', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }; },
  });
  (gateway as any).budgetGuard = guardWithUsage({ weeklyCost: 0, monthlyCompletions: 0 });
  const lockedRes = await gateway.handleRequest('POST', '/v1/ai/generate', { authorization: 'Bearer free-user' }, {
    tier: 'fast',
    manualModel: 'gemini-3.1-pro',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.strictEqual(lockedRes.status, 200);
  assert.strictEqual(servedManualModel, undefined, 'free plan must not get a manually picked model');
  assert.strictEqual(lockedRes.headers['x-synkro-model-locked'], 'auto');

  gateway.authService.validateSession = async (token: string) => ({ userId: token, email: 'pro@example.com', plan: 'pro' }) as any;
  const proRes = await gateway.handleRequest('POST', '/v1/ai/generate', { authorization: 'Bearer pro-user-2' }, {
    tier: 'fast',
    manualModel: 'gemini-3.1-pro',
    messages: [{ role: 'user', content: 'hello' }],
  });
  assert.strictEqual(proRes.status, 200);
  assert.strictEqual(servedManualModel, 'gemini-3.1-pro', 'pro plan keeps the picked model');

  console.log('  🟢 All ServerBudgetGuard unit tests passed.');
}
