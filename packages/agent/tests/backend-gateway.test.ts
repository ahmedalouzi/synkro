import { BackendAIGateway } from '../src/models/backend-gateway';
import { db } from '../src/models/db';

export default async function runTests() {
  console.log('  Running BackendAIGateway unit tests...');

  const gateway = new BackendAIGateway();
  const { MockOpenAIAdapter } = await import('../src/models/backend-gateway');
  (gateway as any).adapters.set('google', new MockOpenAIAdapter());
  
  const email = `gateway_test_${Math.random().toString(36).substring(7)}@example.com`;
  await gateway.authService.signup(email, 'hash-password-123');
  await db.query('UPDATE users SET email_verified = TRUE WHERE email = $1', [email]);
  const session = await gateway.authService.login(email, 'hash-password-123');

  // Test 1: Successful Auth & Generate routing
  const authHeaders = {
    'authorization': `Bearer ${session.sessionToken}`,
    'x-request-id': 'req-1'
  };
  const body = {
    tier: 'fast',
    messages: [{ role: 'user', content: 'hello adapter' }]
  };
  
  const res = await gateway.handleRequest('POST', '/v1/ai/generate', authHeaders, body);
  if (res.status !== 200) {
    throw new Error(`handleRequest failed with status ${res.status}`);
  }
  if (!res.body.content.includes('[OpenAI Backend]')) {
    throw new Error('Response did not route to OpenAI mock adapter');
  }

  // Test 2: Missing Authorization Header
  const badRes1 = await gateway.handleRequest('POST', '/v1/ai/generate', {}, body);
  if (badRes1.status !== 401 || badRes1.body.code !== 'UNAUTHORIZED') {
    throw new Error('Missing Auth header check failed');
  }

  // Test 3: Invalid Session Token
  const badRes2 = await gateway.handleRequest('POST', '/v1/ai/generate', { 'authorization': 'Bearer bad-token' }, body);
  if (badRes2.status !== 401 || (!badRes2.body.message.includes('Session not found') && !badRes2.body.message.includes('Invalid session token'))) {
    throw new Error('Invalid token check failed');
  }

  // Test 4: Request Validation (Invalid Tier)
  const badRes3 = await gateway.handleRequest('POST', '/v1/ai/generate', authHeaders, { tier: 'ultra-premium', messages: [{ role: 'user', content: 'test' }] });
  if (badRes3.status !== 400 || badRes3.body.code !== 'VALIDATION_ERROR') {
    throw new Error('Model tier validation failed to reject request');
  }

  // Test 5: Request Cancellation propagation
  const controller = new AbortController();
  controller.abort();
  const cancelRes = await gateway.handleRequest('POST', '/v1/ai/generate', authHeaders, body, { signal: controller.signal });
  if (cancelRes.status !== 502 || cancelRes.body.code !== 'REQUEST_CANCELLED') {
    throw new Error('Cancellation signal propagation failed');
  }

  console.log('  🟢 All BackendAIGateway unit tests passed.');
}
