// Create the empty test database before the API starts (the API makes the tables when it starts).
import pg from 'pg';
const admin = process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/laborops_e2e';
const url = new URL(admin);
const name = url.pathname.slice(1);
url.pathname = '/postgres';
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
if (!(await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await c.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
await c.end();
