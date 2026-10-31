import crypto from 'node:crypto';
import pino from 'pino';
import express, { Router } from 'express';
import multer from 'multer';
import { db as client, validateZipBuffer, AuthenticationRouter, readSigningKey } from '@peep/agent/server';

export const buildRouter: Router = express.Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isValidJobId(jobId: unknown): jobId is string {
  return typeof jobId === 'string' && UUID_REGEX.test(jobId);
}

// Configure multer for zip uploads (max 50MB limit)
const upload = multer({
  storage: multer.memoryStorage(), // For MVP, keep in memory before writing to disk/db
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

const authService = new AuthenticationRouter();

const logger = pino({ name: 'build-download' });

const DOWNLOAD_TOKEN_SECRET = process.env.DOWNLOAD_TOKEN_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET || 'synkro-download-secret-fallback-key-32b';
const DOWNLOAD_TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes

export interface DownloadTokenPayload {
  jobId: string;
  userId: string;
  purpose: 'apk-download';
  exp: number; // timestamp in ms
  tokenId: string;
}

export function createDownloadToken(jobId: string, userId: string): { token: string; expiresAt: number } {
  const expiresAt = Date.now() + DOWNLOAD_TOKEN_TTL_MS;
  const payload: DownloadTokenPayload = {
    jobId,
    userId,
    purpose: 'apk-download',
    exp: expiresAt,
    tokenId: crypto.randomBytes(8).toString('hex'),
  };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', DOWNLOAD_TOKEN_SECRET).update(data).digest('base64url');
  return { token: `${data}.${sig}`, expiresAt };
}

export function verifyDownloadToken(token: string, expectedJobId: string): { valid: boolean; payload?: DownloadTokenPayload; reason?: string } {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) {
      return { valid: false, reason: 'Malformed token format' };
    }
    const [data, sig] = parts;
    const expectedSig = crypto.createHmac('sha256', DOWNLOAD_TOKEN_SECRET).update(data).digest('base64url');
    const sigBuf = Buffer.from(sig);
    const expBuf = Buffer.from(expectedSig);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return { valid: false, reason: 'Invalid signature' };
    }
    const payload: DownloadTokenPayload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
    if (payload.purpose !== 'apk-download') {
      return { valid: false, reason: 'Invalid token purpose' };
    }
    if (payload.jobId !== expectedJobId) {
      return { valid: false, reason: 'Token is not bound to this job' };
    }
    if (Date.now() > payload.exp) {
      return { valid: false, reason: 'Download token has expired' };
    }
    return { valid: true, payload };
  } catch (err: any) {
    return { valid: false, reason: err?.message || 'Token verification failed' };
  }
}


// Middleware for true authentication
const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const token = (req.headers['authorization'] || '').replace('Bearer ', '') || (req.headers['session'] as string) || (req.query.token as string);
    if (!token) {
      res.status(401).json({ error: 'Unauthorized: Missing session token' });
      return;
    }
    const session = await authService.validateSession(token);
    (req as any).user = session;
    next();
  } catch (err: any) {
    res.status(401).json({ error: 'Unauthorized: ' + (err.message || 'Invalid session') });
  }
};

// Middleware for Usage Cap (10 builds/day)
const buildRateLimiter = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  try {
    const userId = (req as any).user.userId;

    const dbClient = await client.connect();
    let result;
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      result = await dbClient.query(`
        SELECT COUNT(*) as count 
        FROM build_jobs 
        WHERE user_id = $1 
          AND created_at >= NOW() - INTERVAL '1 day'
      `, [userId]);
      await dbClient.query('COMMIT');
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }

    const count = parseInt(result.rows[0].count, 10);
    if (count >= 10) {
      res.status(429).json({ error: 'Usage Limit Exceeded: You can only build 10 times per day.' });
      return;
    }

    next();
  } catch (err) {
    console.error('[Build Rate Limiter Error]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

buildRouter.post('/upload', requireAuth, buildRateLimiter, upload.single('project'), async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const projectId = String(req.body.projectId || 'unknown').trim().slice(0, 128);
    const framework = req.body.framework || 'flutter';
    const target = req.body.target || 'apk';

    const ALLOWED_FRAMEWORKS = new Set(['flutter', 'react-native']);
    const ALLOWED_TARGETS = new Set(['apk', 'aab']);

    if (!ALLOWED_FRAMEWORKS.has(framework)) {
      res.status(400).json({ error: `Invalid framework "${framework}". Must be "flutter" or "react-native".` });
      return;
    }

    if (!ALLOWED_TARGETS.has(target)) {
      res.status(400).json({ error: `Invalid target "${target}". Must be "apk" or "aab".` });
      return;
    }

    // Every build is signed with its project's own key, found by this ID (.synkro/project.json on the desktop).
    if (!UUID_REGEX.test(projectId)) {
      res.status(400).json({ error: 'This build has no project ID, so it cannot be signed. Update Atomvs and build again.' });
      return;
    }

    if (!req.file) {
      res.status(400).json({ error: 'No project file uploaded' });
      return;
    }

    const zipCheck = validateZipBuffer(req.file.buffer);
    if (!zipCheck.valid) {
      res.status(400).json({ error: zipCheck.error || 'Invalid ZIP archive' });
      return;
    }

    // Save validated archive to local temp build directory
    const artifactPath = `/tmp/builds/${Date.now()}_${userId}.zip`;
    const fs = await import('node:fs/promises');
    await fs.mkdir('/tmp/builds', { recursive: true });
    await fs.writeFile(artifactPath, req.file.buffer);
    
    const dbClient = await client.connect();
    let job;
    try {
      await dbClient.query('BEGIN');
      // SECURITY CRITICAL: The base connection authenticates as the postgres superuser.
      // RLS protection depends ENTIRELY on this line being present. If forgotten, 
      // the endpoint silently loses all tenant isolation and fails open.
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      const result = await dbClient.query(`
        INSERT INTO build_jobs (user_id, project_id, status, source_path, framework, target)
        VALUES ($1, $2, 'queued', $3, $4, $5)
        RETURNING id, status
      `, [userId, projectId, artifactPath, framework, target]);
      job = result.rows[0];
      await dbClient.query('COMMIT');
    } catch (e) {
      await dbClient.query('ROLLBACK');
      await fs.unlink(artifactPath).catch(() => {});
      throw e;
    } finally {
      dbClient.release();
    }

    console.log(`[BUILD_ROUTER] Uploaded project for user ${userId}, job ID ${job.id}`);
    res.status(202).json({ jobId: job.id, status: job.status });
  } catch (err) {
    console.error('[Build Upload Error]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

buildRouter.get('/history', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;

    const dbClient = await client.connect();
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      
      const result = await dbClient.query(`
        SELECT id, project_id AS "projectId", status, framework, target, created_at AS "createdAt", started_at AS "startedAt", completed_at AS "completedAt", artifact_url AS "artifactUrl"
        FROM build_jobs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50
      `, [userId]);
      
      await dbClient.query('COMMIT');
      const rows = result.rows.map((row: any) => {
        if (row.status === 'success' && row.artifactUrl) {
          const { token, expiresAt } = createDownloadToken(row.id, userId);
          return {
            ...row,
            downloadToken: token,
            downloadExpiresAt: expiresAt,
            artifactUrl: `/api/build/${row.id}/download?token=${token}`,
          };
        }
        return row;
      });
      res.json(rows);
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[GET /build/history]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

buildRouter.get('/:jobId', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const jobId = req.params.jobId;

    if (!isValidJobId(jobId)) {
      res.status(400).json({ error: 'Invalid jobId: must be a valid UUID' });
      return;
    }

    const dbClient = await client.connect();
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      
      const result = await dbClient.query(`
        SELECT id, project_id AS "projectId", status, framework, target, created_at AS "createdAt", started_at AS "startedAt", completed_at AS "completedAt", error_log AS "errorLog", artifact_url AS "artifactUrl"
        FROM build_jobs
        WHERE id = $1
      `, [jobId]);
      
      await dbClient.query('COMMIT');

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Build job not found' });
        return;
      }
      const job = result.rows[0];
      if (job.status === 'success' && job.artifactUrl) {
        const { token, expiresAt } = createDownloadToken(job.id, userId);
        job.downloadToken = token;
        job.downloadExpiresAt = expiresAt;
        job.artifactUrl = `/api/build/${job.id}/download?token=${token}`;
      }
      res.json(job);
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[GET /build/:jobId]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

buildRouter.get('/:jobId/download-token', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const jobId = req.params.jobId;

    if (!isValidJobId(jobId)) {
      res.status(400).json({ error: 'Invalid jobId: must be a valid UUID' });
      return;
    }

    const dbClient = await client.connect();
    let job;
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      
      const result = await dbClient.query(`
        SELECT id, status, artifact_url
        FROM build_jobs
        WHERE id = $1
      `, [jobId]);
      
      await dbClient.query('COMMIT');
      job = result.rows[0];
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }

    if (!job) {
      res.status(404).json({ error: 'Build job not found' });
      return;
    }
    
    if (job.status !== 'success') {
      res.status(400).json({ error: 'Artifact not ready or build failed' });
      return;
    }

    const { token, expiresAt } = createDownloadToken(job.id, userId);
    res.json({
      token,
      downloadUrl: `/api/build/${job.id}/download?token=${token}`,
      expiresAt,
    });
  } catch (err) {
    console.error('[GET /build/:jobId/download-token]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

buildRouter.get('/:jobId/download', async (req, res) => {
  const clientIp = (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.ip || req.socket.remoteAddress || 'unknown';
  const userAgent = req.headers['user-agent'] || 'unknown';
  const jobId = req.params.jobId;

  if (!isValidJobId(jobId)) {
    res.status(400).json({ error: 'Invalid jobId: must be a valid UUID' });
    return;
  }

  const rawToken = (req.query.token as string) || (req.headers['authorization'] || '').replace('Bearer ', '') || (req.headers['session'] as string);
  if (!rawToken) {
    logger.warn({ event: 'apk_download_rejected', jobId, ip: clientIp, userAgent, reason: 'Missing token' }, 'APK download missing token');
    res.status(401).json({ error: 'Unauthorized: Missing download token' });
    return;
  }

  let userId: string;
  let tokenId: string;

  if (rawToken.includes('.')) {
    const verified = verifyDownloadToken(rawToken, jobId);
    if (!verified.valid || !verified.payload) {
      logger.warn({ event: 'apk_download_rejected', jobId, ip: clientIp, userAgent, reason: verified.reason }, 'APK download token verification failed');
      res.status(401).json({ error: `Unauthorized: ${verified.reason}` });
      return;
    }
    userId = verified.payload.userId;
    tokenId = verified.payload.tokenId;
  } else {
    // Session token fallback
    try {
      const session = await authService.validateSession(rawToken);
      userId = session.userId;
      tokenId = 'session';
    } catch (err: any) {
      logger.warn({ event: 'apk_download_rejected', jobId, ip: clientIp, userAgent, reason: 'Invalid session token' }, 'APK download session invalid');
      res.status(401).json({ error: 'Unauthorized: ' + (err.message || 'Invalid session') });
      return;
    }
  }

  try {
    const dbClient = await client.connect();
    let job;
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      
      const result = await dbClient.query(`
        SELECT id, status, artifact_url
        FROM build_jobs
        WHERE id = $1
      `, [jobId]);
      
      await dbClient.query('COMMIT');
      job = result.rows[0];
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }

    if (!job) {
      logger.warn({ event: 'apk_download_rejected', jobId, userId, ip: clientIp, reason: 'Job not found' }, 'APK download job not found');
      res.status(404).json({ error: 'Build job not found' });
      return;
    }
    
    if (job.status !== 'success') {
      logger.warn({ event: 'apk_download_rejected', jobId, userId, ip: clientIp, reason: 'Artifact not ready' }, 'APK artifact not ready');
      res.status(400).json({ error: 'Artifact not ready or build failed' });
      return;
    }

    const fs = await import('node:fs');
    const path = await import('node:path');
    const destDir = process.env.ARTIFACT_DIR || '/var/lib/synkro/artifacts';
    const resolvedDest = path.resolve(destDir);
    const artifactPath = path.resolve(destDir, userId.toString(), `${jobId}.apk`);

    if (!artifactPath.startsWith(resolvedDest + path.sep)) {
      res.status(400).json({ error: 'Invalid artifact path' });
      return;
    }

    if (!fs.existsSync(artifactPath)) {
      logger.warn({ event: 'apk_download_rejected', jobId, userId, artifactPath, ip: clientIp, reason: 'File not found on disk' }, 'APK file missing');
      res.status(404).json({ error: 'Artifact file not found on disk' });
      return;
    }

    logger.info({
      event: 'apk_download_started',
      timestamp: new Date().toISOString(),
      jobId,
      userId,
      tokenId,
      ip: clientIp,
      userAgent,
      artifactPath,
    }, `Serving APK download for job ${jobId}`);

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="app-release.apk"');
    const stream = fs.createReadStream(artifactPath);
    stream.on('error', (err) => {
      logger.error({ event: 'apk_download_stream_error', jobId, error: err.message }, 'Download stream error');
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to stream artifact' });
      } else {
        res.destroy();
      }
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    logger.error({ event: 'apk_download_error', jobId, error: String(err) }, 'Error in download route');
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

buildRouter.post('/:jobId/cancel', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const jobId = req.params.jobId;

    if (!isValidJobId(jobId)) {
      res.status(400).json({ error: 'Invalid jobId: must be a valid UUID' });
      return;
    }

    const dbClient = await client.connect();
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      
      const result = await dbClient.query(`
        UPDATE build_jobs
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1 AND status IN ('queued', 'running')
        RETURNING id
      `, [jobId]);
      
      await dbClient.query('COMMIT');

      if (result.rows.length === 0) {
        res.status(404).json({ error: 'Job not found, or cannot be cancelled' });
        return;
      }
      res.json({ success: true, message: 'Job cancelled' });
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }
  } catch (err) {
    console.error('[POST /build/:jobId/cancel]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

buildRouter.get('/:jobId/stream', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const jobId = req.params.jobId;

    if (!isValidJobId(jobId)) {
      res.status(400).json({ error: 'Invalid jobId: must be a valid UUID' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const dbClient = await client.connect();
    
    // Send an initial chunk to establish connection
    res.write(`data: ${JSON.stringify({ status: 'connected', chunk: 'Connected to log stream\\r\\n' })}\n\n`);

    // For MVP, we'll just poll the error_log column every 2 seconds
    // In production, this should use LISTEN/NOTIFY or Redis PubSub
    let lastLength = 0;
    
    const interval = setInterval(async () => {
      try {
        await dbClient.query('BEGIN');
        await dbClient.query('SET LOCAL ROLE api_user');
        await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
        
        const result = await dbClient.query(`
          SELECT status, error_log
          FROM build_jobs
          WHERE id = $1
        `, [jobId]);
        
        await dbClient.query('COMMIT');
        
        if (result.rows.length > 0) {
          const row = result.rows[0];
          const logStr = row.error_log || '';
          
          if (logStr.length > lastLength) {
            const newChunk = logStr.slice(lastLength);
            lastLength = logStr.length;
            res.write(`data: ${JSON.stringify({ chunk: newChunk })}\n\n`);
          } else {
            // Send keep-alive to prevent Body Timeout Error on long Docker pulls
            res.write(`:\n\n`);
          }
          
          if (row.status === 'success' || row.status === 'failed' || row.status === 'cancelled') {
            res.write(`data: ${JSON.stringify({ chunk: '\\r\\n[Stream Terminated: Job ' + row.status + ']' })}\n\n`);
            clearInterval(interval);
            dbClient.release();
            res.end();
          }
        } else {
          clearInterval(interval);
          dbClient.release();
          res.end();
        }
      } catch (err) {
        await dbClient.query('ROLLBACK');
        console.error('[GET /build/:jobId/stream poll error]', err);
        clearInterval(interval);
        dbClient.release();
        res.end();
      }
    }, 2000);

    req.on('close', () => {
      clearInterval(interval);
      try { dbClient.release(); } catch (e) {}
    });
  } catch (err) {
    console.error('[GET /build/:jobId/stream]', err);
    res.status(500).end();
  }
});

// ---------------------------------------------------------------------------
// Release keystore download: lets a project's owner take their signing key with them (they need it to keep
// updating their app on Google Play if they leave Synkro). Sensitive, so: session token from the
// Authorization header only (never ?token=), the account password again in the body, 5 attempts per hour,
// and every attempt logged without secrets.
// ---------------------------------------------------------------------------
const KEYSTORE_DOWNLOADS_PER_HOUR = 5;

/** Counts this attempt; false once the user has used up the hour's attempts. */
async function allowKeystoreAttempt(userId: string): Promise<boolean> {
  const res = await client.query(
    `INSERT INTO rate_limits (ip_or_email, attempts, window_start) VALUES ($1, 1, NOW())
     ON CONFLICT (ip_or_email) DO UPDATE SET
       attempts = CASE WHEN rate_limits.window_start < NOW() - INTERVAL '1 hour' THEN 1 ELSE rate_limits.attempts + 1 END,
       window_start = CASE WHEN rate_limits.window_start < NOW() - INTERVAL '1 hour' THEN NOW() ELSE rate_limits.window_start END
     RETURNING attempts`,
    [`keystore-download:${userId}`],
  );
  return res.rows[0].attempts <= KEYSTORE_DOWNLOADS_PER_HOUR;
}

buildRouter.post('/signing/:projectId/keystore', async (req, res) => {
  const projectId = String(req.params.projectId);
  let userId = 'anonymous';
  const audit = (result: string) => {
    console.log(`[KEYSTORE_DOWNLOAD] user=${userId} project=${projectId.slice(0, 64)} ip=${req.ip} result=${result}`);
  };
  res.setHeader('Cache-Control', 'no-store');

  try {
    const header = String(req.headers['authorization'] || '');
    if (!header.startsWith('Bearer ')) {
      audit('no_token');
      res.status(401).json({ error: 'Unauthorized: send the session token in the Authorization header' });
      return;
    }
    try {
      userId = (await authService.validateSession(header.slice('Bearer '.length))).userId;
    } catch {
      audit('bad_token');
      res.status(401).json({ error: 'Unauthorized: invalid session' });
      return;
    }

    if (!UUID_REGEX.test(projectId)) {
      audit('bad_project_id');
      res.status(400).json({ error: 'Invalid project ID' });
      return;
    }

    if (!(await allowKeystoreAttempt(userId))) {
      audit('rate_limited');
      res.status(429).json({ error: `Too many attempts. You can try ${KEYSTORE_DOWNLOADS_PER_HOUR} times per hour.` });
      return;
    }

    const password = req.body?.password;
    if (typeof password !== 'string' || !(await authService.verifyUserPassword(userId, password))) {
      audit('bad_password');
      res.status(403).json({ error: 'Wrong account password' });
      return;
    }

    const dbClient = await client.connect();
    let key;
    try {
      await dbClient.query('BEGIN');
      await dbClient.query('SET LOCAL ROLE api_user');
      await dbClient.query('SELECT set_config($1, $2, true)', ['app.current_user_id', userId]);
      key = await readSigningKey(dbClient, userId, projectId);
      await dbClient.query('COMMIT');
    } catch (e) {
      await dbClient.query('ROLLBACK');
      throw e;
    } finally {
      dbClient.release();
    }

    if (!key) {
      audit('not_found');
      res.status(404).json({ error: 'This project has no signing key yet. It is created by the first Cloud Build.' });
      return;
    }

    audit('ok');
    res.json({
      projectId,
      packageName: key.packageName,
      keystoreType: 'PKCS12',
      fileName: `atomvs-upload-${projectId}.p12`,
      keystoreBase64: key.keystore.toString('base64'),
      alias: key.alias,
      storePassword: key.storePassword,
      keyPassword: key.keyPassword,
      certSha256: key.certSha256,
    });
  } catch (err: any) {
    audit('error');
    console.error('[POST /build/signing/:projectId/keystore]', err.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
