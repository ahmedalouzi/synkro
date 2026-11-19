import crypto from 'crypto';
import { promisify } from 'util';
import { db } from './db';
import { randomUUID } from 'node:crypto';
import { creditLedgerService } from './credit-ledger';

const scryptAsync = promisify(crypto.scrypt);
const randomBytesAsync = promisify(crypto.randomBytes);

export interface UserSession {
  userId: string;
  email: string;
  sessionToken: string;
  refreshToken: string; // only returned on login/refresh
  expiresAt: number; // ms
  emailVerified?: boolean;
  verificationRequired?: boolean;
}

export interface UserAccount {
  id: string;
  email: string;
  passwordHash: string; // format: 'scrypt:salt:hash'
  emailVerified?: boolean;
}

export const OTP_TTL_MS = 15 * 60 * 1000; // 15 mins
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000; // 60 seconds

export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com',
  '10minutemail.net',
  '10minutemail.org',
  '20minutemail.com',
  'anonaddy.com',
  'burnermail.io',
  'crazymailing.com',
  'deadfake.com',
  'discard.email',
  'disposable.com',
  'disposablemail.com',
  'dispostable.com',
  'dropmail.me',
  'emailondeck.com',
  'fakeinbox.com',
  'fakemailgenerator.com',
  'generator.email',
  'getairmail.com',
  'getnada.com',
  'grr.la',
  'guerrillamail.biz',
  'guerrillamail.com',
  'guerrillamail.de',
  'guerrillamail.info',
  'guerrillamail.net',
  'guerrillamail.org',
  'guerrillamailblock.com',
  'harakirimail.com',
  'inboxkitten.com',
  'incognitomail.org',
  'jetable.org',
  'kasmail.com',
  'mailcatch.com',
  'maildrop.cc',
  'mailforspam.com',
  'mailinator.com',
  'mailinator.net',
  'mailinator2.com',
  'mailnesia.com',
  'mailnull.com',
  'meltmail.com',
  'mohmal.com',
  'mohmal.im',
  'mohmal.in',
  'mytrashmail.com',
  'mytemp.email',
  'mytempemail.com',
  'nada.ch',
  'nada.email',
  'nada.ltd',
  'nomail.xl.cx',
  'oneoffmail.com',
  'owlymail.com',
  'pokemail.net',
  'safetymail.info',
  'sharklasers.com',
  'spam4.me',
  'spambog.com',
  'spambox.us',
  'spamex.com',
  'spamevader.com',
  'spamfree24.org',
  'spamgourmet.com',
  'spamspot.com',
  'temp-email.com',
  'temp-mail.org',
  'tempail.com',
  'tempinbox.com',
  'tempmail.com',
  'tempmail.net',
  'tempmailaddress.com',
  'throwawaymail.com',
  'trashmail.com',
  'trashmail.net',
  'trashmail.org',
  'trashymail.com',
  'yopmail.com',
  'yopmail.fr',
  'yopmail.net',
  'zetmail.com'
]);

export function isDisposableEmail(email: string): boolean {
  if (!email || !email.includes('@')) return false;
  const parts = email.trim().toLowerCase().split('@');
  if (parts.length !== 2) return false;
  const domain = parts[1].trim();
  if (!domain) return false;

  const extra = process.env.SYNKRO_EXTRA_DISPOSABLE_DOMAINS
    ? process.env.SYNKRO_EXTRA_DISPOSABLE_DOMAINS.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
    : [];
  const extraSet = new Set(extra);

  if (DISPOSABLE_EMAIL_DOMAINS.has(domain) || extraSet.has(domain)) {
    return true;
  }

  // Check subdomains (e.g. *.mailinator.com)
  for (const blocked of DISPOSABLE_EMAIL_DOMAINS) {
    if (domain.endsWith('.' + blocked)) {
      return true;
    }
  }
  for (const blocked of extraSet) {
    if (domain.endsWith('.' + blocked)) {
      return true;
    }
  }

  return false;
}

import type { IAuthProvider } from './auth-provider';

export class AuthService implements IAuthProvider {
  private readonly WINDOW_MS = 15 * 60 * 1000; // 15 mins
  private readonly MAX_ATTEMPTS = 10;
  emailSender?: (email: string, otp: string) => Promise<void>;

  constructor() {}

  // --- Password Hashing ---
  private async hashPassword(password: string): Promise<string> {
    const salt = (await randomBytesAsync(16)).toString('hex');
    const hash = (await scryptAsync(password, salt, 64)) as Buffer;
    return `scrypt:${salt}:${hash.toString('hex')}`;
  }

  private async verifyPassword(password: string, storedHash: string): Promise<boolean> {
    const parts = storedHash.split(':');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = parts[1];
    const key = parts[2];
    const hash = (await scryptAsync(password, salt, 64)) as Buffer;
    return crypto.timingSafeEqual(Buffer.from(key, 'hex'), hash);
  }

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private validatePasswordRules(password: string): boolean {
    return password.length >= 8;
  }

  // --- Rate Limiter ---
  private async checkRateLimit(key: string): Promise<boolean> {
    if (process.env.NODE_ENV === 'test') {
      return true;
    }
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.WINDOW_MS);
    
    // Cleanup old records optionally, but we just check window here
    const res = await db.query(
      `SELECT attempts, window_start FROM rate_limits WHERE ip_or_email = $1`,
      [key]
    );

    if (res.rows.length === 0) {
      await db.query(
        `INSERT INTO rate_limits (ip_or_email, attempts, window_start) VALUES ($1, 1, $2)`,
        [key, now]
      );
      return true;
    }

    const record = res.rows[0];
    if (record.window_start < windowStart) {
      await db.query(
        `UPDATE rate_limits SET attempts = 1, window_start = $1 WHERE ip_or_email = $2`,
        [now, key]
      );
      return true;
    }

    if (record.attempts >= this.MAX_ATTEMPTS) {
      return false;
    }

    await db.query(
      `UPDATE rate_limits SET attempts = attempts + 1 WHERE ip_or_email = $1`,
      [key]
    );
    return true;
  }

  // --- Endpoints ---
  async signup(email: string, password: string): Promise<UserSession> {
    if (!(await this.checkRateLimit(`signup:${email}`))) {
      throw new Error('Too many attempts. Please try again later.');
    }

    if (!email || !email.includes('@')) {
      throw new Error('Invalid email address');
    }
    if (isDisposableEmail(email)) {
      throw new Error('Disposable email addresses are not allowed. Please use a permanent email address.');
    }
    if (!this.validatePasswordRules(password)) {
      throw new Error('Password must be at least 8 characters long');
    }

    const client = await db.connect();
    let userId: string;
    let session: UserSession;
    try {
      await client.query('BEGIN');
      
      const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length > 0) {
        throw new Error('Email already registered');
      }

      const hash = await this.hashPassword(password);
      userId = randomUUID();
      
      await client.query(
        'INSERT INTO users (id, email, password_hash, email_verified) VALUES ($1, $2, $3, FALSE)',
        [userId, email, hash]
      );

      session = await this.createSessionInternal(client, userId, email);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    // Send verification code AFTER commit so user row is visible to code insert
    await this.sendVerificationCode(userId, email, { enforceCooldown: false });

    return {
      ...session,
      emailVerified: false,
      verificationRequired: true
    };
  }

  /** True when `password` is this user's account password. */
  async verifyUserPassword(userId: string, password: string): Promise<boolean> {
    if (typeof password !== 'string' || password.length === 0) return false;
    const res = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
    if (res.rows.length === 0) return false;
    return this.verifyPassword(password, res.rows[0].password_hash);
  }

  async login(email: string, password: string): Promise<UserSession> {
    if (!(await this.checkRateLimit(`login:${email}`))) {
      throw new Error('Too many attempts. Please try again later.');
    }

    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const userRes = await client.query('SELECT id, email, password_hash, email_verified FROM users WHERE email = $1', [email]);
      
      if (userRes.rows.length === 0) {
        throw new Error('Invalid email or password');
      }

      const user = userRes.rows[0];
      const isValid = await this.verifyPassword(password, user.password_hash);
      if (!isValid) {
        throw new Error('Invalid email or password');
      }

      const session = await this.createSessionInternal(client, user.id, user.email);
      await client.query('COMMIT');
      const emailVerified = !!user.email_verified;
      return {
        ...session,
        emailVerified,
        verificationRequired: !emailVerified
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Creates a session for an authenticated OAuth user using the identical session token
   * entropy, refresh token hashing, and expiration rules as email/password login.
   */
  async createOAuthSession(userId: string, email: string, client?: any): Promise<UserSession> {
    const runner = client || db;
    const session = await this.createSessionInternal(runner, userId, email);
    return {
      ...session,
      emailVerified: true,
      verificationRequired: false,
    };
  }

  private async createSessionInternal(client: any, userId: string, email: string): Promise<UserSession> {
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const refreshToken = crypto.randomBytes(32).toString('hex');
    const hashedRefresh = this.hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    await client.query(
      `INSERT INTO sessions (session_token, refresh_token, user_id, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sessionToken, hashedRefresh, userId, expiresAt]
    );

    return {
      userId,
      email,
      sessionToken,
      refreshToken,
      expiresAt: expiresAt.getTime()
    };
  }

  async validateSession(sessionToken: string, requestId?: string): Promise<{ userId: string; email: string; plan: string; emailVerified: boolean }> {
    const reqId = requestId || 'UNKNOWN';
    console.log(`[REQ ${reqId}] AuthService.validateSession entered`);
    const res = await db.query(
      `SELECT s.user_id, u.email, u.plan, u.email_verified, s.expires_at 
       FROM sessions s 
       JOIN users u ON s.user_id = u.id 
       WHERE s.session_token = $1`,
      [sessionToken]
    );

    if (res.rows.length === 0) {
      throw new Error('Invalid session token');
    }

    const session = res.rows[0];
    if (new Date(session.expires_at) < new Date()) {
      await db.query('DELETE FROM sessions WHERE session_token = $1', [sessionToken]);
      throw new Error('Session expired');
    }

    return {
      userId: session.user_id,
      email: session.email,
      plan: session.plan || 'free',
      emailVerified: !!session.email_verified
    };
  }

  async refresh(refreshToken: string): Promise<UserSession> {
    const hashedRefresh = this.hashToken(refreshToken);
    
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      
      // Check if this token was already rotated/reused
      const rotatedRes = await client.query(
        'SELECT user_id FROM rotated_refresh_tokens WHERE refresh_token = $1 FOR UPDATE',
        [hashedRefresh]
      );
      
      if (rotatedRes.rows.length > 0) {
        const userId = rotatedRes.rows[0].user_id;
        // Invalidate entire family: delete all active sessions & rotated tokens for this user!
        await client.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
        await client.query('DELETE FROM rotated_refresh_tokens WHERE user_id = $1', [userId]);
        await client.query('COMMIT');
        throw new Error('Invalid refresh token (reuse detected)');
      }
      
      const res = await client.query(
        `SELECT s.session_token, s.user_id, u.email, u.email_verified 
         FROM sessions s 
         JOIN users u ON s.user_id = u.id 
         WHERE s.refresh_token = $1 FOR UPDATE`,
        [hashedRefresh]
      );

      if (res.rows.length === 0) {
        throw new Error('Invalid refresh token');
      }

      const oldSession = res.rows[0];
      
      // Store old token in rotated list
      await client.query(
        'INSERT INTO rotated_refresh_tokens (refresh_token, user_id) VALUES ($1, $2) ON CONFLICT (refresh_token) DO NOTHING',
        [hashedRefresh, oldSession.user_id]
      );
      
      await client.query('DELETE FROM sessions WHERE session_token = $1', [oldSession.session_token]);

      const session = await this.createSessionInternal(client, oldSession.user_id, oldSession.email);
      await client.query('COMMIT');
      const emailVerified = !!oldSession.email_verified;
      return {
        ...session,
        emailVerified,
        verificationRequired: !emailVerified
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async logout(sessionToken: string, refreshToken?: string): Promise<void> {
    if (refreshToken) {
      const hashedRefresh = this.hashToken(refreshToken);
      await db.query('DELETE FROM sessions WHERE refresh_token = $1', [hashedRefresh]);
    } else {
      await db.query('DELETE FROM sessions WHERE session_token = $1', [sessionToken]);
    }
  }

  // --- Email OTP Verification ---
  async sendVerificationCode(
    userIdOrEmail: string,
    emailOrOptions?: string | { enforceCooldown?: boolean },
    optionsArg?: { enforceCooldown?: boolean }
  ): Promise<{ success: boolean; code?: string }> {
    let email: string | undefined;
    let options: { enforceCooldown?: boolean } | undefined;

    if (typeof emailOrOptions === 'string') {
      email = emailOrOptions;
      options = optionsArg;
    } else if (typeof emailOrOptions === 'object') {
      options = emailOrOptions;
    }

    let userId: string;
    if (userIdOrEmail.includes('@')) {
      email = userIdOrEmail.toLowerCase().trim();
      const res = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (res.rows.length === 0) {
        throw new Error('User not found');
      }
      userId = res.rows[0].id;
    } else {
      userId = userIdOrEmail;
      if (!email) {
        const res = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
        if (res.rows.length === 0) {
          throw new Error('User not found');
        }
        email = res.rows[0].email;
      }
    }

    if (!email) {
      throw new Error('User email not found');
    }

    const shouldEnforceCooldown = options?.enforceCooldown === true ||
      (process.env.NODE_ENV !== 'test' && options?.enforceCooldown !== false);

    if (shouldEnforceCooldown) {
      const recentCode = await db.query(
        `SELECT created_at FROM email_verification_codes
         WHERE user_id = $1 AND created_at > NOW() - INTERVAL '60 seconds'
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
      if (recentCode.rows.length > 0) {
        throw new Error('Please wait 60 seconds before requesting a new verification code.');
      }
    }

    // Invalidate prior unused codes
    await db.query(
      `UPDATE email_verification_codes SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );

    const otp = crypto.randomInt(100000, 1000000).toString();
    const codeHash = crypto.createHash('sha256').update(otp).digest('hex');
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);

    await db.query(
      `INSERT INTO email_verification_codes (user_id, email, code_hash, attempts, max_attempts, expires_at)
       VALUES ($1, $2, $3, 0, $4, $5)`,
      [userId, email, codeHash, OTP_MAX_ATTEMPTS, expiresAt]
    );

    await this.dispatchVerificationEmail(email, otp);

    return { success: true, ...(process.env.NODE_ENV === 'test' ? { code: otp } : {}) };
  }

  private async dispatchVerificationEmail(email: string, otp: string): Promise<void> {
    if (this.emailSender) {
      await this.emailSender(email, otp);
      return;
    }

    if (process.env.RESEND_API_KEY) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM_EMAIL || 'Atomvs <auth@atomvs.dev>',
            to: [email],
            subject: `Your Atomvs verification code: ${otp}`,
            text: `Your Atomvs verification code is: ${otp}\n\nThis code expires in 15 minutes. If you did not request this code, you can safely ignore this email.`,
            html: `<p>Your Atomvs verification code is: <strong>${otp}</strong></p><p>This code expires in 15 minutes. If you did not request this code, you can safely ignore this email.</p>`
          })
        });
        if (!res.ok) {
          const errText = await res.text();
          console.error('[EmailVerification] Resend API error:', errText);
        }
      } catch (err: any) {
        console.error('[EmailVerification] Failed to dispatch via Resend:', err.message);
      }
      return;
    }

    console.log(`[EmailVerification] OTP for ${email}: ${otp}`);
  }

  async verifyEmailOtp(userIdOrEmail: string, code: string, deviceId?: string): Promise<{ success: boolean; emailVerified: boolean }> {
    if (!code || typeof code !== 'string') {
      throw new Error('Verification code is required');
    }
    const cleanCode = code.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      throw new Error('Invalid verification code format. Must be a 6-digit number.');
    }

    let userId: string;
    if (userIdOrEmail.includes('@')) {
      const uRes = await db.query('SELECT id FROM users WHERE email = $1', [userIdOrEmail.toLowerCase().trim()]);
      if (uRes.rows.length === 0) {
        throw new Error('User not found');
      }
      userId = uRes.rows[0].id;
    } else {
      userId = userIdOrEmail;
    }

    const client = await db.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const res = await client.query(
        `SELECT id, code_hash, attempts, max_attempts, expires_at 
         FROM email_verification_codes 
         WHERE user_id = $1 AND used_at IS NULL 
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [userId]
      );

      if (res.rows.length === 0) {
        throw new Error('No pending verification code found. Please request a new code.');
      }

      const record = res.rows[0];

      if (record.attempts >= record.max_attempts) {
        throw new Error('Too many failed attempts. This verification code has been locked. Please request a new code.');
      }

      if (new Date(record.expires_at) <= new Date()) {
        throw new Error('Verification code has expired. Please request a new code.');
      }

      const inputHash = crypto.createHash('sha256').update(cleanCode).digest('hex');
      const hashBuf = Buffer.from(inputHash, 'hex');
      const targetBuf = Buffer.from(record.code_hash, 'hex');
      const matches = hashBuf.length === targetBuf.length && crypto.timingSafeEqual(hashBuf, targetBuf);

      if (!matches) {
        const newAttempts = record.attempts + 1;
        await client.query(
          'UPDATE email_verification_codes SET attempts = $1 WHERE id = $2',
          [newAttempts, record.id]
        );
        await client.query('COMMIT');
        committed = true;

        const remaining = record.max_attempts - newAttempts;
        if (remaining <= 0) {
          throw new Error('Too many failed attempts. This verification code has been locked. Please request a new code.');
        }
        throw new Error(`Invalid verification code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
      }

      // Valid match! Mark code as used and update user
      await client.query(
        'UPDATE email_verification_codes SET used_at = NOW(), attempts = attempts + 1 WHERE id = $1',
        [record.id]
      );
      await client.query(
        'UPDATE users SET email_verified = TRUE WHERE id = $1',
        [userId]
      );
      await client.query('COMMIT');
      committed = true;

      // Grant welcome credits (250) and initial monthly plan credits
      await creditLedgerService.grantWelcomeCredits(userId, userIdOrEmail.includes('@') ? userIdOrEmail : '', deviceId).catch(() => {});
      await creditLedgerService.ensureMonthlyPlanGrant(userId, 'free').catch(() => {});

      return { success: true, emailVerified: true };
    } catch (err) {
      if (!committed) {
        try {
          await client.query('ROLLBACK');
        } catch {}
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
