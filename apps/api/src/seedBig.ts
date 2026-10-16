import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { PoolClient } from 'pg';
import { pool, withTenant, audit } from './db';
import { config } from './config';
import { roleKeyOf } from './pay';

/**
 * The public demo (demoapp.laborops.app): on top of the regular demo company, a busy season of sample data —
 * ~45 crew, a dozen customers, ~40 events from two months back to six weeks ahead with phases, shifts, crew, approved
 * time, ratings, quotes, invoices, an archive, plus an HR account. Runs once per fresh demo database.
 * Deterministic (seeded random), so every demo looks the same.
 */
let seed = 20261016;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

const FIRST = ['Avery', 'Blake', 'Cameron', 'Dakota', 'Emerson', 'Finley', 'Gray', 'Harley', 'Indy', 'Jesse', 'Kai', 'Logan', 'Marley', 'Noel', 'Oakley', 'Parker',
  'Quinn', 'Reese', 'Sage', 'Tatum', 'Umi', 'Val', 'Wren', 'Xan', 'Yael', 'Zion', 'Ari', 'Bo', 'Cruz', 'Devon', 'Eli', 'Frankie', 'Gale', 'Hayden', 'Ira', 'Jules', 'Kendall', 'Lane', 'Milan', 'Nico'];
const LAST = ['Alvarez', 'Bennett', 'Castillo', 'Dawson', 'Ellis', 'Foster', 'Garcia', 'Hughes', 'Ibarra', 'Jensen', 'Kim', 'Lopez', 'Moreno', 'Nash', 'Ortiz', 'Patel',
  'Quintero', 'Ramos', 'Silva', 'Torres', 'Underwood', 'Vasquez', 'Walsh', 'Xu', 'Young', 'Zamora', 'Avila', 'Brooks', 'Chavez', 'Diaz', 'Evans', 'Flores', 'Gomez', 'Hale', 'Irwin', 'James', 'Kerr', 'Lin', 'Mendez', 'Novak'];
const ROLES: [string, number, number][] = [
  // role, pay, bill
  ['Stagehand', 22, 48], ['Loader', 20, 42], ['Audio Tech', 28, 62], ['Lighting Tech', 30, 65], ['Rigger', 38, 85], ['Forklift Operator', 26, 55],
  ['Camera Operator', 32, 70], ['Runner', 18, 38], ['Security', 24, 50],
];
const CUSTOMERS: [string, string, string][] = [
  ['Live Nation Rocky Mountains', 'Dana Price', 'Denver, CO'], ['Red Rocks Amphitheatre', 'Chris Vail', 'Morrison, CO'], ['Ball Arena Events', 'Pat Moreno', 'Denver, CO'],
  ['Colorado Convention Center', 'Lee Hart', 'Denver, CO'], ['Mile High Corporate Events', 'Robin Shaw', 'Englewood, CO'], ['Boulder Theater', 'Sky Patel', 'Boulder, CO'],
  ['Fiddler’s Green', 'Jo Kim', 'Greenwood Village, CO'], ['Broomfield Event Center', 'Max Ruiz', 'Broomfield, CO'], ['Denver Botanic Gardens', 'Ash Lee', 'Denver, CO'],
  ['Mission Ballroom', 'Tess Nguyen', 'Denver, CO'], ['Gaylord Rockies', 'Drew Foster', 'Aurora, CO'], ['Coors Field Events', 'Sam Ortiz', 'Denver, CO'],
];
const SHOWS = ['Spring Product Launch', 'Tech Summit', 'Holiday Gala', 'Charity Auction', 'Jazz Night', 'Rock Festival', 'Trade Show', 'Graduation Ceremony', 'Film Premiere',
  'Wedding Expo', 'Comedy Tour', 'Symphony Pops', 'Esports Finals', 'Auto Show', 'Fashion Week', 'Brewfest', 'Marathon Expo', 'Country Music Night', 'Corporate Retreat',
  'Food & Wine Festival', 'Hip-Hop Showcase', 'Ballet Gala', 'Home Show', 'Car Launch', 'Awards Dinner', 'Electronic Music Night', 'Gaming Convention', 'Bridal Show',
  'Art Fair', 'Shareholder Meeting', 'Christmas Market', 'Indie Rock Weekend', 'Opera Night', 'Science Expo', 'Film Festival', 'Kids Fest', 'Pumpkin Festival', 'Rodeo', 'Gala Dinner', 'Tattoo Expo'];

const VENUES = ['Main Stage', 'Exhibit Hall A', 'Grand Ballroom', 'North Lawn', 'Arena Floor', 'Studio 3', 'Pavilion', 'Amphitheatre', 'Hall B', 'Rooftop Terrace'];
const DAY = 86400_000;
const ymd = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
/** A time on a day relative to today, in the company's time zone (approximately: Denver = UTC−6). */
const at = (dayOffset: number, hour: number) => {
  const d = new Date(Date.now() + dayOffset * DAY);
  d.setUTCHours(hour + 6, 0, 0, 0);
  return d;
};

export async function seedBigDemo(): Promise<void> {
  const found = await pool.query('SELECT tenant_id FROM auth_find_user($1)', ['admin@demo.laborops.app']);
  if (!found.rowCount) return;
  const tid = found.rows[0].tenant_id as string;
  if ((await pool.query('SELECT 1 FROM auth_find_user($1)', ['hr@demo.laborops.app'])).rowCount) return; // already done
  const hash = await bcrypt.hash(config.demoPassword, 10);
  await withTenant(tid, (c) => big(c, tid, hash));
  console.log('big demo data created');
}

async function big(c: PoolClient, tid: string, hash: string) {
  const id = () => crypto.randomUUID();
  const one = async (sql: string, p: unknown[]) => (await c.query(sql, p)).rows[0];
  const admin = (await one("SELECT id FROM users WHERE email = 'admin@demo.laborops.app'", [])).id as string;
  const manager = (await one("SELECT id FROM users WHERE email = 'manager@demo.laborops.app'", [])).id as string;
  await c.query("INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES ($1,'hr@demo.laborops.app','Harper Hill','hr',$2)", [tid, hash]);
  await c.query("UPDATE tenants SET name = 'Summit Stage Crew (demo)' WHERE id = $1", [tid]);

  // Roles with pay and bill rates
  for (const [name, pay, bill] of ROLES)
    await c.query(
      `INSERT INTO skills (tenant_id, name, pay_rate, bill_rate) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, lower(name)) DO UPDATE SET pay_rate = EXCLUDED.pay_rate, bill_rate = EXCLUDED.bill_rate`,
      [tid, name, pay, bill],
    );

  // Crew: the five named demo crew plus 40 more
  const crew: { id: string; skills: string[] }[] = (await c.query("SELECT id, skills FROM users WHERE role = 'crew' AND active")).rows;
  for (let i = 0; i < 40; i++) {
    const name = `${FIRST[i]} ${LAST[(i * 7) % LAST.length]}`;
    const skills = [...new Set([pick(ROLES)[0], pick(ROLES)[0], i % 3 === 0 ? 'Stagehand' : pick(ROLES)[0]])].slice(0, int(1, 3));
    const uid = id();
    await c.query(
      'INSERT INTO users (id, tenant_id, email, name, role, password_hash, skills, phone, payroll_ids) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [uid, tid, `crew${i + 6}@demo.laborops.app`, name, 'crew', hash, skills, `555-01${String(i + 10).padStart(2, '0')}`, JSON.stringify({ adp: String(100200 + i) })],
    );
    crew.push({ id: uid, skills });
    if (i % 5 === 0) await c.query('INSERT INTO user_certs (tenant_id, user_id, name, expires_on) VALUES ($1,$2,$3,$4)', [tid, uid, pick(['Forklift', 'OSHA 10', 'First Aid', 'Rigging']), ymd(int(-20, 400))]);
  }

  // Customers
  const customers: string[] = [];
  for (const [name, contact, city] of CUSTOMERS) {
    const r = await c.query("INSERT INTO customers (tenant_id, name, stage) VALUES ($1,$2,'active') ON CONFLICT DO NOTHING RETURNING id", [tid, name]);
    if (!r.rows[0]) continue;
    const cid = r.rows[0].id as string;
    customers.push(cid);
    await c.query('INSERT INTO customer_contacts (tenant_id, customer_id, name, title, email, phone, is_primary) VALUES ($1,$2,$3,$4,$5,$6,true)',
      [tid, cid, contact, 'Production Manager', `${contact.split(' ')[0].toLowerCase()}@example.com`, `303-555-${String(int(1000, 9999))}`]);
    await c.query('INSERT INTO customer_locations (tenant_id, customer_id, label, venue, address, is_default) VALUES ($1,$2,$3,$4,$5,true)',
      [tid, cid, 'Main venue', name.replace(/ Events$/, ''), city]);
  }

  // Events across the season
  const busy = new Map<string, Set<number>>(); // who works which day
  const free = (uid: string, day: number) => !busy.get(uid)?.has(day);
  const book = (uid: string, day: number) => busy.set(uid, (busy.get(uid) ?? new Set()).add(day));
  let quoteNo = Number((await one('SELECT COALESCE(max(number), 1000) AS n FROM quotes', [])).n);
  for (let i = 0; i < SHOWS.length; i++) {
    const start = -70 + Math.round(i * 3.1) + int(-1, 1);
    const days = pick([1, 1, 1, 2, 2, 3]);
    const end = start + days - 1;
    const cust = pick(customers);
    const custName = await one('SELECT c.name, l.address FROM customers c LEFT JOIN customer_locations l ON l.customer_id = c.id AND l.is_default WHERE c.id = $1', [cust]);
    const eid = id();
    const status = end < 0 ? 'completed' : start <= 0 && end >= 0 ? 'in_progress' : start < 14 ? 'confirmed' : pick(['confirmed', 'quote', 'pending']);
    await c.query(
      `INSERT INTO events (id, tenant_id, name, venue, address, start_date, end_date, created_by, customer_id, pipeline_status, priority, labor_budget)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [eid, tid, `${SHOWS[i]} ${new Date(Date.now() + start * DAY).getUTCFullYear()}`, pick(VENUES), custName.address, ymd(start), ymd(end), manager, cust, status,
        pick(['low', 'medium', 'medium', 'high']), i % 3 === 0 ? int(3, 12) * 1000 : null],
    );
    let billed = 0;
    for (let d = 0; d < days; d++) {
      const day = start + d;
      await c.query('INSERT INTO event_phases (tenant_id, event_id, label, starts_on, ends_on) VALUES ($1,$2,$3,$4,$4)',
        [tid, eid, days === 1 ? 'Show day' : d === 0 ? 'Load in' : d === days - 1 ? 'Strike' : 'Show day', ymd(day)]);
      const roles = [...new Set(Array.from({ length: int(3, 5) }, () => pick(ROLES)))];
      for (const [role, , bill] of roles) {
        const startH = pick([6, 7, 8, 12, 16]);
        const len = pick([4, 6, 8, 8, 10]);
        const head = int(2, 7);
        const sid = id();
        await c.query(
          'INSERT INTO shifts (id, tenant_id, event_id, role_name, starts_at, ends_at, headcount, min_hours) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [sid, tid, eid, role, at(day, startH), at(day, startH + len), head, len <= 4 ? 4 : null],
        );
        const fit = crew.filter((p) => p.skills.includes(role) && free(p.id, day)).sort(() => rnd() - 0.5);
        const others = crew.filter((p) => !p.skills.includes(role) && free(p.id, day)).sort(() => rnd() - 0.5);
        const fillTo = day < 0 ? head : day < 10 ? head - int(0, 1) : Math.max(0, head - int(1, head));
        const people = [...fit, ...others].slice(0, Math.max(0, fillTo));
        for (const [k, p] of people.entries()) {
          book(p.id, day);
          const st = day < 0 ? 'accepted' : k % 4 === 3 ? 'offered' : 'accepted';
          const aid = id();
          await c.query('INSERT INTO shift_assignments (id, tenant_id, shift_id, user_id, status, is_lead) VALUES ($1,$2,$3,$4,$5,$6)', [aid, tid, sid, p.id, st, k === 0 && head >= 4]);
          if (day < 0) {
            // Worked: approved time (the last few days still waiting), with some early/late variance and a rare no-show
            if (rnd() < 0.03) { await c.query('UPDATE shift_assignments SET no_show_at = $2 WHERE id = $1', [aid, at(day, startH + 1)]); continue; }
            const inAt = new Date(+at(day, startH) + int(-10, 12) * 60_000);
            const outAt = new Date(+at(day, startH + len) + int(-30, 45) * 60_000);
            const approved = day < -3;
            await c.query(
              `INSERT INTO time_entries (tenant_id, assignment_id, user_id, clock_in, clock_out, status, approved_at, approved_by, auto_approved)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [tid, aid, p.id, inAt, outAt, approved ? 'approved' : 'submitted', approved ? outAt : null, approved && rnd() < 0.4 ? manager : null, approved && rnd() >= 0.4],
            );
            billed += ((+outAt - +inAt) / 3600_000) * bill;
            if (rnd() < 0.7)
              await c.query(
                'INSERT INTO crew_reviews (tenant_id, user_id, role_key, stars, tags, shift_id, event_id, rated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING',
                [tid, p.id, roleKeyOf(role), pick([3, 4, 4, 5, 5, 5]), rnd() < 0.3 ? [pick(['on_time', 'hard_worker', 'skilled', 'team_player'])] : [], sid, eid, manager],
              );
          }
        }
      }
    }
    // Quotes: accepted for most booked work, sent or draft for the pipeline
    if (status !== 'pending' || rnd() < 0.3) {
      const qid = id();
      const qs = status === 'quote' ? 'sent' : status === 'pending' ? 'draft' : 'accepted';
      await c.query('INSERT INTO quotes (id, tenant_id, number, customer_id, event_id, title, status, tax_pct, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,8,$8)',
        [qid, tid, ++quoteNo, cust, eid, `Labor estimate`, qs, manager]);
      for (const [k, [role, , bill]] of ROLES.slice(0, int(2, 5)).entries())
        await c.query('INSERT INTO quote_lines (tenant_id, quote_id, sort, description, qty, hours, rate) VALUES ($1,$2,$3,$4,$5,$6,$7)', [tid, qid, k, role, int(1, 3), 6 * days, bill]);
    }
    // Invoices: completed events more than ~10 days ago are invoiced and archived; a couple are canceled
    if (status === 'completed' && end < -10 && billed > 0) {
      await c.query("INSERT INTO event_invoices (tenant_id, event_id, provider, source, doc_number, total, created_by) VALUES ($1,$2,'iif','time',$3,$4,$5)",
        [tid, eid, `INV-${2400 + i}`, Math.round(billed * 100) / 100, admin]);
      await c.query("UPDATE events SET archived_at = now() - make_interval(days => $2), archive_reason = 'invoiced', archived_by = $3, invoice_alert_at = now() WHERE id = $1", [eid, int(1, 8), admin]);
    } else if (status === 'completed') {
      await c.query('UPDATE events SET invoice_alert_at = now() WHERE id = $1', [eid]);
    }
    if (i === 7 || i === 29) {
      await c.query("UPDATE events SET pipeline_status = 'canceled', archived_at = now(), archive_reason = 'canceled', archived_by = $2 WHERE id = $1", [eid, manager]);
    }
  }
  // The regular demo events follow the calendar too.
  await c.query("UPDATE events SET pipeline_status = 'completed' WHERE end_date < current_date AND pipeline_status NOT IN ('completed', 'canceled')");
  await c.query("UPDATE events SET pipeline_status = 'in_progress' WHERE start_date <= current_date AND end_date >= current_date AND pipeline_status NOT IN ('completed', 'canceled', 'in_progress')");
  // A notice for HR and the admin: something ready to invoice
  const ready = await one("SELECT id, name FROM events WHERE pipeline_status = 'completed' AND archived_at IS NULL ORDER BY end_date DESC LIMIT 1", []);
  if (ready) {
    const hr = (await one("SELECT id FROM users WHERE email = 'hr@demo.laborops.app'", [])).id;
    for (const uid of [hr, admin])
      await c.query("INSERT INTO notifications (tenant_id, user_id, category, title, body, link) VALUES ($1,$2,'billing',$3,$4,$5)",
        [tid, uid, `Ready to invoice: ${ready.name}`, `${ready.name} is completed and ready to be invoiced.`, `/events/${ready.id}#invoice`]);
  }
  await audit(c, tid, admin, 'tenant.seed_big', 'tenant', tid);
}
