import { Pool, PoolClient } from 'pg';
import { config } from './config';

export const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });

/**
 * Run work inside a transaction scoped to one tenant. The tenant id is set as a
 * transaction-local setting, which the Row-Level Security policies read.
 */
export async function withTenant<T>(tenantId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

export async function audit(
  c: PoolClient,
  tenantId: string,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string | null,
  detail?: unknown,
): Promise<void> {
  await c.query(
    'INSERT INTO audit_logs (tenant_id, actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5,$6)',
    [tenantId, actorId, action, entity, entityId, detail ? JSON.stringify(detail) : null],
  );
}
