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
    PLATFORM_ADMINS: OPS,
  });
  const { migrate } = await import('../src/migrate');
  await migrate();
  mods = {
    ...(await import('../src/db')),
    storage: await import('../src/storage'),
    backup: await import('../src/backup'),
  };
  await mods.storage.ensureBuckets();
  app = await (await import('../src/app')).buildApp();
});
after(async () => {
  await app?.close();
  await mods?.pool.end();
  await mods?.storage.adminPool().end();
  if (!real) await s3.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(cookie: string | null, method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, headers: Record<string, string> = {}) {
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
  const ops = await register(OPS);
  assert.equal((await call(company.cookie, 'GET', '/api/platform/storage')).status, 403);
  assert.equal((await call(company.cookie, 'GET', '/api/auth/me')).json.user.platformAdmin, false);
  assert.equal((await call(ops.cookie, 'GET', '/api/auth/me')).json.user.platformAdmin, true);

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
