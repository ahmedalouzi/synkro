import crypto from 'node:crypto';
import {
  createDownloadToken, verifyDownloadToken, resolveDownloadTokenSecret, DOWNLOAD_TOKEN_TTL_MS,
} from '../../../apps/server/src/download-token';

/** APK download links: signed with a dedicated secret, short-lived, bound to one job and one user. */
export default async function run() {
  const key = crypto.randomBytes(32);
  const jobId = crypto.randomUUID();
  const userId = crypto.randomUUID();

  console.log('  [download-token] A valid link verifies, for its own job only...');
  const { token, expiresAt } = createDownloadToken(jobId, userId, key);
  const ok = verifyDownloadToken(token, jobId, key);
  if (!ok.valid || ok.payload?.userId !== userId) throw new Error('Valid token rejected');
  if (expiresAt - Date.now() > DOWNLOAD_TOKEN_TTL_MS || DOWNLOAD_TOKEN_TTL_MS > 15 * 60 * 1000) throw new Error('Token lives too long');
  if (verifyDownloadToken(token, crypto.randomUUID(), key).valid) throw new Error('Token accepted for another job');

  console.log('  [download-token] Forged tokens are refused...');
  // Signed with the old hard-coded fallback key that used to be in the source.
  const oldFallback = Buffer.from('synkro-download-secret-fallback-key-32b');
  if (verifyDownloadToken(createDownloadToken(jobId, userId, oldFallback).token, jobId, key).valid) {
    throw new Error('Token signed with the old fallback key accepted');
  }
  // Payload edited to another user, signature kept.
  const [data, sig] = token.split('.');
  const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(data, 'base64url').toString()), userId: crypto.randomUUID() })).toString('base64url');
  if (verifyDownloadToken(`${edited}.${sig}`, jobId, key).valid) throw new Error('Edited payload accepted');
  for (const bad of ['', 'abc', 'a.b.c', `${data}.`, `.${sig}`]) {
    if (verifyDownloadToken(bad, jobId, key).valid) throw new Error(`Malformed token accepted: ${bad}`);
  }

  console.log('  [download-token] Expired links are refused...');
  if (verifyDownloadToken(token, jobId, key, expiresAt + 1).valid) throw new Error('Expired token accepted');

  console.log('  [download-token] The secret: required in production, no fallback, random per boot in dev...');
  const throws = (env: NodeJS.ProcessEnv, pattern: RegExp, label: string) => {
    try {
      resolveDownloadTokenSecret(env);
    } catch (err) {
      if (!pattern.test((err as Error).message)) throw new Error(`${label}: ${(err as Error).message}`);
      return;
    }
    throw new Error(`${label}: did not throw`);
  };
  throws({ NODE_ENV: 'production' }, /not set/, 'production without a secret');
  throws({ NODE_ENV: 'production', DOWNLOAD_TOKEN_SECRET: 'too-short' }, /shorter than 32 bytes/, 'production with a short secret');
  // Other secrets are not used as a stand-in.
  throws({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(64), SESSION_SECRET: 'y'.repeat(64) }, /not set/, 'JWT/session secret as fallback');
  const configured = 'z'.repeat(48);
  if (!resolveDownloadTokenSecret({ NODE_ENV: 'production', DOWNLOAD_TOKEN_SECRET: configured }).equals(Buffer.from(configured))) {
    throw new Error('Configured secret not used');
  }
  const devA = resolveDownloadTokenSecret({ NODE_ENV: 'development' });
  const devB = resolveDownloadTokenSecret({ NODE_ENV: 'development' });
  if (devA.length < 32 || devA.equals(devB)) throw new Error('Dev key is not random per boot');

  console.log('  v Download token tests passed.');
}
