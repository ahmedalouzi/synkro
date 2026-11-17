import type { UserSession } from './auth';

export interface IAuthProvider {
  validateSession(sessionToken: string, requestId?: string): Promise<{ userId: string; email: string; plan: string; emailVerified?: boolean }>;
  signup?(email: string, password: string): Promise<UserSession>;
  login?(email: string, password: string): Promise<UserSession>;
  refresh?(refreshToken: string): Promise<UserSession>;
  logout?(sessionToken: string, refreshToken?: string): Promise<void>;
  sendVerificationCode?(
    userIdOrEmail: string,
    emailOrOptions?: string | { enforceCooldown?: boolean },
    options?: { enforceCooldown?: boolean }
  ): Promise<{ success: boolean; code?: string }>;
  verifyEmailOtp?(userIdOrEmail: string, code: string): Promise<{ success: boolean; emailVerified: boolean }>;
}
