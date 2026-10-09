import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { migrate } from '../src/migrate';
import { buildApp } from '../src/app';
import { pool, withTenant } from '../src/db';

let app: FastifyInstance;
const run = Date.now().toString(36);

before(async () => {
  await migrate();
  app = await buildApp();
});
after(async () => {
  await app.close();
  await pool.end();
});

type Session = { cookie: string; id: string; tid?: string };

async function call(s: Session | null, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
  const res = await app.inject({
    method,
    url,
    payload: body as object | undefined,
    headers: s ? { cookie: s.cookie } : {},
  });
  let json: any = undefined;
  try {
    json = res.json();
  } catch {
    /* csv */
  }
  return { status: res.statusCode, json, text: res.body, res };
}

async function register(tag: string): Promise<Session> {
  const r = await call(null, 'POST', '/api/auth/register', {
    company: `Co ${tag} ${run}`,
    name: `Admin ${tag}`,
    email: `admin-${tag}-${run}@test.example`,
    password: 'password123',
  });
  assert.equal(r.status, 200, r.text);
  const c = r.res.cookies.find((x) => x.name === 'lo_token')!;
  return { cookie: `lo_token=${c.value}`, id: r.json.user.id };
}

async function login(email: string, password: string): Promise<Session> {
  const r = await call(null, 'POST', '/api/auth/login', { email, password });
  assert.equal(r.status, 200, r.text);
  const c = r.res.cookies.find((x) => x.name === 'lo_token')!;
  return { cookie: `lo_token=${c.value}`, id: r.json.user.id };
}

const start = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

test('auth: wrong password and unauthenticated access are rejected', async () => {
  const a = await register('auth');
  assert.equal((await call(null, 'POST', '/api/auth/login', { email: `admin-auth-${run}@test.example`, password: 'nope-nope' })).status, 401);
  assert.equal((await call(null, 'GET', '/api/events')).status, 401);
  assert.equal((await call(a, 'GET', '/api/auth/me')).json.user.role, 'admin');
  // duplicate email
  const dup = await call(null, 'POST', '/api/auth/register', {
    company: 'Another', name: 'X', email: `admin-auth-${run}@test.example`, password: 'password123',
  });
  assert.equal(dup.status, 409);
});

test('tenant isolation: company B cannot see or touch company A data (API level)', async () => {
  const a = await register('isoA');
  const b = await register('isoB');
  const ev = await call(a, 'POST', '/api/events', { name: 'Secret Show', startDate: '2030-01-01', endDate: '2030-01-02' });
  assert.equal(ev.status, 201);
  const evId = ev.json.event.id;
  const sh = await call(a, 'POST', `/api/events/${evId}/shifts`, { roleName: 'Tech', startsAt: start(1), endsAt: start(5), headcount: 1 });
  assert.equal(sh.status, 201);

  assert.deepEqual((await call(b, 'GET', '/api/events')).json.events, []);
  assert.equal((await call(b, 'GET', `/api/events/${evId}`)).status, 404);
  assert.equal((await call(b, 'DELETE', `/api/events/${evId}`)).status, 404);
  assert.equal((await call(b, 'POST', `/api/events/${evId}/shifts`, { roleName: 'X', startsAt: start(1), endsAt: start(2) })).status, 404);
  assert.equal((await call(b, 'DELETE', `/api/shifts/${sh.json.shift.id}`)).status, 404);
  assert.equal((await call(b, 'GET', '/api/crew')).json.crew.length, 1); // only B's own admin
  // A still has it
  assert.equal((await call(a, 'GET', `/api/events/${evId}`)).status, 200);
});

test('tenant isolation: Row-Level Security holds even when the application code is wrong', async () => {
  const a = await register('rlsA');
  const b = await register('rlsB');
  const tidOf = async (sess: Session) =>
    (await adminQuery('SELECT tenant_id FROM users WHERE id = $1', [sess.id])).rows[0].tenant_id as string;
  const tidA = await tidOf(a);
  const tidB = await tidOf(b);
  await call(a, 'POST', '/api/events', { name: 'RLS event', startDate: '2030-01-01', endDate: '2030-01-01' });

  // In B's context, an unfiltered SELECT sees none of A's rows.
  const seen = await withTenant(tidB, async (c) => (await c.query('SELECT count(*)::int AS n FROM events')).rows[0].n);
  assert.equal(seen, 0);
  const users = await withTenant(tidB, async (c) => (await c.query('SELECT tenant_id FROM users')).rows);
  assert.ok(users.every((u) => u.tenant_id === tidB));
  // With no tenant context at all, nothing is visible.
  const none = await pool.query('SELECT count(*)::int AS n FROM events');
  assert.equal(none.rows[0].n, 0);
  // B cannot write a row that belongs to A.
  await assert.rejects(
    withTenant(tidB, (c) =>
      c.query('INSERT INTO events (tenant_id, name, start_date, end_date) VALUES ($1, $2, now(), now())', [tidA, 'planted']),
    ),
    /row-level security/i,
  );
  // B cannot read or modify A's tenant record, and cannot delete A's rows.
  assert.equal((await withTenant(tidB, (c) => c.query('SELECT 1 FROM tenants WHERE id = $1', [tidA]))).rowCount, 0);
  assert.equal((await withTenant(tidB, (c) => c.query("DELETE FROM events WHERE tenant_id = $1", [tidA]))).rowCount, 0);
  // The audit log cannot be rewritten by the app role.
  await assert.rejects(withTenant(tidA, (c) => c.query("UPDATE audit_logs SET action = 'x'")), /permission denied/i);
});

async function adminQuery(sql: string, params: unknown[]) {
  const { Client } = await import('pg');
  const { config } = await import('../src/config');
  const c = new Client({ connectionString: config.adminDatabaseUrl });
  await c.connect();
  try {
    return await c.query(sql, params);
  } finally {
    await c.end();
  }
}

test('roles: crew cannot use manager endpoints', async () => {
  const a = await register('roles');
  const m = await call(a, 'POST', '/api/crew', { name: 'Cree Crew', email: `crew-roles-${run}@test.example`, skills: ['Audio'] });
  assert.equal(m.status, 201);
  const crew = await login(`crew-roles-${run}@test.example`, m.json.tempPassword);
  assert.equal((await call(crew, 'GET', '/api/crew')).status, 403);
  assert.equal((await call(crew, 'POST', '/api/events', { name: 'x', startDate: '2030-01-01', endDate: '2030-01-01' })).status, 403);
  assert.equal((await call(crew, 'GET', '/api/timesheets/export.csv')).status, 403);
  // managers cannot create managers; admins can
  const mgr = await call(a, 'POST', '/api/crew', { name: 'Mo Mgr', email: `mgr-roles-${run}@test.example`, role: 'manager', password: 'password123' });
  assert.equal(mgr.status, 201);
  const mgrSession = await login(`mgr-roles-${run}@test.example`, 'password123');
  assert.equal((await call(mgrSession, 'POST', '/api/crew', { name: 'No', email: `no-${run}@test.example`, role: 'manager' })).status, 403);
});

test('scheduling: double-booking and overfilling are blocked', async () => {
  const a = await register('sched');
  const mk = async (n: string) =>
    (await call(a, 'POST', '/api/crew', { name: n, email: `${n}-sched-${run}@test.example` })).json.member.id as string;
  const [c1, c2] = [await mk('c1'), await mk('c2')];
  const ev = (await call(a, 'POST', '/api/events', { name: 'Fest', startDate: '2030-01-01', endDate: '2030-01-02' })).json.event.id;
  const s1 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'A', startsAt: start(10), endsAt: start(14), headcount: 1 })).json.shift.id;
  const s2 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'B', startsAt: start(12), endsAt: start(16), headcount: 1 })).json.shift.id;
  const s3 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'C', startsAt: start(14), endsAt: start(18), headcount: 1 })).json.shift.id;

  assert.equal((await call(a, 'POST', `/api/shifts/${s1}/assign`, { userId: c1 })).status, 201);
  const clash = await call(a, 'POST', `/api/shifts/${s2}/assign`, { userId: c1 });
  assert.equal(clash.status, 409);
  assert.match(clash.json.error, /already booked/);
  // back-to-back (ends exactly when the next starts) is allowed
  assert.equal((await call(a, 'POST', `/api/shifts/${s3}/assign`, { userId: c1 })).status, 201);
  // full shift
  const full = await call(a, 'POST', `/api/shifts/${s1}/assign`, { userId: c2 });
  assert.equal(full.status, 409);
  assert.match(full.json.error, /full/);
  // bad input
  assert.equal((await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Z', startsAt: start(5), endsAt: start(4) })).status, 400);
});

test('time: accept, clock in/out, approve, export CSV', async () => {
  const a = await register('time');
  const mem = await call(a, 'POST', '/api/crew', { name: '=Evil Name', email: `t1-${run}@test.example`, password: 'password123' });
  const crew = await login(`t1-${run}@test.example`, 'password123');
  const ev = (await call(a, 'POST', '/api/events', { name: 'Load-out', startDate: '2030-01-01', endDate: '2030-01-01' })).json.event.id;
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Loader', startsAt: start(-1), endsAt: start(6), headcount: 2 })).json.shift.id;
  const asg = (await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: mem.json.member.id })).json.assignment.id;

  // can't clock in before accepting
  assert.equal((await call(crew, 'POST', '/api/time/clock-in', { assignmentId: asg })).status, 404);
  const mine = await call(crew, 'GET', '/api/my/shifts');
  assert.equal(mine.json.shifts.length, 1);
  assert.equal(mine.json.shifts[0].status, 'offered');
  assert.equal((await call(crew, 'POST', `/api/assignments/${asg}/respond`, { response: 'accepted' })).status, 200);
  assert.equal((await call(crew, 'POST', '/api/time/clock-in', { assignmentId: asg })).status, 201);
  assert.equal((await call(crew, 'POST', '/api/time/clock-in', { assignmentId: asg })).status, 409);
  assert.equal((await call(crew, 'POST', '/api/time/clock-out')).status, 200);
  assert.equal((await call(crew, 'POST', '/api/time/clock-out')).status, 409);

  const pending = (await call(a, 'GET', '/api/timesheets?status=submitted')).json.entries;
  assert.equal(pending.length, 1);
  assert.equal((await call(crew, 'POST', `/api/timesheets/${pending[0].id}/approve`)).status, 403);
  assert.equal((await call(a, 'POST', `/api/timesheets/${pending[0].id}/approve`)).status, 200);
  assert.equal((await call(a, 'POST', `/api/timesheets/${pending[0].id}/approve`)).status, 404); // already approved

  const csv = await call(a, 'GET', '/api/timesheets/export.csv');
  assert.equal(csv.status, 200);
  assert.match(String(csv.res.headers['content-type']), /text\/csv/);
  const lines = csv.text.trim().split('\r\n');
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith("'=Evil Name,"), 'formula-looking names are neutralised: ' + lines[1]);

  // A shift that is still hours away cannot be clocked in to yet.
  const later = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Later', startsAt: start(10), endsAt: start(14), headcount: 1 })).json.shift.id;
  const laterAsg = (await call(a, 'POST', `/api/shifts/${later}/assign`, { userId: mem.json.member.id })).json.assignment.id;
  await call(crew, 'POST', `/api/assignments/${laterAsg}/respond`, { response: 'accepted' });
  const early = await call(crew, 'POST', '/api/time/clock-in', { assignmentId: laterAsg });
  assert.equal(early.status, 409);
  assert.match(early.json.error, /opens 1 hour before/);
  const flags = (await call(crew, 'GET', '/api/my/shifts')).json.shifts;
  assert.equal(flags.find((x: any) => x.assignment_id === laterAsg).can_clock_in, false);

  const dash = (await call(a, 'GET', '/api/dashboard')).json;
  assert.equal(dash.pendingApprovals, 0);
  assert.equal(dash.crewCount, 1);
});
