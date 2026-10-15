import type { PoolClient } from 'pg';
import { storeFile } from './storage';

/**
 * Save (or replace) the file of a certificate. The bytes go to the documents bucket when object storage is on.
 * A replaced object is left for the nightly orphan sweep, so a rolled-back transaction never points at a deleted file.
 * With onlyGenerated, a file someone uploaded is kept and only an academy-generated PDF may be replaced.
 */
export async function saveCertFile(c: PoolClient, tid: string, certId: string, filename: string, contentType: string, data: Buffer, onlyGenerated = false) {
  if (onlyGenerated) {
    const cur = (await c.query('SELECT filename FROM cert_files WHERE cert_id = $1', [certId])).rows[0];
    if (cur && !String(cur.filename).startsWith('academy-')) return false;
  }
  const stored = await storeFile('documents', tid, filename, contentType, data);
  await c.query(
    `INSERT INTO cert_files (tenant_id, cert_id, filename, content_type, size, data, storage_key) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (cert_id) DO UPDATE SET filename = EXCLUDED.filename, content_type = EXCLUDED.content_type,
       size = EXCLUDED.size, data = EXCLUDED.data, storage_key = EXCLUDED.storage_key, uploaded_at = now()`,
    [tid, certId, filename, contentType, data.length, stored.data, stored.key],
  );
  return true;
}
