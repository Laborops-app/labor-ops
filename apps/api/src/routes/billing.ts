import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth';
import { config } from '../config';
import { adminPool } from '../storage';
import { platformGuard, audit as platformAudit } from '../platformAuth';
import {
  billingOn, billingSettings, billingSettingsSchema, planForPrice, planOf, saveBilling, stripe, tenantBilling, verifyStripeSignature,
  type BillingSettings,
} from '../billing';

const SOLD = ['starter', 'pro', 'enterprise'] as const;
const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the platform page sees: never the secrets themselves. */
const masked = (s: BillingSettings) => ({
  ...s, secretKey: '', webhookSecret: '',
  hasSecretKey: !!s.secretKey, hasWebhookSecret: !!s.webhookSecret,
  secretKeyMode: s.secretKey.startsWith('sk_live_') || s.secretKey.startsWith('rk_live_') ? 'live' : s.secretKey ? 'test' : null,
});

export async function billingRoutes(app: FastifyInstance) {
  const adminOnly = guard('admin');
  const db = () => adminPool();

  // ---------- the company's Billing page ----------
  app.get('/api/billing', { preHandler: adminOnly }, async (req) => {
    const s = await billingSettings();
    const b = (await tenantBilling(req.user.tid))!;
    const plan = planOf(s, b.plan);
    return {
      enabled: billingOn(s),
      billing: b,
      plan: { key: b.plan, ...plan, priceId: undefined },
      plans: SOLD.map((k) => ({ key: k, name: s.plans[k].name, crewLimit: s.plans[k].crewLimit, smsIncluded: s.plans[k].smsIncluded, priceLabel: s.plans[k].priceLabel, buyable: !!s.plans[k].priceId })),
      smsPack: { size: s.smsPack.size, priceLabel: s.smsPack.priceLabel, buyable: !!s.smsPack.priceId },
    };
  });

  /** Start a subscription (or change plan when there is none yet) with Stripe Checkout. */
  app.post('/api/billing/checkout', { preHandler: adminOnly }, async (req, reply) => {
    const { plan } = z.object({ plan: z.enum(SOLD) }).parse(req.body);
    const s = await billingSettings();
    if (!billingOn(s)) return reply.code(409).send({ error: 'Online billing is not set up yet. Contact LaborOps support.' });
    const p = s.plans[plan];
    const b = (await tenantBilling(req.user.tid))!;
    // An existing subscription changes plan in the Stripe portal (proration handled there).
    if (b.subscriptionId && b.status && !['canceled', 'incomplete_expired'].includes(b.status))
      return reply.code(409).send({ error: 'You already have a subscription. Use "Manage billing" to change plan or payment method.', reason: 'has_subscription' });
    if (!p.priceId) return reply.code(409).send({ error: `The ${p.name} plan cannot be bought online yet. Contact LaborOps support.` });
    const me = (await db().query('SELECT email FROM users WHERE id = $1', [req.user.sub])).rows[0];
    const session = await stripe(s, 'POST', 'checkout/sessions', {
      mode: 'subscription',
      client_reference_id: req.user.tid,
      ...(b.customerId ? { customer: b.customerId } : { customer_email: me?.email }),
      line_items: [{ price: p.priceId, quantity: 1 }],
      allow_promotion_codes: true,
      subscription_data: { metadata: { tenant_id: req.user.tid, plan } },
      metadata: { tenant_id: req.user.tid, kind: 'plan', plan },
      success_url: `${config.appUrl}/billing?done=plan`,
      cancel_url: `${config.appUrl}/billing`,
    }).catch((e) => ({ error: e.message }));
    if ('error' in session) return reply.code(502).send({ error: `Stripe: ${session.error}` });
    return { url: session.url };
  });

  /** Buy extra text messages (one-off payment). */
  app.post('/api/billing/sms-pack', { preHandler: adminOnly }, async (req, reply) => {
    const { packs } = z.object({ packs: z.number().int().min(1).max(20).default(1) }).parse(req.body ?? {});
    const s = await billingSettings();
    if (!billingOn(s) || !s.smsPack.priceId) return reply.code(409).send({ error: 'Text packs cannot be bought online yet. Contact LaborOps support.' });
    const b = (await tenantBilling(req.user.tid))!;
    const me = (await db().query('SELECT email FROM users WHERE id = $1', [req.user.sub])).rows[0];
    const session = await stripe(s, 'POST', 'checkout/sessions', {
      mode: 'payment',
      client_reference_id: req.user.tid,
      ...(b.customerId ? { customer: b.customerId } : { customer_email: me?.email }),
      line_items: [{ price: s.smsPack.priceId, quantity: packs }],
      metadata: { tenant_id: req.user.tid, kind: 'sms', texts: String(packs * s.smsPack.size) },
      success_url: `${config.appUrl}/billing?done=sms`,
      cancel_url: `${config.appUrl}/billing`,
    }).catch((e) => ({ error: e.message }));
    if ('error' in session) return reply.code(502).send({ error: `Stripe: ${session.error}` });
    return { url: session.url };
  });

  /** Stripe's own page for invoices, card, plan changes and cancelling. */
  app.post('/api/billing/portal', { preHandler: adminOnly }, async (req, reply) => {
    const s = await billingSettings();
    const b = (await tenantBilling(req.user.tid))!;
    if (!billingOn(s) || !b.customerId) return reply.code(409).send({ error: 'There is no billing account yet. Choose a plan first.' });
    const p = await stripe(s, 'POST', 'billing_portal/sessions', { customer: b.customerId, return_url: `${config.appUrl}/billing` }).catch((e) => ({ error: e.message }));
    if ('error' in p) return reply.code(502).send({ error: `Stripe: ${p.error}` });
    return { url: p.url };
  });

  // ---------- Stripe webhook ----------
  app.register(async (inst) => {
    inst.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, JSON.parse(String(body)));
      } catch (e) {
        done(e as Error, undefined);
      }
    });
    inst.post('/api/billing/webhook', async (req, reply) => {
      const s = await billingSettings();
      const raw = String((req as any).rawBody ?? '');
      if (!verifyStripeSignature(raw, req.headers['stripe-signature'] as string | undefined, s.webhookSecret)) return reply.code(400).send({ error: 'bad signature' });
      const ev = req.body as { id: string; type: string; data: { object: any } };
      const seen = await db().query('INSERT INTO billing_events (id, type) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING id', [ev.id, ev.type]);
      if (!seen.rowCount) return { received: true, duplicate: true };
      const tenantId = await handle(s, ev).catch(async (e) => {
        // Let Stripe retry later.
        await db().query('DELETE FROM billing_events WHERE id = $1', [ev.id]);
        throw e;
      });
      if (tenantId) await db().query('UPDATE billing_events SET tenant_id = $2 WHERE id = $1', [ev.id, tenantId]);
      return { received: true };
    });
  });

  async function tenantFor(o: any): Promise<string | null> {
    const id = o?.metadata?.tenant_id ?? o?.client_reference_id;
    if (id && uuidRe.test(id) && (await db().query('SELECT 1 FROM tenants WHERE id = $1', [id])).rowCount) return id;
    const sub = o?.object === 'subscription' ? o.id : o?.subscription;
    const r = await db().query('SELECT id FROM tenants WHERE ($1::text IS NOT NULL AND stripe_subscription_id = $1) OR ($2::text IS NOT NULL AND stripe_customer_id = $2) LIMIT 1', [sub ?? null, o?.customer ?? null]);
    return r.rows[0]?.id ?? null;
  }

  async function applySubscription(s: BillingSettings, tenantId: string, sub: any) {
    const price = sub.items?.data?.[0]?.price?.id;
    const plan = planForPrice(s, price) ?? (SOLD as readonly string[]).find((k) => k === sub.metadata?.plan) ?? null;
    const end = sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;
    const gone = sub.status === 'canceled' || sub.status === 'incomplete_expired';
    await db().query(
      `UPDATE tenants SET stripe_subscription_id = $2, stripe_customer_id = COALESCE($3, stripe_customer_id), billing_status = $4,
              billing_period_end = $5, plan = CASE WHEN $6 THEN 'trial' WHEN $7::text IS NOT NULL THEN $7 ELSE plan END
        WHERE id = $1 AND plan <> 'internal'`,
      [tenantId, sub.id, sub.customer ?? null, sub.status, end ? new Date(end * 1000) : null, gone, plan],
    );
  }

  async function handle(s: BillingSettings, ev: { type: string; data: { object: any } }): Promise<string | null> {
    const o = ev.data.object;
    const tenantId = await tenantFor(o);
    if (!tenantId) return null;
    if (ev.type === 'checkout.session.completed') {
      if (o.payment_status && o.payment_status !== 'paid' && o.payment_status !== 'no_payment_required') return tenantId;
      if (o.mode === 'subscription') {
        await db().query('UPDATE tenants SET stripe_customer_id = COALESCE($2, stripe_customer_id), stripe_subscription_id = COALESCE($3, stripe_subscription_id) WHERE id = $1', [tenantId, o.customer ?? null, o.subscription ?? null]);
        if (o.subscription) {
          const sub = await stripe(s, 'GET', `subscriptions/${encodeURIComponent(o.subscription)}`).catch(() => null);
          if (sub) await applySubscription(s, tenantId, sub);
          else if (o.metadata?.plan) await db().query("UPDATE tenants SET plan = $2, billing_status = 'active' WHERE id = $1 AND plan <> 'internal'", [tenantId, o.metadata.plan]);
        }
      } else if (o.mode === 'payment' && o.metadata?.kind === 'sms') {
        const texts = Math.max(0, Math.min(2_000_000, Number(o.metadata.texts) || 0));
        await db().query('UPDATE tenants SET sms_credits = sms_credits + $2, stripe_customer_id = COALESCE(stripe_customer_id, $3) WHERE id = $1', [tenantId, texts, o.customer ?? null]);
      }
    } else if (ev.type.startsWith('customer.subscription.')) {
      await applySubscription(s, tenantId, o);
    } else if (ev.type === 'invoice.payment_failed') {
      await db().query("UPDATE tenants SET billing_status = 'past_due' WHERE id = $1 AND stripe_subscription_id IS NOT DISTINCT FROM COALESCE($2, stripe_subscription_id)", [tenantId, o.subscription ?? null]);
    }
    return tenantId;
  }

  // ---------- platform console: Stripe keys, plans and prices ----------
  app.get('/api/platform/billing', { preHandler: platformGuard }, async () => {
    const s = await billingSettings();
    const companies = (
      await db().query(
        `SELECT t.id, t.name, t.plan, t.billing_status, t.billing_period_end, t.trial_ends_at, t.sms_credits,
                (SELECT count(*)::int FROM users u WHERE u.tenant_id = t.id AND u.active AND u.role = 'crew') AS active_crew
           FROM tenants t ORDER BY t.created_at DESC LIMIT 200`,
      )
    ).rows;
    return { settings: masked(s), webhookUrl: `${config.appUrl}/api/billing/webhook`, companies };
  });

  app.put('/api/platform/billing', { preHandler: platformGuard }, async (req, reply) => {
    const b = billingSettingsSchema.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the billing settings' });
    const old = await billingSettings();
    const next: BillingSettings = { ...b.data, secretKey: b.data.secretKey || old.secretKey, webhookSecret: b.data.webhookSecret || old.webhookSecret };
    if (next.secretKey && !/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(next.secretKey)) return reply.code(400).send({ error: 'That does not look like a Stripe secret key (sk_live_… or sk_test_…)' });
    if (next.webhookSecret && !/^whsec_[A-Za-z0-9]+$/.test(next.webhookSecret)) return reply.code(400).send({ error: 'The webhook signing secret starts with whsec_' });
    await saveBilling(next, null);
    await platformAudit(req.platformUser!.id, 'billing.settings', null, { keyChanged: !!b.data.secretKey, webhookChanged: !!b.data.webhookSecret });
    return { settings: masked(next) };
  });

  /** Turn billing off again (forget the keys). Plans and prices are kept. */
  app.delete('/api/platform/billing/keys', { preHandler: platformGuard }, async (req) => {
    const s = await billingSettings();
    await saveBilling({ ...s, secretKey: '', webhookSecret: '' }, null);
    await platformAudit(req.platformUser!.id, 'billing.keys_removed');
    return { settings: masked({ ...s, secretKey: '', webhookSecret: '' }) };
  });

  /** Credit a company with texts by hand (goodwill, or a payment taken outside Stripe). */
  app.post('/api/platform/companies/:id/sms-credits', { preHandler: platformGuard }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { texts } = z.object({ texts: z.number().int().min(-100000).max(100000) }).parse(req.body);
    const r = await db().query('UPDATE tenants SET sms_credits = GREATEST(0, sms_credits + $2) WHERE id = $1 RETURNING sms_credits', [id, texts]);
    if (!r.rowCount) return reply.code(404).send({ error: 'Company not found' });
    await platformAudit(req.platformUser!.id, 'company.sms_credits', id, { texts });
    return { smsCredits: r.rows[0].sms_credits };
  });

}
