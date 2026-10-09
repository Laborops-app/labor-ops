import fs from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';
import { config } from './config';

export async function migrate(): Promise<void> {
  const c = new Client({ connectionString: config.adminDatabaseUrl });
  await c.connect();
  try {
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const dir = path.join(__dirname, '..', 'migrations');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      await c.query('BEGIN');
      try {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await c.query('COMMIT');
        console.log(`migration applied: ${file}`);
      } catch (err) {
        await c.query('ROLLBACK');
        throw err;
      }
    }
    // The app role's password comes from the environment, never from a SQL file.
    const { rows } = await c.query("SELECT format('ALTER ROLE laborops_app WITH LOGIN PASSWORD %L', $1::text) AS sql", [
      config.appDbPassword,
    ]);
    await c.query(rows[0].sql);
  } finally {
    await c.end();
  }
}

export async function migrateWithRetry(attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await migrate();
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`database not ready (attempt ${i}/${attempts}), retrying...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
