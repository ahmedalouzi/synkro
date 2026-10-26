import { ProductionAIGateway, MockAIGateway, GoogleGeminiAdapter } from '@peep/agent';
import type { AIGateway, Settings } from '@peep/shared';
import type { DatabaseService } from './db';

export type GatewayResolution =
  | { gateway: AIGateway; baseUrl: string }
  | { error: string };

interface GatewayOptions {
  testGateway?: AIGateway;
  /** Called when the backend reports the session is gone (tokens cleared). */
  onSessionExpired?: () => void;
}

/**
 * Picks the AI gateway for this request: mock (tests) → SaaS session → local key (dev only).
 * Shared by the agent and by inline completions so the auth/security rules live in one place.
 * `settings` is mutated when tokens are refreshed, matching the agent's previous behavior.
 */
export function createAIGateway(db: DatabaseService, settings: Settings, options: GatewayOptions = {}): GatewayResolution {
  const baseUrl = settings.gatewayUrl || process.env.SYNKRO_GATEWAY_URL || 'https://api.synkro.com';

  if (process.env.SYNKRO_USE_MOCK_GATEWAY === 'true') {
    return { gateway: new MockAIGateway() as unknown as AIGateway, baseUrl };
  }
  if (options.testGateway) {
    return { gateway: options.testGateway, baseUrl };
  }
  if (settings.sessionToken) {
    const gateway = new ProductionAIGateway({
      baseUrl,
      sessionToken: settings.sessionToken,
      refreshToken: settings.refreshToken,
      onTokensUpdated: async (newSession, newRefresh) => {
        if (newSession === '' && newRefresh === '') {
          await db.setSettings({ sessionToken: '', refreshToken: '' });
          options.onSessionExpired?.();
        } else {
          await db.setSettings({ sessionToken: newSession, refreshToken: newRefresh });
          settings.sessionToken = newSession;
          settings.refreshToken = newRefresh;
        }
      },
    });
    return { gateway: gateway as unknown as AIGateway, baseUrl };
  }

  // Fallback to local AI Provider for development without SaaS session
  // SECURITY GUARD: client-side key fallback is strictly prohibited in production.
  if (process.env.NODE_ENV === 'production') {
    return { error: 'AUTH_REQUIRED: No session token present. Client-side key fallback is disabled in production. Please sign in via Settings → Account.' };
  }
  const providerName = settings.aiProvider || 'gemini';
  const localKey = settings.aiProviderApiKey || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GEMINI_API_KEY;
  if (!localKey) {
    return { error: 'AUTH_REQUIRED: You must sign in via Settings, or configure a Local AI Provider API Key.' };
  }
  if (providerName !== 'gemini') {
    return { error: `AUTH_REQUIRED: The selected local provider '${providerName}' is not yet supported in the desktop build.` };
  }
  return { gateway: new GoogleGeminiAdapter(localKey) as unknown as AIGateway, baseUrl };
}
