import type { IAuthProvider } from './auth-provider';

export class DevelopmentAuthProvider implements IAuthProvider {
  static readonly SESSION_TOKEN = 'dev_test_session';

  async validateSession(sessionToken: string, requestId?: string): Promise<{ userId: string; email: string; plan: string }> {
    const reqId = requestId || 'UNKNOWN';
    console.log(`[REQ ${reqId}] DevelopmentAuthProvider.validateSession entered`);
    if (sessionToken === DevelopmentAuthProvider.SESSION_TOKEN) {
      const result = {
        userId: '00000000-0000-0000-0000-000000000000',
        email: 'dev@synkro.com',
        plan: 'pro'
      };
      console.log(`[REQ ${reqId}] DevelopmentAuthProvider.validateSession returned`);
      return result;
    }
    throw new Error('Invalid development session token');
  }
}
