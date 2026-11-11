import { withTenant } from './db';
import { getToken } from './rentman';
import { loadOptions } from './rentmanOptions';
import { pullRentman, loadPipelineSettings } from './rentmanPipeline';
import { syncCrew, syncRates } from './rentmanSync';
import { clearExtrasCache, syncAllInvoices } from './rentmanExtras';

/**
 * Work started by Rentman webhooks. Changes often come in bursts (saving a project touches many items), so each
 * company's work waits a few seconds after the last call, then runs once with everything that changed.
 */
type Kind = 'projects' | 'crew' | 'rates';
const pending = new Map<string, { kinds: Set<Kind>; timer: NodeJS.Timeout }>();
export const DEBOUNCE_MS = Number(process.env.RENTMAN_WEBHOOK_DEBOUNCE_MS ?? 8000);

/** Which part of the sync an item type needs. */
export function kindOf(itemType: string): Kind {
  const t = itemType.toLowerCase();
  if (/^crew$|crewmember|^crewrate/.test(t)) return t.includes('rate') ? 'rates' : 'crew';
  if (/^rate|ratefactor/.test(t)) return 'rates';
  return 'projects';
}

export function queueRentman(tid: string, itemTypes: string[]) {
  const cur = pending.get(tid);
  const kinds = cur?.kinds ?? new Set<Kind>();
  for (const t of itemTypes) kinds.add(kindOf(t));
  if (cur) clearTimeout(cur.timer);
  const timer = setTimeout(() => {
    pending.delete(tid);
    runRentmanFor(tid, kinds).catch((e) => console.error('rentman webhook run', tid, e?.message ?? e));
  }, DEBOUNCE_MS);
  timer.unref?.();
  pending.set(tid, { kinds, timer });
}

/** One company's Rentman work for these kinds of change. */
export async function runRentmanFor(tid: string, kinds: Set<Kind>) {
  return withTenant(tid, async (c) => {
    const token = await getToken(c);
    if (!token) return null;
    const o = await loadOptions(c);
    const out: Record<string, unknown> = {};
    if (kinds.has('crew') && o.crew_link) out.crew = await syncCrew(c, tid, token);
    if (kinds.has('rates') && o.rates_source) out.rates = await syncRates(c, tid, token);
    if (kinds.has('projects')) {
      const p = await loadPipelineSettings(c);
      const built = (await c.query('SELECT 1 FROM events WHERE rentman_build LIMIT 1')).rowCount;
      if (p.autoEvents || built) out.pull = await pullRentman(c, tid, token);
      if (o.show_invoices) out.invoices = await syncAllInvoices(c, tid, token);
      clearExtrasCache();
    }
    return out;
  });
}

/** Every 30 minutes (and as the backup for webhooks): each company with Rentman connected and something to keep in step. */
export async function runRentmanAll() {
  const { pool } = await import('./db');
  const { rows } = await pool.query('SELECT id FROM notify_tenants()');
  for (const t of rows) await runRentmanFor(t.id, new Set<Kind>(['projects', 'crew', 'rates'])).catch((e) => console.error('rentman run', t.id, e?.message ?? e));
}

/** Run a company's queued webhook work now (tests, and a manual "sync now"). */
export async function flushRentman(tid: string) {
  const cur = pending.get(tid);
  if (!cur) return null;
  clearTimeout(cur.timer);
  pending.delete(tid);
  return runRentmanFor(tid, cur.kinds);
}
