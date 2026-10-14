import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
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

async function admin() {
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { company: `Acad ${run}`, name: 'Boss', email: `boss-${run}@test.example`, password: 'password123' } });
  assert.equal(r.statusCode, 200, r.body);
  const c = r.cookies.find((x) => x.name === 'lo_token')!;
  const tid = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64url').toString()).tid as string;
  return { cookie: `lo_token=${c.value}`, tid };
}

function hook(tid: string, secret: string, body: object, opts: { ts?: number; sig?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000));
  const sig = opts.sig ?? 'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  return app.inject({
    method: 'POST', url: `/api/academy/webhook/${tid}`, payload: raw,
    headers: { 'content-type': 'application/json', 'x-academy-timestamp': ts, 'x-academy-signature': sig },
  });
}

const ev = (email: string, code: string, title = 'Stage Hand Basics', type = 'group') => ({
  event: 'certificate.issued',
  certificate: { code, type, title, issued_at: new Date().toISOString() },
  user: { email, username: email },
});

test('academy: signed certificates are imported to the matching user, verified and de-duplicated', async () => {
  const a = await admin();
  const sec = await app.inject({ method: 'POST', url: '/api/integrations/academy/secret', payload: {}, headers: { cookie: a.cookie } });
  assert.equal(sec.statusCode, 200, sec.body);
  const secret = sec.json().secret as string;
  assert.match(sec.json().url, new RegExp(`/api/academy/webhook/${a.tid}$`));

  // a crew member whose email matches (case-insensitive)
  const email = `Crew-${run}@Test.Example`;
  await withTenant(a.tid, (c) =>
    c.query("INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES ($1,$2,'Crew One','crew','x')", [a.tid, email.toLowerCase()]),
  );

  assert.equal((await hook(a.tid, secret, { event: 'ping' })).json().pong, true);
  assert.equal((await hook(a.tid, 'wrong-secret', ev(email, 'UA-AAAA-000001'))).statusCode, 401);
  assert.equal((await hook(a.tid, secret, ev(email, 'UA-AAAA-000001'), { ts: Math.floor(Date.now() / 1000) - 3600 })).statusCode, 401);

  const r1 = await hook(a.tid, secret, ev(email, 'UA-AAAA-000001'));
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(r1.json().matched, true);
  // repeat delivery changes nothing
  assert.equal((await hook(a.tid, secret, ev(email, 'UA-AAAA-000001'))).json().matched, true);
  const certs = await withTenant(a.tid, (c) => c.query("SELECT name, verified, external_ref, source FROM user_certs WHERE source = 'academy'"));
  assert.equal(certs.rowCount, 1);
  assert.deepEqual(certs.rows[0], { name: 'Stage Hand Basics', verified: true, external_ref: 'UA-AAAA-000001', source: 'academy' });

  // unknown person: kept, then applied once the user exists
  const late = `late-${run}@test.example`;
  assert.equal((await hook(a.tid, secret, ev(late, 'UA-BBBB-000002', 'Wrapping Cables', 'course'))).json().matched, false);
  await withTenant(a.tid, (c) => c.query("INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES ($1,$2,'Late','crew','x')", [a.tid, late]));
  const ap = await app.inject({ method: 'POST', url: '/api/integrations/academy/apply', payload: {}, headers: { cookie: a.cookie } });
  assert.deepEqual(ap.json(), { checked: 1, matched: 1 });

  const st = await app.inject({ method: 'GET', url: '/api/integrations/academy', headers: { cookie: a.cookie } });
  assert.equal(st.json().stats.total, 2);
  assert.equal(st.json().stats.applied, 2);
});


test('academy: course groups sync from the academy, crew are asked to complete them, and a group certificate completes it', async () => {
  const a = await admin2();
  const secret = (await app.inject({ method: 'POST', url: '/api/integrations/academy/secret', payload: {}, headers: { cookie: a.cookie } })).json().secret as string;
  // no address yet: sync explains what to do
  assert.equal((await app.inject({ method: 'POST', url: '/api/academy/sync', payload: {}, headers: { cookie: a.cookie } })).statusCode, 400);
  // a signed ping carrying a certificate URL teaches LaborOps the academy address
  const ping = { event: 'ping', certificate: { code: 'UA-TEST-000000', title: 'Connection test', issued_at: new Date().toISOString(), url: 'https://academy.example.test/certificate/UA-TEST-000000/' } };
  assert.equal((await hook(a.tid, secret, ping)).json().pong, true);
  assert.equal((await app.inject({ method: 'GET', url: '/api/integrations/academy', headers: { cookie: a.cookie } })).json().siteUrl, 'https://academy.example.test');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const u = String(input);
    const body = u.includes('/ual_group')
      ? [{ id: 3, name: 'Stage Hand Basics', slug: 'stage-hand-basics', description: 'Core skills &amp; safety', link: 'https://academy.example.test/course-groups/stage-hand-basics/' }]
      : [
          { id: 35, title: { rendered: 'Wrapping Cables' }, link: 'https://academy.example.test/courses/wrapping-cables/', ual_group: [3] },
          { id: 53, title: { rendered: 'Assembling Truss' }, link: 'https://academy.example.test/courses/assembling-truss/', ual_group: [3] },
        ];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-wp-totalpages': '1' } });
  }) as typeof fetch;
  try {
    const s = await app.inject({ method: 'POST', url: '/api/academy/sync', payload: {}, headers: { cookie: a.cookie } });
    assert.equal(s.statusCode, 200, s.body);
    assert.deepEqual(s.json(), { groups: 1, courses: 2, removed: 0 });
  } finally {
    globalThis.fetch = realFetch;
  }
  const list = (await app.inject({ method: 'GET', url: '/api/academy/courses', headers: { cookie: a.cookie } })).json();
  const g = list.groups[0];
  assert.equal(g.name, 'Stage Hand Basics');
  assert.equal(g.description, 'Core skills & safety');
  assert.equal(g.courses.length, 2);

  // a crew member, invited with a text message
  const email = `learner-${run}@test.example`;
  const crewId = (await withTenant(a.tid, (c) => c.query("INSERT INTO users (tenant_id, email, name, role, password_hash) VALUES ($1,$2,'Lee Learner','crew','x') RETURNING id", [a.tid, email]))).rows[0].id;
  const inv = await app.inject({ method: 'POST', url: `/api/academy/groups/${g.id}/invite`, payload: { userIds: [crewId], note: 'Before the Oct load-in please.', text: true }, headers: { cookie: a.cookie } });
  assert.equal(inv.statusCode, 200, inv.body);
  assert.equal(inv.json().sent, 1);
  // a second send without resend skips them
  assert.equal((await app.inject({ method: 'POST', url: `/api/academy/groups/${g.id}/invite`, payload: { userIds: [crewId] }, headers: { cookie: a.cookie } })).json().skippedInvited, 1);
  const n = (await withTenant(a.tid, (c) => c.query("SELECT title, body FROM notifications WHERE user_id = $1 AND category = 'training'", [crewId]))).rows;
  assert.equal(n.length, 1);
  assert.match(n[0].body, /https:\/\/academy\.example\.test\/enroll\/\?ual_join=35/);
  assert.ok(n[0].body.includes(email));
  assert.ok(n[0].body.startsWith('Before the Oct load-in please.'));
  const mail = (await withTenant(a.tid, (c) => c.query("SELECT html FROM deliveries WHERE user_id = $1 AND channel = 'email'", [crewId]))).rows[0];
  assert.ok(mail.html.includes('Create academy account'));

  // one course certificate: 1 of 2; the group certificate: completed, and the coordinator hears about it
  await hook(a.tid, secret, { event: 'certificate.issued', certificate: { code: `UA-C1-${run}`, type: 'course', title: 'Wrapping Cables', issued_at: new Date().toISOString() }, user: { email, username: email } });
  let mine = (await app.inject({ method: 'GET', url: '/api/academy/courses', headers: { cookie: a.cookie } })).json().groups[0].invites[0];
  assert.deepEqual([mine.coursesDone, mine.done], [1, false]);
  await hook(a.tid, secret, { event: 'certificate.issued', certificate: { code: `UA-G1-${run}`, type: 'group', title: 'Stage Hand Basics', issued_at: new Date().toISOString() }, user: { email, username: email } });
  mine = (await app.inject({ method: 'GET', url: '/api/academy/courses', headers: { cookie: a.cookie } })).json().groups[0].invites[0];
  assert.equal(mine.done, true);
  assert.ok(mine.completed_at);
  const told = (await withTenant(a.tid, (c) => c.query("SELECT title FROM notifications WHERE user_id = (SELECT id FROM users WHERE role = 'admin' LIMIT 1) AND title LIKE '%completed Stage Hand Basics'"))).rowCount;
  assert.equal(told, 1);
  // completed people are skipped on the next send
  assert.equal((await app.inject({ method: 'POST', url: `/api/academy/groups/${g.id}/invite`, payload: { userIds: [crewId], resend: true }, headers: { cookie: a.cookie } })).json().skippedDone, 1);
});

async function admin2() {
  const tag = `${run}b`;
  const r = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { company: `Acad2 ${tag}`, name: 'Boss Two', email: `boss2-${tag}@test.example`, password: 'password123' } });
  assert.equal(r.statusCode, 200, r.body);
  const c = r.cookies.find((x) => x.name === 'lo_token')!;
  const tid = JSON.parse(Buffer.from(c.value.split('.')[1], 'base64url').toString()).tid as string;
  return { cookie: `lo_token=${c.value}`, tid };
}
