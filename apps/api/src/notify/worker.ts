import { pool, withTenant } from '../db';
import { sendEmail, sendSms } from './providers';
import { sendPush } from './push';
import { loadSettings, saveIntegration, type Resolved } from './settings';
import { runSweeps } from './sweeps';
import { useSmsAllowance } from '../billing';
import { runAttendance } from '../attendance';

const MAX_ATTEMPTS = 4;
const BACKOFF = [60, 300, 900]; // seconds before retry 2, 3, 4

const cache = new Map<string, { at: number; cfg: Resolved }>();
export const invalidateSettings = (tenantId: string) => cache.delete(tenantId);

/** The company's settings, cached briefly so a burst of messages does not hit the database for each one. */
async function settingsFor(tenantId: string): Promise<Resolved> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < 30_000) return hit.cfg;
  const cfg = await withTenant(tenantId, (c) => loadSettings(c, tenantId));
  cache.set(tenantId, { at: Date.now(), cfg });
  return cfg;
}

export async function processQueue(limit = 20): Promise<number> {
  // Texts held back behind a push are dropped once the push was opened.
  await pool.query('SELECT notify_skip_acked()');
  const { rows } = await pool.query('SELECT * FROM notify_claim($1)', [limit]);
  for (const d of rows) {
    const finish = (status: string, error: string | null, id: string | null, retry = 0) =>
      pool.query('SELECT notify_finish($1,$2,$3,$4,$5)', [d.id, status, error, id, retry]);
    try {
      // Never send to the demo / placeholder addresses: they would only bounce and hurt the sender reputation.
      if (d.channel === 'email' && /@(demo\.laborops\.app|example\.(com|org|net)|[^@]*\.invalid)$/i.test(d.to_addr)) {
        await finish('skipped', 'placeholder address', null);
        continue;
      }
      let r: { ok: true; id: string; logged?: boolean } | { ok: false; permanent: boolean; error: string };
      if (d.channel === 'push') {
        const sub = (await pool.query('SELECT * FROM notify_push_sub($1)', [d.to_addr])).rows[0];
        if (!sub) {
          await finish('failed', 'subscription no longer exists', null);
          continue;
        }
        const pr = await sendPush(sub, JSON.parse(d.body));
        if (pr.ok) r = { ok: true, id: '' };
        else {
          if (pr.gone) await pool.query('SELECT notify_push_drop($1)', [d.to_addr]);
          r = { ok: false, permanent: pr.gone, error: pr.error };
        }
      } else {
        if (d.channel === 'sms') {
          const allow = await useSmsAllowance(d.tenant_id);
          if (!allow.ok) {
            await finish('skipped', allow.reason, null);
            continue;
          }
        }
        const cfg = await settingsFor(d.tenant_id);
        if (d.channel === 'email') r = await sendEmail(cfg, { to: d.to_addr, subject: d.subject ?? '(no subject)', text: d.body, html: d.html });
        else
          r = await sendSms(cfg, { to: d.to_addr, body: d.body }, {
            persistPodium: async (t) => {
              await withTenant(d.tenant_id, (c) => saveIntegration(c, d.tenant_id, null, 'podium', t, { raw: true }));
              invalidateSettings(d.tenant_id);
            },
          });
      }
      if (r.ok) await finish('sent', (r as any).logged ? 'log-only mode: not delivered' : null, r.id || null);
      else if (r.permanent || d.attempts >= MAX_ATTEMPTS) await finish('failed', r.error, null);
      else await finish('queued', r.error, null, BACKOFF[Math.min(d.attempts - 1, BACKOFF.length - 1)]);
    } catch (e: any) {
      // Never leave a message stuck in 'sending' because of an unexpected error.
      await finish(d.attempts >= MAX_ATTEMPTS ? 'failed' : 'queued', String(e?.message ?? e).slice(0, 300), null, 300).catch(() => undefined);
    }
  }
  return rows.length;
}

export function startWorkers() {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      while ((await processQueue()) >= 20) { /* drain */ }
    } catch (e) {
      console.error('notify worker error', e);
    } finally {
      busy = false;
    }
  };
  const t1 = setInterval(tick, 5000);
  const sweep = () => runSweeps().catch((e) => console.error('notify sweep error', e));
  const t2 = setInterval(sweep, 15 * 60 * 1000);
  const t3 = setTimeout(sweep, 30_000);
  // Late / no-show alerts and forgotten clock-outs need to be quick, so they run every 2 minutes.
  const t4 = setInterval(() => runAttendance().catch((e) => console.error('attendance error', e)), 2 * 60 * 1000);
  t1.unref(); t2.unref(); t3.unref(); t4.unref();
}
