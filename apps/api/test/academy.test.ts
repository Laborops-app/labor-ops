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

