import crypto from 'node:crypto';

/**
 * Signed, short-lived links for downloading a build's APK (the QR code and the desktop's download button).
 *
 * The token is an HMAC over { jobId, userId, purpose, exp, tokenId } with DOWNLOAD_TOKEN_SECRET. It is only a
 * pointer: the download route still checks in the database that the job belongs to that user and has finished.
 *
 * DOWNLOAD_TOKEN_SECRET is its own secret (not the JWT or session secret) of at least 32 bytes. Production does not
 * start without it; outside production a random key is made at each boot (links then expire on restart). There is
 * no fallback key: a key in the source would let anyone sign a link.
 */

export const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000;
export const MIN_SECRET_BYTES = 32;

export interface DownloadTokenPayload {
  jobId: string;
  userId: string;
  purpose: 'apk-download';
  /** Expiry, ms since epoch. */
  exp: number;
  tokenId: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The key for this process, from the environment: throws in production when it is missing or too short. */
export function resolveDownloadTokenSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  const configured = env.DOWNLOAD_TOKEN_SECRET;
  if (configured && Buffer.byteLength(configured, 'utf8') >= MIN_SECRET_BYTES) return Buffer.from(configured, 'utf8');
  if (env.NODE_ENV === 'production') {
    throw new Error(configured
      ? `DOWNLOAD_TOKEN_SECRET is shorter than ${MIN_SECRET_BYTES} bytes`
      : 'DOWNLOAD_TOKEN_SECRET is not set (generate one with: openssl rand -base64 48)');
  }
  return crypto.randomBytes(MIN_SECRET_BYTES);
}

let secret: Buffer | null = null;

/** The process's key, resolved once (the boot check calls this first in production). */
export function downloadTokenSecret(): Buffer {
  if (!secret) {
    secret = resolveDownloadTokenSecret();
    if (!process.env.DOWNLOAD_TOKEN_SECRET && process.env.NODE_ENV !== 'production') {
      console.warn('[download-token] DOWNLOAD_TOKEN_SECRET not set: using a random key for this run (dev only).');
    }
  }
  return secret;
}

function sign(key: Buffer, jobId: string, data: string): string {
  // Bind jobId and purpose into the HMAC input so neither needs to be repeated in the URL token.
  return crypto.createHmac('sha256', key).update(`${jobId}:apk-download:${data}`).digest('base64url');
}

export function createDownloadToken(
  jobId: string, userId: string, key: Buffer = downloadTokenSecret(), now = Date.now(),
): { token: string; expiresAt: number } {
  const expiresAt = now + DOWNLOAD_TOKEN_TTL_MS;
  const compactPayload = {
    userId,
    exp: expiresAt,
    tokenId: crypto.randomBytes(8).toString('hex'),
  };
  const data = Buffer.from(JSON.stringify(compactPayload)).toString('base64url');
  return { token: `${data}.${sign(key, jobId, data)}`, expiresAt };
}

export function verifyDownloadToken(
  token: string, expectedJobId: string, key: Buffer = downloadTokenSecret(), now = Date.now(),
): { valid: boolean; payload?: DownloadTokenPayload; reason?: string } {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: 'Malformed token' };
  const [data, sig] = parts;
  const given = Buffer.from(sig);
  const expected = Buffer.from(sign(key, expectedJobId, data));
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { valid: false, reason: 'Invalid signature' };
  }
  let raw: { userId?: unknown; exp?: unknown; tokenId?: unknown };
  try {
    raw = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'Malformed token' };
  }
  if (!raw || typeof raw.exp !== 'number'
    || typeof raw.userId !== 'string' || !UUID.test(raw.userId) || typeof raw.tokenId !== 'string') {
    return { valid: false, reason: 'Malformed token' };
  }
  if (now > raw.exp) return { valid: false, reason: 'Download link has expired' };
  return {
    valid: true,
    payload: {
      jobId: expectedJobId,
      userId: raw.userId,
      purpose: 'apk-download',
      exp: raw.exp,
      tokenId: raw.tokenId,
    },
  };
}
