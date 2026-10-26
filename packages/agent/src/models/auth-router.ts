import type { IAuthProvider } from './auth-provider';
import { AuthService } from './auth';
import { DevelopmentAuthProvider } from './dev-auth-provider';

export class AuthenticationRouter implements IAuthProvider {
  private productionProvider = new AuthService();
  private devProvider = new DevelopmentAuthProvider();

  /** In bypass mode only the dev token uses the dev provider; real accounts are still validated for real. */
  private getProvider(sessionToken: string): IAuthProvider {
    const devBypass = process.env.NODE_ENV !== 'production' && process.env.SYNKRO_DEV_AUTH_BYPASS === 'true';
    if (devBypass && sessionToken === DevelopmentAuthProvider.SESSION_TOKEN) {
      return this.devProvider;
    }
    return this.productionProvider;
  }

  async validateSession(sessionToken: string, requestId?: string): Promise<{ userId: string; email: string; plan: string }> {
    const provider = this.getProvider(sessionToken);
    const reqId = requestId || 'UNKNOWN';
    console.log(`[REQ ${reqId}] AuthenticationRouter.validateSession entered`);
    console.log(`[REQ ${reqId}] Selected provider = ${provider.constructor.name}`);
    return provider.validateSession(sessionToken, reqId);
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
