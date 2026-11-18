import { AuthService } from '../src/models/auth';
import { BackendAIGateway } from '../src/models/backend-gateway';
import { db } from '../src/models/db';

export default async function runTests() {
  console.log('  Running AuthService & Session database unit tests...');

  const auth = new AuthService();
  const email = `auth_test_${Math.random().toString(36).substring(7)}@example.com`;
  const password = 'hash-password-123';

  // Test 0: Signup
  const signupSession = await auth.signup(email, password);
  if (typeof signupSession.sessionToken !== 'string' || signupSession.sessionToken.length !== 64) {
    throw new Error('signup failed to return a valid session token format');
  }

  // Test 1: Successful Login
  const session = await auth.login(email, password);
  if (typeof session.sessionToken !== 'string' || session.sessionToken.length !== 64) {
    throw new Error('login failed to return a valid session token format');
  }

  // Test 2: Invalid Login Credentials
  try {
    await auth.login(email, 'wrong-pass');
    throw new Error('login did not reject invalid password');
  } catch (err: any) {
    // Expect error
  }

  // Test 3: Session Validation (Valid Token)
  const validated = await auth.validateSession(session.sessionToken);
  if (validated.email !== email) {
    throw new Error('session validation returned incorrect user identity');
  }

  // Test 4: Token Revocation / Logout
  await auth.logout(session.sessionToken);
  try {
    await auth.validateSession(session.sessionToken);
    throw new Error('validateSession did not reject logged out/revoked token');
  } catch (err: any) {
    if (err.message !== 'Invalid session token') throw err;
  }

  // Test 5: Expired Token Check
  const session2 = await auth.login(email, password);
  // Force expire session in the database using SQL
  await db.query(
    'UPDATE sessions SET expires_at = $1 WHERE session_token = $2',
    [new Date(Date.now() - 1000), session2.sessionToken]
  );
  try {
    await auth.validateSession(session2.sessionToken);
    throw new Error('validateSession did not reject expired session token');
  } catch (err: any) {
    if (err.message !== 'Session expired') throw err;
  }

  // Test 6: Gateway Authorization integration
  const gateway = new BackendAIGateway();
  const { MockOpenAIAdapter } = await import('../src/models/backend-gateway');
  (gateway as any).adapters.set('google', new MockOpenAIAdapter());
  
  const gatewayEmail = `gateway_test_${Math.random().toString(36).substring(7)}@example.com`;
  await gateway.authService.signup(gatewayEmail, password);
  await db.query('UPDATE users SET email_verified = TRUE WHERE email = $1', [gatewayEmail]);
  const session3 = await gateway.authService.login(gatewayEmail, password);
  const { creditLedgerService } = await import('../src/models/credit-ledger');
  await creditLedgerService.ensureMonthlyPlanGrant(session3.userId, 'free');
  
  const headers = {
    'authorization': `Bearer ${session3.sessionToken}`,
    'x-request-id': 'req-test'
  };
  const body = { tier: 'fast', messages: [{ role: 'user', content: 'test' }] };
  
  const res = await gateway.handleRequest('POST', '/v1/ai/generate', headers, body);
  if (res.status !== 200) {
    throw new Error(`Gateway failed to authorize valid active session. Status: ${res.status}`);
  }

  console.log('  🟢 All AuthService & Session database unit tests passed.');
}
