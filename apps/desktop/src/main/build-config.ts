// Production values baked in by electron.vite.config.ts at build time.
// Installed builds don't read .env, so these are the only way to point them at the real server.
// `typeof` guards keep this module loadable outside the bundler (tsx tests).
declare const __SYNKRO_GATEWAY_URL__: string | undefined;
declare const __SYNKRO_SENTRY_DSN__: string | undefined;

const BAKED_GATEWAY_URL = typeof __SYNKRO_GATEWAY_URL__ === 'string' ? __SYNKRO_GATEWAY_URL__ : '';
const BAKED_SENTRY_DSN = typeof __SYNKRO_SENTRY_DSN__ === 'string' ? __SYNKRO_SENTRY_DSN__ : '';

export const DEFAULT_GATEWAY_URL = 'https://api.synkro.com';

/** User setting → dev .env → value baked at build time → default. */
export function resolveGatewayUrl(settingsUrl?: string | null): string {
  return settingsUrl || process.env.SYNKRO_GATEWAY_URL || BAKED_GATEWAY_URL || DEFAULT_GATEWAY_URL;
}

export function resolveSentryDsn(): string {
  return process.env.SENTRY_DSN || BAKED_SENTRY_DSN;
}
