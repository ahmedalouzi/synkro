import type { IAuthProvider } from './auth-provider';
import { AuthService } from './auth';

export class AuthenticationRouter implements IAuthProvider {
  private productionProvider = new AuthService();

  async validateSession(sessionToken: string, requestId?: string): Promise<{ userId: string; email: string; plan: string }> {
    const reqId = requestId || 'UNKNOWN';
    console.log(`[REQ ${reqId}] AuthenticationRouter.validateSession entered`);
    return this.productionProvider.validateSession(sessionToken, reqId);
  }
  
  async signup(email: string, password: string) {
    return this.productionProvider.signup(email, password);
  }
  
  async login(email: string, password: string) {
    return this.productionProvider.login(email, password);
  }
  
  async refresh(refreshToken: string) {
    return this.productionProvider.refresh(refreshToken);
  }
  
  async logout(sessionToken: string, refreshToken?: string) {
    return this.productionProvider.logout(sessionToken, refreshToken);
  }
}
