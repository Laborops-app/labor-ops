import type { PoolClient } from 'pg';

/** Hourly rates from the Roles & pay rates list, keyed by lower-case role name. */
export async function loadRates(c: PoolClient): Promise<Map<string, number>> {
  const { rows } = await c.query('SELECT lower(name) AS n, pay_rate FROM skills');
  return new Map(rows.map((r: any) => [r.n as string, Number(r.pay_rate)]));
}

/** A shift's role may carry a suffix such as "Audio (Lead)"; the rate is looked up by the base name. A rate of 0 means "not set". */
export function rateFor(rates: Map<string, number>, role: string): number | undefined {
  const r = rates.get(role.replace(/\s*\(.*\)\s*$/, '').trim().toLowerCase());
  return r && r > 0 ? r : undefined;
}

export const hoursBetween = (a: Date | string, b: Date | string) => Math.max(0, Math.round(((+new Date(b) - +new Date(a)) / 3600_000) * 100) / 100);
export const money = (n: number) => `$${n.toFixed(2)}`;

/** Scheduled hours x hourly rate. It is an estimate: actual pay follows approved time. */
export function estimate(rate: number | undefined, startsAt: Date | string, endsAt: Date | string) {
  const hours = hoursBetween(startsAt, endsAt);
  return { hours, rate: rate ?? null, estimate: rate ? Math.round(hours * rate * 100) / 100 : null };
}
