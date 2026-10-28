/**
 * GatewayResolver — Single source of truth for the active AI Gateway base URL.
 *
 * This is a pure function: it reads no global state. All required values must
 * be explicitly injected by the call site. This makes the resolver fully
 * testable and free of hidden side effects.
 *
 * Resolution order:
 *     1. settingsUrl    (user-configured via the Settings UI)
 *     2. envGatewayUrl  (SYNKRO_GATEWAY_URL — env override)
 *     3. PRODUCTION_DEFAULT (https://api.synkro.com)
 */

export interface GatewayResolverOptions {
  /** User-configured URL from the Settings store. */
  settingsUrl?: string;
  /** Value of SYNKRO_GATEWAY_URL. Must be injected by the call site — not read internally. */
  envGatewayUrl?: string;
  /** Value of NODE_ENV. Reserved for future use; injected by the call site. */
  nodeEnv?: string;
}

export class GatewayResolver {
  /** Fallback base URL for production environments. */
  static readonly PRODUCTION_DEFAULT = 'https://api.synkro.com';

  /**
   * Resolves the active gateway base URL.
   * Pure function — reads no process.env or global state internally.
   */
  static resolve(options: GatewayResolverOptions = {}): string {
    const { settingsUrl, envGatewayUrl } = options;

    // 1. User-configured URL
    if (settingsUrl) return settingsUrl;

    // 2. Environment variable override
    if (envGatewayUrl) return envGatewayUrl;

    // 3. Production default
    return GatewayResolver.PRODUCTION_DEFAULT;
  }
}
