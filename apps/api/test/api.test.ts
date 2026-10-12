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

async function tenantOf(s: Session): Promise<string> {
  return JSON.parse(Buffer.from(s.cookie.split('=')[1].split('.')[1], 'base64url').toString()).tid;
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
  const later = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Later', startsAt: start(20), endsAt: start(24), headcount: 1 })).json.shift.id;
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

test('open shifts: claims are confirmed automatically and hold the slot', async () => {
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
  // no approval step: the claim is already accepted, nothing waits in the coordinator's queue
  const mine = await call(c1.session, 'GET', '/api/my/shifts');
  assert.equal(mine.json.shifts.find((s: any) => s.role_name === 'Open').status, 'accepted');
  assert.equal((await call(a, 'GET', '/api/requests')).json.claims.length, 0);
  // the slot is taken, so a second person is turned away
  assert.equal((await call(c2.session, 'POST', `/api/shifts/${open}/claim`)).status, 409);
  assert.equal((await call(c1.session, 'POST', `/api/shifts/${open}/claim`)).status, 409);
  // the claimant is told, and so are the coordinators
  const t = await tenantOf(a);
  const n = await withTenant(t, (c) => c.query("SELECT title FROM notifications WHERE title LIKE '%confirmed%' OR title LIKE '% took %'"));
  assert.equal(n.rowCount, 2);

  // a coordinator can still remove someone, which frees the slot
  const open2 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Open2', startsAt: start(70), endsAt: start(74), headcount: 1, isOpen: true })).json.shift.id;
  const claim3 = await call(c3.session, 'POST', `/api/shifts/${open2}/claim`);
  assert.equal(claim3.status, 201);
  assert.equal((await call(a, 'DELETE', `/api/assignments/${claim3.json.assignmentId}`)).status, 200);
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
  await processQueue(1000);
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

test('messaging settings: per-company, encrypted, secrets never returned, admin only', async () => {
  const a = await register('set');
  const c1 = await mkCrew(a, 'set1');
  assert.equal((await call(c1.session, 'PUT', '/api/messaging/settings/ses', { host: 'h', user: 'u', pass: 'p', from: 'f' })).status, 403);
  const bad = await call(a, 'PUT', '/api/messaging/settings/ses', { host: 'email-smtp.us-west-2.amazonaws.com', user: 'AKIAUSER', pass: 'super-secret-ses-pass', from: 'LaborOps <no-reply@laborops.app>', evil: 1 });
  assert.equal(bad.status, 400);
  const ok = await call(a, 'PUT', '/api/messaging/settings/ses', { host: 'email-smtp.us-west-2.amazonaws.com', user: 'AKIAUSER', pass: 'super-secret-ses-pass', from: 'LaborOps <no-reply@laborops.app>' });
  assert.equal(ok.status, 200, ok.text);
  let m = await call(a, 'GET', '/api/messaging');
  assert.equal(m.json.email.live, true);
  assert.equal(m.json.email.source, 'company');
  assert.equal(m.json.settings.ses.passSet, true);
  assert.ok(!m.text.includes('super-secret-ses-pass'), 'secret must not be returned');
  // stored encrypted
  const tid = (await pool.query('SELECT tenant_id FROM auth_find_user($1)', [`admin-set-${run}@test.example`])).rows[0].tenant_id;
  const raw = await withTenant(tid, async (c) => (await c.query("SELECT config_enc FROM integration_settings WHERE provider = 'ses'")).rows[0].config_enc);
  assert.ok(raw.startsWith('v1.') && !raw.includes('super-secret') && !raw.includes('AKIAUSER'));
  // blank secret keeps the old one
  await call(a, 'PUT', '/api/messaging/settings/ses', { host: 'email-smtp.us-west-2.amazonaws.com', user: 'AKIAUSER2', pass: '', from: 'x@laborops.app' });
  m = await call(a, 'GET', '/api/messaging');
  assert.equal(m.json.settings.ses.user, 'AKIAUSER2');
  assert.equal(m.json.settings.ses.passSet, true);
  // SNS texting
  await call(a, 'PUT', '/api/messaging/settings/sns', { region: 'us-west-2', accessKeyId: 'AKIASNS', secretAccessKey: 'sns-secret', originationNumber: '+18015550100', senderId: '' });
  assert.equal((await call(a, 'PUT', '/api/messaging/sms-provider', { provider: 'nope' })).status, 400);
  await call(a, 'PUT', '/api/messaging/sms-provider', { provider: 'sns' });
  m = await call(a, 'GET', '/api/messaging');
  assert.equal(m.json.sms.provider, 'sns');
  assert.equal(m.json.sms.live, true);
  assert.equal(m.json.sms.from, '+18015550100');
  // another company is unaffected
  const other = await register('set2');
  const om = await call(other, 'GET', '/api/messaging');
  assert.equal(om.json.sms.live, false);
  assert.equal(om.json.email.source, 'server');
  // clearing reverts to the server default
  await call(a, 'DELETE', '/api/messaging/settings/ses');
  assert.equal((await call(a, 'GET', '/api/messaging')).json.email.source, 'server');
});

test('podium: connect, send a text, signed webhook replies, STOP, bad signatures', async () => {
  const crypto = await import('node:crypto');
  const { processQueue } = await import('../src/notify/worker');
  const { config } = await import('../src/config');
  const a = await register('pod');
  const c1 = await mkCrew(a, 'pd1');
  await call(a, 'PATCH', `/api/crew/${c1.id}`, { phone: '(435) 555-0123' });
  await call(c1.session, 'PUT', '/api/my/notification-prefs', { email: false, sms: true, smsConsent: true });
  const tid = (await pool.query('SELECT tenant_id FROM auth_find_user($1)', [`admin-pod-${run}@test.example`])).rows[0].tenant_id;

  // connect needs credentials first
  assert.equal((await call(a, 'GET', '/api/podium/connect')).status, 400);
  assert.equal((await call(a, 'PUT', '/api/messaging/settings/podium', { clientId: 'cid', clientSecret: 'csecret', locationUid: 'loc-123456' })).status, 200);
  const url = new URL((await call(a, 'GET', '/api/podium/connect')).json.url);
  assert.equal(url.origin + url.pathname, 'https://api.podium.com/oauth/authorize');
  assert.equal(url.searchParams.get('client_id'), 'cid');
  assert.match(url.searchParams.get('scope')!, /write_messages/);
  assert.equal(url.searchParams.get('redirect_uri'), `${config.appUrl}/api/podium/callback`);
  const state = url.searchParams.get('state')!;

  const realFetch = globalThis.fetch;
  const calls: { url: string; init: any }[] = [];
  globalThis.fetch = (async (u: any, init: any) => {
    calls.push({ url: String(u), init });
    if (String(u).endsWith('/oauth/token')) return new Response(JSON.stringify({ access_token: 'AT1', refresh_token: 'RT1', expires_in: 36000 }), { status: 200 });
    if (String(u).endsWith('/v4/messages')) return new Response(JSON.stringify({ data: { uid: 'msg-uid-1' } }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  try {
    // a forged / foreign state is refused; a real one connects
    const forged = await call(a, 'GET', `/api/podium/callback?code=abcdefgh&state=${encodeURIComponent(state.slice(0, -3) + 'xxx')}`);
    assert.match(String(forged.res.headers.location), /podium=invalid/);
    const cb = await call(a, 'GET', `/api/podium/callback?code=abcdefgh&state=${encodeURIComponent(state)}`);
    assert.match(String(cb.res.headers.location), /podium=connected/);
    assert.equal(JSON.parse(calls[0].init.body).grant_type, 'authorization_code');
    const m = await call(a, 'GET', '/api/messaging');
    assert.equal(m.json.settings.podium.connected, true);
    assert.ok(!m.text.includes('AT1') && !m.text.includes('RT1') && !m.text.includes('csecret'));

    // texting goes through Podium
    await call(a, 'PUT', '/api/messaging/sms-provider', { provider: 'podium' });
    const ev = (await call(a, 'POST', '/api/events', { name: 'PGig', venue: 'Hall', startDate: '2030-01-01', endDate: '2030-01-02' })).json.event.id;
    const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Rigger', startsAt: start(30), endsAt: start(36), headcount: 1 })).json.shift.id;
    await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id });
    await processQueue(100);
    const send = calls.find((c) => c.url.endsWith('/v4/messages'))!;
    assert.ok(send, 'Podium send called');
    assert.equal(send.init.headers.authorization, 'Bearer AT1');
    const sent = JSON.parse(send.init.body);
    assert.deepEqual(sent.channel, { type: 'phone', identifier: '+14355550123' });
    assert.equal(sent.locationUid, 'loc-123456');
    assert.match(sent.body, /New shift offered/);
    const log = (await call(a, 'GET', '/api/messaging')).json.deliveries.find((d: any) => d.channel === 'sms');
    assert.equal(log.status, 'sent');

    // webhooks: secret, signature, replies
    const hook = (await call(a, 'GET', '/api/podium/webhook-secret')).json;
    assert.equal(hook.url, `${config.appUrl}/api/podium/webhook/${tid}`);
    const post = (payload: object, secret = hook.secret, tsOffset = 0, sigOverride?: string) => {
      const raw = JSON.stringify(payload);
      const ts = String(Date.now() + tsOffset);
      const sig = sigOverride ?? crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
      return app.inject({ method: 'POST', url: `/api/podium/webhook/${tid}`, payload: raw, headers: { 'content-type': 'application/json', 'podium-timestamp': ts, 'podium-signature': sig } });
    };
    const reply = (uid: string, body: string) => ({
      data: { uid, body, contact: { name: 'Crew pd1' }, conversation: { channel: { type: 'phone', identifier: '+14355550123' } } },
      metadata: { eventType: 'message.received', version: '2021.04.01' },
    });
    assert.equal((await post(reply('r0', 'hi'), 'wrong-secret')).statusCode, 401);
    assert.equal((await post(reply('r0', 'hi'), hook.secret, -10 * 60_000)).statusCode, 401, 'stale timestamp');
    assert.equal((await post(reply('r0', 'hi'), hook.secret, 0, 'deadbeef')).statusCode, 401);
    assert.equal((await post(reply('r1', 'Can I swap Friday?'))).statusCode, 200);
    assert.equal((await post(reply('r1', 'Can I swap Friday?'))).statusCode, 200); // duplicate delivery
    const replies = (await call(a, 'GET', '/api/messaging')).json.replies;
    assert.equal(replies.length, 1);
    assert.equal(replies[0].user_name, 'Crew pd1');
    assert.equal((await call(a, 'GET', '/api/notifications')).json.items.filter((i: any) => /Text reply/.test(i.title)).length, 1);
    assert.equal((await call(c1.session, 'GET', '/api/my/notification-prefs')).json.sms, true);
    assert.equal((await post(reply('r2', ' stop '))).statusCode, 200);
    assert.equal((await call(c1.session, 'GET', '/api/my/notification-prefs')).json.sms, false);
    // delivery failure (e.g. landline) is recorded
    assert.equal((await post({ data: { uid: 'msg-uid-1', failureReason: 'landline', conversation: { channel: { identifier: '+14355550123' } } }, metadata: { eventType: 'message.failed' } })).statusCode, 200);
    const failed = (await call(a, 'GET', '/api/messaging')).json.deliveries.find((d: any) => d.channel === 'sms');
    assert.equal(failed.status, 'failed');
    assert.match(failed.last_error, /landline/);

    // disconnect wipes tokens
    await call(a, 'POST', '/api/podium/disconnect', {});
    assert.equal((await call(a, 'GET', '/api/messaging')).json.settings.podium.connected, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('podium signature helper accepts hex or base64 and rejects tampering', async () => {
  const crypto = await import('node:crypto');
  const { verifyPodiumSignature } = await import('../src/notify/podium');
  const raw = '{"a":1}';
  const ts = String(Date.now());
  const hex = crypto.createHmac('sha256', 's').update(`${ts}.${raw}`).digest('hex');
  const b64 = crypto.createHmac('sha256', 's').update(`${ts}.${raw}`).digest('base64');
  assert.equal(verifyPodiumSignature('s', ts, raw, hex), true);
  assert.equal(verifyPodiumSignature('s', ts, raw, b64), true);
  assert.equal(verifyPodiumSignature('s', ts, raw + ' ', hex), false);
  assert.equal(verifyPodiumSignature('', ts, raw, hex), false);
  assert.equal(verifyPodiumSignature('s', String(Math.floor(Date.now() / 1000)), raw, crypto.createHmac('sha256', 's').update(`${Math.floor(Date.now() / 1000)}.${raw}`).digest('hex')), true, 'seconds timestamp');
});

test('browser push: subscribe, queue a push delivery, send, drop expired subscriptions', async () => {
  const { processQueue } = await import('../src/notify/worker');
  const webpush = (await import('web-push')).default as any;
  const a = await register('psh');
  const c1 = await mkCrew(a, 'ps1');
  const key = await call(c1.session, 'GET', '/api/push/key');
  assert.equal(key.status, 200);
  assert.ok(key.json.publicKey.length > 40);
  assert.equal((await call(null, 'GET', '/api/push/key')).status, 401);
  assert.equal((await call(c1.session, 'POST', '/api/push/subscribe', { endpoint: 'not a url', keys: { p256dh: 'x', auth: 'y' } })).status, 400);
  const sub = (n: string) => ({ endpoint: `https://push.example.test/send/${run}-${n}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });
  assert.equal((await call(c1.session, 'POST', '/api/push/subscribe', sub('a'))).status, 200);
  assert.equal((await call(c1.session, 'POST', '/api/push/subscribe', sub('a'))).status, 200); // idempotent
  assert.equal((await call(c1.session, 'GET', '/api/push/status')).json.devices.length, 1);

  const ev = (await call(a, 'POST', '/api/events', { name: 'PushGig', venue: 'Hall', startDate: '2030-01-01', endDate: '2030-01-02' })).json.event.id;
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Rigger', startsAt: start(30), endsAt: start(36), headcount: 1 })).json.shift.id;
  const sent: any[] = [];
  const orig = webpush.sendNotification;
  webpush.sendNotification = async (s: any, payload: string) => { sent.push({ s, payload: JSON.parse(payload) }); return {}; };
  try {
    await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id });
    await processQueue(100);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].s.endpoint, sub('a').endpoint);
    assert.match(sent[0].payload.title, /New shift offered/);
    assert.match(sent[0].payload.url, /^\/my-shifts\//);
    const log = (await call(a, 'GET', '/api/messaging')).json.deliveries.find((d: any) => d.channel === 'push');
    assert.equal(log.status, 'sent');
    assert.equal(log.to_addr, 'browser', 'push endpoints are not exposed');

    // an expired subscription is removed
    webpush.sendNotification = async () => { throw Object.assign(new Error('gone'), { statusCode: 410, body: 'gone' }); };
    const sh2 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Grip', startsAt: start(60), endsAt: start(64), headcount: 1 })).json.shift.id;
    await call(a, 'POST', `/api/shifts/${sh2}/assign`, { userId: c1.id });
    await processQueue(100);
    assert.equal((await call(c1.session, 'GET', '/api/push/status')).json.devices.length, 0);
  } finally {
    webpush.sendNotification = orig;
  }
  // unsubscribe
  await call(c1.session, 'POST', '/api/push/subscribe', sub('b'));
  assert.equal((await call(c1.session, 'POST', '/api/push/unsubscribe', {})).status, 200);
  assert.equal((await call(c1.session, 'GET', '/api/push/status')).json.devices.length, 0);
});

test('chat: DM rules, groups, event channels, unread, quiet notifications, delete, isolation', async () => {
  const a = await register('cht');
  const b = await register('chtB');
  const c1 = await mkCrew(a, 'ch1');
  const c2 = await mkCrew(a, 'ch2');

  // crew may DM staff only; staff may DM anyone
  assert.equal((await call(c1.session, 'POST', '/api/chat/dm', { userId: c2.id })).status, 404);
  assert.equal((await call(c1.session, 'POST', '/api/chat/dm', { userId: c1.id })).status, 400);
  const people = (await call(c1.session, 'GET', '/api/chat/people')).json.people;
  assert.ok(people.every((p: any) => p.role !== 'crew'));
  const dm = await call(c1.session, 'POST', '/api/chat/dm', { userId: a.id });
  assert.equal(dm.status, 200, dm.text);
  const dm2 = await call(a, 'POST', '/api/chat/dm', { userId: c1.id });
  assert.equal(dm2.json.id, dm.json.id, 'one DM per pair');
  assert.equal((await call(a, 'POST', '/api/chat/dm', { userId: b.id })).status, 404, 'no cross-company DMs');

  // sending, unread and quiet notifications
  const ch = dm.json.id as string;
  assert.equal((await call(c1.session, 'POST', `/api/chat/channels/${ch}/messages`, { body: '  ' })).status, 400);
  assert.equal((await call(c1.session, 'POST', `/api/chat/channels/${ch}/messages`, { body: 'hello' })).status, 200);
  assert.equal((await call(c1.session, 'POST', `/api/chat/channels/${ch}/messages`, { body: 'anyone there?' })).status, 200);
  assert.equal((await call(a, 'GET', '/api/chat/unread')).json.unread, 1);
  const list = (await call(a, 'GET', '/api/chat/channels')).json.channels;
  assert.equal(list[0].unread, 2);
  assert.equal(list[0].name, 'Crew ch1');
  const notes = (await call(a, 'GET', '/api/notifications')).json.items.filter((n: any) => n.category === 'chat');
  assert.equal(notes.length, 1, 'later messages refresh the same notification');
  assert.match(notes[0].body, /anyone there/);
  // reading and paging
  const msgs = (await call(a, 'GET', `/api/chat/channels/${ch}/messages`)).json;
  assert.equal(msgs.messages.length, 2);
  const lastSeq = msgs.messages[1].seq;
  assert.equal((await call(a, 'GET', `/api/chat/channels/${ch}/messages?after=${lastSeq}`)).json.messages.length, 0);
  await call(a, 'POST', `/api/chat/channels/${ch}/messages`, { body: 'on my way' });
  assert.equal((await call(c1.session, 'GET', `/api/chat/channels/${ch}/messages?after=${lastSeq}`)).json.messages.length, 1);
  assert.equal((await call(a, 'POST', `/api/chat/channels/${ch}/read`)).status, 200);
  assert.equal((await call(a, 'GET', '/api/chat/unread')).json.unread, 0);

  // outsiders cannot read or post
  assert.equal((await call(c2.session, 'GET', `/api/chat/channels/${ch}/messages`)).status, 404);
  assert.equal((await call(c2.session, 'POST', `/api/chat/channels/${ch}/messages`, { body: 'hi' })).status, 404);
  assert.equal((await call(b, 'GET', `/api/chat/channels/${ch}`)).status, 404);

  // delete: author or staff only
  const mid = msgs.messages[0].id;
  assert.equal((await call(c2.session, 'DELETE', `/api/chat/messages/${mid}`)).status, 404);
  assert.equal((await call(c1.session, 'DELETE', `/api/chat/messages/${mid}`)).status, 200);
  const after = (await call(a, 'GET', `/api/chat/channels/${ch}/messages`)).json.messages;
  assert.equal(after[0].deleted, true);
  assert.equal(after[0].body, '');

  // groups: staff only
  assert.equal((await call(c1.session, 'POST', '/api/chat/channels', { name: 'Crew room' })).status, 403);
  const g = await call(a, 'POST', '/api/chat/channels', { name: 'Load-in', memberIds: [c1.id] });
  assert.equal(g.status, 201, g.text);
  assert.equal((await call(c1.session, 'GET', `/api/chat/channels/${g.json.id}`)).json.channel.name, 'Load-in');
  assert.equal((await call(c2.session, 'GET', `/api/chat/channels/${g.json.id}`)).status, 404);
  assert.equal((await call(c1.session, 'POST', `/api/chat/channels/${g.json.id}/members`, { userIds: [c2.id] })).status, 403);
  assert.equal((await call(a, 'POST', `/api/chat/channels/${g.json.id}/members`, { userIds: [c2.id] })).status, 200);
  assert.equal((await call(c2.session, 'GET', `/api/chat/channels/${g.json.id}`)).status, 200);
  assert.equal((await call(c1.session, 'DELETE', `/api/chat/channels/${g.json.id}/members/${c2.id}`)).status, 404);
  assert.equal((await call(a, 'DELETE', `/api/chat/channels/${g.json.id}/members/${c2.id}`)).status, 200);
  assert.equal((await call(c2.session, 'GET', `/api/chat/channels/${g.json.id}`)).status, 404);
  // mute stops notifications
  assert.equal((await call(c1.session, 'PATCH', `/api/chat/channels/${g.json.id}`, { muted: true })).status, 200);
  await call(a, 'POST', `/api/chat/channels/${g.json.id}/messages`, { body: 'quiet please' });
  const c1notes = (await call(c1.session, 'GET', '/api/notifications')).json.items.filter((n: any) => /Load-in/.test(n.title));
  assert.equal(c1notes.length, 0);

  // event channels follow assignments
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Tech', startsAt: start(30), endsAt: start(36), headcount: 2 })).json.shift.id;
  const ec = await call(a, 'POST', '/api/chat/channels', { eventId: ev });
  assert.equal(ec.status, 201, ec.text);
  assert.equal((await call(a, 'POST', '/api/chat/channels', { eventId: ev })).json.id, ec.json.id, 'one channel per event');
  assert.equal((await call(c1.session, 'GET', `/api/chat/channels/${ec.json.id}`)).status, 404);
  const asg = await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id });
  assert.equal(asg.status < 300, true, asg.text);
  assert.equal((await call(c1.session, 'GET', `/api/chat/channels/${ec.json.id}`)).status, 200);
  const aid = (await call(a, 'GET', `/api/events/${ev}`)).json.shifts?.[0]?.assignments?.[0]?.id ?? asg.json.assignment?.id;
  assert.ok(aid);
  assert.equal((await call(a, 'DELETE', `/api/assignments/${aid}`)).status < 300, true);
  assert.equal((await call(c1.session, 'GET', `/api/chat/channels/${ec.json.id}`)).status, 404);
});

test('chat: message rate limit', async () => {
  const a = await register('chtrl');
  const c1 = await mkCrew(a, 'rl1');
  const ch = (await call(c1.session, 'POST', '/api/chat/dm', { userId: a.id })).json.id;
  let last = 0;
  for (let i = 0; i < 42; i++) last = (await call(c1.session, 'POST', `/api/chat/channels/${ch}/messages`, { body: `m${i}` })).status;
  assert.equal(last, 429);
});

test('shift offer: email with accept/decline links, chat message, one-click response without signing in', async () => {
  const { respondToken } = await import('../src/notify/respond');
  const a = await register('offr');
  const b = await register('offrB');
  const c1 = await mkCrew(a, 'of1');
  const ev = await mkEvent(a);
  const mk = async (h: number) => (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Tech', startsAt: start(h), endsAt: start(h + 4), headcount: 1 })).json.shift.id;
  const sh = await mk(30);
  const asg = await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id });
  assert.equal(asg.status, 201, asg.text);

  // email carries both links
  const mail = await withTenant(await tenantOf(a), (c) => c.query("SELECT body, html FROM deliveries WHERE channel = 'email' AND user_id = $1 ORDER BY created_at DESC LIMIT 1", [c1.id]));
  assert.match(mail.rows[0].body, /Accept shift: .*\/respond\?t=.*&a=accept/);
  assert.match(mail.rows[0].html, /Decline<\/a>/);

  // chat message from the coordinator
  const chats = (await call(c1.session, 'GET', '/api/chat/channels')).json.channels;
  assert.equal(chats.length, 1);
  const m = (await call(c1.session, 'GET', `/api/chat/channels/${chats[0].id}/messages`)).json.messages[0];
  const t = /respond\?t=([\w.-]+)&a=accept/.exec(m.body)![1];
  assert.match(m.body, /Decline: /);
  assert.equal(m.user_id, a.id);

  // public preview + respond (no cookie)
  const pre = await call(null, 'GET', `/api/respond/preview?t=${t}`);
  assert.equal(pre.status, 200, pre.text);
  assert.equal(pre.json.shift.status, 'offered');
  assert.equal(pre.json.shift.canRespond, true);
  assert.equal((await call(null, 'GET', `/api/respond/preview?t=${t}x`)).status, 400, 'tampered token');
  assert.equal((await call(null, 'POST', '/api/respond', { t: 'junk', response: 'accepted' })).status, 400);
  assert.equal((await call(null, 'POST', '/api/respond', { t, response: 'accepted' })).json.status, 'accepted');
  assert.equal((await call(c1.session, 'GET', `/api/my/assignments/${asg.json.assignment.id}`)).json.shift.status, 'accepted');
  // changing your mind is allowed until the shift is over; declining tells the coordinators
  assert.equal((await call(null, 'POST', '/api/respond', { t, response: 'declined' })).json.status, 'declined');
  const staffNotes = (await call(a, 'GET', '/api/notifications')).json.items.filter((n: any) => /declined Tech/.test(n.title));
  assert.equal(staffNotes.length, 1);

  // a token for another person's shift, or an expired one, is refused
  const forged = respondToken(await tenantOf(b), asg.json.assignment.id, c1.id);
  assert.equal((await call(null, 'GET', `/api/respond/preview?t=${forged}`)).status, 404, 'wrong company cannot see it');
});

test('shift pay: hourly rate and estimated earnings for crew, cost for admins only', async () => {
  const a = await register('payx');
  const c1 = await mkCrew(a, 'px1');
  assert.equal((await call(a, 'POST', '/api/crew', { name: 'Pay Mgr', email: `pxm-${run}@test.example`, role: 'manager', password: 'password123' })).status, 201);
  const mgr = { session: await login(`pxm-${run}@test.example`, 'password123') };
  assert.equal((await call(a, 'POST', '/api/skills', { name: 'Tech', payRate: 20.5 })).status, 201);
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Tech (Lead)', startsAt: start(30), endsAt: start(38), headcount: 2 })).json.shift.id;
  const asg = await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id });
  assert.equal(asg.status, 201, asg.text);

  const mail = await withTenant(await tenantOf(a), (c) => c.query("SELECT body FROM deliveries WHERE channel = 'email' AND user_id = $1 ORDER BY created_at DESC LIMIT 1", [c1.id]));
  assert.match(mail.rows[0].body, /Pay: \$20\.50\/hr · est\. \$164\.00 for 8 h/);

  const mine = await call(c1.session, 'GET', `/api/my/assignments/${asg.json.assignment.id}`);
  assert.equal(mine.json.shift.hourly_rate, 20.5);
  assert.equal(mine.json.shift.estimated_pay, 164);
  const list = (await call(c1.session, 'GET', '/api/my/shifts')).json.shifts[0];
  assert.equal(list.estimated_pay, 164);

  // admin sees rate and total cost for 2 people; others do not
  const adm = (await call(a, 'GET', `/api/events/${ev}`)).json.shifts[0];
  assert.equal(adm.hourly_rate, 20.5);
  assert.equal(adm.estimated_cost, 328);
  assert.equal((await call(mgr.session, 'GET', `/api/events/${ev}`)).json.shifts[0].hourly_rate, undefined);

  // no rate set -> no pay shown
  const sh2 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Unlisted', startsAt: start(60), endsAt: start(64), headcount: 1 })).json.shift.id;
  const a2 = await call(a, 'POST', `/api/shifts/${sh2}/assign`, { userId: c1.id });
  const m2 = await call(c1.session, 'GET', `/api/my/assignments/${a2.json.assignment.id}`);
  assert.equal(m2.json.shift.estimated_pay, null);
  const pre = await call(null, 'GET', `/api/respond/preview?t=${(await import('../src/notify/respond')).respondToken(await tenantOf(a), asg.json.assignment.id, c1.id)}`);
  assert.equal(pre.json.shift.estimated_pay, 164);
  assert.equal(pre.json.shift.assignment_id, asg.json.assignment.id);
});

test('role groups: create, assign roles, starter set with templates is idempotent, admin only', async () => {
  const a = await register('grp');
  const c1 = await mkCrew(a, 'gr1');
  assert.equal((await call(c1.session, 'POST', '/api/skill-groups', { name: 'X' })).status, 403);
  const g = await call(a, 'POST', '/api/skill-groups', { name: 'Riggers' });
  assert.equal(g.status, 201, g.text);
  assert.equal((await call(a, 'POST', '/api/skill-groups', { name: 'riggers' })).status, 409);
  const sk = await call(a, 'POST', '/api/skills', { name: 'Head Rigger', payRate: 40, groupId: g.json.group.id });
  assert.equal(sk.json.skill.groupId, g.json.group.id);
  assert.equal((await call(a, 'PATCH', `/api/skills/${sk.json.skill.id}`, { groupId: null })).json.skill.groupId, null);
  assert.equal((await call(a, 'PATCH', `/api/skills/${sk.json.skill.id}`, { groupId: g.json.group.id })).json.skill.groupId, g.json.group.id);
  assert.equal((await call(a, 'PATCH', `/api/skill-groups/${g.json.group.id}`, { name: 'Rigging' })).json.group.name, 'Rigging');

  // crew can read groups (for drop-downs) but not rates
  const seen = (await call(c1.session, 'GET', '/api/skills')).json;
  assert.ok(seen.groups.some((x: any) => x.name === 'Rigging'));
  assert.equal(seen.skills[0].payRate, undefined);

  // starter set
  assert.equal((await call(c1.session, 'POST', '/api/skills/starter')).status, 403);
  const first = await call(a, 'POST', '/api/skills/starter');
  assert.deepEqual(first.json.added, { groups: 5, roles: 10, templates: 7 });
  assert.deepEqual((await call(a, 'POST', '/api/skills/starter')).json.added, { groups: 0, roles: 0, templates: 0 });
  const all = (await call(a, 'GET', '/api/skills')).json;
  const equip = all.groups.find((x: any) => x.name === 'Equipment Ops').id;
  assert.deepEqual(all.skills.filter((s: any) => s.groupId === equip).map((s: any) => s.name).sort(), ['Boom Op', 'Fork Lift Op', 'High Lift Op', 'Lull Op', 'Scissor Lift Op']);
  const tpls = (await call(a, 'GET', '/api/templates')).json.templates;
  assert.ok(tpls.find((t: any) => t.name === 'Load-in').items.some((i: any) => i.role === 'Fork Lift Op'));

  // a template builds real shifts
  const ev = await mkEvent(a);
  const t = tpls.find((x: any) => x.name === 'Equipment ops');
  const shifts = t.items.map((i: any) => ({ roleName: i.role, startsAt: start(24), endsAt: start(32), headcount: i.headcount, isOpen: false, requiredCerts: [] }));
  assert.equal((await call(a, 'POST', `/api/events/${ev}/shifts/bulk`, { shifts })).json.created, 5);

  // deleting a group keeps its roles
  assert.equal((await call(a, 'DELETE', `/api/skill-groups/${equip}`)).status, 200);
  assert.ok((await call(a, 'GET', '/api/skills')).json.skills.some((s: any) => s.name === 'Boom Op' && s.groupId === null));
});

test('events: client and address editing, phases (load-in, show, strike) drive the event dates', async () => {
  const a = await register('evp');
  const c1 = await mkCrew(a, 'ep1');
  const ev = (await call(a, 'POST', '/api/events', { name: 'Gala', client: 'Acme Corp', venue: 'Hall', address: '1 Main St', startDate: '2030-05-10', endDate: '2030-05-10' })).json.event;
  assert.equal(ev.client, 'Acme Corp');
  assert.equal((await call(c1.session, 'PATCH', `/api/events/${ev.id}`, { client: 'x' })).status, 403);
  const up = await call(a, 'PATCH', `/api/events/${ev.id}`, { name: 'Gala 2030', client: 'Acme Inc', address: '' });
  assert.equal(up.json.event.name, 'Gala 2030');
  assert.equal(up.json.event.client, 'Acme Inc');
  assert.equal(up.json.event.address, null);
  assert.equal(up.json.event.venue, 'Hall', 'untouched fields stay');
  assert.equal((await call(a, 'PATCH', `/api/events/${ev.id}`, { startDate: '2030-06-01' })).status, 400, 'end before start');

  const li = await call(a, 'POST', `/api/events/${ev.id}/phases`, { label: 'Load in', startDate: '2030-05-08', endDate: '2030-05-09' });
  assert.equal(li.status, 201, li.text);
  await call(a, 'POST', `/api/events/${ev.id}/phases`, { label: 'Show days', startDate: '2030-05-10', endDate: '2030-05-12' });
  const st = (await call(a, 'POST', `/api/events/${ev.id}/phases`, { label: 'Strike', startDate: '2030-05-13', endDate: '2030-05-13' })).json.phase;
  assert.equal((await call(a, 'POST', `/api/events/${ev.id}/phases`, { label: 'Bad', startDate: '2030-05-13', endDate: '2030-05-12' })).status, 400);
  let d = (await call(a, 'GET', `/api/events/${ev.id}`)).json;
  assert.deepEqual(d.phases.map((p: any) => p.label), ['Load in', 'Show days', 'Strike']);
  assert.equal(d.event.start_date.slice(0, 10), '2030-05-08');
  assert.equal(d.event.end_date.slice(0, 10), '2030-05-13');
  // dates follow phases, direct date edits are ignored while phases exist
  await call(a, 'PATCH', `/api/events/${ev.id}`, { startDate: '2030-01-01', endDate: '2030-01-02' });
  assert.equal((await call(a, 'GET', `/api/events/${ev.id}`)).json.event.start_date.slice(0, 10), '2030-05-08');
  await call(a, 'PATCH', `/api/event-phases/${st.id}`, { label: 'Strike', startDate: '2030-05-14', endDate: '2030-05-15' });
  assert.equal((await call(a, 'GET', `/api/events/${ev.id}`)).json.event.end_date.slice(0, 10), '2030-05-15');
  await call(a, 'DELETE', `/api/event-phases/${st.id}`);
  assert.equal((await call(a, 'GET', `/api/events/${ev.id}`)).json.event.end_date.slice(0, 10), '2030-05-12');

  // other companies cannot touch them
  const b = await register('evpB');
  assert.equal((await call(b, 'PATCH', `/api/event-phases/${li.json.phase.id}`, { label: 'x', startDate: '2030-01-01', endDate: '2030-01-01' })).status, 404);
  assert.equal((await call(b, 'DELETE', `/api/event-phases/${li.json.phase.id}`)).status, 404);
  assert.equal((await call(b, 'POST', `/api/events/${ev.id}/phases`, { label: 'x', startDate: '2030-01-01', endDate: '2030-01-01' })).status, 404);
});

test('phases: shifts can be added to each phase, moved, and survive phase removal', async () => {
  const a = await register('phs');
  const ev = await mkEvent(a);
  const ev2 = await mkEvent(a);
  const li = (await call(a, 'POST', `/api/events/${ev}/phases`, { label: 'Load in', startDate: '2030-03-01', endDate: '2030-03-01' })).json.phase;
  const sd = (await call(a, 'POST', `/api/events/${ev}/phases`, { label: 'Show', startDate: '2030-03-02', endDate: '2030-03-03' })).json.phase;
  const other = (await call(a, 'POST', `/api/events/${ev2}/phases`, { label: 'Other', startDate: '2030-03-02', endDate: '2030-03-03' })).json.phase;

  const one = await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Fork Lift Op', startsAt: start(24), endsAt: start(30), headcount: 2, phaseId: li.id });
  assert.equal(one.status, 201, one.text);
  assert.equal(one.json.shift.phase_id, li.id);
  assert.equal((await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'X', startsAt: start(24), endsAt: start(30), phaseId: other.id })).status, 400, 'phase from another event');
  const bulk = await call(a, 'POST', `/api/events/${ev}/shifts/bulk`, { shifts: [1, 2].map((n) => ({ roleName: 'Audio', startsAt: start(40 + n), endsAt: start(46 + n), headcount: 1, phaseId: sd.id })) });
  assert.equal(bulk.json.created, 2);
  assert.equal((await call(a, 'POST', `/api/events/${ev}/shifts/bulk`, { shifts: [{ roleName: 'Audio', startsAt: start(5), endsAt: start(9), phaseId: other.id }] })).status, 400);

  let d = (await call(a, 'GET', `/api/events/${ev}`)).json;
  assert.equal(d.shifts.filter((s: any) => s.phase_id === sd.id).length, 2);
  // move a shift to another phase, or to none
  assert.equal((await call(a, 'PATCH', `/api/shifts/${one.json.shift.id}`, { phaseId: sd.id })).json.shift.phase_id, sd.id);
  assert.equal((await call(a, 'PATCH', `/api/shifts/${one.json.shift.id}`, { phaseId: null })).json.shift.phase_id, null);
  assert.equal((await call(a, 'PATCH', `/api/shifts/${one.json.shift.id}`, { phaseId: other.id })).status, 409);
  assert.equal((await call(a, 'PATCH', `/api/shifts/${one.json.shift.id}`, { headcount: 3 })).json.shift.headcount, 3, 'other edits leave the phase alone');

  // removing a phase keeps its shifts
  await call(a, 'DELETE', `/api/event-phases/${sd.id}`);
  d = (await call(a, 'GET', `/api/events/${ev}`)).json;
  assert.equal(d.shifts.length, 3);
  assert.ok(d.shifts.every((s: any) => s.phase_id === null));
});

test('labor rules: rest and daily limits block (admin can override), weekly overtime warns, settings are admin only', async () => {
  const a = await register('rules');
  const c1 = await mkCrew(a, 'ru1');
  assert.equal((await call(c1.session, 'GET', '/api/labor-rules')).status, 403);
  const def = (await call(a, 'GET', '/api/labor-rules')).json;
  assert.equal(def.minRestHours, 8);
  const body = { ...def, minRestHours: 10, maxDailyHours: 12, weeklyOtAfter: 1 };
  assert.equal((await call(c1.session, 'PUT', '/api/labor-rules', body)).status, 403);
  assert.equal((await call(a, 'PUT', '/api/labor-rules', body)).status, 200);
  assert.equal((await call(a, 'PUT', '/api/labor-rules', { ...body, otMultiplier: 0.5 })).status, 400);

  const ev = await mkEvent(a);
  const mk = async (s: number, e: number) => (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Tech', startsAt: start(s), endsAt: start(e), headcount: 1 })).json.shift.id as string;
  const s1 = await mk(100, 106);
  const s2 = await mk(110, 114); // 4 h after s1 ends: not enough rest
  const s3 = await mk(130, 134); // 24 h after: fine
  const r1 = await call(a, 'POST', `/api/shifts/${s1}/assign`, { userId: c1.id });
  assert.equal(r1.status, 201, r1.text);
  assert.match(r1.json.warnings[0], /overtime/);
  const bad = await call(a, 'POST', `/api/shifts/${s2}/assign`, { userId: c1.id });
  assert.equal(bad.status, 409);
  assert.equal(bad.json.reason, 'rules');
  assert.match(bad.json.error, /rest/);
  const ok = await call(a, 'POST', `/api/shifts/${s2}/assign`, { userId: c1.id, override: true });
  assert.equal(ok.status, 201, ok.text);
  assert.ok(ok.json.warnings.length >= 1, 'weekly overtime warning');
  assert.match(ok.json.warnings[0], /overtime/);
  assert.equal((await call(a, 'POST', `/api/shifts/${s3}/assign`, { userId: c1.id })).status, 201);

  // a 13 h day breaks the daily maximum
  const long = await mk(200, 213);
  const d = await call(a, 'POST', `/api/shifts/${long}/assign`, { userId: c1.id });
  assert.equal(d.status, 409);
  assert.match(d.json.error, /maximum/);
});

test('pay rules: weekly overtime and night / Sunday / holiday premiums', async () => {
  const { priceShift } = await import('../src/pay');
  const rules = { tz: 'UTC', minRest: 8, maxDaily: 14, dailyOt: 0, weeklyOt: 40, otMult: 1.5, nightStart: 22 * 60, nightEnd: 6 * 60, nightPct: 25, sundayPct: 50, holidayPct: 100, holidays: ['2030-01-02'] };
  // plain weekday afternoon, no premium
  assert.equal(priceShift(rules, 10, '2030-01-01T10:00:00Z', '2030-01-01T14:00:00Z').estimate, 40);
  // 38 h already worked: the last 2 of 4 hours are overtime at 1.5x
  const ot = priceShift(rules, 10, '2030-01-01T10:00:00Z', '2030-01-01T14:00:00Z', 38);
  assert.equal(ot.estimate, 50);
  assert.equal(ot.otHours, 2);
  // 20:00-02:00 UTC: 2 h normal + 4 h night at +25% (2030-01-05 is a Saturday, then Sunday: 50% applies after midnight)
  const night = priceShift(rules, 10, '2030-01-03T20:00:00Z', '2030-01-04T02:00:00Z');
  assert.equal(night.estimate, 70);
  assert.deepEqual(night.notes, ['night']);
  // Sunday 2030-01-06
  assert.equal(priceShift(rules, 10, '2030-01-06T10:00:00Z', '2030-01-06T12:00:00Z').estimate, 30);
  // holiday doubles it
  assert.equal(priceShift(rules, 10, '2030-01-02T10:00:00Z', '2030-01-02T12:00:00Z').estimate, 40);
  // daily overtime after 8 h
  const dly = priceShift({ ...rules, dailyOt: 8 }, 10, '2030-01-01T08:00:00Z', '2030-01-01T18:00:00Z');
  assert.equal(dly.estimate, 80 + 30);
  // no rate -> no estimate
  assert.equal(priceShift(rules, undefined, '2030-01-01T10:00:00Z', '2030-01-01T14:00:00Z').estimate, null);
});

test('ratings: coordinators rate crew per position, crew cannot, base role name is used', async () => {
  const a = await register('rate');
  const c1 = await mkCrew(a, 'rt1');
  assert.equal((await call(c1.session, 'PUT', `/api/crew/${c1.id}/ratings`, { role: 'Audio', stars: 5 })).status, 403);
  assert.equal((await call(a, 'PUT', `/api/crew/${c1.id}/ratings`, { role: 'Audio (Lead)', stars: 4 })).json.ratings.audio, 4);
  assert.equal((await call(a, 'PUT', `/api/crew/${c1.id}/ratings`, { role: 'Audio', stars: 5 })).json.ratings.audio, 5);
  assert.equal((await call(a, 'PUT', `/api/crew/${c1.id}/ratings`, { role: 'Lighting', stars: 3 })).status, 200);
  assert.equal((await call(a, 'PUT', `/api/crew/${c1.id}/ratings`, { role: 'Audio', stars: 6 })).status, 400);
  const row = (await call(a, 'GET', '/api/crew')).json.crew.find((m: any) => m.id === c1.id);
  assert.deepEqual(row.ratings, { audio: 5, lighting: 3 });
  assert.deepEqual((await call(a, 'PUT', `/api/crew/${c1.id}/ratings`, { role: 'Lighting', stars: null })).json.ratings, { audio: 5 });
  assert.equal((await call(a, 'PUT', `/api/crew/${crypto.randomUUID()}/ratings`, { role: 'Audio', stars: 3 })).status, 404);
});

test('clocking: geofence, coordinator mode and on-site check-in', async () => {
  const a = await register('geo');
  const c1 = await mkCrew(a, 'geo1');
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Tech', startsAt: start(-1), endsAt: start(5), headcount: 1 })).json.shift.id;
  const asg = (await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id })).json.assignment.id;
  await call(c1.session, 'POST', `/api/assignments/${asg}/respond`, { response: 'accepted' });

  // settings: admin/coordinator only, both coordinates needed
  assert.equal((await call(c1.session, 'PUT', `/api/events/${ev}/clocking`, { clockMode: 'self', lat: 39.74, lng: -104.99, geofenceM: 200 })).status, 403);
  assert.equal((await call(a, 'PUT', `/api/events/${ev}/clocking`, { clockMode: 'self', lat: 39.74, lng: null, geofenceM: 200 })).status, 400);
  assert.equal((await call(a, 'PUT', `/api/events/${ev}/clocking`, { clockMode: 'self', lat: 39.74, lng: -104.99, geofenceM: 200 })).status, 200);
  assert.equal((await call(c1.session, 'GET', '/api/my/shifts')).json.shifts[0].needs_location, true);

  // no position, far away, then close by
  const noPos = await call(c1.session, 'POST', '/api/time/clock-in', { assignmentId: asg });
  assert.equal(noPos.status, 409);
  assert.match(noPos.json.error, /location/);
  const far = await call(c1.session, 'POST', '/api/time/clock-in', { assignmentId: asg, lat: 39.80, lng: -104.99, accuracy: 20 });
  assert.equal(far.status, 409);
  assert.equal(far.json.reason, 'geofence');
  assert.match(far.json.error, /km from/);
  const near = await call(c1.session, 'POST', '/api/time/clock-in', { assignmentId: asg, lat: 39.7405, lng: -104.99, accuracy: 15 });
  assert.equal(near.status, 201, near.text);
  assert.equal((await call(c1.session, 'POST', '/api/time/clock-out', { lat: 39.7405, lng: -104.99 })).status, 200);

  // coordinator mode: crew cannot clock themselves in, the coordinator checks them in and out
  assert.equal((await call(a, 'PUT', `/api/events/${ev}/clocking`, { clockMode: 'coordinator', lat: null, lng: null, geofenceM: null })).status, 200);
  const blocked = await call(c1.session, 'POST', '/api/time/clock-in', { assignmentId: asg });
  assert.equal(blocked.status, 409);
  assert.match(blocked.json.error, /coordinator/);
  assert.equal((await call(c1.session, 'POST', `/api/assignments/${asg}/check-in`)).status, 403);
  assert.equal((await call(a, 'POST', `/api/assignments/${asg}/check-in`)).status, 201);
  assert.equal((await call(a, 'POST', `/api/assignments/${asg}/check-in`)).status, 409);
  const det = (await call(a, 'GET', `/api/events/${ev}`)).json.shifts[0].assignments[0];
  assert.ok(det.clocked_in_at);
  assert.equal((await call(a, 'POST', `/api/assignments/${asg}/check-out`)).status, 200);
  assert.equal((await call(a, 'POST', `/api/assignments/${asg}/check-out`)).status, 409);
  assert.equal((await call(a, 'GET', '/api/timesheets?status=submitted')).json.entries.length, 2);
});

test('crew groups: fill from group skips scheduled people, ranks by rating, auto-picks or offers to the group only', async () => {
  const a = await register('cgrp');
  const [c1, c2, c3, c4, outsider] = [await mkCrew(a, 'g1'), await mkCrew(a, 'g2'), await mkCrew(a, 'g3'), await mkCrew(a, 'g4'), await mkCrew(a, 'g5')];
  const g = (await call(a, 'POST', '/api/crew-groups', { name: 'Audio A-team' })).json.group.id;
  assert.equal((await call(a, 'POST', '/api/crew-groups', { name: 'audio a-team' })).status, 409);
  assert.equal((await call(c1.session, 'GET', '/api/crew-groups')).status, 403);
  assert.equal((await call(a, 'PUT', `/api/crew-groups/${g}/members`, { userIds: [c1.id, c2.id, c3.id, c4.id] })).status, 200);
  assert.equal((await call(a, 'GET', '/api/crew-groups')).json.groups[0].members.length, 4);
  for (const [c, n] of [[c1, 3], [c2, 5], [c3, 4], [c4, 5]] as const) await call(a, 'PUT', `/api/crew/${c.id}/ratings`, { role: 'Audio', stars: n });

  const ev = await mkEvent(a);
  const mk = async (s: number, e: number, hc: number) => (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Audio', startsAt: start(s), endsAt: start(e), headcount: hc })).json.shift.id as string;
  const busy = await mk(300, 306, 1);
  await call(a, 'POST', `/api/shifts/${busy}/assign`, { userId: c2.id }); // best rated, but booked
  const sh = await mk(302, 308, 2);
  const cand = (await call(a, 'GET', `/api/shifts/${sh}/group-candidates?groupId=${g}`)).json;
  assert.deepEqual(cand.candidates.map((x: any) => x.user_id), [c4.id, c3.id, c1.id]); // 5, 4, 3 stars; c2 left out
  assert.ok(cand.skipped.some((s: any) => s.user_id === c2.id && /already scheduled/.test(s.reason)));
  assert.equal(cand.spots, 2);

  // auto: top 2
  const auto = await call(a, 'POST', `/api/shifts/${sh}/fill-from-group`, { groupId: g, mode: 'auto' });
  assert.equal(auto.status, 200, auto.text);
  assert.deepEqual(auto.json.offered.map((x: any) => x.user_id), [c4.id, c3.id]);
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/fill-from-group`, { groupId: g, mode: 'auto' })).status, 409); // full

  // offer to the group: only members can see and claim it
  const open = await mk(400, 404, 1);
  const off = await call(a, 'POST', `/api/shifts/${open}/fill-from-group`, { groupId: g, mode: 'offer' });
  assert.equal(off.status, 200, off.text);
  assert.equal(off.json.notified, 4);
  assert.equal((await call(outsider.session, 'GET', '/api/open-shifts')).json.shifts.length, 0);
  assert.equal((await call(outsider.session, 'POST', `/api/shifts/${open}/claim`)).status, 404);
  assert.equal((await call(c1.session, 'GET', '/api/open-shifts')).json.shifts.length, 1);
  assert.equal((await call(c1.session, 'POST', `/api/shifts/${open}/claim`)).status, 201);
});

test('trainings: announce, apply, capacity waitlist, promotion, completion grants the certificate', async () => {
  const a = await register('trn');
  const [c1, c2, c3] = [await mkCrew(a, 'tr1'), await mkCrew(a, 'tr2'), await mkCrew(a, 'tr3')];
  const tid = await tenantOf(a);
  // c3 already holds a valid cert, so is not told about the class
  await withTenant(tid, (c) => c.query("INSERT INTO user_certs (tenant_id, user_id, name, expires_on) VALUES ($1,$2,'Forklift','2099-01-01')", [tid, c3.id]));

  assert.equal((await call(c1.session, 'POST', '/api/trainings', { title: 'x', startsAt: start(48), endsAt: start(52), capacity: 1 })).status, 403);
  const made = await call(a, 'POST', '/api/trainings', { title: 'Forklift class', location: 'Warehouse', startsAt: start(48), endsAt: start(52), capacity: 1, grantsCert: 'Forklift', certValidMonths: 36 });
  assert.equal(made.status, 201, made.text);
  assert.equal(made.json.training.notified, 2);
  const t = made.json.training.id;
  const inbox = await withTenant(tid, (c) => c.query("SELECT user_id FROM notifications WHERE category = 'training' AND title LIKE 'Training open%'"));
  assert.deepEqual(inbox.rows.map((r) => r.user_id).sort(), [c1.id, c2.id].sort());

  assert.equal((await call(c1.session, 'POST', `/api/trainings/${t}/apply`)).status, 201);
  assert.equal((await call(c1.session, 'POST', `/api/trainings/${t}/apply`)).status, 409);
  assert.equal((await call(c2.session, 'POST', `/api/trainings/${t}/apply`)).status, 201);
  const apps = (await call(a, 'GET', '/api/trainings')).json.trainings[0].applications;
  const a1 = apps.find((x: any) => x.user_id === c1.id).id, a2 = apps.find((x: any) => x.user_id === c2.id).id;
  assert.equal((await call(c1.session, 'PATCH', `/api/training-applications/${a1}`, { status: 'approved' })).status, 403);
  assert.equal((await call(a, 'PATCH', `/api/training-applications/${a1}`, { status: 'approved' })).json.status, 'approved');
  assert.equal((await call(a, 'PATCH', `/api/training-applications/${a2}`, { status: 'approved' })).json.status, 'waitlisted'); // full

  // c1 withdraws -> c2 moves up
  assert.equal((await call(c1.session, 'DELETE', `/api/trainings/${t}/apply`)).status, 200);
  const mine = (await call(c2.session, 'GET', '/api/trainings')).json.trainings[0];
  assert.equal(mine.my_status, 'approved');
  assert.equal(mine.applications, undefined);

  // completion grants the certificate with an expiry
  const done = await call(a, 'POST', `/api/trainings/${t}/complete`);
  assert.equal(done.json.completed, 1);
  const cert = await withTenant(tid, (c) => c.query("SELECT verified, expires_on IS NOT NULL AS has_exp FROM user_certs WHERE user_id = $1 AND name = 'Forklift'", [c2.id]));
  assert.deepEqual(cert.rows[0], { verified: true, has_exp: true });
  assert.equal((await call(a, 'POST', `/api/trainings/${t}/complete`)).status, 409);
});

test('open shift for a group: the email carries claim links that work without signing in', async () => {
  const a = await register('clk');
  const [c1, c2] = [await mkCrew(a, 'gclm1'), await mkCrew(a, 'gclm2')];
  const tid = await tenantOf(a);
  const g = (await call(a, 'POST', '/api/crew-groups', { name: 'Team' })).json.group.id;
  await call(a, 'PUT', `/api/crew-groups/${g}/members`, { userIds: [c1.id] });
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Tech', startsAt: start(60), endsAt: start(66), headcount: 1 })).json.shift.id;
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/fill-from-group`, { groupId: g, mode: 'offer' })).status, 200);
  const mail = await withTenant(tid, (c) => c.query("SELECT body, html FROM deliveries WHERE channel = 'email' AND user_id = $1 ORDER BY created_at DESC LIMIT 1", [c1.id]));
  const url = /\/respond\?t=([\w.-]+)&(?:amp;)?a=accept/.exec(mail.rows[0].html)!;
  const t = url[1];
  const pre = await call(null, 'GET', `/api/respond/preview?t=${t}`);
  assert.equal(pre.status, 200, pre.text);
  assert.equal(pre.json.shift.kind, 'claim');
  assert.equal(pre.json.shift.canRespond, true);
  // another person's token for a group they are not in cannot claim
  const { claimToken } = await import('../src/notify/respond');
  const bad = await call(null, 'POST', '/api/respond', { t: claimToken(tid, sh, c2.id), response: 'accepted' });
  assert.equal(bad.status, 409);
  assert.equal((await call(null, 'POST', '/api/respond', { t, response: 'accepted' })).json.status, 'accepted');
  assert.equal((await call(null, 'GET', `/api/respond/preview?t=${t}`)).json.shift.canRespond, false);
  assert.equal((await call(null, 'POST', '/api/respond', { t: 'x.y', response: 'accepted' })).status, 400);
});

test('coordinator can confirm crew straight onto a shift (no accept step)', async () => {
  const a = await register('autoc');
  const [c1, c2] = [await mkCrew(a, 'ac1'), await mkCrew(a, 'ac2')];
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Tech', startsAt: start(80), endsAt: start(86), headcount: 2 })).json.shift.id;
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id, confirmed: true })).status, 201);
  assert.equal((await call(c1.session, 'GET', '/api/my/shifts')).json.shifts[0].status, 'accepted');
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c2.id })).status, 201);
  assert.equal((await call(c2.session, 'GET', '/api/my/shifts')).json.shifts[0].status, 'offered');
  const t = await tenantOf(a);
  const m = await withTenant(t, (c) => c.query("SELECT title FROM notifications WHERE user_id = $1", [c1.id]));
  assert.equal(m.rows[0].title, "You're scheduled: Tech");
  // group auto-fill can confirm too
  const g = (await call(a, 'POST', '/api/crew-groups', { name: 'AC' })).json.group.id;
  const c3 = await mkCrew(a, 'ac3');
  await call(a, 'PUT', `/api/crew-groups/${g}/members`, { userIds: [c3.id] });
  const sh2 = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Tech', startsAt: start(120), endsAt: start(126), headcount: 1 })).json.shift.id;
  assert.equal((await call(a, 'POST', `/api/shifts/${sh2}/fill-from-group`, { groupId: g, mode: 'auto', confirmed: true })).status, 200);
  assert.equal((await call(c3.session, 'GET', '/api/my/shifts')).json.shifts[0].status, 'accepted');
});

test('coordinator can confirm an offered shift on the crew member\'s behalf', async () => {
  const a = await register('cfm');
  const c1 = await mkCrew(a, 'cf1');
  const ev = await mkEvent(a);
  const sh = (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Tech', startsAt: start(90), endsAt: start(96), headcount: 1 })).json.shift.id;
  const asg = (await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id })).json.assignment.id;
  assert.equal((await call(c1.session, 'POST', `/api/assignments/${asg}/confirm`)).status, 403);
  assert.equal((await call(a, 'POST', `/api/assignments/${asg}/confirm`)).status, 200);
  assert.equal((await call(c1.session, 'GET', '/api/my/shifts')).json.shifts[0].status, 'accepted');
  assert.equal((await call(a, 'POST', `/api/assignments/${asg}/confirm`)).status, 404);
});

test('rentman: connect with a token, sync projects, link to an event, equipment and project info, admin-only settings', async () => {
  const a = await register('rm');
  const c1 = await mkCrew(a, 'rm1');
  const calls: string[] = [];
  const pushed: any[] = [];
  const real = globalThis.fetch;
  const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    if (!url.startsWith('https://api.rentman.net')) return real(input, init);
    calls.push(url);
    if ((init?.headers as any)?.Authorization !== 'Bearer good-token-123456') return json({ error: 'nope' }, 401);
    if (init?.method === 'POST' && url.endsWith('/contacts')) { pushed.push(JSON.parse(init.body)); return json({ data: { id: 555 } }); }
    if (init?.method === 'PUT' && url.includes('/contacts/')) { pushed.push(JSON.parse(init.body)); return json({ data: {} }); }
    if (url.includes('/contactpersons')) return json({ data: [{ id: 1, contact: '/contacts/7', firstname: 'Dana', surname: 'Lee', email: 'dana@utah.example', function: 'Producer' }] });
    if (url.includes('/contacts')) return json({ data: [
      { id: 7, displayname: 'Utah Athletics', email_1: 'ops@utah.example', phone_1: '555-0100', visit_street: 'Fieldhouse Dr', visit_number: '1', visit_city: 'Salt Lake City', visit_postalcode: '84112' },
      { id: 9, displayname: 'Rice-Eccles Stadium', visit_street: '451 S 1400 E', visit_city: 'Salt Lake City', visit_postalcode: '84112' },
    ] });
    if (url.includes('/projectequipmentgroup')) return json({ data: [{ id: 50, name: 'Audio', order: 1 }, { id: 51, name: 'Lighting', order: 2 }] });
    if (url.includes('/projectequipment')) return json({ data: [
      { id: 1, displayname: 'Shure SM58', quantity_total: 12, unit_price: 9.5, is_option: false, equipment_group: '/projectequipmentgroup/50', planperiod_start: '2030-01-01T08:00:00+00:00', planperiod_end: '2030-01-02T22:00:00+00:00' },
      { id: 2, displayname: 'JBL VTX A12', quantity_total: 24, unit_price: 80, is_option: true, equipment_group: '/projectequipmentgroup/50' },
      { id: 3, displayname: 'Cable pack', quantity_total: 1, parent: '/projectequipment/2', equipment_group: '/projectequipmentgroup/50' },
      { id: 4, displayname: 'Moving head', quantity_total: 8, equipment_group: '/projectequipmentgroup/51' },
      { id: 5, displayname: 'Ungrouped item', quantity_total: 2 },
    ] });
    if (url.includes('/projects')) return json({ data: [
      { id: 101, number: 2042, displayname: 'U of U Game Day', customer: '/contacts/7', location: '/contacts/9', reference: 'PO-77', project_type: 'Regular', planperiod_start: '2030-01-01T08:00:00+00:00', planperiod_end: '2030-01-02T22:00:00+00:00' },
      { id: 102, number: 2043, displayname: 'Spring Concert', customer: '/contacts/7' },
    ] });
    return json({ error: 'unexpected' }, 404);
  }) as typeof fetch;
  try {
    // admin only
    assert.equal((await call(c1.session, 'GET', '/api/rentman/settings')).status, 403);
    assert.equal((await call(a, 'PUT', '/api/rentman/settings', { token: 'bad-token-1234567' })).status, 400);
    assert.equal((await call(a, 'GET', '/api/rentman/settings')).json.connected, false);
    assert.equal((await call(a, 'POST', '/api/rentman/sync')).status, 409);
    assert.equal((await call(a, 'PUT', '/api/rentman/settings', { token: 'good-token-123456' })).status, 200);
    assert.equal((await call(a, 'GET', '/api/rentman/settings')).json.connected, true);

    const syn = await call(a, 'POST', '/api/rentman/sync');
    assert.equal(syn.json.synced, 2);
    assert.equal(syn.json.customers.created, 1);
    assert.equal(syn.json.customers.contacts, 2, 'the company and its contact person');
    const list = (await call(a, 'GET', '/api/rentman/projects?q=game')).json.projects;
    assert.equal(list.length, 1);
    assert.equal(list[0].customer, 'Utah Athletics');
    assert.equal(list[0].location, 'Rice-Eccles Stadium');
    assert.equal(list[0].location_address, '451 S 1400 E, 84112 Salt Lake City');
    assert.ok(list[0].customer_local_id, 'the Rentman customer now exists in the CRM');

    // the customer came across with contacts and an address, and syncing again does not duplicate anything
    const cust = (await call(a, 'GET', `/api/customers/${list[0].customer_local_id}`)).json;
    assert.equal(cust.customer.rentman_contact_id, 7);
    assert.deepEqual(cust.contacts.map((x: any) => x.email).sort(), ['dana@utah.example', 'ops@utah.example']);
    assert.equal(cust.locations.length, 1);
    assert.equal((await call(a, 'POST', '/api/rentman/sync')).json.customers.contacts, 0);
    assert.equal((await call(a, 'GET', '/api/customers')).json.customers.length, 1);

    // a new CRM customer can be sent to Rentman; the one already there is not duplicated
    await call(a, 'POST', '/api/customers', { name: 'New Client', email: 'hi@new.example' });
    const ps = await call(a, 'POST', '/api/rentman/push-customers');
    assert.equal(ps.json.sent, 1, ps.text);
    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].displayname, 'New Client');
    assert.equal(pushed[0].email_1, 'hi@new.example');
    assert.equal((await call(c1.session, 'POST', '/api/rentman/push-customers')).status, 403);

    // create an event already linked, equipment comes with it
    const made = await call(a, 'POST', '/api/events', { name: 'Game Day', startDate: '2030-01-01', endDate: '2030-01-02', rentmanProjectId: 101 });
    assert.equal(made.status, 201, made.text);
    const ev = made.json.event.id;
    // the project filled in the customer, client name, venue and street address
    assert.equal(made.json.event.client, 'Utah Athletics');
    assert.equal(made.json.event.customer_id, list[0].customer_local_id);
    assert.equal(made.json.event.venue, 'Rice-Eccles Stadium');
    assert.match(made.json.event.address, /451 S 1400 E/);
    const v = (await call(a, 'GET', `/api/events/${ev}/rentman`)).json;
    assert.equal(v.linked, true);
    assert.equal(v.project.number, 2042);
    assert.equal(v.project.reference, 'PO-77');
    assert.equal(v.equipment.length, 5);
    assert.equal(v.equipment[0].unit_price, '9.5'); // admin sees prices
    assert.deepEqual([...new Set(v.equipment.map((e: any) => e.group_name))], ['Audio', 'Lighting', null]);
    assert.equal(v.equipment.find((e: any) => e.item_id === 3).parent_id, 2);

    // link another event later, unlink, and coordinators do not see prices
    const ev2 = await mkEvent(a);
    assert.equal((await call(a, 'PUT', `/api/events/${ev2}/rentman`, { projectId: 999 })).status, 409);
    assert.equal((await call(a, 'PUT', `/api/events/${ev2}/rentman`, { projectId: 102 })).json.linked, true);
    assert.equal((await call(a, 'POST', `/api/events/${ev}/rentman/refresh`)).json.equipment.length, 5);
    assert.equal((await call(c1.session, 'GET', `/api/events/${ev}/rentman`)).status, 403);
    assert.equal((await call(a, 'PUT', `/api/events/${ev2}/rentman`, { projectId: null })).json.linked, false);

    // the token is stored encrypted, never returned
    assert.ok(!JSON.stringify((await call(a, 'GET', '/api/rentman/settings')).json).includes('good-token'));
    assert.equal((await call(a, 'DELETE', '/api/rentman/settings')).json.connected, false);
  } finally {
    globalThis.fetch = real;
  }
});

test('customers: CRUD, duplicates, import from event client names, roles, isolation', async () => {
  const a = await register('crm1');
  const b = await register('crm2');
  const c1 = await mkCrew(a, 'crmc1');
  assert.equal((await call(c1.session, 'GET', '/api/customers')).status, 403);
  const made = await call(a, 'POST', '/api/customers', { name: 'Acme Corp', contactName: 'Pat', email: 'pat@acme.example' });
  assert.equal(made.status, 201, made.text);
  const id = made.json.customer.id;
  assert.equal((await call(a, 'POST', '/api/customers', { name: 'acme corp' })).status, 409);
  assert.equal((await call(a, 'POST', '/api/customers', { name: 'X', email: 'nope' })).status, 400);
  const up = await call(a, 'PATCH', `/api/customers/${id}`, { phone: '555-1234', notes: 'Pays net 30' });
  assert.equal(up.json.customer.phone, '555-1234');
  assert.equal(up.json.customer.contact_name, 'Pat', 'untouched fields stay');
  assert.equal((await call(b, 'GET', `/api/customers/${id}`)).status, 404);

  // events with client text only get turned into customers
  await call(a, 'POST', '/api/events', { name: 'Old Show', client: 'Globex', startDate: '2029-01-01', endDate: '2029-01-01' });
  await call(a, 'POST', '/api/events', { name: 'Old Show 2', client: 'ACME CORP', startDate: '2029-02-01', endDate: '2029-02-01' });
  const imp = await call(a, 'POST', '/api/customers/import-from-events');
  assert.equal(imp.json.created, 1);
  assert.equal(imp.json.linked, 2);
  assert.equal((await call(a, 'GET', `/api/customers/${id}`)).json.events.length, 1);

  // an event created for a customer carries its name
  const ev = await call(a, 'POST', '/api/events', { name: 'New Show', customerId: id, startDate: '2030-01-01', endDate: '2030-01-01' });
  assert.equal(ev.json.event.client, 'Acme Corp');
  assert.equal(ev.json.event.customer_id, id);
  assert.equal((await call(a, 'POST', '/api/events', { name: 'Z', customerId: (await call(b, 'POST', '/api/customers', { name: 'Other' })).json.customer.id, startDate: '2030-01-01', endDate: '2030-01-01' })).status, 404);
  assert.equal((await call(a, 'DELETE', `/api/customers/${id}`)).status, 200);
  assert.equal((await call(a, 'GET', `/api/events/${ev.json.event.id}`)).json.event.customer_id, null);
});

test('copy event: dates shift, phases and shifts come along, crew do not', async () => {
  const a = await register('cpy');
  const c1 = await mkCrew(a, 'cpyc1');
  const src = (await call(a, 'POST', '/api/events', { name: 'Gala', client: 'Acme', venue: 'Hall', startDate: '2030-05-10', endDate: '2030-05-10' })).json.event.id;
  const ph = (await call(a, 'POST', `/api/events/${src}/phases`, { label: 'Show', startDate: '2030-05-10', endDate: '2030-05-11' })).json.phase;
  const sh = (await call(a, 'POST', `/api/events/${src}/shifts`, { roleName: 'Audio A1', startsAt: '2030-05-10T15:00:00Z', endsAt: '2030-05-10T23:00:00Z', headcount: 2, phaseId: ph.id })).json.shift.id;
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: c1.id })).status, 201);

  assert.equal((await call(c1.session, 'POST', `/api/events/${src}/copy`, { name: 'x', startDate: '2031-05-10' })).status, 403);
  const cp = await call(a, 'POST', `/api/events/${src}/copy`, { name: 'Gala 2031', startDate: '2031-05-09' });
  assert.equal(cp.status, 201, cp.text);
  assert.equal(cp.json.offsetDays, 364);
  const d = (await call(a, 'GET', `/api/events/${cp.json.event.id}`)).json;
  assert.equal(d.event.name, 'Gala 2031');
  assert.equal(d.event.venue, 'Hall');
  assert.equal(d.phases.length, 1);
  assert.equal(d.phases[0].starts_on.slice(0, 10), '2031-05-09');
  assert.equal(d.shifts.length, 1);
  assert.equal(d.shifts[0].role_name, 'Audio A1');
  assert.equal(d.shifts[0].headcount, 2);
  assert.equal(d.shifts[0].phase_id, d.phases[0].id, 'phase remapped to the copy');
  assert.equal(d.shifts[0].starts_at.slice(0, 10), '2031-05-09');
  assert.equal(d.shifts[0].assignments.length, 0, 'crew are not copied');
  // the original is untouched
  assert.equal((await call(a, 'GET', `/api/events/${src}`)).json.shifts[0].assignments.length, 1);
  assert.equal((await call(a, 'POST', `/api/events/${src}/copy`, { name: 'Bare', startDate: '2032-01-01', includeShifts: false, includePhases: false })).json.shifts, 0);
});

test('quotes: lines from an event, totals, send, customer accepts without signing in', async () => {
  const a = await register('qte');
  const b = await register('qte2');
  const c1 = await mkCrew(a, 'qtec1');
  const tid = await tenantOf(a);
  const sk = (await call(a, 'POST', '/api/skills', { name: 'Audio A1', payRate: 30, billRate: 60 })).json.skill;
  assert.equal(sk.billRate, 60);
  assert.equal((await call(c1.session, 'GET', '/api/quotes')).status, 403);

  const cu = (await call(a, 'POST', '/api/customers', { name: 'Acme', contactName: 'Pat', email: 'pat@acme.example' })).json.customer.id;
  const ev = (await call(a, 'POST', '/api/events', { name: 'Gala', customerId: cu, startDate: '2030-05-10', endDate: '2030-05-10' })).json.event.id;
  await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Audio A1', startsAt: '2030-05-10T15:00:00Z', endsAt: '2030-05-10T23:00:00Z', headcount: 2 });

  const q = await call(a, 'POST', '/api/quotes', { eventId: ev, taxPct: 10, discount: 100 });
  assert.equal(q.status, 201, q.text);
  assert.equal(q.json.quote.number, 1001);
  assert.equal(q.json.quote.customer_id, cu);
  assert.equal(q.json.lines.length, 1);
  assert.equal(q.json.lines[0].amount, 960); // 2 people × 8h × $60
  assert.deepEqual(q.json.totals, { subtotal: 960, discount: 100, tax: 86, total: 946 });
  const id = q.json.quote.id;
  assert.equal((await call(a, 'POST', '/api/quotes', { title: 'Second' })).json.quote.number, 1002);
  assert.equal((await call(b, 'GET', `/api/quotes/${id}`)).status, 404);

  const ed = await call(a, 'PUT', `/api/quotes/${id}`, { lines: [{ description: 'Audio A1', qty: 2, hours: 8, rate: 60 }, { description: 'Travel', qty: 1, hours: 1, rate: 40.5 }], taxPct: 0, discount: 0 });
  assert.equal(ed.json.totals.total, 1000.5);

  // drafts are not visible to the customer; sending needs lines and an address
  assert.equal((await call(a, 'POST', `/api/quotes/${(await call(a, 'POST', '/api/quotes', { title: 'Empty' })).json.quote.id}/send`, { to: 'x@y.example' })).status, 400);
  const sent = await call(a, 'POST', `/api/quotes/${id}/send`, { message: 'Thanks for the chance!' });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json.sentTo, 'pat@acme.example');
  const mail = await withTenant(tid, (c) => c.query("SELECT html, subject FROM deliveries WHERE to_addr = 'pat@acme.example' ORDER BY created_at DESC LIMIT 1"));
  const t = /\/quote\?t=([\w.-]+)/.exec(mail.rows[0].html)![1];
  assert.match(mail.rows[0].subject, /Quote #1001/);

  const v = await call(null, 'GET', `/api/quote/view?t=${t}`);
  assert.equal(v.status, 200, v.text);
  assert.equal(v.json.quote.totals.total, 1000.5);
  assert.equal(v.json.quote.canRespond, true);
  assert.equal((await call(null, 'GET', '/api/quote/view?t=bad.token')).status, 400);

  // editing a sent quote puts it back to draft and the customer can no longer see it
  assert.equal((await call(a, 'PUT', `/api/quotes/${id}`, { intro: 'Revised' })).json.quote.status, 'draft');
  assert.equal((await call(null, 'GET', `/api/quote/view?t=${t}`)).status, 404);
  assert.equal((await call(a, 'POST', `/api/quotes/${id}/send`)).status, 200);

  assert.equal((await call(null, 'POST', '/api/quote/respond', { t, response: 'accepted', note: 'Go ahead' })).json.status, 'accepted');
  assert.equal((await call(null, 'POST', '/api/quote/respond', { t, response: 'declined' })).status, 409);
  const after = (await call(a, 'GET', `/api/quotes/${id}`)).json.quote;
  assert.equal(after.status, 'accepted');
  assert.equal(after.response_note, 'Go ahead');
  const note = await withTenant(tid, (c) => c.query("SELECT 1 FROM notifications WHERE title = 'Quote #1001 accepted'"));
  assert.ok(note.rowCount! >= 1, 'staff are told');
  assert.equal((await call(a, 'GET', `/api/customers/${cu}`)).json.quotes.length, 1);
  assert.equal((await call(a, 'DELETE', `/api/quotes/${id}`)).status, 200);
});

test('customers: several contacts and locations, main ones are kept, quotes use the main contact', async () => {
  const a = await register('crm3');
  const b = await register('crm4');
  const c1 = await mkCrew(a, 'crm3c');
  const cu = (await call(a, 'POST', '/api/customers', { name: 'Multi Co', contactName: 'Pat', email: 'pat@multi.example', address: '1 Main St' })).json.customer;
  let d = (await call(a, 'GET', `/api/customers/${cu.id}`)).json;
  assert.equal(d.contacts.length, 1);
  assert.equal(d.contacts[0].is_primary, true);
  assert.equal(d.locations[0].address, '1 Main St');
  assert.equal(d.customer.email, 'pat@multi.example');

  const second = await call(a, 'POST', `/api/customers/${cu.id}/contacts`, { name: 'Sam', title: 'AP', email: 'sam@multi.example' });
  assert.equal(second.status, 201, second.text);
  assert.equal(second.json.contact.is_primary, false);
  assert.equal((await call(c1.session, 'POST', `/api/customers/${cu.id}/contacts`, { name: 'x' })).status, 403);
  assert.equal((await call(b, 'POST', `/api/customers/${cu.id}/contacts`, { name: 'x' })).status, 404);
  // make Sam the main contact: the customer's main email follows
  assert.equal((await call(a, 'PATCH', `/api/customer-contacts/${second.json.contact.id}`, { primary: true })).json.contact.is_primary, true);
  d = (await call(a, 'GET', `/api/customers/${cu.id}`)).json;
  assert.equal(d.customer.email, 'sam@multi.example');
  assert.equal(d.contacts.filter((x: any) => x.is_primary).length, 1);
  // deleting the main contact promotes another
  await call(a, 'DELETE', `/api/customer-contacts/${second.json.contact.id}`);
  d = (await call(a, 'GET', `/api/customers/${cu.id}`)).json;
  assert.equal(d.contacts.length, 1);
  assert.equal(d.contacts[0].is_primary, true);

  const loc = await call(a, 'POST', `/api/customers/${cu.id}/locations`, { label: 'Warehouse', venue: 'Dock 4', address: '9 Industrial Way', isDefault: true });
  assert.equal(loc.status, 201, loc.text);
  d = (await call(a, 'GET', `/api/customers/${cu.id}`)).json;
  assert.equal(d.locations.length, 2);
  assert.equal(d.locations[0].label, 'Warehouse');
  assert.equal(d.locations.filter((x: any) => x.is_default).length, 1);
  assert.equal((await call(a, 'PATCH', `/api/customer-locations/${loc.json.location.id}`, { venue: 'Dock 5' })).json.location.venue, 'Dock 5');
  assert.equal((await call(a, 'DELETE', `/api/customer-locations/${loc.json.location.id}`)).status, 200);
  d = (await call(a, 'GET', `/api/customers/${cu.id}`)).json;
  assert.equal(d.locations.length, 1);
  assert.equal(d.locations[0].is_default, true);

  // the quote goes to the main contact by default
  const q = (await call(a, 'POST', '/api/quotes', { title: 'T', customerId: cu.id, lines: [{ description: 'x', qty: 1, hours: 1, rate: 10 }] })).json.quote;
  assert.equal(q.customer_email, 'pat@multi.example');
});

test('quote layout: lines grouped by phase with times, PDF output, admin-designed layouts, customer-only templates', async () => {
  const a = await register('qly');
  const c1 = await mkCrew(a, 'qlyc1');
  const tid = await tenantOf(a);
  await call(a, 'POST', '/api/skills', { name: 'Audio A1', payRate: 30, billRate: 80 });
  const cu = (await call(a, 'POST', '/api/customers', { name: 'Layout Co', email: 'buyer@layout.example' })).json.customer.id;
  const other = (await call(a, 'POST', '/api/customers', { name: 'Other Co' })).json.customer.id;
  const ev = (await call(a, 'POST', '/api/events', { name: 'Expo', customerId: cu, startDate: '2030-05-09', endDate: '2030-05-10' })).json.event.id;
  const li = (await call(a, 'POST', `/api/events/${ev}/phases`, { label: 'Load in', startDate: '2030-05-09', endDate: '2030-05-09' })).json.phase.id;
  const sh = (await call(a, 'POST', `/api/events/${ev}/phases`, { label: 'Show', startDate: '2030-05-10', endDate: '2030-05-10' })).json.phase.id;
  await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Audio A1', startsAt: '2030-05-10T17:00:00Z', endsAt: '2030-05-11T01:00:00Z', headcount: 2, phaseId: sh });
  await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Audio A1', startsAt: '2030-05-09T15:00:00Z', endsAt: '2030-05-09T23:00:00Z', headcount: 1, phaseId: li });

  const q = await call(a, 'POST', '/api/quotes', { eventId: ev });
  assert.equal(q.status, 201, q.text);
  assert.deepEqual(q.json.lines.map((l: any) => l.section), ['Load in', 'Show'], 'phases come first, in date order');
  assert.equal(q.json.lines[1].hours, 8);
  assert.equal(q.json.lines[1].rate, 80);
  assert.match(q.json.lines[1].startTime, /^\d\d:\d\d$/);
  assert.match(q.json.lines[1].day, /^2030-05-1[01]$/);
  const id = q.json.quote.id;

  // times drive hours (and an end before the start means past midnight)
  const ed = await call(a, 'PUT', `/api/quotes/${id}`, { lines: [{ section: 'Show', description: 'Audio A1', day: '2030-05-10', startTime: '18:00', endTime: '02:00', qty: 1, hours: 99, rate: 80 }] });
  assert.equal(ed.json.lines[0].hours, 8);
  assert.equal((await call(a, 'PUT', `/api/quotes/${id}`, { lines: [{ description: 'x', startTime: '25:00', qty: 1, hours: 1, rate: 1 }] })).status, 400);

  // PDF
  const res = await call(a, 'GET', `/api/quotes/${id}/pdf`);
  assert.equal(res.status, 200);
  assert.ok(res.text.startsWith('%PDF'), 'a real PDF');
  assert.equal((await call(c1.session, 'GET', `/api/quotes/${id}/pdf`)).status, 403);

  // layouts: admin only, validated, one default, preview renders unsaved settings, a quote can choose one
  const cfg = (await call(a, 'GET', '/api/quote-layouts')).json.builtIn;
  assert.equal((await call(c1.session, 'POST', '/api/quote-layouts', { name: 'x', config: cfg })).status, 403);
  assert.equal((await call(a, 'POST', '/api/quote-layouts', { name: 'Bad', config: { ...cfg, accent: 'red' } })).status, 400);
  const l1 = await call(a, 'POST', '/api/quote-layouts', { name: 'Classic', config: cfg });
  assert.equal(l1.status, 201, l1.text);
  assert.equal(l1.json.layout.is_default, true, 'the first layout is the default');
  const l2 = await call(a, 'POST', '/api/quote-layouts', { name: 'Bold', config: { ...cfg, accent: '#cc0000', font: 'Times', blocks: [...cfg.blocks.slice(0, 3), { id: 'x1', type: 'text', heading: 'Hello', body: 'Hi {{customer}} - total {{total}}', align: 'center' }, { id: 'x2', type: 'lines', groupBySection: false, showDate: false, showPeople: true, showHours: true, showRate: false, zebra: false }, { id: 'x3', type: 'totals' }] } });
  assert.equal((await call(a, 'POST', '/api/quote-layouts', { name: 'bold', config: cfg })).status, 409);
  assert.equal((await call(c1.session, 'GET', '/api/quote-layouts')).status, 403);
  assert.equal((await call(a, 'GET', '/api/quote-layouts')).json.layouts.length, 2);
  assert.ok((await call(a, 'POST', '/api/quote-layouts/preview', { config: cfg })).text.startsWith('%PDF'));
  assert.ok((await call(a, 'POST', '/api/quote-layouts/preview', { config: l2.json.layout ? (await call(a, 'GET', `/api/quote-layouts/${l2.json.layout.id}`)).json.layout.config : cfg, quoteId: id })).text.startsWith('%PDF'));
  assert.equal((await call(a, 'PUT', `/api/quotes/${id}`, { layoutId: l2.json.layout.id })).json.quote.layout_id, l2.json.layout.id);
  assert.equal((await call(a, 'POST', `/api/quote-layouts/${l2.json.layout.id}/default`)).status, 200);
  assert.equal((await call(a, 'GET', '/api/quote-layouts')).json.layouts[0].name, 'Bold');

  // the customer can download the PDF from the emailed link, but not a draft
  const draftTok = (await call(a, 'GET', `/api/quotes/${id}`)).json.link.split('t=')[1];
  assert.equal((await call(null, 'GET', `/api/quote/pdf?t=${draftTok}`)).status, 404);
  assert.equal((await call(a, 'POST', `/api/quotes/${id}/send`)).status, 200);
  const mail = await withTenant(tid, (c) => c.query("SELECT body FROM deliveries WHERE to_addr = 'buyer@layout.example' ORDER BY created_at DESC LIMIT 1"));
  const pt = /\/api\/quote\/pdf\?t=([\w.-]+)/.exec(mail.rows[0].body)![1];
  const pub = await call(null, 'GET', `/api/quote/pdf?t=${pt}`);
  assert.equal(pub.status, 200);
  assert.ok(pub.text.startsWith('%PDF'));
  assert.equal((await call(null, 'GET', '/api/quote/pdf?t=bad.token')).status, 400);

  // save the quote as a template for this customer only
  assert.equal((await call(a, 'POST', `/api/quotes/${id}/save-template`, { name: 'Expo crew' })).status, 201);
  assert.equal((await call(a, 'POST', `/api/quotes/${id}/save-template`, { name: 'Expo crew' })).status, 409);
  const mine = (await call(a, 'GET', `/api/templates?customerId=${cu}`)).json.templates;
  assert.equal(mine.length, 1);
  assert.equal(mine[0].items[0].role, 'Audio A1');
  assert.equal(mine[0].items[0].start, '18:00');
  assert.equal(mine[0].items[0].end, '02:00');
  assert.equal((await call(a, 'GET', `/api/templates?customerId=${other}`)).json.templates.length, 0, 'other customers never see it');
  assert.equal((await call(a, 'GET', '/api/templates')).json.templates.length, 0, 'not offered when no customer is chosen');
  const noCust = (await call(a, 'POST', '/api/quotes', { title: 'Loose', lines: [{ description: 'x', day: '2030-01-01', startTime: '08:00', endTime: '10:00', qty: 1, hours: 2, rate: 5 }] })).json.quote.id;
  assert.equal((await call(a, 'POST', `/api/quotes/${noCust}/save-template`, { name: 'n' })).status, 400);
});

test('rates: two rates per role; only admins and allowed coordinators can adjust them, on roles and on quotes', async () => {
  const a = await register('rtp');
  await call(a, 'POST', '/api/skills', { name: 'Audio A1', payRate: 40, billRate: 90 });
  const skill = (await call(a, 'GET', '/api/skills')).json.skills.find((s: any) => s.name === 'Audio A1');
  const crew = await mkCrew(a, 'rtpcrew');
  const mk = await call(a, 'POST', '/api/crew', { name: 'Coord', email: `rtpco-${run}@test.example`, password: 'password123', role: 'manager' });
  assert.equal(mk.status, 201, mk.text);
  const coordId = mk.json.member.id;
  const coord = await login(`rtpco-${run}@test.example`, 'password123');

  // crew never see the bill rate; they only see pay (their own estimate elsewhere)
  const cs = (await call(crew.session, 'GET', '/api/skills')).json.skills[0];
  assert.equal(cs.billRate, undefined);
  assert.equal(cs.payRate, undefined);
  // a coordinator without permission sees bill rates but not pay rates, and cannot change either
  assert.equal((await call(coord, 'GET', '/api/auth/me')).json.user.canAdjustRates, false);
  const nsk = (await call(coord, 'GET', '/api/skills')).json.skills.find((s: any) => s.name === 'Audio A1');
  assert.equal(nsk.billRate, 90);
  assert.equal(nsk.payRate, undefined);
  assert.equal((await call(coord, 'PATCH', `/api/skills/${skill.id}`, { billRate: 95 })).status, 403);
  assert.equal((await call(crew.session, 'PATCH', `/api/skills/${skill.id}`, { billRate: 95 })).status, 403);

  // on a quote, their role lines stay at the role's bill rate and the discount cannot be set, but a travel line is free
  const q = (await call(coord, 'POST', '/api/quotes', { title: 'T', discount: 50, lines: [
    { description: 'Audio A1', qty: 1, hours: 8, rate: 10 }, { description: 'Travel', qty: 1, hours: 1, rate: 75 }] })).json;
  assert.equal(q.lines[0].rate, 90, 'locked to the role bill rate');
  assert.equal(q.lines[1].rate, 75);
  assert.equal(q.quote.discount, 0);
  assert.equal((await call(coord, 'PUT', `/api/quotes/${q.quote.id}`, { discount: 20, lines: [{ description: 'audio a1', qty: 2, hours: 8, rate: 1 }] })).json.totals.total, 1440);
  const dq = (await call(coord, 'GET', `/api/quotes/${q.quote.id}`)).json;
  assert.equal(dq.canAdjustRates, false);
  assert.deepEqual(dq.roleRates, []);

  // only an admin can grant the permission, and only to a coordinator
  assert.equal((await call(coord, 'PUT', `/api/crew/${coordId}/rate-permission`, { allowed: true })).status, 403);
  assert.equal((await call(a, 'PUT', `/api/crew/${crew.id}/rate-permission`, { allowed: true })).status, 404);
  assert.equal((await call(a, 'PUT', `/api/crew/${coordId}/rate-permission`, { allowed: true })).json.can_adjust_rates, true);

  // now they can change rates on the fly: on lines, discount, and the role defaults (only the two rates)
  assert.equal((await call(coord, 'GET', '/api/auth/me')).json.user.canAdjustRates, true);
  assert.equal((await call(coord, 'GET', '/api/skills')).json.skills.find((s: any) => s.name === 'Audio A1').payRate, 40);
  const up = await call(coord, 'PUT', `/api/quotes/${q.quote.id}`, { discount: 100, lines: [{ description: 'Audio A1', qty: 1, hours: 8, rate: 100 }] });
  assert.equal(up.json.lines[0].rate, 100);
  assert.equal(up.json.totals.total, 700);
  const dq2 = (await call(coord, 'GET', `/api/quotes/${q.quote.id}`)).json;
  assert.equal(dq2.roleRates.find((r: any) => r.name === 'Audio A1').payRate, 40);
  assert.equal((await call(coord, 'PATCH', `/api/skills/${skill.id}`, { payRate: 42, billRate: 95 })).json.skill.billRate, 95);
  assert.equal((await call(coord, 'PATCH', `/api/skills/${skill.id}`, { name: 'Renamed' })).status, 403);
  assert.equal((await call(coord, 'PATCH', `/api/skills/${skill.id}`, { active: false })).status, 403);

  // turning it off locks them again
  await call(a, 'PUT', `/api/crew/${coordId}/rate-permission`, { allowed: false });
  assert.equal((await call(coord, 'PATCH', `/api/skills/${skill.id}`, { billRate: 1 })).status, 403);
});

test('pay override: one shift can have its own pay rate, only for those allowed to adjust rates', async () => {
  const a = await register('pov');
  await call(a, 'POST', '/api/skills', { name: 'Rigger', payRate: 40, billRate: 90 });
  const crew = await mkCrew(a, 'povcrew');
  const mk = await call(a, 'POST', '/api/crew', { name: 'Coord', email: `povco-${run}@test.example`, password: 'password123', role: 'manager' });
  const coord = await login(`povco-${run}@test.example`, 'password123');
  const tid = await tenantOf(a);
  const ev = await mkEvent(a);
  const mkShift = async () => (await call(a, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Rigger', startsAt: start(100), endsAt: start(104), headcount: 2 })).json.shift.id as string;
  const sh = await mkShift();
  const other = await mkShift();
  assert.equal((await call(a, 'POST', `/api/shifts/${sh}/assign`, { userId: crew.id })).status, 201);
  const shiftOf = async (s: Session, id: string) => (await call(s, 'GET', `/api/events/${ev}`)).json.shifts.find((x: any) => x.id === id);

  // not allowed: coordinators without permission and crew
  assert.equal((await call(coord, 'PATCH', `/api/shifts/${sh}`, { payRate: 55 })).status, 403);
  assert.equal((await call(crew.session, 'PATCH', `/api/shifts/${sh}`, { payRate: 55 })).status, 403);
  assert.equal((await shiftOf(coord, sh)).hourly_rate, undefined, 'coordinators without permission see no rates');
  assert.equal((await call(a, 'PATCH', `/api/shifts/${sh}`, { payRate: 0 })).status, 400);

  // admin sets 55 on this shift only
  assert.equal((await call(a, 'PATCH', `/api/shifts/${sh}`, { payRate: 55 })).status, 200);
  let s1 = await shiftOf(a, sh);
  assert.equal(s1.hourly_rate, 55);
  assert.equal(s1.role_rate, 40);
  assert.equal(s1.pay_rate_override, '55.00');
  assert.equal(s1.estimated_cost, 55 * 4 * 2);
  assert.equal((await shiftOf(a, other)).hourly_rate, 40, 'other shifts keep the role rate');

  // the person on the shift sees the new pay and is told
  const mine = (await call(crew.session, 'GET', '/api/my/shifts')).json.shifts.find((x: any) => x.shift_id === sh);
  assert.equal(mine.hourly_rate, 55);
  assert.equal(mine.estimated_pay, 220);
  const n = await withTenant(tid, (c) => c.query("SELECT 1 FROM notifications WHERE user_id = $1 AND title LIKE 'Pay updated%'", [crew.id]));
  assert.equal(n.rowCount, 1);

  // an allowed coordinator can change and clear it
  await call(a, 'PUT', `/api/crew/${mk.json.member.id}/rate-permission`, { allowed: true });
  assert.equal((await call(coord, 'PATCH', `/api/shifts/${sh}`, { payRate: 60 })).status, 200);
  assert.equal((await shiftOf(coord, sh)).hourly_rate, 60);
  assert.equal((await call(coord, 'PATCH', `/api/shifts/${sh}`, { payRate: null })).status, 200);
  s1 = await shiftOf(a, sh);
  assert.equal(s1.hourly_rate, 40);
  assert.equal(s1.pay_rate_override, null);
});
