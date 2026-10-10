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

async function call(s: Session | null, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) {
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

async function mkCrew(a: Session, tag: string) {
  const m = await call(a, 'POST', '/api/crew', { name: `Crew ${tag}`, email: `${tag}-${run}@test.example`, password: 'password123' });
  assert.equal(m.status, 201, m.text);
  return { id: m.json.member.id as string, session: await login(`${tag}-${run}@test.example`, 'password123') };
}
async function mkEvent(a: Session) {
  return (await call(a, 'POST', '/api/events', { name: 'Show', startDate: '2030-01-01', endDate: '2030-01-02' })).json.event.id as string;
}

test('certificates: required certs are enforced (missing, expired, valid)', async () => {
  const a = await register('certs');
  const c1 = await mkCrew(a, 'cert1');
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Fork', startsAt: start(30), endsAt: start(36), headcount: 2, requiredCerts: ['Forklift'] })).json.shift.id;

  const missing = await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id });
  assert.equal(missing.status, 409);
  assert.equal(missing.json.reason, 'missing_cert');
  // the manager's view marks them ineligible
  const detail = await call(a, 'GET', `/api/events/${ev}`);
  assert.deepEqual(detail.json.shifts[0].crew_status[0].missing_certs, ['Forklift']);

  // an expired cert does not count
  assert.equal((await call(a, 'POST', `/api/crew/${c1.id}/certs`, { name: 'forklift', expiresOn: '2020-01-01' })).status, 201);
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id })).status, 409);
  // renewing it (same name, case-insensitive) fixes it
  assert.equal((await call(a, 'POST', `/api/crew/${c1.id}/certs`, { name: 'Forklift', expiresOn: '2099-01-01' })).status, 201);
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id })).status, 201);
  // crew cannot manage certs
  assert.equal((await call(c1.session, 'POST', `/api/crew/${c1.id}/certs`, { name: 'Self-made' })).status, 403);
});

test('availability: outside weekly availability needs a manager override; time off counts too', async () => {
  const a = await register('avail');
  const c1 = await mkCrew(a, 'av1');
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'A', startsAt: start(30), endsAt: start(36), headcount: 3 })).json.shift.id;
  // no availability set = always available
  const fine = await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: (await mkCrew(a, 'av0')).id });
  assert.equal(fine.status, 201);
  // only 00:00-00:30 every day: a six hour shift can never fit
  const windows = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, startTime: '00:00', endTime: '00:30' }));
  assert.equal((await call(c1.session, 'PUT', '/api/my/availability', { windows })).status, 200);
  assert.equal((await call(c1.session, 'PUT', '/api/my/availability', { windows: [{ weekday: 1, startTime: '10:00', endTime: '09:00' }] })).status, 400);
  const blocked = await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.reason, 'unavailable');
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id, override: true })).status, 201);

  // time off
  const c2 = await mkCrew(a, 'av2');
  const sh2 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'B', startsAt: start(100), endsAt: start(104), headcount: 1 })).json.shift.id;
  const day = (h: number) => new Date(Date.now() + h * 3600_000).toISOString().slice(0, 10);
  assert.equal((await call(c2.session, 'POST', '/api/my/time-off', { startsOn: day(90), endsOn: day(110) })).status, 201);
  const off = await call(a, 'POST', `/api/shifts/${sh2}/assign`, { userId: c2.id });
  assert.equal(off.status, 409);
  assert.equal(off.json.reason, 'unavailable');
  const mine = await call(c2.session, 'GET', '/api/my/availability');
  assert.equal(mine.json.timeOff.length, 1);
  assert.equal((await call(c2.session, 'DELETE', `/api/my/time-off/${mine.json.timeOff[0].id}`)).status, 200);
  assert.equal((await call(a, 'POST', `/api/shifts/${sh2}/assign`, { userId: c2.id })).status, 201);
});

test('open shifts: claim, hold the slot, manager approves or rejects', async () => {
  const a = await register('claim');
  const [c1, c2, c3] = [await mkCrew(a, 'cl1'), await mkCrew(a, 'cl2'), await mkCrew(a, 'cl3')];
  const ev = await mkEvent(a);
  const closed = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Closed', startsAt: start(40), endsAt: start(44), headcount: 1 })).json.shift.id;
  const open = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Open', startsAt: start(50), endsAt: start(54), headcount: 1, isOpen: true })).json.shift.id;
  const gated = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Gated', startsAt: start(60), endsAt: start(64), headcount: 1, isOpen: true, requiredCerts: ['Rigging'] })).json.shift.id;

  // only open shifts are listed; the gated one is visible but not claimable
  const list = await call(c1.session, 'GET', '/api/open-shifts');
  assert.deepEqual(list.json.shifts.map((s: any) => s.role_name), ['Open', 'Gated']);
  assert.equal(list.json.shifts[1].can_claim, false);
  assert.match(list.json.shifts[1].reason, /Rigging/);
  assert.equal((await call(c1.session, 'POST', `/api/shifts/${closed}/claim`)).status, 404);
  assert.equal((await call(c1.session, 'POST', `/api/shifts/${gated}/claim`)).status, 409);

  const claim = await call(c1.session, 'POST', `/api/shifts/${open}/claim`);
  assert.equal(claim.status, 201, claim.text);
  // the pending claim holds the slot, so a second person is turned away
  assert.equal((await call(c2.session, 'POST', `/api/shifts/${open}/claim`)).status, 409);
  assert.equal((await call(c1.session, 'POST', `/api/shifts/${open}/claim`)).status, 409);
  // a pending claim cannot be used to clock in
  assert.equal((await call(c1.session, 'POST', '/api/time/clock-in', { assignmentId: claim.json.assignmentId })).status, 404);

  const reqs = await call(a, 'GET', '/api/requests');
  assert.equal(reqs.json.claims.length, 1);
  assert.equal(reqs.json.claims[0].user_name, 'Crew cl1');
  // crew cannot approve their own claim
  assert.equal((await call(c1.session, 'POST', `/api/assignments/${claim.json.assignmentId}/approve`)).status, 403);
  assert.equal((await call(a, 'POST', `/api/assignments/${claim.json.assignmentId}/approve`)).status, 200);
  assert.equal((await call(a, 'POST', `/api/assignments/${claim.json.assignmentId}/approve`)).status, 404);
  const mine = await call(c1.session, 'GET', '/api/my/shifts');
  assert.equal(mine.json.shifts.find((s: any) => s.role_name === 'Open').status, 'accepted');

  // rejecting frees the slot
  const open2 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Open2', startsAt: start(70), endsAt: start(74), headcount: 1, isOpen: true })).json.shift.id;
  const claim3 = await call(c3.session, 'POST', `/api/shifts/${open2}/claim`);
  assert.equal(claim3.status, 201);
  assert.equal((await call(a, 'POST', `/api/assignments/${claim3.json.assignmentId}/reject`)).status, 200);
  assert.equal((await call(c2.session, 'POST', `/api/shifts/${open2}/claim`)).status, 201);
  // toggling a shift closed removes it from the list
  assert.equal((await call(a, 'PATCH', `/api/shifts/${open2}`, { isOpen: false })).status, 200);
  assert.equal((await call(c1.session, 'GET', '/api/open-shifts')).json.shifts.some((s: any) => s.role_name === 'Open2'), false);
});

test('swaps: offer, take, manager approval moves the shift; clashes and certs block taking', async () => {
  const a = await register('swap');
  const [c1, c2, c3] = [await mkCrew(a, 'sw1'), await mkCrew(a, 'sw2'), await mkCrew(a, 'sw3')];
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Swap me', startsAt: start(50), endsAt: start(56), headcount: 1 })).json.shift.id;
  const asg = (await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id })).json.assignment.id;

  // only an accepted assignment can be offered
  assert.equal((await call(c1.session, 'POST', `/api/assignments/${asg}/offer-swap`)).status, 404);
  assert.equal((await call(c1.session, 'POST', `/api/assignments/${asg}/respond`, { response: 'accepted' })).status, 200);
  assert.equal((await call(c2.session, 'POST', `/api/assignments/${asg}/offer-swap`)).status, 404);
  const offer = await call(c1.session, 'POST', `/api/assignments/${asg}/offer-swap`);
  assert.equal(offer.status, 201, offer.text);
  assert.equal((await call(c1.session, 'POST', `/api/assignments/${asg}/offer-swap`)).status, 409);
  assert.equal((await call(c1.session, 'GET', '/api/my/shifts')).json.shifts[0].swap_status, 'open');

  // c3 is busy at that time, so cannot take it
  const other = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Busy', startsAt: start(52), endsAt: start(54), headcount: 1 })).json.shift.id;
  assert.equal((await call(a, 'POST', `/api/shifts/${other}/assign`, { userId: c3.id })).status, 201);
  const board3 = await call(c3.session, 'GET', '/api/swaps/board');
  assert.equal(board3.json.swaps[0].can_take, false);
  assert.equal((await call(c3.session, 'POST', `/api/swaps/${offer.json.swapId}/take`)).status, 409);
  // you can't take your own offer
  assert.equal((await call(c1.session, 'POST', `/api/swaps/${offer.json.swapId}/take`)).status, 409);

  const board = await call(c2.session, 'GET', '/api/swaps/board');
  assert.equal(board.json.swaps.length, 1);
  assert.equal(board.json.swaps[0].can_take, true);
  assert.equal((await call(c2.session, 'POST', `/api/swaps/${offer.json.swapId}/take`)).status, 200);
  // now it needs a manager
  assert.equal((await call(c2.session, 'GET', '/api/swaps/board')).json.swaps.length, 0);
  const reqs = await call(a, 'GET', '/api/requests');
  assert.equal(reqs.json.swaps.length, 1);
  assert.equal(reqs.json.swaps[0].taken_by_name, 'Crew sw2');
  assert.equal((await call(c2.session, 'POST', `/api/swaps/${offer.json.swapId}/approve`)).status, 403);
  assert.equal((await call(a, 'POST', `/api/swaps/${offer.json.swapId}/approve`)).status, 200);

  // the shift moved from c1 to c2, accepted
  assert.equal((await call(c1.session, 'GET', '/api/my/shifts')).json.shifts.some((s: any) => s.role_name === 'Swap me'), false);
  const m2 = (await call(c2.session, 'GET', '/api/my/shifts')).json.shifts.find((s: any) => s.role_name === 'Swap me');
  assert.equal(m2.status, 'accepted');

  // cancel and reject paths
  const offer2 = await call(c2.session, 'POST', `/api/assignments/${m2.assignment_id}/offer-swap`);
  assert.equal((await call(c1.session, 'POST', `/api/swaps/${offer2.json.swapId}/take`)).status, 200);
  assert.equal((await call(a, 'POST', `/api/swaps/${offer2.json.swapId}/reject`)).status, 200);
  assert.equal((await call(c1.session, 'GET', '/api/swaps/board')).json.swaps.length, 1); // back on the board
  assert.equal((await call(c2.session, 'POST', `/api/swaps/${offer2.json.swapId}/cancel`)).status, 200);
  assert.equal((await call(c1.session, 'GET', '/api/swaps/board')).json.swaps.length, 0);
});

test('recurring shifts and templates: bulk create, validation, template CRUD', async () => {
  const a = await register('bulk');
  const ev = await mkEvent(a);
  const days = [0, 1, 2, 3, 4, 5, 6].map((d) => ({ roleName: 'Stagehand', startsAt: start(24 * (d + 1)), endsAt: start(24 * (d + 1) + 8), headcount: 2, isOpen: d % 2 === 0, requiredCerts: ['Rigging'] }));
  const r = await call(a, 'POST', `/api/events/${ev}/shifts/bulk`, { shifts: days });
  assert.equal(r.status, 201);
  assert.equal(r.json.created, 7);
  const detail = await call(a, 'GET', `/api/events/${ev}`);
  assert.equal(detail.json.shifts.length, 7);
  assert.equal(detail.json.shifts[0].is_open, true);
  assert.deepEqual(detail.json.shifts[0].required_certs, ['Rigging']);

  // all-or-nothing validation
  const bad = await call(a, 'POST', `/api/events/${ev}/shifts/bulk`, { shifts: [days[0], { ...days[1], endsAt: days[1].startsAt }] });
  assert.equal(bad.status, 400);
  assert.equal((await call(a, 'GET', `/api/events/${ev}`)).json.shifts.length, 7);
  assert.equal((await call(a, 'POST', `/api/events/${ev}/shifts/bulk`, { shifts: [] })).status, 400);
  assert.equal((await call(a, 'POST', `/api/events/${ev}/shifts/bulk`, { shifts: Array(121).fill(days[0]) })).status, 400);

  const t = await call(a, 'POST', '/api/templates', { name: 'Std day', items: [{ role: 'Load-in', dayOffset: 0, start: '08:00', end: '16:00', headcount: 4 }, { role: 'Show', dayOffset: 1, start: '18:00', end: '23:30', headcount: 2, isOpen: true }] });
  assert.equal(t.status, 201, t.text);
  assert.equal((await call(a, 'POST', '/api/templates', { name: 'Bad', items: [{ role: 'X', dayOffset: 0, start: '8am', end: '16:00', headcount: 1 }] })).status, 400);
  assert.equal((await call(a, 'GET', '/api/templates')).json.templates.length, 1);
  // templates are per company
  const other = await register('bulk2');
  assert.equal((await call(other, 'GET', '/api/templates')).json.templates.length, 0);
  assert.equal((await call(other, 'DELETE', `/api/templates/${t.json.template.id}`)).status, 404);
  assert.equal((await call(a, 'DELETE', `/api/templates/${t.json.template.id}`)).status, 200);
});

test('crew shift details: address, coworkers, own calendar only', async () => {
  const a = await register('detail');
  const [c1, c2, c3] = [await mkCrew(a, 'dt1'), await mkCrew(a, 'dt2'), await mkCrew(a, 'dt3')];
  const ev = (await call(a, 'POST', '/api/events', { name: 'Gig', venue: 'Hall', address: '1 Main St, Denver', startDate: '2030-01-01', endDate: '2030-01-02' })).json.event.id;
  const s1 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'A', startsAt: start(30), endsAt: start(36), headcount: 2 })).json.shift.id;
  const s2 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'B', startsAt: start(50), endsAt: start(54), headcount: 1 })).json.shift.id;
  const a1 = (await call(a, 'POST', `/api/shifts/${s1}/assign`, { userId: c1.id })).json.assignment.id;
  await call(a, 'POST', `/api/shifts/${s1}/assign`, { userId: c2.id });
  await call(a, 'POST', `/api/shifts/${s2}/assign`, { userId: c3.id });

  const d = await call(c1.session, 'GET', `/api/my/assignments/${a1}`);
  assert.equal(d.status, 200, d.text);
  assert.equal(d.json.shift.address, '1 Main St, Denver');
  assert.deepEqual(d.json.coworkers.map((x: any) => x.name).sort(), ['Crew dt2', 'Crew dt3']);
  assert.equal(d.json.coworkers.find((x: any) => x.name === 'Crew dt2').shift_id, s1);
  // someone else's assignment is not visible
  assert.equal((await call(c2.session, 'GET', `/api/my/assignments/${a1}`)).status, 404);
  assert.equal((await call(c3.session, 'GET', `/api/my/assignments/${a1}`)).status, 404);

  const from = new Date(Date.now() - 86400000).toISOString();
  const to = new Date(Date.now() + 10 * 86400000).toISOString();
  const cal = await call(c1.session, 'GET', `/api/my/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  assert.deepEqual(cal.json.shifts.map((x: any) => x.role_name), ['A']);
  assert.equal((await call(c1.session, 'GET', '/api/my/calendar')).status, 400);
});

test('profile: edit details, change password, upload certificates that a manager must verify', async () => {
  const a = await register('prof');
  const c1 = await mkCrew(a, 'pf1');
  const c2 = await mkCrew(a, 'pf2');
  const email = `pf1-${run}@test.example`;

  const patch = await call(c1.session, 'PATCH', '/api/my/profile', {
    name: 'Pat Crew', phone: '555-0199', address: '9 Elm St', emergencyName: 'Kim', emergencyPhone: '555-0100', bio: 'Hi', skills: ['Audio', 'Stage'],
  });
  assert.equal(patch.status, 200, patch.text);
  const prof = (await call(c1.session, 'GET', '/api/my/profile')).json;
  assert.equal(prof.user.name, 'Pat Crew');
  assert.equal(prof.user.emergency_name, 'Kim');
  assert.deepEqual(prof.user.skills, ['Audio', 'Stage']);
  assert.equal((await call(c1.session, 'GET', '/api/auth/me')).json.user.name, 'Pat Crew');
  // the manager sees the details
  const seen = (await call(a, 'GET', '/api/crew')).json.crew.find((m: any) => m.id === c1.id);
  assert.equal(seen.address, '9 Elm St');
  // clearing a field
  await call(c1.session, 'PATCH', '/api/my/profile', { bio: '' });
  assert.equal((await call(c1.session, 'GET', '/api/my/profile')).json.user.bio, null);

  // password
  assert.equal((await call(c1.session, 'POST', '/api/my/password', { current: 'wrong-pass', next: 'newpassword1' })).status, 400);
  assert.equal((await call(c1.session, 'POST', '/api/my/password', { current: 'password123', next: 'short' })).status, 400);
  assert.equal((await call(c1.session, 'POST', '/api/my/password', { current: 'password123', next: 'newpassword1' })).status, 200);
  await login(email, 'newpassword1');
  assert.equal((await call(null, 'POST', '/api/auth/login', { email, password: 'password123' })).status, 401);

  // self-submitted certificate does not count until verified
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Fork', startsAt: start(30), endsAt: start(36), headcount: 1, requiredCerts: ['Forklift'] })).json.shift.id;
  const mk = await call(c1.session, 'POST', '/api/my/certs', { name: 'Forklift', expiresOn: '2099-01-01' });
  assert.equal(mk.status, 201, mk.text);
  const certId = mk.json.cert.id;
  assert.equal(mk.json.cert.verified, false);
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id })).status, 409);

  // uploads: wrong type, then a real PDF
  const put = (s: Session, cid: string, buf: Buffer, ct = 'application/pdf') =>
    app.inject({ method: 'PUT', url: `/api/my/certs/${cid}/file?filename=card.pdf`, payload: buf, headers: { cookie: s.cookie, 'content-type': ct } });
  assert.equal((await put(c1.session, certId, Buffer.from('MZ not a pdf'))).statusCode, 400);
  assert.equal((await put(c1.session, certId, Buffer.from('%PDF-1.4 hello'), 'text/plain')).statusCode, 400);
  assert.equal((await put(c2.session, certId, Buffer.from('%PDF-1.4 hello'))).statusCode, 404);
  assert.equal((await put(c1.session, certId, Buffer.from('%PDF-1.4 hello'))).statusCode, 201);

  const dl = await app.inject({ method: 'GET', url: `/api/certs/${certId}/file`, headers: { cookie: c1.session.cookie } });
  assert.equal(dl.statusCode, 200);
  assert.equal(dl.headers['content-type'], 'application/pdf');
  assert.equal(dl.headers['x-content-type-options'], 'nosniff');
  assert.equal(dl.body, '%PDF-1.4 hello');
  assert.equal((await app.inject({ method: 'GET', url: `/api/certs/${certId}/file`, headers: { cookie: a.cookie } })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/api/certs/${certId}/file`, headers: { cookie: c2.session.cookie } })).statusCode, 404);

  // manager reviews: crew list shows it, verify makes it count
  const row = (await call(a, 'GET', '/api/crew')).json.crew.find((m: any) => m.id === c1.id).certs[0];
  assert.equal(row.verified, false);
  assert.equal(row.has_file, true);
  assert.equal((await call(c1.session, 'POST', `/api/certs/${certId}/verify`)).status, 403);
  assert.equal((await call(a, 'POST', `/api/certs/${certId}/verify`)).status, 200);
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id })).status, 201);
  // changing the expiry sends it back for review
  assert.equal((await call(c1.session, 'POST', '/api/my/certs', { name: 'forklift', expiresOn: '2098-01-01' })).json.cert.verified, false);

  // others cannot delete mine; I can
  assert.equal((await call(c2.session, 'DELETE', `/api/my/certs/${certId}`)).status, 404);
  assert.equal((await call(c1.session, 'DELETE', `/api/my/certs/${certId}`)).status, 200);
  assert.equal((await call(a, 'GET', `/api/certs/${certId}/file`)).status, 404);
});

test('labor coordinator can view and edit a crew member profile, certs and password', async () => {
  const a = await register('coord');
  const c1 = await mkCrew(a, 'co1');
  const c2 = await mkCrew(a, 'co2');
  const cEmail = `co1-${run}@test.example`;

  const patch = await call(a, 'PATCH', `/api/crew/${c1.id}`, {
    name: 'Pat Q', email: `new-co1-${run}@test.example`, phone: '555-0111', address: '5 Oak', emergencyName: 'Lee', emergencyPhone: '555-0112', bio: 'bio', coordinatorNotes: 'prefers nights', skills: ['Audio'],
  });
  assert.equal(patch.status, 200, patch.text);
  const full = (await call(a, 'GET', `/api/crew/${c1.id}`)).json;
  assert.equal(full.member.email, `new-co1-${run}@test.example`);
  assert.equal(full.member.coordinator_notes, 'prefers nights');
  assert.equal(full.member.emergency_name, 'Lee');
  // crew never see the coordinator notes, and cannot use these routes
  assert.equal((await call(c1.session, 'GET', '/api/my/profile')).json.user.coordinator_notes, undefined);
  assert.equal((await call(c1.session, 'GET', `/api/crew/${c1.id}`)).status, 403);
  // email already used by someone else
  assert.equal((await call(a, 'PATCH', `/api/crew/${c1.id}`, { email: `co2-${run}@test.example` })).status, 409);
  // clearing a field
  await call(a, 'PATCH', `/api/crew/${c1.id}`, { phone: '' });
  assert.equal((await call(a, 'GET', `/api/crew/${c1.id}`)).json.member.phone, null);

  // login follows the new email; reset password
  assert.equal((await call(null, 'POST', '/api/auth/login', { email: cEmail, password: 'password123' })).status, 401);
  const reset = await call(a, 'POST', `/api/crew/${c1.id}/password`, {});
  assert.equal(reset.status, 200);
  await login(`new-co1-${run}@test.example`, reset.json.tempPassword);
  assert.equal((await call(c1.session, 'POST', `/api/crew/${c2.id}/password`, {})).status, 403);

  // add a cert and its file for them; a coordinator's cert is verified
  const cert = (await call(a, 'POST', `/api/crew/${c1.id}/certs`, { name: 'Rigging', expiresOn: '2099-01-01' })).json.cert;
  const up = await app.inject({ method: 'PUT', url: `/api/certs/${cert.id}/file?filename=r.png`, payload: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]), headers: { cookie: a.cookie, 'content-type': 'image/png' } });
  assert.equal(up.statusCode, 201, up.body);
  const certs = (await call(a, 'GET', `/api/crew/${c1.id}`)).json.certs;
  assert.equal(certs[0].verified, true);
  assert.equal(certs[0].file_name, 'r.png');
  const denied = await app.inject({ method: 'PUT', url: `/api/certs/${cert.id}/file`, payload: Buffer.from('%PDF-1.4 x'), headers: { cookie: c2.session.cookie, 'content-type': 'application/pdf' } });
  assert.equal(denied.statusCode, 403);
});

test('skills and pay rates: admin manages them, coordinators and crew only see names, export shows pay to admins', async () => {
  const a = await register('skills');
  const coord = await mkCrew(a, 'sk0'); // placeholder crew to test crew visibility
  const mgrRes = await call(a, 'POST', '/api/crew', { name: 'Coord', email: `coord-sk-${run}@test.example`, password: 'password123', role: 'manager' });
  assert.equal(mgrRes.status, 201, mgrRes.text);
  const mgr = await login(`coord-sk-${run}@test.example`, 'password123');

  const s1 = await call(a, 'POST', '/api/skills', { name: 'Audio Tech', payRate: 28.5 });
  assert.equal(s1.status, 201, s1.text);
  assert.equal(s1.json.skill.payRate, 28.5);
  assert.equal((await call(a, 'POST', '/api/skills', { name: 'audio tech', payRate: 1 })).status, 409);
  assert.equal((await call(a, 'POST', '/api/skills', { name: 'Rigger', payRate: 22.35 })).status, 201);
  assert.equal((await call(a, 'POST', '/api/skills', { name: 'Bad', payRate: -1 })).status, 400);

  // only admins can change; names are visible to others without rates
  assert.equal((await call(mgr, 'POST', '/api/skills', { name: 'Nope', payRate: 1 })).status, 403);
  assert.equal((await call(coord.session, 'PATCH', `/api/skills/${s1.json.skill.id}`, { payRate: 99 })).status, 403);
  const seenByMgr = (await call(mgr, 'GET', '/api/skills')).json.skills;
  assert.deepEqual(seenByMgr.map((x: any) => x.name), ['Audio Tech', 'Rigger']);
  assert.equal(seenByMgr[0].payRate, undefined);
  assert.equal((await call(a, 'GET', '/api/skills')).json.skills[0].payRate, 28.5);

  // rename carries over to people; deactivated skills leave the drop-downs
  await call(a, 'PATCH', `/api/crew/${coord.id}`, { skills: ['Audio Tech'] });
  await call(a, 'PATCH', `/api/skills/${s1.json.skill.id}`, { name: 'Audio Engineer', payRate: 30 });
  assert.deepEqual((await call(a, 'GET', `/api/crew/${coord.id}`)).json.member.skills, ['Audio Engineer']);
  const rig = (await call(a, 'GET', '/api/skills')).json.skills.find((x: any) => x.name === 'Rigger');
  await call(a, 'PATCH', `/api/skills/${rig.id}`, { active: false });
  assert.deepEqual((await call(coord.session, 'GET', '/api/skills')).json.skills.map((x: any) => x.name), ['Audio Engineer']);
  assert.equal((await call(a, 'GET', '/api/skills')).json.skills.length, 2);

  // isolation: another company sees none of it
  const b = await register('skills-b');
  assert.deepEqual((await call(b, 'GET', '/api/skills')).json.skills, []);
  assert.equal((await call(b, 'DELETE', `/api/skills/${rig.id}`)).status, 404);
  assert.equal((await call(a, 'DELETE', `/api/skills/${rig.id}`)).status, 200);

  // timesheet export: pay columns for admins only
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Audio Engineer (Show)', startsAt: start(-3), endsAt: start(5), headcount: 1 })).json.shift.id;
  const asg = (await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: coord.id })).json.assignment.id;
  await call(coord.session, 'POST', `/api/assignments/${asg}/respond`, { response: 'accepted' });
  await call(coord.session, 'POST', '/api/time/clock-in', { assignmentId: asg });
  await call(coord.session, 'POST', '/api/time/clock-out', {});
  const entry = (await call(a, 'GET', '/api/timesheets?status=submitted')).json.entries[0];
  await call(a, 'POST', `/api/timesheets/${entry.id}/approve`);
  const adminCsv = (await call(a, 'GET', '/api/timesheets/export.csv')).text.split('\r\n');
  assert.match(adminCsv[0], /Hourly rate,Pay$/);
  assert.match(adminCsv[1], /,30,0\.00$/);
  assert.doesNotMatch((await call(mgr, 'GET', '/api/timesheets/export.csv')).text.split('\r\n')[0], /rate/i);
});

test('notifications: queue, inbox, preferences, SMS consent, reset and invite links, STOP, tenant isolation', async () => {
  const { processQueue } = await import('../src/notify/worker');
  const a = await register('ntf');
  const c1 = await mkCrew(a, 'nt1');
  const ev = (await call(a, 'POST', '/api/events', { name: 'NGig', venue: 'Hall', startDate: '2030-01-01', endDate: '2030-01-02' })).json.event.id;
  const s1 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Rigger', startsAt: start(30), endsAt: start(36), headcount: 1 })).json.shift.id;
  const as = (await call(a, 'POST', `/api/shifts/${s1}/assign`, { userId: c1.id })).json.assignment.id;

  // crew gets an in-app notification and a queued email, but no SMS until they opt in
  let inbox = await call(c1.session, 'GET', '/api/notifications');
  assert.equal(inbox.json.unread, 1);
  assert.match(inbox.json.items[0].title, /New shift offered: Rigger/);
  assert.equal((await call(a, 'GET', '/api/notifications')).json.unread, 0);
  let log = await call(a, 'GET', '/api/messaging');
  assert.ok(log.json.deliveries.some((d: any) => d.channel === 'email' && d.category === 'assignment'));
  assert.ok(!log.json.deliveries.some((d: any) => d.channel === 'sms'));
  assert.equal(log.json.email.live, false);

  // SMS needs a valid phone and explicit consent
  let p = await call(c1.session, 'PUT', '/api/my/notification-prefs', { email: true, sms: true, smsConsent: true });
  assert.equal(p.status, 400);
  await call(a, 'PATCH', `/api/crew/${c1.id}`, { phone: '801-555-0142' });
  p = await call(c1.session, 'PUT', '/api/my/notification-prefs', { email: true, sms: true });
  assert.equal(p.status, 400);
  p = await call(c1.session, 'PUT', '/api/my/notification-prefs', { email: true, sms: true, smsConsent: true });
  assert.equal(p.status, 200, p.text);
  const g = await call(c1.session, 'GET', '/api/my/notification-prefs');
  assert.equal(g.json.sms, true);
  assert.ok(g.json.consentAt);

  // approving something now also queues a text
  const s2 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Stagehand', startsAt: start(60), endsAt: start(64), headcount: 1 })).json.shift.id;
  await call(a, 'POST', `/api/shifts/${s2}/assign`, { userId: c1.id });
  log = await call(a, 'GET', '/api/messaging');
  const sms = log.json.deliveries.find((d: any) => d.channel === 'sms');
  assert.ok(sms, 'sms queued');
  assert.equal(sms.to_addr, '+18015550142');

  // worker drains the queue in log-only mode (nothing really sent) and skips placeholder addresses
  await processQueue(100);
  log = await call(a, 'GET', '/api/messaging');
  assert.ok(log.json.deliveries.every((d: any) => d.status !== 'queued' && d.status !== 'sending'));
  assert.ok(log.json.deliveries.find((d: any) => d.channel === 'sms').status === 'sent');

  // read state
  await call(c1.session, 'POST', '/api/notifications/read', {});
  assert.equal((await call(c1.session, 'GET', '/api/notifications/count')).json.unread, 0);

  // turning email off stops email but keeps in-app
  await call(c1.session, 'PUT', '/api/my/notification-prefs', { email: false, sms: false });
  const before = (await call(a, 'GET', '/api/messaging')).json.deliveries.length;
  const s3 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Grip', startsAt: start(80), endsAt: start(84), headcount: 1 })).json.shift.id;
  await call(a, 'POST', `/api/shifts/${s3}/assign`, { userId: c1.id });
  assert.equal((await call(a, 'GET', '/api/messaging')).json.deliveries.length, before);
  assert.equal((await call(c1.session, 'GET', '/api/notifications/count')).json.unread, 1);

  // coordinators are told about claims; crew are not
  await call(a, 'PATCH', `/api/shifts/${s3}`, { isOpen: false });
  const c2 = await mkCrew(a, 'nt2');
  await call(a, 'PATCH', `/api/shifts/${s2}`, { isOpen: true });
  assert.ok((await call(c2.session, 'GET', '/api/notifications')).json.items.some((i: any) => /Open shift/.test(i.title)));

  // non-admins cannot see the delivery log
  assert.equal((await call(c1.session, 'GET', '/api/messaging')).status, 403);
  assert.equal((await call(c1.session, 'POST', '/api/messaging/test', { channel: 'email', to: 'x@y.com' })).status, 403);
  const t = await call(a, 'POST', '/api/messaging/test', { channel: 'sms', to: 'nope' });
  assert.equal(t.status, 400);
  assert.equal((await call(a, 'POST', '/api/messaging/test', { channel: 'email', to: 'me@test.example' })).json.logged, true);

  // another company sees none of this
  const other = await register('ntf2');
  assert.equal((await call(other, 'GET', '/api/messaging')).json.deliveries.length, 0);

  // forgot / reset: same answer for unknown emails; token works once and sets a new password
  assert.equal((await call(null, 'POST', '/api/auth/forgot', { email: 'nobody@test.example' })).json.ok, true);
  const email = `nt1-${run}@test.example`;
  const crewRow = (await pool.query('SELECT email FROM auth_find_user($1)', [email])).rowCount;
  assert.ok(crewRow);
  assert.equal((await call(null, 'POST', '/api/auth/forgot', { email })).json.ok, true);
  const mail = await withTenant(await tidOf(), async (c) => (await c.query("SELECT body FROM deliveries WHERE to_addr = $1 AND category = 'account' ORDER BY created_at DESC LIMIT 1", [email])).rows[0]);
  const token = /token=([\w-]+)/.exec(mail?.body ?? '')?.[1];
  assert.ok(token, 'reset link in email');
  assert.equal((await call(null, 'POST', '/api/auth/reset', { token, password: 'short' })).status, 400);
  assert.equal((await call(null, 'POST', '/api/auth/reset', { token, password: 'brand-new-pass-1' })).status, 200);
  assert.equal((await call(null, 'POST', '/api/auth/reset', { token, password: 'another-pass-22' })).status, 400);
  await login(email, 'brand-new-pass-1');
  assert.equal((await call(null, 'POST', '/api/auth/reset', { token: 'x'.repeat(43), password: 'brand-new-pass-1' })).status, 400);

  // inbound STOP turns SMS off (requires a configured auth token, so exercise the DB function directly)
  await call(c1.session, 'PUT', '/api/my/notification-prefs', { email: true, sms: true, smsConsent: true });
  assert.equal((await pool.query("SELECT notify_sms_stop('8015550142') AS n")).rows[0].n >= 1, true);
  assert.equal((await call(c1.session, 'GET', '/api/my/notification-prefs')).json.sms, false);
  const inbound = await app.inject({ method: 'POST', url: '/api/sms/twilio/inbound', payload: 'Body=STOP&From=%2B18015550142', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(inbound.statusCode, 503); // no Twilio token configured in tests
  void as;
});

async function tidOf() {
  return (await pool.query('SELECT tenant_id FROM auth_find_user($1)', [`admin-ntf-${run}@test.example`])).rows[0].tenant_id as string;
}

test('twilio inbound webhook: signature is required, STOP switches SMS off', async () => {
  const { config } = await import('../src/config');
  const crypto = await import('node:crypto');
  const a = await register('twi');
  const c1 = await mkCrew(a, 'tw1');
  await call(a, 'PATCH', `/api/crew/${c1.id}`, { phone: '(385) 555-0199' });
  await call(c1.session, 'PUT', '/api/my/notification-prefs', { email: true, sms: true, smsConsent: true });
  config.sms.token = 'test-token';
  try {
    const params: Record<string, string> = { Body: 'stop', From: '+13855550199' };
    const sig = (p: Record<string, string>) =>
      crypto.createHmac('sha1', 'test-token').update(`${config.appUrl}/api/sms/twilio/inbound` + Object.keys(p).sort().map((k) => k + p[k]).join('')).digest('base64');
    const send = (sg: string) =>
      app.inject({ method: 'POST', url: '/api/sms/twilio/inbound', payload: new URLSearchParams(params).toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sg } });
    assert.equal((await send('bogus')).statusCode, 403);
    assert.equal((await call(c1.session, 'GET', '/api/my/notification-prefs')).json.sms, true);
    assert.equal((await send(sig(params))).statusCode, 200);
    assert.equal((await call(c1.session, 'GET', '/api/my/notification-prefs')).json.sms, false);
  } finally {
    config.sms.token = '';
  }
});

test('sms provider: SNS mode reports connected only with credentials and shows in admin status', async () => {
  const { config } = await import('../src/config');
  const a = await register('sns');
  const prev = { ...config.sms.sns, provider: config.sms.provider };
  try {
    config.sms.provider = 'sns';
    config.sms.sns.accessKeyId = '';
    config.sms.sns.secretAccessKey = '';
    let m = (await call(a, 'GET', '/api/messaging')).json;
    assert.equal(m.sms.provider, 'sns');
    assert.equal(m.sms.live, false);
    config.sms.sns.accessKeyId = 'AKIATEST';
    config.sms.sns.secretAccessKey = 'secret';
    config.sms.sns.originationNumber = '+18015550100';
    m = (await call(a, 'GET', '/api/messaging')).json;
    assert.equal(m.sms.live, true);
    assert.equal(m.sms.from, '+18015550100');
  } finally {
    config.sms.provider = prev.provider;
    Object.assign(config.sms.sns, { accessKeyId: prev.accessKeyId, secretAccessKey: prev.secretAccessKey, originationNumber: prev.originationNumber });
  }
});
