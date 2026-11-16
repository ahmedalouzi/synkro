import { Router, type Request, type Response } from 'express';
import crypto, { randomUUID } from 'node:crypto';
import { db, AuthService } from '@peep/agent/server';

export const oauthRouter: Router = Router();
const authService = new AuthService();

export type SupportedOAuthProvider = 'google' | 'github';

interface ProviderConfig {
  clientId?: string;
  clientSecret?: string;
  authUrl: string;
  tokenUrl: string;
}

export function validateLoopbackUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:') return false;
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return false;
    const port = parseInt(u.port, 10);
    if (isNaN(port) || port < 1024 || port > 65535) return false;
    if (u.pathname !== '/callback') return false;
    return true;
  } catch {
    return false;
  }
}

function getProviderConfig(provider: SupportedOAuthProvider): ProviderConfig {
  if (provider === 'google') {
    return {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
    };
  }
  return {
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
    authUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
  };
}

function getCallbackUrl(provider: SupportedOAuthProvider): string {
  const base = process.env.OAUTH_CALLBACK_BASE_URL ||
    process.env.PUBLIC_BASE_URL ||
    `http://localhost:${process.env.PORT || 8080}`;
  return `${base.replace(/\/+$/, '')}/v1/auth/oauth/${provider}/callback`;
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { codeVerifier, codeChallenge };
}

/**
 * GET /v1/auth/oauth/:provider/start
 * Generates random state + PKCE, validates client return URL, and redirects to provider.
 */
oauthRouter.get('/:provider/start', async (req: Request, res: Response) => {
  const provider = req.params.provider?.toLowerCase() as SupportedOAuthProvider;
  if (provider !== 'google' && provider !== 'github') {
    res.status(404).json({ code: 'UNKNOWN_PROVIDER', error: `Unknown OAuth provider: '${req.params.provider}'` });
    return;
  }

  const config = getProviderConfig(provider);
  if (!config.clientId || !config.clientSecret) {
    const providerName = provider === 'google' ? 'Google' : 'GitHub';
    res.status(503).json({
      code: 'OAUTH_NOT_CONFIGURED',
      error: `${providerName} sign-in is not configured on this server.`,
    });
    return;
  }

  const returnTo = (req.query.client_return_url || req.query.return_to) as string;
  if (!returnTo || !validateLoopbackUrl(returnTo)) {
    res.status(400).json({
      code: 'INVALID_RETURN_URL',
      error: 'Invalid client return URL. Must be a loopback HTTP address (e.g. http://127.0.0.1:port/callback).',
    });
    return;
  }

  const state = crypto.randomBytes(32).toString('hex');
  const { codeVerifier, codeChallenge } = generatePkce();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  try {
    await db.query(
      `INSERT INTO oauth_states (state, provider, code_verifier, client_return_url, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [state, provider, codeVerifier, returnTo, expiresAt]
    );

    const redirectUri = getCallbackUrl(provider);

    let authUrl: string;
    if (provider === 'google') {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
      });
      authUrl = `${config.authUrl}?${params.toString()}`;
    } else {
      const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        scope: 'read:user user:email',
        state,
      });
      authUrl = `${config.authUrl}?${params.toString()}`;
    }

    res.redirect(authUrl);
  } catch (err: any) {
    console.error('[OAuth Start Error]', err.message);
    res.status(500).json({ error: 'Failed to initiate OAuth flow.' });
  }
});

/**
 * GET /v1/auth/oauth/:provider/callback
 * Validates state, exchanges code with provider, verifies email, resolves/creates user,
 * creates session, issues one-time exchange code, and redirects to client loopback.
 */
oauthRouter.get('/:provider/callback', async (req: Request, res: Response) => {
  const provider = req.params.provider?.toLowerCase() as SupportedOAuthProvider;
  if (provider !== 'google' && provider !== 'github') {
    res.status(404).json({ error: `Unknown OAuth provider: '${req.params.provider}'` });
    return;
  }

  const { code, state, error: providerError, error_description } = req.query as Record<string, string>;

  // Handle provider-level error / cancellation
  if (providerError) {
    if (state) {
      const stateRow = await db.query(
        'DELETE FROM oauth_states WHERE state = $1 RETURNING client_return_url',
        [state]
      );
      if (stateRow.rows.length > 0) {
        const returnUrl = stateRow.rows[0].client_return_url;
        const redirectWithError = new URL(returnUrl);
        redirectWithError.searchParams.set('error', error_description || providerError);
        res.redirect(redirectWithError.toString());
        return;
      }
    }
    res.status(400).json({ error: error_description || providerError });
    return;
  }

  if (!state || typeof state !== 'string') {
    res.status(400).json({ code: 'INVALID_STATE', error: 'Missing OAuth state parameter.' });
    return;
  }

  // Atomically validate and consume state to ensure single use
  const stateResult = await db.query(
    `DELETE FROM oauth_states 
     WHERE state = $1 AND provider = $2 AND expires_at > NOW() 
     RETURNING code_verifier, client_return_url`,
    [state, provider]
  );

  if (stateResult.rows.length === 0) {
    res.status(400).json({ code: 'INVALID_STATE', error: 'Invalid, expired, or already-used OAuth state.' });
    return;
  }

  const { code_verifier, client_return_url } = stateResult.rows[0];

  const redirectFailure = (message: string) => {
    try {
      const u = new URL(client_return_url);
      u.searchParams.set('error', message);
      res.redirect(u.toString());
    } catch {
      res.status(400).json({ error: message });
    }
  };

  if (!code || typeof code !== 'string') {
    redirectFailure('Missing authorization code from provider.');
    return;
  }

  const config = getProviderConfig(provider);
  if (!config.clientId || !config.clientSecret) {
    redirectFailure('OAuth provider credentials are not configured on server.');
    return;
  }

  const redirectUri = getCallbackUrl(provider);

  try {
    // 1. Exchange authorization code with provider
    let accessToken: string;
    if (provider === 'google') {
      const tokenRes = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          code_verifier,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error('[Google Token Exchange Failed]', tokenRes.status, errBody);
        redirectFailure('Failed to exchange authorization code with Google.');
        return;
      }

      const tokenData = await tokenRes.json();
      accessToken = tokenData.access_token;
    } else {
      // GitHub
      const tokenRes = await fetch(config.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: redirectUri,
        }),
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error('[GitHub Token Exchange Failed]', tokenRes.status, errBody);
        redirectFailure('Failed to exchange authorization code with GitHub.');
        return;
      }

      const tokenData = await tokenRes.json();
      if (tokenData.error) {
        console.error('[GitHub Token Response Error]', tokenData.error_description || tokenData.error);
        redirectFailure(tokenData.error_description || 'GitHub authorization failed.');
        return;
      }
      accessToken = tokenData.access_token;
    }

    if (!accessToken) {
      redirectFailure('Provider returned no access token.');
      return;
    }

    // 2. Fetch user profile and verify email
    let providerUserId: string;
    let verifiedEmail: string;

    if (provider === 'google') {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!userRes.ok) {
        redirectFailure('Failed to fetch user profile from Google.');
        return;
      }
      const profile = await userRes.json();
      if (!profile.sub || !profile.email) {
        redirectFailure('Incomplete profile received from Google.');
        return;
      }
      if (profile.email_verified !== true) {
        redirectFailure('Google account email is not verified.');
        return;
      }
      providerUserId = String(profile.sub);
      verifiedEmail = profile.email.toLowerCase().trim();
    } else {
      // GitHub
      const userRes = await fetch('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'Atomvs-Desktop-App',
        },
      });
      if (!userRes.ok) {
        redirectFailure('Failed to fetch user profile from GitHub.');
        return;
      }
      const profile = await userRes.json();
      if (!profile.id) {
        redirectFailure('Incomplete profile received from GitHub.');
        return;
      }
      providerUserId = String(profile.id);

      // Fetch emails to get primary verified email
      const emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'Atomvs-Desktop-App',
        },
      });
      if (!emailsRes.ok) {
        redirectFailure('Failed to fetch user emails from GitHub.');
        return;
      }
      const emailsList = await emailsRes.json();
      if (!Array.isArray(emailsList)) {
        redirectFailure('Invalid email format received from GitHub.');
        return;
      }

      const primaryVerified = emailsList.find((e: any) => e.primary && e.verified);
      const anyVerified = emailsList.find((e: any) => e.verified);
      const matched = primaryVerified || anyVerified;

      if (!matched || !matched.email) {
        redirectFailure('GitHub account has no verified email address.');
        return;
      }
      verifiedEmail = matched.email.toLowerCase().trim();
    }

    // 3. Account resolution transaction:
    // (a) identity exists -> log in
    // (b) user with verified email exists -> link identity and log in
    // (c) new user -> create user (locked password hash) + link identity and log in
    const client = await db.connect();
    let userId: string;
    let session: any;

    try {
      await client.query('BEGIN');

      // (a) Check existing OAuth identity
      const identityRes = await client.query(
        'SELECT user_id FROM oauth_identities WHERE provider = $1 AND provider_user_id = $2 FOR UPDATE',
        [provider, providerUserId]
      );

      if (identityRes.rows.length > 0) {
        userId = identityRes.rows[0].user_id;
      } else {
        // (b) Check existing user by verified email
        const userRes = await client.query(
          'SELECT id FROM users WHERE email = $1 FOR UPDATE',
          [verifiedEmail]
        );

        if (userRes.rows.length > 0) {
          userId = userRes.rows[0].id;
        } else {
          // (c) Create new user (locked unmatchable password hash satisfies NOT NULL constraint)
          userId = randomUUID();
          const lockedPasswordHash = `oauth:locked:${randomUUID()}`;
          await client.query(
            'INSERT INTO users (id, email, password_hash, plan) VALUES ($1, $2, $3, $4)',
            [userId, verifiedEmail, lockedPasswordHash, 'free']
          );
        }

        // Link identity
        await client.query(
          `INSERT INTO oauth_identities (id, user_id, provider, provider_user_id, email)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (provider, provider_user_id) DO NOTHING`,
          [randomUUID(), userId, provider, providerUserId, verifiedEmail]
        );
      }

      // Create session using AuthService
      session = await authService.createOAuthSession(userId, verifiedEmail, client);

      // Generate single-use exchange code (60-second TTL)
      const exchangeCode = crypto.randomBytes(32).toString('hex');
      const exchangeExpires = new Date(Date.now() + 60 * 1000);

      await client.query(
        `INSERT INTO oauth_exchange_codes (code, user_id, session_token, refresh_token, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [exchangeCode, userId, session.sessionToken, session.refreshToken, exchangeExpires]
      );

      await client.query('COMMIT');

      // Redirect browser to desktop app's loopback URL with the one-time exchange code
      const successUrl = new URL(client_return_url);
      successUrl.searchParams.set('code', exchangeCode);
      res.redirect(successUrl.toString());
    } catch (dbErr: any) {
      await client.query('ROLLBACK');
      console.error('[OAuth Account Resolution DB Error]', dbErr.message);
      redirectFailure('Database error during account resolution.');
    } finally {
      client.release();
    }
  } catch (err: any) {
    console.error('[OAuth Callback Error]', err.message);
    redirectFailure('Failed to complete OAuth authentication.');
  }
});

/**
 * POST /v1/auth/oauth/exchange
 * Atomically exchanges a short-lived one-time code for the session tokens.
 */
oauthRouter.post('/exchange', async (req: Request, res: Response) => {
  const { code } = req.body || {};
  if (!code || typeof code !== 'string') {
    res.status(400).json({ code: 'INVALID_REQUEST', error: 'Missing or invalid exchange code.' });
    return;
  }

  try {
    const result = await db.query(
      `DELETE FROM oauth_exchange_codes 
       WHERE code = $1 AND expires_at > NOW() 
       RETURNING user_id, session_token, refresh_token, expires_at`,
      [code]
    );

    if (result.rows.length === 0) {
      res.status(401).json({
        code: 'INVALID_CODE',
        error: 'Invalid, expired, or already-used exchange code.',
      });
      return;
    }

    const { user_id, session_token, refresh_token, expires_at } = result.rows[0];
    const userRes = await db.query('SELECT email FROM users WHERE id = $1', [user_id]);
    const email = userRes.rows[0]?.email || '';

    res.status(200).json({
      userId: user_id,
      email,
      sessionToken: session_token,
      refreshToken: refresh_token,
      expiresAt: new Date(expires_at).getTime(),
    });
  } catch (err: any) {
    console.error('[OAuth Exchange Error]', err.message);
    res.status(500).json({ code: 'SERVER_ERROR', error: 'Failed to exchange OAuth code.' });
  }
});

