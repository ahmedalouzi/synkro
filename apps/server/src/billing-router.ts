import express, { Router } from 'express';
import * as crypto from 'node:crypto';
import { db } from '@peep/agent/server';

let customDbPool: any = null;
export function setBillingDbPool(pool: any) {
  customDbPool = pool;
}

export const billingRouter: Router = express.Router();

export function verifyLemonSqueezySignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const digestBuf = Buffer.from(hmac, 'utf8');
  const sigBuf = Buffer.from(signatureHeader.trim(), 'utf8');
  if (digestBuf.length !== sigBuf.length) return false;
  return crypto.timingSafeEqual(digestBuf, sigBuf);
}

export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const parts = signatureHeader.split(',').reduce<Record<string, string>>((acc, item) => {
    const [k, v] = item.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const timestamp = parts['t'];
  const v1 = parts['v1'];
  if (!timestamp || !v1) return false;

  const signedPayload = `${timestamp}.${rawBody.toString('utf8')}`;
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest('hex');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(v1, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, actualBuf);
}

interface NormalizedBillingEvent {
  provider: 'lemonsqueezy' | 'stripe';
  eventId: string;
  eventType: string;
  email?: string;
  userId?: string;
  customerId?: string;
  subscriptionId?: string;
  status: string;
  targetPlan: 'pro' | 'free';
}

export function normalizeWebhookPayload(provider: 'lemonsqueezy' | 'stripe', payload: any): NormalizedBillingEvent | null {
  if (!payload || typeof payload !== 'object') return null;

  if (provider === 'lemonsqueezy') {
    const eventName: string = payload.meta?.event_name || '';
    const data = payload.data || {};
    const attrs = data.attributes || {};
    const customData = payload.meta?.custom_data || {};

    if (!eventName) return null;

    const status: string = String(attrs.status || '').toLowerCase();
    const isUpgrade =
      (eventName === 'subscription_created' ||
        eventName === 'subscription_updated' ||
        eventName === 'subscription_resumed' ||
        eventName === 'subscription_payment_success') &&
      (status === 'active' || status === 'on_trial' || status === 'trialing' || status === 'paid' || status === '');

    const isDowngrade =
      eventName === 'subscription_expired' ||
      eventName === 'subscription_cancelled' ||
      eventName === 'subscription_payment_failed' ||
      status === 'expired' ||
      status === 'unpaid' ||
      status === 'cancelled';

    if (!isUpgrade && !isDowngrade) return null;

    const eventId =
      String(payload.meta?.webhook_id || '') ||
      `ls_${eventName}_${data.id || 'unknown'}_${attrs.updated_at || Date.now()}`;

    return {
      provider: 'lemonsqueezy',
      eventId,
      eventType: eventName,
      email: attrs.user_email ? String(attrs.user_email).toLowerCase().trim() : undefined,
      userId: customData.user_id ? String(customData.user_id).trim() : undefined,
      customerId: attrs.customer_id !== undefined ? String(attrs.customer_id) : undefined,
      subscriptionId: data.id !== undefined ? String(data.id) : undefined,
      status: status || (isUpgrade ? 'active' : 'expired'),
      targetPlan: isUpgrade && !isDowngrade ? 'pro' : 'free',
    };
  }

  // Stripe
  const eventType: string = payload.type || '';
  const eventId: string = payload.id || '';
  const obj = payload.data?.object || {};
  if (!eventType || !eventId) return null;

  const status: string = String(obj.status || '').toLowerCase();
  const isUpgrade =
    eventType === 'checkout.session.completed' ||
    ((eventType === 'customer.subscription.created' ||
      eventType === 'customer.subscription.updated' ||
      eventType === 'invoice.paid') &&
      (status === 'active' || status === 'trialing' || status === 'paid' || status === 'complete'));

  const isDowngrade =
    eventType === 'customer.subscription.deleted' ||
    eventType === 'invoice.payment_failed' ||
    status === 'canceled' ||
    status === 'unpaid' ||
    status === 'incomplete_expired';

  if (!isUpgrade && !isDowngrade) return null;

  const email =
    obj.customer_email ||
    obj.customer_details?.email ||
    obj.receipt_email;

  return {
    provider: 'stripe',
    eventId,
    eventType,
    email: email ? String(email).toLowerCase().trim() : undefined,
    userId: obj.metadata?.user_id || obj.client_reference_id || undefined,
    customerId: obj.customer ? String(obj.customer) : undefined,
    subscriptionId: obj.subscription ? String(obj.subscription) : (obj.id ? String(obj.id) : undefined),
    status: status || (isUpgrade ? 'active' : 'canceled'),
    targetPlan: isUpgrade && !isDowngrade ? 'pro' : 'free',
  };
}

billingRouter.post('/webhook', async (req, res) => {
  try {
    const lsSignature = req.headers['x-signature'] as string | undefined;
    const stripeSignature = req.headers['stripe-signature'] as string | undefined;

    const lsSecret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || '';
    const stripeSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

    const rawBody: Buffer =
      (req as any).rawBody instanceof Buffer
        ? (req as any).rawBody
        : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {}), 'utf8');

    let provider: 'lemonsqueezy' | 'stripe' | null = null;

    if (lsSignature) {
      if (!verifyLemonSqueezySignature(rawBody, lsSignature, lsSecret)) {
        res.status(401).json({ error: 'Invalid Lemon Squeezy webhook signature' });
        return;
      }
      provider = 'lemonsqueezy';
    } else if (stripeSignature) {
      if (!verifyStripeSignature(rawBody, stripeSignature, stripeSecret)) {
        res.status(401).json({ error: 'Invalid Stripe webhook signature' });
        return;
      }
      provider = 'stripe';
    } else {
      res.status(401).json({ error: 'Missing webhook signature header' });
      return;
    }

    const normalized = normalizeWebhookPayload(provider, req.body);
    if (!normalized) {
      res.status(200).json({ received: true, ignored: true });
      return;
    }

    const client = await (customDbPool || db).connect();
    try {
      await client.query('BEGIN');

      // Idempotency check
      const existing = await client.query(
        'SELECT event_id FROM billing_webhook_events WHERE event_id = $1',
        [normalized.eventId],
      );
      if (existing.rows.length > 0) {
        await client.query('COMMIT');
        res.status(200).json({ received: true, duplicate: true });
        return;
      }

      let userRow: { id: string } | undefined;

      if (normalized.userId) {
        const byId = await client.query('SELECT id FROM users WHERE id = $1', [normalized.userId]);
        userRow = byId.rows[0];
      }
      if (!userRow && normalized.email) {
        const byEmail = await client.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [normalized.email]);
        userRow = byEmail.rows[0];
      }
      if (!userRow && normalized.subscriptionId) {
        const bySub = await client.query('SELECT id FROM users WHERE billing_subscription_id = $1', [normalized.subscriptionId]);
        userRow = bySub.rows[0];
      }
      if (!userRow && normalized.customerId) {
        const byCust = await client.query('SELECT id FROM users WHERE billing_customer_id = $1', [normalized.customerId]);
        userRow = byCust.rows[0];
      }

      if (userRow) {
        await client.query(
          `UPDATE users
           SET plan = $1,
               billing_customer_id = COALESCE($2, billing_customer_id),
               billing_subscription_id = COALESCE($3, billing_subscription_id),
               billing_status = $4,
               plan_updated_at = NOW()
           WHERE id = $5`,
          [
            normalized.targetPlan,
            normalized.customerId ?? null,
            normalized.subscriptionId ?? null,
            normalized.status,
            userRow.id,
          ],
        );
      }

      await client.query(
        `INSERT INTO billing_webhook_events (event_id, provider, event_type, user_id)
         VALUES ($1, $2, $3, $4)`,
        [normalized.eventId, normalized.provider, normalized.eventType, userRow?.id ?? null],
      );

      await client.query('COMMIT');
      res.status(200).json({
        received: true,
        updated: Boolean(userRow),
        plan: normalized.targetPlan,
      });
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('[BILLING_WEBHOOK_ERROR]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});
