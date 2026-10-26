import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
(globalThis as any).require = require;
import { BackendAIGateway } from '../src/models/backend-gateway';
import { PLAN_POLICIES } from '../src/models/usage-limits';

export default async function runTests() {
  console.log('  Running Rate Limiter unit tests...');

  const gateway = new BackendAIGateway();

  // No DB: usage recording and the usage pool are out of scope here.
  gateway.usageStore.recordUsage = async () => {};
  gateway.authService.validateSession = async (token: string) => {
    return { userId: token, email: `${token}@example.com`, plan: token.startsWith('pro') ? 'pro' : 'free' } as any;
  };
  (gateway as any).budgetGuard.checkUsage = async () => ({ action: 'allow' });

  (gateway as any).router.route = () => ({ providerId: 'test', modelId: 'test', costInputPerMillion: 0, costOutputPerMillion: 0 });
  (gateway as any).adapters.set('test', {
    stream: () => ({
      [Symbol.asyncIterator]: async function* () { yield { type: 'done' }; }
    }),
    generate: async () => ({ content: 'test', usage: {} })
  });

  const send = (userId: string, id: string, purpose?: 'completion') =>
    gateway.handleRequest('POST', '/v1/ai/stream', {
      'authorization': `Bearer ${userId}`,
      'x-request-id': id,
    }, { tier: 'fast', purpose, messages: [{ role: 'user', content: 'test' }] });

  const freeChat = PLAN_POLICIES.free.chatPerMinute;
  const freeCompletions = PLAN_POLICIES.free.completionsPerMinute;

  console.log(`  [Test 1] enforces ${freeChat} chat requests per minute on the free plan`);
  {
    for (let i = 0; i < freeChat; i++) {
      assert.strictEqual((await send('user_1', `req-${i}`)).status, 200);
    }
    const limited = await send('user_1', 'req-over');
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(limited.body.code, 'RATE_LIMIT_EXCEEDED');
    assert.ok(Number(limited.headers['Retry-After']) > 0, 'Retry-After header must be set');
  }

  console.log('  [Test 2] Tab completions have their own, larger bucket');
  {
    // user_1's chat bucket is full, but completions are counted separately.
    for (let i = 0; i < freeCompletions; i++) {
      assert.strictEqual((await send('user_1', `cmp-${i}`, 'completion')).status, 200);
    }
    assert.strictEqual((await send('user_1', 'cmp-over', 'completion')).status, 429);
  }

  console.log('  [Test 3] does not share quota between users, and Pro gets more');
  {
    assert.strictEqual((await send('user_B', 'req-B-1')).status, 200);
    for (let i = 0; i < freeChat + 1; i++) {
      assert.strictEqual((await send('pro_user', `pro-${i}`)).status, 200);
    }
  }

  console.log('  [Test 4] frees slots once the 60-second window passes');
  {
    const originalDateNow = Date.now;
    let currentTime = 1_000_000;
    global.Date.now = () => currentTime;
    try {
      for (let i = 0; i < freeChat; i++) await send('user_window', `w-${i}`);
      currentTime += 30_000;
      assert.strictEqual((await send('user_window', 'w-mid')).status, 429);
      currentTime += 31_000;
      assert.strictEqual((await send('user_window', 'w-after')).status, 200);
    } finally {
      global.Date.now = originalDateNow;
    }
  }

  console.log('  🟢 Passed');
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runTests().catch(console.error);
}
