import { ServerUsageStore } from '../src/models/usage-store';
import { BackendAIGateway } from '../src/models/backend-gateway';
import { db } from '../src/models/db';

export default async function runTests() {
  console.log('  Running ServerUsageStore & Accounting unit tests...');

  const store = new ServerUsageStore();
  const testUserId = '00000000-0000-0000-0000-000000000123';
  const testReqId = `req-abc-${Math.random().toString(36).substring(7)}`;

  // Seed the test user to satisfy foreign key constraints
  await db.query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING",
    [testUserId, 'test-usage-user@example.com', 'scrypt:mock-hash']
  );

  // Test 1: Record Usage
  await store.recordUsage({
    userId: testUserId,
    requestId: testReqId,
    modelTier: 'fast',
    resolvedModel: 'gemini-3.6-flash',
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    estimatedCost: 0.0005,
    status: 'success'
  });

  const records = await store.getRecordsForUser(testUserId);
  const matchedRecs = records.filter(r => r.requestId === testReqId);
  if (matchedRecs.length !== 1 || matchedRecs[0].totalTokens !== 300) {
    throw new Error('recordUsage failed to store correct token count');
  }

  // Test 2: Double Counting Prevention
  await store.recordUsage({
    userId: testUserId,
    requestId: testReqId, // Same Request ID
    modelTier: 'fast',
    resolvedModel: 'gemini-3.6-flash',
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    estimatedCost: 0.0005,
    status: 'success'
  });

  const doubleCheckRecords = await store.getRecordsForUser(testUserId);
  const matchedDoubleCheck = doubleCheckRecords.filter(r => r.requestId === testReqId);
  if (matchedDoubleCheck.length !== 1) {
    throw new Error('ServerUsageStore failed to prevent double counting on same Request ID');
  }

  // Test 3: Gateway integration usage logging
  const gateway = new BackendAIGateway();
  
  // Inject MockOpenAIAdapter for google to test usage isolation without real keys
  const { MockOpenAIAdapter } = await import('../src/models/backend-gateway');
  (gateway as any).adapters.set('google', new MockOpenAIAdapter());
  
  const email = `usage_test_${Math.random().toString(36).substring(7)}@example.com`;
  await gateway.authService.signup(email, 'hash-password-123');
  await db.query('UPDATE users SET email_verified = TRUE WHERE email = $1', [email]);
  const session = await gateway.authService.login(email, 'hash-password-123');
  const { creditLedgerService } = await import('../src/models/credit-ledger');
  await creditLedgerService.ensureMonthlyPlanGrant(session.userId, 'free');

  const gatewayReqId = `gateway-usage-req-${Math.random().toString(36).substring(7)}`;
  const headers = {
    'authorization': `Bearer ${session.sessionToken}`,
    'x-request-id': gatewayReqId
  };

  await gateway.handleRequest('POST', '/v1/ai/generate', headers, {
    tier: 'fast',
    messages: [{ role: 'user', content: 'please log this usage' }]
  });

  const gatewayRecords = await gateway.usageStore.getRecordsForUser(session.userId);
  const matchedGatewayRecs = gatewayRecords.filter(r => r.requestId === gatewayReqId);
  if (matchedGatewayRecs.length !== 1) {
    throw new Error('Gateway failed to log usage to usageStore');
  }

  // Test 4: Cost Accumulation
  const totalCost = await gateway.usageStore.getAccumulatedCost(session.userId);
  if (totalCost <= 0) {
    throw new Error('Cost calculation returned incorrect accumulated value');
  }

  console.log('  🟢 All ServerUsageStore & Accounting unit tests passed.');
}
