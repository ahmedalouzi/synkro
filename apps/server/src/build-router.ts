import express, { Router } from 'express';
import multer from 'multer';
import { db as client, validateZipBuffer, AuthenticationRouter } from '@peep/agent/server';

export const buildRouter: Router = express.Router();

// Configure multer for zip uploads (max 50MB limit)
const upload = multer({
  storage: multer.memoryStorage(), // For MVP, keep in memory before writing to disk/db
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

const authService = new AuthenticationRouter();

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
      res.json(result.rows);
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
      res.json(result.rows[0]);
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

buildRouter.get('/:jobId/download', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const jobId = req.params.jobId;

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

    const fs = await import('node:fs');
    const path = await import('node:path');
    const destDir = process.env.ARTIFACT_DIR || '/var/lib/synkro/artifacts';
    
    // We strictly use userId and jobId (UUIDs) avoiding path traversal
    const artifactPath = path.join(destDir, userId.toString(), `${jobId}.apk`);

    if (!fs.existsSync(artifactPath)) {
      res.status(404).json({ error: 'Artifact file not found on disk' });
      return;
    }

    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', 'attachment; filename="app-release.apk"');
    const stream = fs.createReadStream(artifactPath);
    stream.pipe(res);
  } catch (err) {
    console.error('[GET /build/:jobId/download]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

buildRouter.post('/:jobId/cancel', requireAuth, async (req, res) => {
  try {
    const userId = (req as any).user.userId;
    const jobId = req.params.jobId;

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
