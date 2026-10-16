import type { PoolClient } from 'pg';
import type { SessionUser } from './auth';

/** Admins always; a Labor Coordinator only when an admin has allowed it on their profile. Crew never. */
export async function canAdjustRates(c: PoolClient, u: SessionUser): Promise<boolean> {
  if (u.role === 'admin') return true;
  if (u.role !== 'manager') return false;
  return !!(await c.query('SELECT 1 FROM users WHERE id = $1 AND can_adjust_rates AND active', [u.sub])).rowCount;
}

/** Who may send an event's invoice: anyone who may adjust rates, and HR accounts. */
export async function canBill(c: PoolClient, u: SessionUser): Promise<boolean> {
  return u.role === 'hr' || canAdjustRates(c, u);
}
