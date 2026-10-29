import * as path from 'node:path';
import { config } from 'dotenv';
import pino from 'pino';
import { ipRateLimiter } from './rate-limiter';

// Load env from root workspace
config({ path: path.resolve(process.cwd(), '.env') });
// Fallbacks for direct runner execution
config({ path: path.join(__dirname, '../../.env') });
config({ path: path.join(__dirname, '../../../.env') });

import express from 'express';
import * as Sentry from '@sentry/node';
import { BackendAIGateway, initDbSchema, startBuildWorker, loadSigningEncKey } from '@peep/agent/server';
import { fetchProductionSecrets } from './secrets';
import { execSync } from 'node:child_process';
import { buildRouter } from './build-router';
import { threadsRouter } from './threads-router';
import { billingRouter } from './billing-router';

async function bootstrap() {
  if (process.env.SENTRY_DSN) {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      tracesSampleRate: 1.0,
      debug: false,
    });
  }

  let commitHash = '168e73a';
  try {
    commitHash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch (e) {
    // fallback
  }
  const startedAt = new Date().toISOString();
  console.log(`[SERVER_BUILD] commit=${commitHash}`);
  console.log(`[SERVER_BUILD] started at ${startedAt}`);

  const secrets = await fetchProductionSecrets();
  
  // Set secrets into the environment so GoogleGeminiAdapter picks them up
  if (secrets.GOOGLE_API_KEY) process.env.GOOGLE_API_KEY = secrets.GOOGLE_API_KEY;
  if (secrets.OPENAI_API_KEY) process.env.OPENAI_API_KEY = secrets.OPENAI_API_KEY;
  if (secrets.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = secrets.ANTHROPIC_API_KEY;
  if (secrets.LEMONSQUEEZY_WEBHOOK_SECRET) process.env.LEMONSQUEEZY_WEBHOOK_SECRET = secrets.LEMONSQUEEZY_WEBHOOK_SECRET;
  if (secrets.STRIPE_WEBHOOK_SECRET) process.env.STRIPE_WEBHOOK_SECRET = secrets.STRIPE_WEBHOOK_SECRET;
  if (secrets.SYNKRO_SIGNING_ENC_KEY) process.env.SYNKRO_SIGNING_ENC_KEY = secrets.SYNKRO_SIGNING_ENC_KEY;

  // Every Cloud Build is signed with a key stored encrypted under SYNKRO_SIGNING_ENC_KEY: without it no build
  // can be signed, so production does not start.
  if (process.env.NODE_ENV === 'production') {
    try {
      loadSigningEncKey();
    } catch (err: any) {
      console.error(`[BOOT] ${err.message}. Refusing to start.`);
      process.exit(1);
    }
  }

  // Initialize the database schema (tables, indexes)
  console.log('[DATABASE_BOOT] Initializing database schema...');
  try {
    await initDbSchema();
    console.log('[DATABASE_BOOT] Database initialized successfully!');
    
    // Start build queue polling
    startBuildWorker();
  } catch (dbErr: any) {
    console.error('[DATABASE_BOOT] Database initialization failed:', dbErr.message);
  }

  // Initialize the backend gateway with structured pino logger
  const logger = pino({ level: 'info' });
  const gateway = new BackendAIGateway({
    info: (msg, meta) => logger.info(meta ?? {}, msg),
    warn: (msg, meta) => logger.warn(meta ?? {}, msg),
    error: (msg, meta) => logger.error(meta ?? {}, msg),
  });

  interface RateLimitInfo {
    count: number;
    resetTime: number;
  }

  const rateLimitStore = new Map<string, RateLimitInfo>();

  function apiRateLimiter(req: express.Request, res: express.Response, next: express.NextFunction) {
    const key = (req.headers['session'] as string) || (req.headers['authorization'] as string) || req.ip || 'unknown';
    const now = Date.now();
    const windowMs = 60 * 1000;
    const maxRequests = 60;

    let limitInfo = rateLimitStore.get(key);

    if (!limitInfo || now > limitInfo.resetTime) {
      limitInfo = {
        count: 1,
        resetTime: now + windowMs,
      };
      rateLimitStore.set(key, limitInfo);
    } else {
      limitInfo.count++;
    }

    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - limitInfo.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(limitInfo.resetTime / 1000));

    if (limitInfo.count > maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }

    next();
  }

  const app = express();
  app.use((req, _res, next) => {
    console.log("[REQUEST ARRIVED]", req.method, req.url);
    _res.setHeader('X-Synkro-Server-Version', commitHash);
    next();
  });
  app.use((req, res, next) => {
    const origin = req.headers.origin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Session, X-Request-Id, X-Synkro-Client-Start');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.json({
    limit: '50mb',
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use(ipRateLimiter());

  // Healthcheck endpoint for AWS ECS Load Balancer
  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // Attach Android Cloud Build Router
  app.use('/api/build', buildRouter);

  // Attach Chat Threads Router
  app.use('/v1/threads', threadsRouter);
  app.use('/v1/billing', billingRouter);
  app.use('/api/billing', billingRouter);

  // Signup Endpoint
  app.post('/v1/auth/signup', async (req, res) => {
    try {
      const headers = req.headers as Record<string, string>;
      const response = await gateway.handleRequest('POST', '/v1/auth/signup', headers, req.body);
      res.status(response.status).json(response.body);
    } catch (err: any) {
      console.error('[Signup Route Error]', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Signin Endpoint
  app.post('/v1/auth/signin', async (req, res) => {
    try {
      const headers = req.headers as Record<string, string>;
      const response = await gateway.handleRequest('POST', '/v1/auth/signin', headers, req.body);
      res.status(response.status).json(response.body);
    } catch (err: any) {
      console.error('[Signin Route Error]', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Refresh Token Endpoint
  app.post('/v1/auth/refresh', async (req, res) => {
    try {
      const headers = req.headers as Record<string, string>;
      const response = await gateway.handleRequest('POST', '/v1/auth/refresh', headers, req.body);
      res.status(response.status).json(response.body);
    } catch (err: any) {
      console.error('[Refresh Route Error]', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Logout Endpoint
  app.post('/v1/auth/logout', async (req, res) => {
    try {
      const headers = req.headers as Record<string, string>;
      const response = await gateway.handleRequest('POST', '/v1/auth/logout', headers, req.body);
      res.status(response.status).json(response.body);
    } catch (err: any) {
      console.error('[Logout Route Error]', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // Account Status Endpoint
  app.get('/v1/account/status', async (req, res) => {
    try {
      const headers = req.headers as Record<string, string>;
      const response = await gateway.handleRequest('POST', '/v1/account/status', headers, req.body);
      res.status(response.status).json(response.body);
    } catch (err: any) {
      console.error('[Account Status Route Error]', err);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // AI Generate Endpoint
  app.post('/v1/ai/generate', apiRateLimiter, async (req, res) => {
    const requestId = Math.random().toString(36).slice(2, 10);
    console.log(`\n[BACKEND_RECEIVED] [${requestId}] POST /v1/ai/generate`);
    console.log(`[BACKEND_RECEIVED] [${requestId}] Authorization: Bearer ***  Session: ${req.headers['session'] ?? '(none)'}`);
    console.log(`[BACKEND_RECEIVED] [${requestId}] Tier: ${req.body?.capabilityTier ?? 'unset'}  Messages: ${req.body?.messages?.length ?? 0}`);
    try {
      const headers = req.headers as Record<string, string>;
      headers['x-request-id'] = requestId;
      console.log(`[BACKEND_PROCESSING] [${requestId}] Dispatching to BackendAIGateway...`);
      const response = await gateway.handleRequest('POST', '/v1/ai/generate', headers, req.body);
      console.log(`[BACKEND_RESPONDING] [${requestId}] Status: ${response.status}  HasToolCalls: ${!!response.body?.toolCalls?.length}`);
      res.status(response.status).json(response.body);
    } catch (error: any) {
      console.error('[Generate Error]', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  // AI Stream Endpoint
  app.post('/v1/ai/stream', apiRateLimiter, async (req, res) => {
    const requestId = Math.random().toString(36).slice(2, 10);
    console.log(`\n[BACKEND_RECEIVED] [${requestId}] POST /v1/ai/stream`);
    console.log(`[BACKEND_RECEIVED] [${requestId}] Authorization: Bearer ***  Session: ${req.headers['session'] ?? '(none)'}`);
    try {
      const headers = req.headers as Record<string, string>;
      headers['x-request-id'] = requestId;
      console.log(`[BACKEND_PROCESSING] [${requestId}] Dispatching to BackendAIGateway (stream)...`);
      const response = await gateway.handleRequest('POST', '/v1/ai/stream', headers, req.body);
      
      res.status(response.status);
      if (response.headers) {
        for (const [key, value] of Object.entries(response.headers)) {
          res.setHeader(key, value as string);
        }
      }
      
      // For streams, handleRequest returns an AsyncIterable in the body if status is 200
      if (response.status === 200 && response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
        const stream = response.body as AsyncIterable<any>;
        let chunkIndex = 0;
        for await (const chunk of stream) {
          if (chunkIndex === 0) {
            console.log(`[BACKEND_STREAMING] [${requestId}] First SSE chunk emitted: ${JSON.stringify(chunk).slice(0, 120)}`);
          }
          chunkIndex++;
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
        console.log(`[BACKEND_STREAMING] [${requestId}] Stream complete. Total chunks: ${chunkIndex}`);
        res.end();
      } else {
        res.json(response.body);
      }
    } catch (error: any) {
      console.error('[Stream Error]', error);
      res.status(500).json({ error: 'Internal Server Error' });
    }
  });

  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

bootstrap().catch(console.error);
