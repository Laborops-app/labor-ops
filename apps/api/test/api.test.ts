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
