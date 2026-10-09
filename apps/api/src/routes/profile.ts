import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { authenticate, guard } from '../auth';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const MAX_FILE = 5 * 1024 * 1024;
const FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg'];

const text = (max: number) => z.string().trim().max(max).nullable().optional();
const profileBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  phone: text(40),
  address: text(300),
  emergencyName: text(100),
  emergencyPhone: text(40),
  bio: text(1000),
  skills: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
});

/** The file's real type, from its first bytes, or null if it is not a PDF, PNG or JPEG. */
function sniff(b: Buffer): string | null {
  if (b.length > 4 && b.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  return null;
}

export async function profileRoutes(app: FastifyInstance) {
  // Raw file bodies for certificate uploads.
  app.addContentTypeParser(FILE_TYPES, { parseAs: 'buffer', bodyLimit: MAX_FILE }, (_req, body, done) => done(null, body));

  const CERTS = `SELECT k.id, k.name, k.expires_on::text, k.verified, f.filename AS file_name, f.size AS file_size, f.content_type AS file_type
                 FROM user_certs k LEFT JOIN cert_files f ON f.cert_id = k.id WHERE k.user_id = $1 ORDER BY k.name`;

  app.get('/api/my/profile', { preHandler: authenticate }, async (req, reply) => {
    const out = await withTenant(req.user.tid, async (c) => {
      const u = (
        await c.query('SELECT id, name, email, role, phone, address, emergency_name, emergency_phone, bio, skills FROM users WHERE id = $1', [req.user.sub])
      ).rows[0];
      if (!u) return null;
      return { user: u, certs: (await c.query(CERTS, [req.user.sub])).rows };
    });
    return out ?? reply.code(404).send({ error: 'Not found' });
  });

  app.patch('/api/my/profile', { preHandler: authenticate }, async (req) => {
    const b = profileBody.parse(req.body);
    const has = (k: keyof typeof b) => b[k] !== undefined;
    return withTenant(req.user.tid, async (c) => {
      const r = await c.query(
        `UPDATE users SET
           name = COALESCE($2, name),
           phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
           address = CASE WHEN $5::boolean THEN $6 ELSE address END,
           emergency_name = CASE WHEN $7::boolean THEN $8 ELSE emergency_name END,
           emergency_phone = CASE WHEN $9::boolean THEN $10 ELSE emergency_phone END,
           bio = CASE WHEN $11::boolean THEN $12 ELSE bio END,
           skills = COALESCE($13, skills)
         WHERE id = $1 RETURNING id, name, email, role, phone, address, emergency_name, emergency_phone, bio, skills`,
        [
          req.user.sub, b.name ?? null,
          has('phone'), b.phone || null,
          has('address'), b.address || null,
          has('emergencyName'), b.emergencyName || null,
          has('emergencyPhone'), b.emergencyPhone || null,
          has('bio'), b.bio || null,
          b.skills ?? null,
        ],
      );
      await audit(c, req.user.tid, req.user.sub, 'profile.update', 'user', req.user.sub, { fields: Object.keys(b) });
      return { user: r.rows[0] };
    });
  });

  app.post('/api/my/password', { config: { rateLimit: { max: Number(process.env.AUTH_RATE_MAX ?? 10), timeWindow: '1 minute' } }, preHandler: authenticate }, async (req, reply) => {
    const b = z.object({ current: z.string().min(1).max(200), next: z.string().min(8).max(200) }).parse(req.body);
    const ok = await withTenant(req.user.tid, async (c) => {
      const row = (await c.query('SELECT password_hash FROM users WHERE id = $1', [req.user.sub])).rows[0];
      if (!row || !(await bcrypt.compare(b.current, row.password_hash))) return false;
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.sub, await bcrypt.hash(b.next, 10)]);
      await audit(c, req.user.tid, req.user.sub, 'auth.password_change', 'user', req.user.sub);
      return true;
    });
    return ok ? { ok: true } : reply.code(400).send({ error: 'Your current password is not correct' });
  });

  // ---------- my certificates ----------
  app.post('/api/my/certs', { preHandler: authenticate }, async (req, reply) => {
    const b = z
      .object({ name: z.string().trim().min(1).max(60), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional() })
      .parse(req.body);
    const row = await withTenant(req.user.tid, async (c) => {
      // Anything a crew member adds or changes waits for a manager's review before the scheduler counts it.
      const r = await c.query(
        `INSERT INTO user_certs (tenant_id, user_id, name, expires_on, verified) VALUES ($1,$2,$3,$4,false)
         ON CONFLICT (user_id, lower(name)) DO UPDATE SET name = EXCLUDED.name, expires_on = EXCLUDED.expires_on,
           verified = (user_certs.verified AND user_certs.expires_on IS NOT DISTINCT FROM EXCLUDED.expires_on)
         RETURNING id, name, expires_on::text, verified`,
        [req.user.tid, req.user.sub, b.name, b.expiresOn ?? null],
      );
      await audit(c, req.user.tid, req.user.sub, 'cert.self_submit', 'cert', r.rows[0].id, { name: b.name });
      return r.rows[0];
    });
    return reply.code(201).send({ cert: row });
  });

  app.delete('/api/my/certs/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM user_certs WHERE id = $1 AND user_id = $2', [id, req.user.sub]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'cert.self_delete', 'cert', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Certificate not found' });
  });

  // Upload (or replace) the scan or photo for one of my certificates. The body is the raw file.
  app.put('/api/my/certs/:id/file', { preHandler: authenticate, bodyLimit: MAX_FILE }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { filename } = z.object({ filename: z.string().trim().max(200).default('certificate') }).parse(req.query);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Choose a PDF, PNG or JPG file (up to 5 MB)' });
    const type = sniff(body);
    if (!type) return reply.code(400).send({ error: 'That file is not a PDF, PNG or JPG' });
    const safeName = filename.replace(/[\\/\r\n"]/g, '_');
    const ok = await withTenant(req.user.tid, async (c) => {
      const cert = (await c.query('SELECT verified FROM user_certs WHERE id = $1 AND user_id = $2', [id, req.user.sub])).rows[0];
      if (!cert) return false;
      await c.query(
        `INSERT INTO cert_files (tenant_id, cert_id, filename, content_type, size, data) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (cert_id) DO UPDATE SET filename = EXCLUDED.filename, content_type = EXCLUDED.content_type,
           size = EXCLUDED.size, data = EXCLUDED.data, uploaded_at = now()`,
        [req.user.tid, id, safeName, type, body.length, body],
      );
      // A new document means the manager should look at it again.
      await c.query('UPDATE user_certs SET verified = false WHERE id = $1', [id]);
      await audit(c, req.user.tid, req.user.sub, 'cert.upload', 'cert', id, { size: body.length, type });
      return true;
    });
    return ok ? reply.code(201).send({ ok: true }) : reply.code(404).send({ error: 'Certificate not found' });
  });

  // A labor coordinator uploads a file for someone's certificate. Their upload counts as reviewed.
  app.put('/api/certs/:id/file', { preHandler: guard('admin', 'manager'), bodyLimit: MAX_FILE }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { filename } = z.object({ filename: z.string().trim().max(200).default('certificate') }).parse(req.query);
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) return reply.code(400).send({ error: 'Choose a PDF, PNG or JPG file (up to 5 MB)' });
    const type = sniff(body);
    if (!type) return reply.code(400).send({ error: 'That file is not a PDF, PNG or JPG' });
    const ok = await withTenant(req.user.tid, async (c) => {
      if (!(await c.query('SELECT 1 FROM user_certs WHERE id = $1', [id])).rowCount) return false;
      await c.query(
        `INSERT INTO cert_files (tenant_id, cert_id, filename, content_type, size, data) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (cert_id) DO UPDATE SET filename = EXCLUDED.filename, content_type = EXCLUDED.content_type,
           size = EXCLUDED.size, data = EXCLUDED.data, uploaded_at = now()`,
        [req.user.tid, id, filename.replace(/[\\/\r\n"]/g, '_'), type, body.length, body],
      );
      await audit(c, req.user.tid, req.user.sub, 'cert.upload', 'cert', id, { size: body.length, type, by: 'coordinator' });
      return true;
    });
    return ok ? reply.code(201).send({ ok: true }) : reply.code(404).send({ error: 'Certificate not found' });
  });

  // Download: the owner, or a manager of the same company.
  app.get('/api/certs/:id/file', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = await withTenant(req.user.tid, async (c) => {
      const r = (
        await c.query(
          `SELECT f.filename, f.content_type, f.data, k.user_id FROM cert_files f JOIN user_certs k ON k.id = f.cert_id WHERE k.id = $1`,
          [id],
        )
      ).rows[0];
      if (!r) return null;
      if (r.user_id !== req.user.sub && req.user.role === 'crew') return null;
      return r;
    });
    if (!row) return reply.code(404).send({ error: 'File not found' });
    return reply
      .header('content-type', row.content_type)
      .header('content-disposition', `inline; filename="${row.filename}"`)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox")
      .header('cache-control', 'private, no-store')
      .send(row.data);
  });
}
