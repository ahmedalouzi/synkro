import crypto from 'node:crypto';
import forge from 'node-forge';

// ---------------------------------------------------------------------------
// Release signing keys: one upload key per (user, project), created on the project's first Cloud Build and
// reused for every build after it, so updates install over each other and can go to Google Play.
// Stored in signing_keys, every secret field encrypted with AES-256-GCM under SYNKRO_SIGNING_ENC_KEY.
// ---------------------------------------------------------------------------

export const SIGNING_KEY_ALIAS = 'synkro-upload';
const VALIDITY_YEARS = 30;
const IV_BYTES = 12;
const TAG_BYTES = 16;

type Query = { query: Function };

export type EncryptedField = 'keystore' | 'store_password' | 'key_password';

export interface SigningKey {
  alias: string;
  /** PKCS#12 keystore holding the private key and its self-signed certificate. */
  keystore: Buffer;
  storePassword: string;
  keyPassword: string;
  /** SHA-256 of the certificate (DER), lowercase hex, as apksigner prints it. */
  certSha256: string;
  packageName: string | null;
}

/**
 * The 32-byte key from SYNKRO_SIGNING_ENC_KEY (base64). Losing it loses every user's signing key, so keep a
 * copy off the server; changing it needs every stored key re-encrypted first.
 */
export function loadSigningEncKey(): Buffer {
  const raw = process.env.SYNKRO_SIGNING_ENC_KEY;
  if (!raw) throw new Error('SYNKRO_SIGNING_ENC_KEY is not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('SYNKRO_SIGNING_ENC_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
  return key;
}

/** Binds a ciphertext to its row and column, so it cannot be moved to another project or field. */
export function fieldAad(userId: string, projectId: string, field: EncryptedField): string {
  return `${userId}:${projectId}:${field}`;
}

/** AES-256-GCM. Output: iv (12) | tag (16) | ciphertext. */
export function encryptField(plain: Buffer, aad: string, key: Buffer = loadSigningEncKey()): Buffer {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Throws when the data, the key or the AAD do not match. */
export function decryptField(blob: Buffer, aad: string, key: Buffer = loadSigningEncKey()): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('Encrypted field is too short');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/**
 * A new upload key: RSA 2048, self-signed certificate valid for 30 years, in a PKCS#12 keystore.
 * PKCS#12 has one password for the store and the key (keytool and the Android Gradle Plugin expect them to match).
 */
export function generateUploadKeystore(): { keystore: Buffer; password: string; certSha256: string } {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  });
  const forgePrivateKey = forge.pki.privateKeyFromPem(privateKey);

  const cert = forge.pki.createCertificate();
  cert.publicKey = forge.pki.publicKeyFromPem(publicKey);
  // Positive serial (leading byte below 0x80).
  cert.serialNumber = '01' + crypto.randomBytes(15).toString('hex');
  const now = new Date();
  cert.validity.notBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  cert.validity.notAfter = new Date(now);
  cert.validity.notAfter.setFullYear(now.getFullYear() + VALIDITY_YEARS);
  const subject = [
    { name: 'commonName', value: 'Atomvs Upload Key' },
    { name: 'organizationName', value: 'Atomvs' },
  ];
  cert.setSubject(subject);
  cert.setIssuer(subject);
  cert.sign(forgePrivateKey, forge.md.sha256.create());

  const password = crypto.randomBytes(24).toString('base64url');
  const p12 = forge.pkcs12.toPkcs12Asn1(forgePrivateKey, [cert], password, {
    algorithm: '3des',
    friendlyName: SIGNING_KEY_ALIAS,
    generateLocalKeyId: true,
  });
  const keystore = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');
  const certDer = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
  const certSha256 = crypto.createHash('sha256').update(certDer).digest('hex');
  return { keystore, password, certSha256 };
}

function decryptRow(row: any, userId: string, projectId: string): SigningKey {
  const key = loadSigningEncKey();
  return {
    alias: row.alias,
    keystore: decryptField(row.keystore_enc, fieldAad(userId, projectId, 'keystore'), key),
    storePassword: decryptField(row.store_password_enc, fieldAad(userId, projectId, 'store_password'), key).toString('utf8'),
    keyPassword: decryptField(row.key_password_enc, fieldAad(userId, projectId, 'key_password'), key).toString('utf8'),
    certSha256: row.cert_sha256,
    packageName: row.package_name,
  };
}

const SELECT_KEY = `SELECT alias, keystore_enc, store_password_enc, key_password_enc, cert_sha256, package_name
  FROM signing_keys WHERE user_id = $1 AND project_id = $2`;

/**
 * The project's signing key, created on its first build. Two first builds racing each other end up with the
 * same key (the losing INSERT does nothing and both read the stored row). Call with a worker_user client.
 */
export async function getOrCreateSigningKey(c: Query, userId: string, projectId: string): Promise<SigningKey> {
  const existing = await c.query(SELECT_KEY, [userId, projectId]);
  if (existing.rows.length > 0) return decryptRow(existing.rows[0], userId, projectId);

  const key = loadSigningEncKey();
  const generated = generateUploadKeystore();
  const password = Buffer.from(generated.password, 'utf8');
  await c.query(
    `INSERT INTO signing_keys (user_id, project_id, alias, keystore_enc, store_password_enc, key_password_enc, cert_sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, project_id) DO NOTHING`,
    [
      userId,
      projectId,
      SIGNING_KEY_ALIAS,
      encryptField(generated.keystore, fieldAad(userId, projectId, 'keystore'), key),
      encryptField(password, fieldAad(userId, projectId, 'store_password'), key),
      encryptField(password, fieldAad(userId, projectId, 'key_password'), key),
      generated.certSha256,
    ],
  );
  const stored = await c.query(SELECT_KEY, [userId, projectId]);
  return decryptRow(stored.rows[0], userId, projectId);
}

/** The project's signing key for its owner, or null. Call with an api_user client scoped to userId (RLS). */
export async function readSigningKey(c: Query, userId: string, projectId: string): Promise<SigningKey | null> {
  const res = await c.query(SELECT_KEY, [userId, projectId]);
  return res.rows.length > 0 ? decryptRow(res.rows[0], userId, projectId) : null;
}

/** Remembers the package name the key was first used for (shown with the downloaded keystore). worker_user. */
export async function recordSigningPackageName(c: Query, userId: string, projectId: string, packageName: string): Promise<void> {
  await c.query(
    `UPDATE signing_keys SET package_name = $3 WHERE user_id = $1 AND project_id = $2 AND package_name IS NULL`,
    [userId, projectId, packageName],
  );
}
