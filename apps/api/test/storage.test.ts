import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';

// A local S3 server stands in for RustFS. Settings must be in place before the app modules load.
const S3rver = require('s3rver');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 's3rver-'));
const s3 = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: dir });
const run = Date.now().toString(36);
const OPS = `ops-${run}@test.example`;

let app: FastifyInstance;
let mods: any;
// TEST_S3_ENDPOINT (+ TEST_S3_ACCESS_KEY / TEST_S3_SECRET_KEY) runs the same tests against a real RustFS instead.
const real = process.env.TEST_S3_ENDPOINT;
before(async () => {
  const endpoint = real ?? `http://127.0.0.1:${(await s3.run()).port}`;
  Object.assign(process.env, {
    S3_ENDPOINT: endpoint, S3_ACCESS_KEY: real ? process.env.TEST_S3_ACCESS_KEY : 'S3RVER', S3_SECRET_KEY: real ? process.env.TEST_S3_SECRET_KEY : 'S3RVER', S3_REGION: 'us-east-1',
    S3_BUCKET_CHAT: `t-chat-${run}`, S3_BUCKET_DOCUMENTS: `t-docs-${run}`, S3_BUCKET_BACKUPS: `t-backups-${run}`,
  });
  const { migrate } = await import('../src/migrate');
  await migrate();
  mods = {
    ...(await import('../src/db')),
    storage: await import('../src/storage'),
    backup: await import('../src/backup'),
    platformAuth: await import('../src/platformAuth'),
  };
  await mods.storage.ensureBuckets();
  app = await (await import('../src/app')).buildApp();
});
after(async () => {
  await app?.close();
  await mods?.pool.end();
  await mods?.storage.closeAdminPool();
  if (!real) await s3.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(cookie: string | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({ method, url, payload: body as any, headers: { ...(cookie ? { cookie } : {}), ...headers } });
  let json: any;
  try { json = res.json(); } catch { /* binary */ }
  return { status: res.statusCode, json, text: res.body, raw: res.rawPayload, res };
}
async function register(email: string) {
  const r = await call(null, 'POST', '/api/auth/register', { company: `Store ${email}`, name: 'Owner', email, password: 'password123' });
  assert.equal(r.status, 200, r.text);
  const c = r.res.cookies.find((x) => x.name === 'lo_token')!;
  return { cookie: `lo_token=${c.value}`, tid: JSON.parse(Buffer.from(c.value.split('.')[1], 'base64url').toString()).tid as string, id: r.json.user.id as string };
}
/** A platform console account: invited, then set up through its one-time link. Returns its session cookie. */
async function platformAdmin(email: string, name = 'Ops') {
  const { link } = await mods.platformAuth.issueSetup(email, name);
  const token = new URL(link).searchParams.get('token')!;
  const r = await call(null, 'POST', '/api/platform/auth/setup', { token, name, password: 'platform-pass-1' });
  assert.equal(r.status, 200, r.text);
  const c = r.res.cookies.find((x) => x.name === 'lo_platform')!;
  return { cookie: `lo_platform=${c.value}`, id: r.json.user.id as string, token };
}
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

test('storage: uploads go to their own buckets, are served back through the API, and old files are moved out of Postgres', async () => {
  const a = await register(`own-${run}@test.example`);
  const { storage, withTenant } = mods;

  // a chat photo lands in the chat bucket; the row keeps only the key
  const ch = (await call(a.cookie, 'POST', '/api/chat/channels', { name: 'Crew', memberIds: [] })).json.id;
  const up = await call(a.cookie, 'POST', `/api/chat/channels/${ch}/files?filename=stage.png`, PNG, { 'content-type': 'application/octet-stream' });
  assert.equal(up.status, 200, up.text);
  const fid = up.json.message.files[0].id;
  const row = (await withTenant(a.tid, (c: any) => c.query('SELECT data, storage_key FROM chat_attachments WHERE id = $1', [fid]))).rows[0];
  assert.equal(row.data, null);
  assert.match(row.storage_key, new RegExp(`^${a.tid}/\\d{4}/\\d{2}/[0-9a-f-]{36}-stage\\.png$`));
  assert.deepEqual(await storage.getBuffer('chat', row.storage_key), PNG);
  const back = await call(a.cookie, 'GET', `/api/chat/files/${fid}`);
  assert.equal(back.status, 200);
  assert.deepEqual(back.raw, PNG);

  // a certificate scan lands in the documents bucket
  const crew = (await call(a.cookie, 'POST', '/api/crew', { name: 'Crew S', email: `crew-${run}@test.example`, password: 'password123' })).json.member.id;
  const cert = (await call(a.cookie, 'POST', `/api/crew/${crew}/certs`, { name: 'Forklift', expiresOn: null })).json.cert.id;
  const pdf = Buffer.from('%PDF-1.4\n% test\n');
  assert.equal((await call(a.cookie, 'PUT', `/api/certs/${cert}/file?filename=forklift.pdf`, pdf, { 'content-type': 'application/pdf' })).status, 201);
  const ck = (await withTenant(a.tid, (c: any) => c.query('SELECT data, storage_key FROM cert_files WHERE cert_id = $1', [cert]))).rows[0];
  assert.equal(ck.data, null);
  assert.deepEqual(await storage.getBuffer('documents', ck.storage_key), pdf);
  assert.deepEqual((await call(a.cookie, 'GET', `/api/certs/${cert}/file`)).raw, pdf);

  // a file saved in Postgres before storage was set up is moved into its bucket and still opens
  await withTenant(a.tid, (c: any) => c.query("UPDATE cert_files SET data = $2, storage_key = NULL WHERE cert_id = $1", [cert, pdf]));
  assert.ok((await storage.moveFilesToStorage()) >= 1);
  const moved = (await withTenant(a.tid, (c: any) => c.query('SELECT data, storage_key FROM cert_files WHERE cert_id = $1', [cert]))).rows[0];
  assert.equal(moved.data, null);
  assert.ok(moved.storage_key);
  assert.deepEqual((await call(a.cookie, 'GET', `/api/certs/${cert}/file`)).raw, pdf);
});

test('backups: the nightly job dumps the database and copies uploads into the backups bucket; only platform operators see it', async () => {
  const company = await register(`boss-${run}@test.example`);
  const ops = await platformAdmin(OPS);
  assert.equal((await call(company.cookie, 'GET', '/api/platform/storage')).status, 401); // a company admin is not a platform admin

  const out = await mods.backup.nightly('manual');
  assert.ok(out.database.key.startsWith('postgres/'), JSON.stringify(out));
  assert.ok(out.database.size > 1000);
  assert.ok(out.files.copied >= 1, JSON.stringify(out.files));
  const keys: string[] = [];
  for await (const o of mods.storage.listObjects('backups')) keys.push(o.key);
  assert.ok(keys.some((k) => k.startsWith('postgres/') && k.endsWith('.dump')));
  assert.ok(keys.some((k) => k.startsWith('files/chat/')));
  assert.ok(keys.some((k) => k.startsWith('files/documents/')));
  // the dump is a real pg_dump archive
  const dump = await mods.storage.getBuffer('backups', out.database.key);
  assert.equal(dump.subarray(0, 5).toString(), 'PGDMP');

  const st = (await call(ops.cookie, 'GET', '/api/platform/storage')).json;
  assert.equal(st.storage.enabled, true);
  assert.equal(st.storage.reachable, true);
  assert.equal(st.backups[0].status, 'done');
  const dl = await call(ops.cookie, 'GET', `/api/platform/backups/${st.backups[0].id}/download`);
  assert.equal(dl.status, 200);
  assert.equal(dl.raw.subarray(0, 5).toString(), 'PGDMP');
  // running again copies nothing new
  assert.equal((await mods.backup.mirrorUploads()).copied, 0);
});

test('backups: retention keeps recent nights, then one a week, then one a month', async () => {
  const { backupsToDelete } = mods.backup;
  const now = new Date('2030-06-30T12:00:00Z');
  const rows = Array.from({ length: 200 }, (_, i) => ({ id: `b${i}`, started_at: new Date(now.getTime() - i * 86400000) }));
  const drop = new Set(backupsToDelete(rows, now, { daily: 14, weekly: 8, monthly: 12 }).map((r: any) => r.id));
  const kept = rows.filter((r) => !drop.has(r.id));
  assert.equal(kept.filter((r) => (now.getTime() - r.started_at.getTime()) / 86400000 < 14).length, 14); // every night for two weeks
  assert.ok(kept.length < 40, `kept ${kept.length}`);
  assert.ok(kept.some((r) => (now.getTime() - r.started_at.getTime()) / 86400000 > 150)); // something from five months ago
  assert.ok(!drop.has('b0'));
});

test('platform: separate console accounts, dashboard, companies (plan, notes, suspend), admins and storage settings', async () => {
  const company = await register(`co2-${run}@test.example`);
  const rootCookie = (await platformAdmin(OPS)).cookie; // a new link for an existing account resets its password

  // the console and the company app do not share sessions
  assert.equal((await call(company.cookie, 'GET', '/api/platform/dashboard')).status, 401);
  assert.equal((await call(rootCookie, 'GET', '/api/events')).status, 401);
  assert.equal((await call(null, 'POST', '/api/platform/auth/login', { email: `co2-${run}@test.example`, password: 'password123' })).status, 401);
  assert.equal((await call(null, 'POST', '/api/platform/auth/login', { email: OPS, password: 'wrong-password' })).status, 401);
  const login = await call(null, 'POST', '/api/platform/auth/login', { email: OPS, password: 'platform-pass-1' });
  assert.equal(login.status, 200);
  assert.ok(login.res.cookies.find((x: any) => x.name === 'lo_platform'));
  assert.equal((await call(rootCookie, 'GET', '/api/platform/auth/me')).json.user.email, OPS);

  // dashboard
  const d = (await call(rootCookie, 'GET', '/api/platform/dashboard?days=30')).json;
  assert.ok(d.kpis.companies >= 2, JSON.stringify(d.kpis));
  assert.ok(d.kpis.new_companies >= 2);
  assert.equal(d.unit, 'day');
  assert.ok(d.series.length >= 30 && d.series.at(-1).signups >= 2, JSON.stringify(d.series.at(-1)));
  assert.equal(d.health.storage.enabled, true);
  assert.ok(d.health.dbBytes > 0);
  assert.equal((await call(rootCookie, 'GET', '/api/platform/dashboard?days=365')).json.unit, 'month');
  assert.equal((await call(rootCookie, 'GET', '/api/platform/dashboard?days=12')).status, 400);

  // invite another platform admin: a one-time link, no company needed
  const inv = await call(rootCookie, 'POST', '/api/platform/admins', { email: `ops2-${run}@test.example`, name: 'Second' });
  assert.equal(inv.status, 201);
  const token = new URL(inv.json.link).searchParams.get('token')!;
  assert.equal((await call(null, 'GET', `/api/platform/auth/setup?token=${token}`)).json.email, `ops2-${run}@test.example`);
  assert.equal((await call(null, 'POST', '/api/platform/auth/setup', { token, name: 'Second', password: 'short' })).status, 400);
  const set = await call(null, 'POST', '/api/platform/auth/setup', { token, name: 'Second Ops', password: 'second-pass-123' });
  assert.equal(set.status, 200);
  assert.equal((await call(null, 'POST', '/api/platform/auth/setup', { token, name: 'Again', password: 'second-pass-123' })).status, 404); // used once
  const ops2 = `lo_platform=${set.res.cookies.find((x: any) => x.name === 'lo_platform')!.value}`;
  assert.equal((await call(ops2, 'GET', '/api/platform/companies')).status, 200);
  assert.equal((await call(rootCookie, 'POST', '/api/platform/admins', { email: `ops2-${run}@test.example` })).status, 409);
  const admins = (await call(rootCookie, 'GET', '/api/platform/admins')).json.admins;
  const second = admins.find((a: any) => a.email === `ops2-${run}@test.example`);
  assert.equal(second.ready, true);
  assert.equal((await call(ops2, 'DELETE' as any, `/api/platform/admins/${second.id}`)).status, 400); // not yourself
  assert.equal((await call(rootCookie, 'DELETE' as any, `/api/platform/admins/${second.id}`)).status, 200);
  mods.platformAuth.forgetPlatformUser(second.id);
  assert.equal((await call(ops2, 'GET', '/api/platform/companies')).status, 401); // removed: signed out

  // companies: detail, plan and notes, suspend
  const list = (await call(rootCookie, 'GET', '/api/platform/companies')).json.companies;
  const co = list.find((c: any) => c.id === company.tid);
  assert.equal(co.admins, `co2-${run}@test.example`);
  assert.equal((await call(rootCookie, 'PATCH' as any, `/api/platform/companies/${company.tid}`, { plan: 'pro', notes: 'Pays yearly' })).status, 200);
  assert.equal((await call(rootCookie, 'PATCH' as any, `/api/platform/companies/${company.tid}`, { plan: 'gold' })).status, 400);
  const det = (await call(rootCookie, 'GET', `/api/platform/companies/${company.tid}`)).json;
  assert.equal(det.company.plan, 'pro');
  assert.equal(det.company.platform_notes, 'Pays yearly');
  assert.equal(det.staff[0].email, `co2-${run}@test.example`);
  assert.equal(det.activity.length, 30);
  assert.equal(det.history[0].action, 'company.notes');
  assert.equal((await call(rootCookie, 'POST', `/api/platform/companies/${company.tid}/suspend`, { suspended: true, reason: 'Unpaid' })).status, 200);
  assert.equal((await call(company.cookie, 'GET', '/api/events')).status, 403);
  assert.equal((await call(null, 'POST', '/api/auth/login', { email: `co2-${run}@test.example`, password: 'password123' })).status, 403);
  assert.equal((await call(rootCookie, 'POST', `/api/platform/companies/${company.tid}/suspend`, { suspended: false })).status, 200);
  assert.equal((await call(company.cookie, 'GET', '/api/events')).status, 200);
  const log = (await call(rootCookie, 'GET', '/api/platform/audit')).json.entries;
  assert.ok(log.some((e: any) => e.action === 'company.suspend' && e.company && e.detail.reason === 'Unpaid'));
  assert.ok(log.some((e: any) => e.action === 'company.plan' && e.detail.to === 'pro'));

  // storage settings: wrong keys are refused; new bucket names copy the files over before switching
  const st = (await call(rootCookie, 'GET', '/api/platform/storage')).json;
  assert.equal(st.settings.mode, 'auto');
  assert.equal(st.storage.source, 'env');
  const endpoint = process.env.S3_ENDPOINT!;
  const bad = await call(rootCookie, 'PUT', '/api/platform/storage', { mode: 'custom', custom: { endpoint, accessKey: 'nope', secretKey: 'wrong-secret-123' } });
  assert.equal(bad.status, 400);
  const chat = (await call(company.cookie, 'POST', '/api/chat/channels', { name: 'Move', memberIds: [] })).json.id;
  const fid = (await call(company.cookie, 'POST', `/api/chat/channels/${chat}/files?filename=a.png`, PNG, { 'content-type': 'application/octet-stream' })).json.message.files[0].id;
  const nb = { chat: `n-chat-${run}`, documents: `n-docs-${run}`, backups: `n-backups-${run}` };
  const sw = await call(rootCookie, 'PUT', '/api/platform/storage', {
    mode: 'custom', custom: { endpoint, accessKey: process.env.S3_ACCESS_KEY, secretKey: process.env.S3_SECRET_KEY }, buckets: nb, backups: { hourUtc: 4, keepDaily: 7 },
  });
  assert.equal(sw.status, 202, sw.text);
  for (let i = 0; i < 100; i++) {
    const j = (await call(rootCookie, 'GET', '/api/platform/storage')).json.job;
    if (j.state !== 'running') { assert.equal(j.state, 'done', JSON.stringify(j)); break; }
    await new Promise((r) => setTimeout(r, 200));
  }
  const after = (await call(rootCookie, 'GET', '/api/platform/storage')).json;
  assert.equal(after.storage.source, 'custom');
  assert.equal(after.settings.buckets.chat, nb.chat);
  assert.equal(after.settings.custom.hasSecret, true);
  assert.equal(after.settings.custom.secretKey, undefined); // secrets never go back to the page
  assert.equal(after.schedule.hourUtc, 4);
  assert.deepEqual((await call(company.cookie, 'GET', `/api/chat/files/${fid}`)).raw, PNG); // still opens from the new bucket
  // saving again without the secret keeps the saved one
  assert.equal((await call(rootCookie, 'PUT', '/api/platform/storage', { mode: 'custom', custom: { endpoint, accessKey: process.env.S3_ACCESS_KEY }, buckets: nb })).status, 200);
  assert.equal((await call(rootCookie, 'GET', '/api/platform/storage')).json.storage.reachable, true);
  // leave the shared test database as we found it
  await mods.storage.adminPool().query("DELETE FROM platform_settings WHERE key = 'storage'");
  mods.storage.apply(null);
});
