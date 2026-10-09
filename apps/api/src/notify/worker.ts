import { pool } from '../db';
import { sendEmail, sendSms } from './providers';
import { runSweeps } from './sweeps';

const MAX_ATTEMPTS = 4;
const BACKOFF = [60, 300, 900]; // seconds before retry 2, 3, 4

export async function processQueue(limit = 20): Promise<number> {
  const { rows } = await pool.query('SELECT * FROM notify_claim($1)', [limit]);
  for (const d of rows) {
    // Never send to the demo / placeholder addresses: they would only bounce and hurt the sender reputation.
    if (d.channel === 'email' && /@(demo\.laborops\.app|example\.(com|org|net)|[^@]*\.invalid)$/i.test(d.to_addr)) {
      await pool.query('SELECT notify_finish($1,$2,$3,NULL,0)', [d.id, 'skipped', 'placeholder address']);
      continue;
    }
    const r =
      d.channel === 'email'
        ? await sendEmail({ to: d.to_addr, subject: d.subject ?? '(no subject)', text: d.body, html: d.html })
        : await sendSms({ to: d.to_addr, body: d.body });
    if (r.ok) {
      await pool.query('SELECT notify_finish($1,$2,$3,$4,0)', [d.id, 'sent', r.logged ? 'log-only mode: not delivered' : null, r.id]);
    } else if (r.permanent || d.attempts >= MAX_ATTEMPTS) {
      await pool.query('SELECT notify_finish($1,$2,$3,NULL,0)', [d.id, 'failed', r.error]);
    } else {
      await pool.query('SELECT notify_finish($1,$2,$3,NULL,$4)', [d.id, 'queued', r.error, BACKOFF[Math.min(d.attempts - 1, BACKOFF.length - 1)]]);
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
  t1.unref(); t2.unref(); t3.unref();
}
