# Payment Onboarding & Merchant of Record Runbook (Lemon Squeezy / Paddle)

**Document Owner:** Abdullah (Commercial & Release Operations)  
**Target Release Gate:** Synkro v0.1.0 Android Beta  
**Key References:** `apps/server/src/billing-router.ts`, `apps/server/src/index.ts`, `website/pricing/index.html`

---

## 1. Executive Summary & Strategic Justification

### 1.1 The Turkish Banking Blocker (Why Stripe Cannot Be Used Directly)
Direct integration with standard payment processors like **Stripe** or **Braintree** is blocked for founders and entities operating out of Turkey:
- **BDDK Regulation (Law No. 6493):** Turkey's Banking Regulation and Supervision Agency (BDDK) mandates that payment service providers store data locally within Turkey and hold a direct Turkish payment license.
- **Stripe Non-Operation in Turkey:** Stripe does not hold a BDDK license, does not onboard Turkish sole proprietorships or entities, and cannot disburse payouts to Turkish bank accounts.
- **Risks of Offshore Shell Workarounds:** Setting up automated Delaware/UK shell entities without local substance creates severe tax liabilities (cross-border withholding tax complications), compliance freezes, and recurring Stripe KYC verification lockouts.

### 1.2 The Solution: Merchant of Record (MoR)
To process global credit cards, Apple Pay, Google Pay, and localized payment methods compliantly, Synkro utilizes a **Merchant of Record (MoR)** platform — primarily **Lemon Squeezy** (or **Paddle** as redundant fallback).

| Dimension | Traditional Gateway (Stripe) | Merchant of Record (Lemon Squeezy / Paddle) |
|---|---|---|
| **Legal Seller** | Synkro is the seller of record | MoR is the legal reseller of the digital software |
| **Global Sales Tax / VAT** | Synkro must register & remit in 100+ tax jurisdictions | MoR automatically calculates, collects, and remits global VAT/GST |
| **Turkish Founder Payouts** | ❌ Blocked (no Turkish bank support) | ✅ Supported via direct SWIFT wire transfer, Wise Business, or Payoneer |
| **Chargeback & Fraud Liability** | Synkro absorbs 100% liability & dispute penalties | MoR handles fraud screening, 3DS authentication, and disputes |
| **PCI-DSS Compliance** | Synkro bears partial SAQ burden | MoR handles 100% of payment data (Synkro touches zero card data) |

---

## 2. Store Registration & Domain Verification

### 2.1 Lemon Squeezy Store Setup
1. **Account Registration:** Register an account at [lemonsqueezy.com](https://www.lemonsqueezy.com) under the official commercial entity.
2. **Store Settings:**
   - **Store Name:** `Synkro`
   - **Store URL:** `synkro.lemonsqueezy.com`
   - **Support Email:** `support@synkro.com`
   - **Refund Policy:** Select *7-day money-back guarantee* matching `website/terms/index.html`.
3. **Payout Configuration:**
   - Configure payouts to your **Wise Business** (EUR/USD) or Turkish bank account via international SWIFT wire transfer.
   - Payout frequency: Weekly or bi-weekly.

### 2.2 Domain Verification (`synkro.app` & `synkro.dev`)
To serve branded checkout overlays and customized email receipts:
1. In the Lemon Squeezy dashboard, navigate to **Settings → Domains**.
2. Add custom domain: `checkout.synkro.dev` (or `synkro.app`).
3. Add the required DNS records at your DNS provider (Cloudflare):
   - `CNAME` `checkout` pointing to `domains.lemonsqueezy.com`
   - `TXT` record for domain ownership verification (provided in dashboard).

---

## 3. Product & Subscription Tier Configuration

Synkro operates on weekly compute pools backed by monthly recurring subscriptions. All subscriptions are defined in the MoR dashboard and normalized by our backend.

### 3.1 Product Tiers

#### Tier 1: Synkro Pro ($20 / month)
- **Product Name:** `Synkro Pro Monthly`
- **Pricing:** `$20.00 USD / month` (recurring)
- **Trial Period:** None (backed by 7-day money-back guarantee)
- **Benefits:**
  - $5.00 / week AI chat & agent model pool (resets Mondays 00:00 UTC)
  - Unlimited monthly ghost-text Tab completions
  - Frontier model selector (Gemini 2.5 Pro, Claude 3.5 Sonnet, GPT-4o)
  - Prioritized cloud build queue
- **Checkout Custom Data:** Must pass `custom[user_id]` so the webhook maps the subscription to the authenticated user.

#### Tier 2: Synkro Pro+ ($59 / month)
- **Product Name:** `Synkro Pro+ High Intensity`
- **Pricing:** `$59.00 USD / month` (recurring)
- **Benefits:**
  - Designed for agencies and intensive daily builders
  - Higher concurrent cloud build compilation slots
  - Increased single-request token cost limits

### 3.2 Plan Normalization Architecture Note
> [!IMPORTANT]
> In `apps/server/src/billing-router.ts`, all active paid subscription events (`subscription_created`, `subscription_updated`, `subscription_resumed`, `subscription_payment_success`) are intentionally normalized to:
> ```ts
> targetPlan: 'pro'
> ```
> Downgrades, expirations, or payment failures (`subscription_expired`, `subscription_cancelled`, `subscription_payment_failed`) revert the user to:
> ```ts
> targetPlan: 'free'
> ```
> Any additional tier metadata is preserved in the database without altering core gateway permission boundaries.

---

## 4. Webhook Security & Endpoint Integration

### 4.1 Production Webhook Endpoints
The Synkro backend exposes two mounted paths for billing webhooks (configured in `apps/server/src/index.ts` lines 153-154):
- Primary: `https://api.synkro.dev/v1/billing/webhook`
- Secondary / Legacy Alias: `https://api.synkro.dev/api/billing/webhook`

### 4.2 Generating the Webhook Secret
Generate a high-entropy secret using OpenSSL:
```bash
openssl rand -hex 32
```
Save this value in the production server environment file (`/opt/synkro/.env` or Docker secret):
```env
LEMONSQUEEZY_WEBHOOK_SECRET=your_generated_64_character_hex_secret
```

### 4.3 Subscribing to Webhook Events
In Lemon Squeezy dashboard → **Settings → Webhooks**:
- **Callback URL:** `https://api.synkro.dev/v1/billing/webhook`
- **Secret:** Enter the exact value from `LEMONSQUEEZY_WEBHOOK_SECRET`
- **Selected Events:**
  1. `subscription_created`
  2. `subscription_updated`
  3. `subscription_cancelled`
  4. `subscription_resumed`
  5. `subscription_expired`
  6. `subscription_payment_success`
  7. `subscription_payment_failed`

### 4.4 Critical Security & PostgreSQL Service Role Invariant
> [!CAUTION]
> In `apps/server/src/billing-router.ts` (lines 177-247), webhook database transactions execute with the raw connection pool:
> ```ts
> const client = await (customDbPool || db).connect();
> ```
> **INVARIANT:** Webhook execution must **NEVER** execute `SET LOCAL ROLE api_user`.
> 
> *Why?*
> 1. Webhook processing is a machine-to-machine system process, not a tenant session.
> 2. The restricted PostgreSQL role `api_user` has strict Row-Level Security (RLS) policies requiring an active `app.current_user_id` session setting.
> 3. `api_user` lacks direct modification permissions on the audit table `billing_webhook_events` and cannot update arbitrary records across the `users` table.

---

## 5. End-to-End Testing & Verification Harness

`billing-router.ts` validates incoming Lemon Squeezy requests by computing the HMAC-SHA256 signature of the raw UTF-8 request body against `LEMONSQUEEZY_WEBHOOK_SECRET` and comparing it to the `x-signature` header via `crypto.timingSafeEqual`.

### 5.1 Test Signature Generator (Node.js)
To test webhook ingestion against a local or staging server:

```javascript
// test-webhook.js
const crypto = require('crypto');
const http = require('http');

const secret = process.env.LEMONSQUEEZY_WEBHOOK_SECRET || 'test_secret_key_123';
const payload = JSON.stringify({
  meta: {
    event_name: 'subscription_created',
    webhook_id: 'ls_test_evt_' + Date.now(),
    custom_data: {
      user_id: 'USER_UUID_HERE' // Replace with existing test user ID
    }
  },
  data: {
    id: 'sub_test_998877',
    attributes: {
      user_email: 'developer@example.com',
      customer_id: 12345,
      status: 'active',
      updated_at: new Date().toISOString()
    }
  }
});

const signature = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');

const req = http.request({
  hostname: 'localhost',
  port: 3000,
  path: '/v1/billing/webhook',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'x-signature': signature,
    'Content-Length': Buffer.byteLength(payload)
  }
}, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => console.log('Response:', res.statusCode, JSON.parse(data)));
});

req.write(payload);
req.end();
```

### 5.2 Verification Checklist
- [x] **Valid Signature Upgrade:** Returns `200 OK` with `{ received: true, updated: true, plan: "pro" }`.
- [x] **Invalid Signature:** Returns `401 Unauthorized` with `{ error: "Invalid Lemon Squeezy webhook signature" }`.
- [x] **Idempotency Replay:** Re-submitting the same payload with the identical `meta.webhook_id` returns `200 OK` with `{ received: true, duplicate: true }` without executing duplicate database `UPDATE` or `INSERT` operations.
- [x] **Cancellation / Downgrade:** Submitting `subscription_cancelled` or `subscription_expired` updates the database record to `users.plan = 'free'` and sets `billing_status = 'cancelled'`.

---

## 6. Production Maintenance & Runbook Summary

1. **Secret Rotation:** When rotating `LEMONSQUEEZY_WEBHOOK_SECRET`, update the environment variable on the server, restart `peep-server`, and update the webhook secret in Lemon Squeezy dashboard simultaneously.
2. **Monitoring Webhook Failures:** Check server logs via:
   ```bash
   journalctl -u peep-server -n 100 --no-pager | grep "BILLING_WEBHOOK"
   ```
3. **Database Audit Records:** Query received events directly in PostgreSQL:
   ```sql
   SELECT event_id, provider, event_type, user_id, received_at 
   FROM billing_webhook_events 
   ORDER BY received_at DESC 
   LIMIT 20;
   ```
