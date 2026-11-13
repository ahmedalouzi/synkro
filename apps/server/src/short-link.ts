import crypto from 'crypto';

export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

export const SHORT_LINK_TTL_MS = 15 * 60 * 1000;
export const SHORT_LINK_PURPOSE = 'apk-download' as const;

export interface ShortLinkRecord {
  id: string;
  codeHash: string;
  jobId: string;
  userId: string;
  purpose: string;
  expiresAt: number;
  createdAt: number;
  usedCount: number;
}

export interface ShortLinkResult {
  url: string;
  expiresAt: number;
  codeId: string;
}

export interface ShortLinkStore {
  insert(record: ShortLinkRecord): Promise<void>;
  findByCodeHash(codeHash: string): Promise<ShortLinkRecord | null>;
  incrementUsedCount(id: string): Promise<void>;
  deleteExpired(nowMs: number): Promise<number>;
}

/**
 * Generates a cryptographically random opaque short code (16 bytes -> 22 base64url chars).
 */
export function generateShortCode(): string {
  return crypto.randomBytes(16).toString('base64url');
}

/**
 * Hashes a raw short code using SHA-256 hex digest. Raw codes are never persisted.
 */
export function hashShortCode(code: string): string {
  return crypto.createHash('sha256').update(code, 'utf8').digest('hex');
}

/**
 * Resolves the public base URL used to build phone-scannable short links.
 * Reads PUBLIC_BASE_URL from env; falls back to localhost only outside production.
 */
export function resolvePublicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (raw) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`Invalid PUBLIC_BASE_URL: "${raw}"`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`PUBLIC_BASE_URL must use http or https protocol, got "${parsed.protocol}"`);
    }
    return parsed.toString().replace(/\/+$/, '');
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_BASE_URL environment variable is required in production');
  }

  const port = env.PORT?.trim() || '8080';
  return `http://localhost:${port}`;
}

/**
 * In-memory short-link store for isolated unit tests.
 */
export class InMemoryShortLinkStore implements ShortLinkStore {
  private readonly byHash = new Map<string, ShortLinkRecord>();

  async insert(record: ShortLinkRecord): Promise<void> {
    // Supersede any existing short link for the same job & purpose
    for (const [hash, existing] of this.byHash.entries()) {
      if (existing.jobId === record.jobId && existing.purpose === record.purpose) {
        this.byHash.delete(hash);
      }
    }
    this.byHash.set(record.codeHash, { ...record });
  }

  async findByCodeHash(codeHash: string): Promise<ShortLinkRecord | null> {
    const rec = this.byHash.get(codeHash);
    return rec ? { ...rec } : null;
  }

  async incrementUsedCount(id: string): Promise<void> {
    for (const rec of this.byHash.values()) {
      if (rec.id === id) {
        rec.usedCount += 1;
        return;
      }
    }
  }

  async deleteExpired(nowMs: number): Promise<number> {
    let removed = 0;
    for (const [hash, rec] of this.byHash.entries()) {
      if (rec.expiresAt <= nowMs) {
        this.byHash.delete(hash);
        removed += 1;
      }
    }
    return removed;
  }
}

/**
 * Postgres-backed short-link store.
 */
export class PgShortLinkStore implements ShortLinkStore {
  constructor(private readonly pool: PgPoolLike) { }

  async insert(record: ShortLinkRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `DELETE FROM download_short_links WHERE job_id = $1 AND purpose = $2`,
        [record.jobId, record.purpose]
      );
      await client.query(
        `INSERT INTO download_short_links (id, code_hash, job_id, user_id, purpose, expires_at, created_at, used_count)
         VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0), to_timestamp($7 / 1000.0), $8)`,
        [
          record.id,
          record.codeHash,
          record.jobId,
          record.userId,
          record.purpose,
          record.expiresAt,
          record.createdAt,
          record.usedCount,
        ]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => { });
      throw err;
    } finally {
      client.release();
    }
  }

  async findByCodeHash(codeHash: string): Promise<ShortLinkRecord | null> {
    const res = await this.pool.query(
      `SELECT id,
              code_hash AS "codeHash",
              job_id AS "jobId",
              user_id AS "userId",
              purpose,
              (EXTRACT(EPOCH FROM expires_at) * 1000)::bigint AS "expiresAt",
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS "createdAt",
              used_count AS "usedCount"
       FROM download_short_links
       WHERE code_hash = $1
       LIMIT 1`,
      [codeHash]
    );
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: String(row.id),
      codeHash: String(row.codeHash),
      jobId: String(row.jobId),
      userId: String(row.userId),
      purpose: String(row.purpose),
      expiresAt: Number(row.expiresAt),
      createdAt: Number(row.createdAt),
      usedCount: Number(row.usedCount),
    };
  }

  async incrementUsedCount(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE download_short_links SET used_count = used_count + 1 WHERE id = $1`,
      [id]
    );
  }

  async deleteExpired(nowMs: number): Promise<number> {
    const res = await this.pool.query(
      `DELETE FROM download_short_links WHERE expires_at <= to_timestamp($1 / 1000.0)`,
      [nowMs]
    );
    return res.rowCount ?? 0;
  }
}

/**
 * Mints a new short link for a build job, superseding any previous link for that job.
 */
export async function createShortLink(options: {
  jobId: string;
  userId: string;
  store: ShortLinkStore;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): Promise<ShortLinkResult> {
  const { jobId, userId, store, env = process.env, nowMs = Date.now() } = options;
  const baseUrl = resolvePublicBaseUrl(env);
  const code = generateShortCode();
  const codeHash = hashShortCode(code);
  const id = crypto.randomUUID();
  const expiresAt = nowMs + SHORT_LINK_TTL_MS;

  await store.insert({
    id,
    codeHash,
    jobId,
    userId,
    purpose: SHORT_LINK_PURPOSE,
    expiresAt,
    createdAt: nowMs,
    usedCount: 0,
  });

  // Periodically prune expired entries in the background (best-effort)
  void store.deleteExpired(nowMs).catch(() => { });

  return {
    url: `${baseUrl}/d/${code}`,
    expiresAt,
    codeId: id,
  };
}

export type ResolveShortLinkOutcome =
  | { ok: true; record: ShortLinkRecord }
  | { ok: false; reason: 'not_found' | 'expired' | 'invalid_purpose'; codeId?: string; jobId?: string };

/**
 * Resolves and validates a raw short code against the store.
 */
export async function resolveShortLink(options: {
  code: string;
  store: ShortLinkStore;
  nowMs?: number;
}): Promise<ResolveShortLinkOutcome> {
  const { code, store, nowMs = Date.now() } = options;
  if (!code || typeof code !== 'string' || code.length < 16 || code.length > 128) {
    return { ok: false, reason: 'not_found' };
  }

  const codeHash = hashShortCode(code);
  const record = await store.findByCodeHash(codeHash);
  if (!record) {
    return { ok: false, reason: 'not_found' };
  }

  if (record.purpose !== SHORT_LINK_PURPOSE) {
    return { ok: false, reason: 'invalid_purpose', codeId: record.id, jobId: record.jobId };
  }

  if (record.expiresAt <= nowMs) {
    return { ok: false, reason: 'expired', codeId: record.id, jobId: record.jobId };
  }

  return { ok: true, record };
}
