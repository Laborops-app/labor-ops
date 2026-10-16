import type { PoolClient } from 'pg';
import { localDate } from './accounting';

export type Period = { from: string; to: string; index: number };
const DAY = 86400_000;
const toMs = (ymd: string) => Date.parse(`${ymd}T00:00:00Z`);
const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** The company's pay period setting (Labor rules): weekly or every two weeks, counted from a start date. */
export async function loadPayPeriod(c: PoolClient) {
  const r = (await c.query(`SELECT t.timezone, COALESCE(r.pay_period, 'biweekly') AS pay_period, to_char(COALESCE(r.pay_period_start, '2026-01-05'::date), 'YYYY-MM-DD') AS start
                              FROM tenants t LEFT JOIN labor_rules r ON r.tenant_id = t.id LIMIT 1`)).rows[0];
  return { tz: r.timezone as string, kind: r.pay_period as 'weekly' | 'biweekly', start: r.start as string, days: r.pay_period === 'weekly' ? 7 : 14 };
}

/** The pay period containing a local date, moved by `offset` periods (-1 = the one before). */
export function periodFor(p: { start: string; days: number }, date: string, offset = 0): Period {
  const n = Math.floor((toMs(date) - toMs(p.start)) / (p.days * DAY)) + offset;
  const from = toMs(p.start) + n * p.days * DAY;
  return { from: ymd(from), to: ymd(from + (p.days - 1) * DAY), index: n };
}

export async function currentPeriods(c: PoolClient) {
  const p = await loadPayPeriod(c);
  const today = localDate(p.tz, new Date());
  return { kind: p.kind, start: p.start, current: periodFor(p, today), previous: periodFor(p, today, -1), next: periodFor(p, today, 1), today, tz: p.tz, days: p.days };
}
