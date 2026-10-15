/**
 * Restore from the backups bucket. Run inside the api container:
 *   docker compose exec api node dist/restore.js list
 *   docker compose exec api node dist/restore.js database latest            (or a key from "list")
 *   docker compose exec api node dist/restore.js files                       (copies uploaded files back into their buckets)
 * Restoring the database replaces the current data. Stop traffic first and take a manual backup if anything is worth keeping.
 */
import { spawn } from 'node:child_process';
import { Upload } from '@aws-sdk/lib-storage';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { config } from './config';
import { bucketOf, client, ensureBuckets, getObject, listObjects, storageEnabled, type BucketKind } from './storage';

async function list() {
  const all: { key: string; size: number; modified: Date }[] = [];
  for await (const o of listObjects('backups', 'postgres/')) all.push(o);
  all.sort((a, b) => b.modified.getTime() - a.modified.getTime());
  for (const o of all) console.log(`${o.modified.toISOString()}  ${(o.size / 1048576).toFixed(1).padStart(8)} MB  ${o.key}`);
  return all;
}

async function database(which: string) {
  const key = which === 'latest' ? (await list())[0]?.key : which;
  if (!key) throw new Error('No database backups found.');
  console.log(`Restoring ${key} into ${new URL(config.adminDatabaseUrl).pathname.slice(1)} ...`);
  const body = await getObject('backups', key);
  await new Promise<void>((resolve, reject) => {
    const p = spawn(process.env.PG_RESTORE_PATH ?? 'pg_restore', ['--clean', '--if-exists', '--no-owner', '--single-transaction', `--dbname=${config.adminDatabaseUrl}`], { stdio: ['pipe', 'inherit', 'inherit'] });
    body.pipe(p.stdin);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`pg_restore exited with ${code}`))));
  });
  console.log('Database restored (with its permissions). Restart the api container: docker compose restart api');
}

async function files() {
  await ensureBuckets();
  for (const kind of ['chat', 'documents'] as BucketKind[]) {
    const prefix = `files/${kind}/`;
    let n = 0;
    for await (const o of listObjects('backups', prefix)) {
      const key = o.key.slice(prefix.length);
      const exists = await client(kind).send(new HeadObjectCommand({ Bucket: bucketOf(kind), Key: key })).then(() => true, () => false);
      if (exists) continue;
      const head = await client('backups').send(new HeadObjectCommand({ Bucket: bucketOf('backups'), Key: o.key }));
      await new Upload({ client: client(kind), params: { Bucket: bucketOf(kind), Key: key, Body: await getObject('backups', o.key), ContentType: head.ContentType } }).done();
      n++;
    }
    console.log(`${kind}: restored ${n} files`);
  }
}

async function main() {
  if (!storageEnabled()) throw new Error('Set S3_ENDPOINT, S3_ACCESS_KEY and S3_SECRET_KEY first.');
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'list') await list();
  else if (cmd === 'database') await database(arg ?? 'latest');
  else if (cmd === 'files') await files();
  else console.log('Usage: restore.js list | database [latest|<key>] | files');
}
main().then(() => process.exit(0), (e) => { console.error(e?.message ?? e); process.exit(1); });
