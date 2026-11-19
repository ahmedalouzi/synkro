import { ServerModelRouter } from '../src/models/server-router';
import { BackendAIGateway } from '../src/models/backend-gateway';
import { db } from '../src/models/db';

export default async function runTests() {
  console.log('  Running ServerModelRouter unit tests...');

  const router = new ServerModelRouter();

  // Test 1: Route Tiers
  const fastConfig = router.route('fast');
  if (fastConfig.providerId !== 'google' || fastConfig.modelId !== 'gemini-3.6-flash') {
    throw new Error('fast tier routing mapped to incorrect model config');
  }

  const reasoningConfig = router.route('reasoning');
  if (process.env.OPENAI_API_KEY) {
    if (reasoningConfig.providerId !== 'openai' || reasoningConfig.modelId !== 'gpt-4o') {
      throw new Error('reasoning tier routing mapped to incorrect model config');
    }
  } else {
    if (reasoningConfig.providerId !== 'google' || reasoningConfig.modelId !== 'gemini-3.6-flash') {
      throw new Error('reasoning tier routing without OPENAI_API_KEY must fall back to google/gemini-3.6-flash');
    }
  }

  // Verify explicit OpenAI vs Gemini-fallback routing regardless of env
  const reasoningWithOpenAi = router.route('reasoning', 'pro', undefined, { hasOpenAiKey: true });
  if (reasoningWithOpenAi.providerId !== 'openai' || reasoningWithOpenAi.modelId !== 'gpt-4o') {
    throw new Error('reasoning tier with hasOpenAiKey=true must map to openai/gpt-4o');
  }
  const reasoningNoOpenAi = router.route('reasoning', 'pro', undefined, { hasOpenAiKey: false });
  if (reasoningNoOpenAi.providerId !== 'google' || reasoningNoOpenAi.modelId !== 'gemini-3.6-flash') {
    throw new Error('reasoning tier with hasOpenAiKey=false must fall back to google/gemini-3.6-flash');
  }

  const premiumConfig = router.route('premium');
  if (premiumConfig.providerId !== 'google' || premiumConfig.modelId !== 'gemini-3.1-pro') {
    throw new Error('premium tier routing mapped to incorrect model config');
  }

  // Test 2: Plan Limitations
  try {
    router.route('premium', 'free');
    throw new Error('premium tier request did not block free tier plan');
  } catch (err: any) {
    if (!err.message.includes('paid active subscription')) throw err;
  }

  // Test 3: Gateway Integration (Routing by Tier)
  const gateway = new BackendAIGateway();
  const { MockOpenAIAdapter } = await import('../src/models/backend-gateway');
  (gateway as any).adapters.set('google', new MockOpenAIAdapter());
  
  const email = `router_test_${Math.random().toString(36).substring(7)}@example.com`;
  await gateway.authService.signup(email, 'hash-password-123');
  await db.query('UPDATE users SET email_verified = TRUE WHERE email = $1', [email]);
  const session = await gateway.authService.login(email, 'hash-password-123');
  const { creditLedgerService } = await import('../src/models/credit-ledger');
  await creditLedgerService.ensureMonthlyPlanGrant(session.userId, 'free');

  const headers = {
    'authorization': `Bearer ${session.sessionToken}`,
    'x-request-id': 'req-router-id'
  };

  const res = await gateway.handleRequest('POST', '/v1/ai/generate', headers, {
    tier: 'fast',
    messages: [{ role: 'user', content: 'route this please' }]
  });
  if (res.status !== 200) {
    throw new Error(`Gateway handleRequest failed under routing. Status: ${res.status}`);
  }

  // Test 4: Unsupported Tier Rejection
  const badRes = await gateway.handleRequest('POST', '/v1/ai/generate', headers, {
    tier: 'ultra-fast-hyper-intelligence' as any,
    messages: [{ role: 'user', content: 'test' }]
  });
  if (badRes.status !== 400 || badRes.body.code !== 'VALIDATION_ERROR') {
    throw new Error('Gateway failed to reject unsupported model tier');
  }

  console.log('  🟢 All ServerModelRouter unit tests passed.');
}
