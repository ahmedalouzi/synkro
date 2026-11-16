import type { Express } from 'express';

/**
 * Which proxies Express trusts for X-Forwarded-For. Caddy runs on the same host (scripts/setup-production-server.sh)
 * and reaches the server on 127.0.0.1:8080, so only loopback addresses are trusted. Express then sets req.ip to the
 * address Caddy received the request from: it walks X-Forwarded-For from the right and stops at the first address
 * that is not loopback, so entries a client writes into the header itself are ignored.
 *
 * Without it (the Express default, false) req.ip is 127.0.0.1 for every request through Caddy: every user shared one
 * rate-limit key, and express-rate-limit logged ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. Never `true`: that would trust any
 * X-Forwarded-For, letting a client pick its own rate-limit key.
 */
export const TRUST_PROXY = 'loopback';

export function applyTrustProxy(app: Express): void {
  app.set('trust proxy', TRUST_PROXY);
}
