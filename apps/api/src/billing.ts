import crypto from 'node:crypto';
import { z } from 'zod';
import { adminPool } from './storage';
import { decrypt, encrypt } from './crypto';

/**
 * Subscriptions through Stripe. The Stripe keys and price ids are entered on the Platform page (saved encrypted in
 * platform_settings); nothing here is configured from code or the environment. Until a secret key is saved, billing is off:
 * no limits apply and the Billing page says so.
 */

export const PLAN_KEYS = ['trial', 'starter', 'pro', 'enterprise', 'internal'] as const;
export type PlanKey = (typeof PLAN_KEYS)[number];

const planSchema = z.object({
  name: z.string().trim().min(1).max(40),
  /** Active crew accounts allowed; null = no limit. */
  crewLimit: z.number().int().min(1).max(100000).nullable(),
  /** Text messages included each calendar month; null = no limit. */
  smsIncluded: z.number().int().min(0).max(1000000).nullable(),
  /** What the page shows, e.g. "$149 / month". */
  priceLabel: z.string().max(40).default(''),
  /** Stripe price id (price_...). Blank = cannot be bought online. */
  priceId: z.string().trim().max(100).regex(/^(price_[A-Za-z0-9]+)?$/, 'A Stripe price id starts with price_').default(''),
});
export type Plan = z.infer<typeof planSchema>;

export const billingSettingsSchema = z.object({
  secretKey: z.string().trim().max(300).default(''),
  webhookSecret: z.string().trim().max(300).default(''),
  trialDays: z.number().int().min(0).max(90).default(14),
  smsPack: z.object({ size: z.number().int().min(1).max(100000).default(500), priceId: z.string().trim().max(100).regex(/^(price_[A-Za-z0-9]+)?$/).default(''), priceLabel: z.string().max(40).default('') }).default({ size: 500, priceId: '', priceLabel: '' }),
  plans: z.object({
    starter: planSchema, pro: planSchema, enterprise: planSchema,
  }),
});
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

export const DEFAULT_BILLING: BillingSettings = {
  secretKey: '', webhookSecret: '', trialDays: 14,
  smsPack: { size: 500, priceId: '', priceLabel: '$15' },
  plans: {
    starter: { name: 'Starter', crewLimit: 25, smsIncluded: 250, priceLabel: '$49 / month', priceId: '' },
    pro: { name: 'Pro', crewLimit: 100, smsIncluded: 1000, priceLabel: '$149 / month', priceId: '' },
    enterprise: { name: 'Business', crewLimit: 400, smsIncluded: 4000, priceLabel: '$399 / month', priceId: '' },
  },
};
/** Limits for the plans that are not sold: a free trial, and companies run by LaborOps itself. */
const TRIAL: Plan = { name: 'Free trial', crewLimit: 25, smsIncluded: 100, priceLabel: 'Free', priceId: '' };
const INTERNAL: Plan = { name: 'Internal', crewLimit: null, smsIncluded: null, priceLabel: '—', priceId: '' };

let cache: { at: number; s: BillingSettings } | null = null;
export const forgetBilling = () => (cache = null);

export async function billingSettings(): Promise<BillingSettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.s;
  const row = (await adminPool().query("SELECT value_enc FROM platform_settings WHERE key = 'billing'")).rows[0];
  let s = DEFAULT_BILLING;
  if (row) {
    try {
      s = billingSettingsSchema.parse(JSON.parse(decrypt(row.value_enc)));
    } catch {
      console.error('billing: saved settings could not be read, billing is off');
    }
  }
  cache = { at: Date.now(), s };
  return s;
}

export async function saveBilling(s: BillingSettings, by: string | null) {
  await adminPool().query(
    `INSERT INTO platform_settings (key, value_enc, updated_by) VALUES ('billing', $1, $2)
     ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [encrypt(JSON.stringify(s)), by],
  );
  forgetBilling();
}

export const billingOn = (s: BillingSettings) => !!s.secretKey;
export function planOf(s: BillingSettings, key: string): Plan {
  if (key === 'internal') return INTERNAL;
  if (key === 'starter' || key === 'pro' || key === 'enterprise') return s.plans[key];
  return TRIAL;
}
export const planForPrice = (s: BillingSettings, priceId: string): PlanKey | null =>
  (['starter', 'pro', 'enterprise'] as const).find((k) => s.plans[k].priceId && s.plans[k].priceId === priceId) ?? null;

export type TenantBilling = {
  plan: string; status: string | null; trialEndsAt: string | null; periodEnd: string | null; customerId: string | null; subscriptionId: string | null;
  smsCredits: number; activeCrew: number; smsThisMonth: number; suspended: boolean;
};
export async function tenantBilling(tenantId: string): Promise<TenantBilling | null> {
  const t = (
    await adminPool().query(
      `SELECT t.plan, t.billing_status, t.trial_ends_at, t.billing_period_end, t.stripe_customer_id, t.stripe_subscription_id, t.sms_credits,
              t.suspended_at IS NOT NULL AS suspended,
              (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active AND u.role = 'crew') AS active_crew,
              (SELECT count(*)::int FROM deliveries d WHERE d.tenant_id = t.id AND d.channel = 'sms' AND d.status = 'sent'
                  AND d.sent_at >= date_trunc('month', now())) AS sms_month
         FROM tenants t WHERE t.id = $1`,
      [tenantId],
    )
  ).rows[0];
  if (!t) return null;
  return {
    plan: t.plan, status: t.billing_status, trialEndsAt: t.trial_ends_at?.toISOString() ?? null, periodEnd: t.billing_period_end?.toISOString() ?? null,
    customerId: t.stripe_customer_id, subscriptionId: t.stripe_subscription_id, smsCredits: t.sms_credits, activeCrew: t.active_crew,
    smsThisMonth: t.sms_month, suspended: t.suspended,
  };
}

/**
 * Whether one more active crew account fits the company's plan. Always fine while billing is off.
 * Returns an error message when it does not.
 */
export async function crewRoomFor(tenantId: string, adding = 1): Promise<string | null> {
  const s = await billingSettings();
  if (!billingOn(s)) return null;
  const b = await tenantBilling(tenantId);
  if (!b) return null;
  const p = planOf(s, b.plan);
  if (p.crewLimit === null || b.activeCrew + adding <= p.crewLimit) return null;
  return `Your ${p.name} plan includes ${p.crewLimit} active crew and you have ${b.activeCrew}. Upgrade on the Billing page, or deactivate someone who no longer works with you.`;
}

/**
 * Called just before a text goes out. Inside the plan's monthly allowance it is free; past it, one bought credit is used;
 * with no credits left the text is skipped. Always allowed while billing is off.
 */
export async function useSmsAllowance(tenantId: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const s = await billingSettings();
  if (!billingOn(s)) return { ok: true };
  const b = await tenantBilling(tenantId);
  if (!b) return { ok: true };
  const p = planOf(s, b.plan);
  if (p.smsIncluded === null || b.smsThisMonth < p.smsIncluded) return { ok: true };
  const r = await adminPool().query('UPDATE tenants SET sms_credits = sms_credits - 1 WHERE id = $1 AND sms_credits > 0 RETURNING sms_credits', [tenantId]);
  if (r.rowCount) return { ok: true };
  return { ok: false, reason: 'monthly text allowance used up (buy more texts on the Billing page)' };
}

// ---------- Stripe API (form-encoded REST; no SDK needed) ----------
const API = () => (process.env.STRIPE_API_BASE ?? 'https://api.stripe.com').replace(/\/+$/, '');

/** Flatten { a: { b: [x] } } into Stripe's a[b][0]=x form fields. */
export function form(o: Record<string, unknown>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x as any, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') form(v as any, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe<T = any>(s: BillingSettings, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, idem?: string): Promise<T> {
  const res = await fetch(`${API()}/v1/${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${s.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Stripe-Version': '2024-06-20',
      ...(idem ? { 'Idempotency-Key': idem } : {}),
    },
    body: body ? form(body).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j?.error?.message ?? `Stripe error ${res.status}`), { status: res.status });
  return j as T;
}

/** Check a webhook's Stripe-Signature header (t=...,v1=...) against the raw body. Five-minute tolerance. */
export function verifyStripeSignature(raw: string, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]).filter((p) => p.length === 2 && p[0] !== 'v1'));
  const sigs = header.split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > 300) return false;
  const want = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
}
export const signStripe = (raw: string, secret: string, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`;
