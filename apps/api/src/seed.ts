import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { config } from './config';
import { pool, withTenant, audit } from './db';
import { Client } from 'pg';
import { migrateWithRetry } from './migrate';

const DEMO_SLUG = 'demo-productions';
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const dateOnly = (offsetDays: number) => new Date(Date.now() + offsetDays * 86400_000).toISOString().slice(0, 10);

/** Creates a sample company so the demo is not an empty screen. Safe to run repeatedly. */
export async function seedDemo(): Promise<void> {
  const found = await pool.query('SELECT tenant_id FROM auth_find_user($1)', ['admin@demo.laborops.app']);
  if (found.rowCount) {
    // Existing demo company: add the sample data for newer features once.
    const tid = found.rows[0].tenant_id as string;
    await withTenant(tid, async (c) => {
      await seedScheduling(c, tid);
      await seedAddresses(c);
      await seedSkills(c, tid);
    });
    return;
  }

  const tenantId = crypto.randomUUID();
  const hash = await bcrypt.hash(config.demoPassword, 10);
  const id = () => crypto.randomUUID();

  await withTenant(tenantId, async (c) => {
    await c.query('INSERT INTO tenants (id, name, slug) VALUES ($1,$2,$3)', [tenantId, 'Demo Productions', DEMO_SLUG]);
    const addUser = async (email: string, name: string, role: string, skills: string[] = [], phone?: string) => {
      const uid = id();
      await c.query(
        'INSERT INTO users (id, tenant_id, email, name, role, password_hash, skills, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [uid, tenantId, email, name, role, hash, skills, phone ?? null],
      );
      return uid;
    };
    const admin = await addUser('admin@demo.laborops.app', 'Alex Admin', 'admin');
    const manager = await addUser('manager@demo.laborops.app', 'Morgan Manager', 'manager');
    const crew = [
      await addUser('crew1@demo.laborops.app', 'Jordan Rivera', 'crew', ['Audio', 'Stage'], '555-0101'),
      await addUser('crew2@demo.laborops.app', 'Sam Okafor', 'crew', ['Lighting', 'Rigging'], '555-0102'),
      await addUser('crew3@demo.laborops.app', 'Taylor Nguyen', 'crew', ['Video', 'Camera'], '555-0103'),
      await addUser('crew4@demo.laborops.app', 'Casey Brooks', 'crew', ['Stage', 'Forklift'], '555-0104'),
      await addUser('crew5@demo.laborops.app', 'Riley Chen', 'crew', ['Security'], '555-0105'),
    ];

    const addEvent = async (name: string, venue: string, s: number, e: number) => {
      const eid = id();
      await c.query(
        'INSERT INTO events (id, tenant_id, name, venue, start_date, end_date, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [eid, tenantId, name, venue, dateOnly(s), dateOnly(e), manager],
      );
      return eid;
    };
    const addShift = async (eid: string, role: string, startH: number, endH: number, headcount: number) => {
      const sid = id();
      await c.query(
        'INSERT INTO shifts (id, tenant_id, event_id, role_name, starts_at, ends_at, headcount) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [sid, tenantId, eid, role, hoursFromNow(startH), hoursFromNow(endH), headcount],
      );
      return sid;
    };
    const assign = async (sid: string, uid: string, status: string) => {
      const aid = id();
      await c.query('INSERT INTO shift_assignments (id, tenant_id, shift_id, user_id, status) VALUES ($1,$2,$3,$4,$5)', [
        aid, tenantId, sid, uid, status,
      ]);
      return aid;
    };

    // A finished gig with timesheets waiting for approval.
    const past = await addEvent('Corporate Gala (last week)', 'Grand Hotel Ballroom', -7, -7);
    const pastShift = await addShift(past, 'Audio Tech', -24 * 7, -24 * 7 + 8, 2);
    for (const uid of [crew[0], crew[3]]) {
      const aid = await assign(pastShift, uid, 'accepted');
      await c.query(
        "INSERT INTO time_entries (tenant_id, assignment_id, user_id, clock_in, clock_out, status) VALUES ($1,$2,$3,$4,$5,'submitted')",
        [tenantId, aid, uid, hoursFromNow(-24 * 7), hoursFromNow(-24 * 7 + 7.5)],
      );
    }

    // An upcoming multi-day festival with some roles filled and some open.
    const fest = await addEvent('Summer Music Festival', 'Riverside Park', 1, 3);
    const loadIn = await addShift(fest, 'Stagehand (Load-in)', 24 + 6, 24 + 14, 4);
    const show = await addShift(fest, 'Audio Tech (Show)', 48 + 8, 48 + 16, 2);
    const strike = await addShift(fest, 'Stagehand (Strike)', 72 + 2, 72 + 8, 3);
    await assign(loadIn, crew[0], 'accepted');
    await assign(loadIn, crew[3], 'offered');
    await assign(show, crew[0], 'offered');
    await assign(show, crew[1], 'accepted');
    await assign(strike, crew[3], 'offered');

    // A shift starting now so crew can try clock in/out straight away.
    const today = await addEvent('Warehouse Load-out (today)', 'Main Warehouse', 0, 0);
    const now = await addShift(today, 'Loader', -1, 7, 3);
    await assign(now, crew[0], 'accepted');
    await assign(now, crew[2], 'accepted');

    await seedScheduling(c, tenantId);
    await seedAddresses(c);
    await seedSkills(c, tenantId);
    await audit(c, tenantId, admin, 'tenant.seed', 'tenant', tenantId);
  });
  console.log('demo data created (admin@demo.laborops.app, manager@..., crew1@... through crew5@...)');
}

const DEMO_ADDRESSES: Record<string, string> = {
  'Corporate Gala (last week)': '1700 Lincoln St, Denver, CO 80203',
  'Summer Music Festival': '1101 W 7th Ave, Denver, CO 80204',
  'Warehouse Load-out (today)': '4800 Brighton Blvd, Denver, CO 80216',
};
async function seedAddresses(c: import('pg').PoolClient): Promise<void> {
  for (const [name, addr] of Object.entries(DEMO_ADDRESSES))
    await c.query('UPDATE events SET address = $2 WHERE name = $1 AND address IS NULL', [name, addr]);
}

const DEMO_SKILLS: [string, number][] = [
  ['Audio Tech', 28], ['Camera Operator', 32], ['Forklift Operator', 26], ['Lighting Tech', 30], ['Loader', 20],
  ['Rigger', 38], ['Runner', 18], ['Security', 24], ['Stagehand', 22],
];
const DEMO_CREW_SKILLS: Record<string, string[]> = {
  crew1: ['Audio Tech', 'Stagehand'], crew2: ['Lighting Tech', 'Rigger'], crew3: ['Camera Operator'],
  crew4: ['Stagehand', 'Forklift Operator'], crew5: ['Security', 'Runner'],
};
/** Sample skills and pay rates, once. */
async function seedSkills(c: import('pg').PoolClient, tenantId: string): Promise<void> {
  if ((await c.query('SELECT 1 FROM skills LIMIT 1')).rowCount) return;
  for (const [name, rate] of DEMO_SKILLS) await c.query('INSERT INTO skills (tenant_id, name, pay_rate) VALUES ($1,$2,$3)', [tenantId, name, rate]);
  for (const [k, list] of Object.entries(DEMO_CREW_SKILLS)) await c.query('UPDATE users SET skills = $2 WHERE lower(email) = $1', [`${k}@demo.laborops.app`, list]);
}

/** Sample certificates, availability, an open shift with a pending claim, a swap offer and a template. Runs once. */
async function seedScheduling(c: import('pg').PoolClient, tenantId: string): Promise<void> {
  if ((await c.query('SELECT 1 FROM user_certs LIMIT 1')).rowCount) return;
  const uid = async (email: string) => (await c.query('SELECT id FROM users WHERE lower(email) = $1', [email])).rows[0]?.id as string | undefined;
  const [jordan, sam, taylor, casey, riley, manager] = await Promise.all(
    ['crew1', 'crew2', 'crew3', 'crew4', 'crew5', 'manager'].map((n) => uid(`${n}@demo.laborops.app`)),
  );
  if (!jordan || !sam || !taylor || !casey || !riley) return;
  const cert = (u: string, name: string, days: number) =>
    c.query('INSERT INTO user_certs (tenant_id, user_id, name, expires_on) VALUES ($1,$2,$3,$4)', [tenantId, u, name, dateOnly(days)]);
  await cert(casey, 'Forklift', 180);
  await cert(sam, 'Rigging', 365);
  await cert(sam, 'First Aid', -10); // expired on purpose, so the demo shows an expiry
  await cert(jordan, 'Audio Console', 200);
  for (let d = 1; d <= 5; d++)
    await c.query("INSERT INTO availability (tenant_id, user_id, weekday, start_time, end_time) VALUES ($1,$2,$3,'09:00','17:00')", [tenantId, taylor, d]);

  const fest = (await c.query("SELECT id FROM events WHERE name = 'Summer Music Festival' LIMIT 1")).rows[0]?.id as string | undefined;
  if (fest) {
    await c.query("UPDATE shifts SET is_open = true, required_certs = ARRAY['Forklift'] WHERE event_id = $1 AND role_name = 'Stagehand (Strike)'", [fest]);
    const runner = (
      await c.query(
        `INSERT INTO shifts (tenant_id, event_id, role_name, starts_at, ends_at, headcount, is_open)
         VALUES ($1,$2,'Runner (Show)',$3,$4,2,true) RETURNING id`,
        [tenantId, fest, hoursFromNow(48 + 8), hoursFromNow(48 + 16)],
      )
    ).rows[0].id as string;
    await c.query("INSERT INTO shift_assignments (tenant_id, shift_id, user_id, status) VALUES ($1,$2,$3,'pending')", [tenantId, runner, riley]);
    const showAsg = (
      await c.query(
        `SELECT a.id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
         WHERE s.event_id = $1 AND s.role_name = 'Audio Tech (Show)' AND a.user_id = $2 AND a.status = 'accepted'`,
        [fest, sam],
      )
    ).rows[0]?.id as string | undefined;
    if (showAsg) await c.query('INSERT INTO shift_swaps (tenant_id, assignment_id, offered_by) VALUES ($1,$2,$3)', [tenantId, showAsg, sam]);
  }
  await c.query('INSERT INTO shift_templates (tenant_id, name, items) VALUES ($1,$2,$3)', [
    tenantId,
    'Festival day (load-in, show, strike)',
    JSON.stringify([
      { role: 'Stagehand (Load-in)', dayOffset: 0, start: '06:00', end: '14:00', headcount: 4, isOpen: false, requiredCerts: [] },
      { role: 'Audio Tech (Show)', dayOffset: 1, start: '08:00', end: '16:00', headcount: 2, isOpen: false, requiredCerts: [] },
      { role: 'Runner (Show)', dayOffset: 1, start: '08:00', end: '16:00', headcount: 2, isOpen: true, requiredCerts: [] },
      { role: 'Stagehand (Strike)', dayOffset: 2, start: '14:00', end: '22:00', headcount: 3, isOpen: false, requiredCerts: ['Forklift'] },
    ]),
  ]);
  if (manager) await audit(c, tenantId, manager, 'tenant.seed_scheduling', 'tenant', tenantId);
}

/** Removes the demo company (and everything in it) using the owner connection. */
async function resetDemo(): Promise<void> {
  const c = new Client({ connectionString: config.adminDatabaseUrl });
  await c.connect();
  try {
    const r = await c.query('DELETE FROM tenants WHERE slug = $1', [DEMO_SLUG]);
    console.log(`demo data removed (${r.rowCount} company)`);
  } finally {
    await c.end();
  }
}

if (require.main === module) {
  migrateWithRetry()
    .then(() => (process.argv.includes('--reset') ? resetDemo() : undefined))
    .then(seedDemo)
    .then(() => pool.end())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
