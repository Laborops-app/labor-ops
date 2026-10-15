import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import crypto from 'node:crypto';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { saveCertFile } from '../files';
import { guard, authenticate } from '../auth';
import { config } from '../config';
import { notify } from '../notify';
import { readAcademy, writeAcademy, siteOrigin, fetchCatalog, signupUrl, AcademyError, type CatalogCourse } from '../academy';
import { academyCertificatePdf } from '../academyPdf';

/**
 * Upstage Academy certificate sync.
 * The academy site sends a signed webhook whenever a student earns a certificate (course or course group).
 * The student is matched to a LaborOps user by email (the academy username is the email) and the certificate
 * is added to their profile as verified. Certificates with no matching user are kept and applied later.
 */

const adm = guard('admin');
const mgr = guard('admin', 'manager');
const webhookUrl = (tid: string) => `${config.appUrl}/api/academy/webhook/${tid}`;
const readSecret = async (c: PoolClient) => (await readAcademy(c)).secret;

function verify(secret: string, ts: string, raw: string, header: string): boolean {
  if (!secret || !ts || !header.startsWith('sha256=')) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!Number.isFinite(age) || age > 600) return false;
  const want = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex');
  const got = header.slice(7);
  return want.length === got.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got));
}

/** Adds one received certificate to the matching user's profile. Returns true when a user was matched. */
type CertRow = {
  id: string; code: string; email: string; username: string | null; title: string;
  kind?: string; issued_at?: string | Date; student_name?: string | null; url?: string | null;
};

/** Stores the certificate as a PDF on the person's certificate so they and the coordinators can open it.
 *  A scan the person or a coordinator uploaded themselves is never replaced. */
async function attachPdf(c: PoolClient, tid: string, certId: string, userName: string, row: CertRow): Promise<void> {
  const data = await academyCertificatePdf({
    studentName: row.student_name || userName,
    title: row.title,
    kind: row.kind === 'group' ? 'group' : 'course',
    issuedAt: row.issued_at ? new Date(row.issued_at) : new Date(),
    code: row.code,
    verifyUrl: row.url,
  });
  await saveCertFile(c, tid, certId, `academy-${row.code}.pdf`, 'application/pdf', data, true);
}

/** Makes the PDF for a certificate that was already imported but has none yet (repeat deliveries, older imports). */
async function ensurePdf(c: PoolClient, tid: string, row: CertRow & { user_id: string }): Promise<void> {
  const k = (
    await c.query(
      `SELECT k.id, u.name, (f.cert_id IS NOT NULL) AS has_file FROM user_certs k JOIN users u ON u.id = k.user_id
       LEFT JOIN cert_files f ON f.cert_id = k.id WHERE k.user_id = $1 AND k.external_ref = $2`,
      [row.user_id, row.code],
    )
  ).rows[0];
  if (k && !k.has_file) await attachPdf(c, tid, k.id, k.name, row);
}

async function applyCert(c: PoolClient, tid: string, row: CertRow): Promise<boolean> {
  const u = (
    await c.query(
      'SELECT id, name FROM users WHERE active AND (lower(email) = lower($1) OR lower(email) = lower($2)) ORDER BY (lower(email) = lower($1)) DESC LIMIT 1',
      [row.email, row.username ?? ''],
    )
  ).rows[0];
  if (!u) return false;
  // One certificate per name per person: an existing one with the same name becomes verified.
  const r = await c.query(
    `INSERT INTO user_certs (tenant_id, user_id, name, expires_on, verified, external_ref, source)
     VALUES ($1,$2,$3,NULL,true,$4,'academy')
     ON CONFLICT (user_id, lower(name)) DO UPDATE SET verified = true, external_ref = EXCLUDED.external_ref, source = 'academy'
     RETURNING id`,
    [tid, u.id, row.title.slice(0, 60), row.code],
  );
  await c.query('UPDATE academy_certs SET user_id = $2, applied_at = now() WHERE id = $1', [row.id, u.id]);
  await attachPdf(c, tid, r.rows[0].id, u.name, row);
  await audit(c, tid, null, 'cert.academy_import', 'cert', r.rows[0].id, { code: row.code, title: row.title });
  await notify(c, tid, {
    userId: u.id,
    category: 'cert',
    title: `Academy certificate added: ${row.title}`,
    body: 'Your certificate from Upstage Academy was added to your profile.',
    link: '/profile',
  });
  // A finished course group closes any open request to complete it, and whoever sent the request is told.
  if (row.kind === 'group') {
    const done = (
      await c.query(
        `UPDATE academy_invites i SET completed_at = now() FROM academy_groups g
         WHERE i.group_id = g.id AND i.user_id = $1 AND i.completed_at IS NULL AND lower(g.name) = lower($2)
         RETURNING i.invited_by, g.name`,
        [u.id, row.title],
      )
    ).rows;
    const who = [...new Set(done.map((d) => d.invited_by).filter(Boolean))] as string[];
    await notify(c, tid, who.map((id) => ({ userId: id, category: 'training' as const, title: `${u.name} completed ${row.title}`, body: 'Their academy certificate was added to their profile.', link: '/trainings', quiet: true })));
  }
  return true;
}

/** Each group's course progress for a set of people, from the academy certificates already received. */
async function progressFor(c: PoolClient, userIds: string[]) {
  if (!userIds.length) return new Map<string, { groups: Set<string>; courses: Set<string> }>();
  const rows = (await c.query("SELECT user_id, kind, lower(title) AS t FROM academy_certs WHERE user_id = ANY($1::uuid[])", [userIds])).rows;
  const m = new Map<string, { groups: Set<string>; courses: Set<string> }>();
  for (const r of rows) {
    const e = m.get(r.user_id) ?? { groups: new Set<string>(), courses: new Set<string>() };
    (r.kind === 'group' ? e.groups : e.courses).add(r.t);
    m.set(r.user_id, e);
  }
  return m;
}
const status = (g: { name: string; courses: CatalogCourse[] }, p: { groups: Set<string>; courses: Set<string> } | undefined, completedAt: string | null) => {
  const coursesDone = g.courses.filter((x) => p?.courses.has(x.title.toLowerCase())).length;
  const done = !!completedAt || !!p?.groups.has(g.name.toLowerCase()) || (g.courses.length > 0 && coursesDone === g.courses.length);
  return { coursesDone, done };
};

/** The message a crew member gets: what to do, the sign-up link (with the email to use) and the course link. */
function inviteMessage(base: string, g: { name: string; description: string | null; url: string; courses: CatalogCourse[] }, email: string, note?: string | null) {
  const signup = signupUrl(base, g.courses[0]?.id);
  const body = [
    note?.trim() ? note.trim() : null,
    `Please complete the ${g.name} courses on Upstage Academy${g.courses.length ? ` (${g.courses.length} course${g.courses.length === 1 ? '' : 's'})` : ''}.${g.description ? `\n${g.description}` : ''}`,
    `1. New to the academy? Create your account with this email address: ${email}\n${signup}`,
    `2. Open the courses (log in if asked):\n${g.url}`,
    'When you finish, your certificate is added to your LaborOps profile automatically.',
  ].filter(Boolean).join('\n\n');
  return {
    title: `Online training: ${g.name}`,
    body,
    sms: `Please complete ${g.name} on Upstage Academy. Sign up with ${email}:`,
    smsLink: signup,
    actions: [
      { label: 'Create academy account', url: signup, kind: 'primary' as const },
      { label: 'Open the courses', url: g.url, kind: 'primary' as const },
    ],
  };
}

const payload = z.object({
  event: z.string(),
  certificate: z.object({
    code: z.string().trim().min(3).max(64),
    type: z.enum(['course', 'group']).default('course'),
    title: z.string().trim().min(1).max(200),
    issued_at: z.string().datetime({ offset: true }),
    url: z.string().trim().max(500).optional(),
    student_name: z.string().trim().max(200).optional(),
  }).partial({ type: true, url: true, student_name: true }).optional(),
  user: z.object({ email: z.string().trim().max(254).default(''), username: z.string().trim().max(254).default('') }).optional(),
});

export async function academyRoutes(app: FastifyInstance) {
  // Admin: status, recent certificates, a new shared secret, and a retry for unmatched ones.
  app.get('/api/integrations/academy', { preHandler: adm }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      url: webhookUrl(req.user.tid),
      siteUrl: (await readAcademy(c)).url,
      secretSet: !!(await readSecret(c)),
      stats: (await c.query('SELECT count(*)::int AS total, count(applied_at)::int AS applied FROM academy_certs')).rows[0],
      recent: (
        await c.query(
          `SELECT a.code, a.email, a.title, a.kind, a.issued_at, a.applied_at, u.name AS user_name
           FROM academy_certs a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC LIMIT 15`,
        )
      ).rows,
    })),
  );

  // Creates (or replaces) the shared secret. It is returned once, to paste into the academy settings.
  app.post('/api/integrations/academy/secret', { preHandler: adm }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const secret = crypto.randomBytes(24).toString('hex');
      await writeAcademy(c, req.user.tid, { secret }, req.user.sub);
      await audit(c, req.user.tid, req.user.sub, 'academy.secret_rotated', 'integration', null, {});
      return { url: webhookUrl(req.user.tid), secret };
    }),
  );

  // The academy's web address, used to read its course groups and build sign-up links.
  app.put('/api/integrations/academy/site', { preHandler: adm }, async (req, reply) => {
    const { url } = z.object({ url: z.string().trim().max(300) }).parse(req.body);
    const origin = url ? siteOrigin(url) : '';
    if (origin === null) return reply.code(400).send({ error: 'Enter the academy address starting with https://' });
    await withTenant(req.user.tid, (c) => writeAcademy(c, req.user.tid, { url: origin }, req.user.sub));
    return { siteUrl: origin };
  });

  app.post('/api/integrations/academy/apply', { preHandler: adm }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const pending = (await c.query('SELECT id, code, email, username, title, kind, issued_at, student_name, url FROM academy_certs WHERE applied_at IS NULL ORDER BY issued_at')).rows;
      let matched = 0;
      for (const p of pending) if (await applyCert(c, req.user.tid, p)) matched++;
      return { checked: pending.length, matched };
    }),
  );

  /* ------------------------------------------------------------ Course groups */

  // Coordinators: every synced group with who was asked to do it. Crew: the groups they were asked to do.
  app.get('/api/academy/courses', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const cfg = await readAcademy(c);
      const staff = req.user.role !== 'crew';
      if (!staff) {
        const me = (await c.query('SELECT email FROM users WHERE id = $1', [req.user.sub])).rows[0];
        const rows = (
          await c.query(
            `SELECT i.id AS invite_id, i.created_at, i.completed_at, g.id, g.name, g.description, g.url, g.courses
             FROM academy_invites i JOIN academy_groups g ON g.id = i.group_id WHERE i.user_id = $1 AND g.active ORDER BY i.completed_at NULLS FIRST, i.created_at DESC`,
            [req.user.sub],
          )
        ).rows;
        const p = (await progressFor(c, [req.user.sub])).get(req.user.sub);
        return {
          siteUrl: cfg.url || null,
          email: me?.email ?? '',
          groups: rows.map((g) => ({ ...g, ...status(g, p, g.completed_at), signupUrl: cfg.url ? signupUrl(cfg.url, g.courses[0]?.id) : null, doneCourseIds: g.courses.filter((x: CatalogCourse) => p?.courses.has(x.title.toLowerCase())).map((x: CatalogCourse) => x.id) })),
        };
      }
      const groups = (await c.query('SELECT id, academy_id, name, slug, description, url, courses, synced_at FROM academy_groups WHERE active ORDER BY lower(name)')).rows;
      const invites = (
        await c.query(
          `SELECT i.id, i.group_id, i.user_id, i.created_at, i.last_sent_at, i.send_count, i.completed_at, u.name, u.email
           FROM academy_invites i JOIN users u ON u.id = i.user_id ORDER BY lower(u.name)`,
        )
      ).rows;
      const p = await progressFor(c, [...new Set(invites.map((i) => i.user_id))]);
      return {
        siteUrl: cfg.url || null,
        lastSync: groups.reduce((m: string | null, g) => (!m || g.synced_at > m ? g.synced_at : m), null),
        groups: groups.map((g) => ({
          ...g,
          invites: invites.filter((i) => i.group_id === g.id).map((i) => ({ ...i, ...status(g, p.get(i.user_id), i.completed_at) })),
        })),
      };
    }),
  );

  // Pull the course groups and their courses from the academy.
  app.post('/api/academy/sync', { preHandler: mgr }, async (req, reply) => {
    const cfg = await withTenant(req.user.tid, (c) => readAcademy(c));
    if (!cfg.url) return reply.code(400).send({ error: 'Add the academy web address under Integrations → Upstage Academy first.' });
    let cat;
    try {
      cat = await fetchCatalog(cfg.url);
    } catch (e) {
      if (e instanceof AcademyError) return reply.code(502).send({ error: e.message });
      throw e;
    }
    return withTenant(req.user.tid, async (c) => {
      for (const g of cat) {
        await c.query(
          `INSERT INTO academy_groups (tenant_id, academy_id, name, slug, description, url, courses, active, synced_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true,now())
           ON CONFLICT (tenant_id, academy_id) DO UPDATE SET name = EXCLUDED.name, slug = EXCLUDED.slug, description = EXCLUDED.description,
             url = EXCLUDED.url, courses = EXCLUDED.courses, active = true, synced_at = now()`,
          [req.user.tid, g.id, g.name, g.slug, g.description || null, g.url, JSON.stringify(g.courses)],
        );
      }
      // Groups deleted on the academy are hidden (requests already sent are kept).
      const gone = await c.query('UPDATE academy_groups SET active = false WHERE active AND NOT (academy_id = ANY($1::int[]))', [cat.map((g) => g.id)]);
      await audit(c, req.user.tid, req.user.sub, 'academy.sync', 'integration', null, { groups: cat.length, removed: gone.rowCount });
      return { groups: cat.length, courses: new Set(cat.flatMap((g) => g.courses.map((x) => x.id))).size, removed: gone.rowCount };
    });
  });

  // Ask crew to complete a group: in-app, push and email, plus a text message when asked for (to people who accept texts).
  app.post('/api/academy/groups/:id/invite', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        userIds: z.array(z.string().uuid()).max(2000).default([]),
        crewGroupId: z.string().uuid().optional(),
        everyone: z.boolean().default(false),
        note: z.string().trim().max(500).optional().nullable(),
        text: z.boolean().default(false),
        resend: z.boolean().default(false),
      })
      .parse(req.body ?? {});
    const r = await withTenant(req.user.tid, async (c) => {
      const cfg = await readAcademy(c);
      if (!cfg.url) return { code: 400, error: 'Add the academy web address under Integrations → Upstage Academy first.' };
      const g = (await c.query('SELECT * FROM academy_groups WHERE id = $1 AND active', [id])).rows[0];
      if (!g) return { code: 404, error: 'Course group not found. Sync from the academy and try again.' };
      const people = (
        await c.query(
          `SELECT u.id, u.name, u.email FROM users u
           WHERE u.active AND (u.id = ANY($1::uuid[])
             OR ($2::uuid IS NOT NULL AND u.id IN (SELECT user_id FROM crew_group_members WHERE group_id = $2))
             OR ($3::boolean AND u.role = 'crew'))`,
          [b.userIds, b.crewGroupId ?? null, b.everyone],
        )
      ).rows;
      if (!people.length) return { code: 400, error: 'Pick at least one person.' };
      const existing = new Map((await c.query('SELECT user_id, completed_at FROM academy_invites WHERE group_id = $1', [id])).rows.map((x) => [x.user_id, x]));
      const prog = await progressFor(c, people.map((x) => x.id));
      let sent = 0, skippedDone = 0, skippedInvited = 0;
      for (const u of people) {
        const ex = existing.get(u.id);
        if (status(g, prog.get(u.id), ex?.completed_at ?? null).done) { skippedDone++; continue; }
        if (ex && !b.resend) { skippedInvited++; continue; }
        await c.query(
          `INSERT INTO academy_invites (tenant_id, group_id, user_id, invited_by) VALUES ($1,$2,$3,$4)
           ON CONFLICT (group_id, user_id) DO UPDATE SET last_sent_at = now(), send_count = academy_invites.send_count + 1, invited_by = EXCLUDED.invited_by`,
          [req.user.tid, id, u.id, req.user.sub],
        );
        await notify(c, req.user.tid, { userId: u.id, category: 'training', link: '/trainings', linkLabel: 'See it in LaborOps', allowSms: b.text, ...inviteMessage(cfg.url, g, u.email, b.note) });
        sent++;
      }
      await audit(c, req.user.tid, req.user.sub, 'academy.invite', 'academy_group', id, { sent, skippedDone, skippedInvited, text: b.text });
      return { code: 200, sent, skippedDone, skippedInvited };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // Send the same request again to one person.
  app.post('/api/academy/invites/:id/remind', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { text } = z.object({ text: z.boolean().default(false) }).parse(req.body ?? {});
    const r = await withTenant(req.user.tid, async (c) => {
      const cfg = await readAcademy(c);
      const i = (await c.query('SELECT i.*, u.email FROM academy_invites i JOIN users u ON u.id = i.user_id WHERE i.id = $1', [id])).rows[0];
      if (!i) return null;
      if (i.completed_at) return { error: 'Already completed' };
      const g = (await c.query('SELECT * FROM academy_groups WHERE id = $1', [i.group_id])).rows[0];
      if (!cfg.url || !g) return { error: 'The academy is not set up' };
      await c.query('UPDATE academy_invites SET last_sent_at = now(), send_count = send_count + 1 WHERE id = $1', [id]);
      const m = inviteMessage(cfg.url, g, i.email, null);
      await notify(c, req.user.tid, { userId: i.user_id, category: 'training', link: '/trainings', linkLabel: 'See it in LaborOps', allowSms: text, ...m, title: `Reminder: ${m.title}` });
      return { ok: true };
    });
    if (!r) return reply.code(404).send({ error: 'Not found' });
    return 'error' in r ? reply.code(409).send(r) : r;
  });

  app.delete('/api/academy/invites/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => (await c.query('DELETE FROM academy_invites WHERE id = $1', [id])).rowCount);
    return n ? { ok: true } : reply.code(404).send({ error: 'Not found' });
  });

  // Public webhook. Own plugin scope because the signature is checked against the raw request body.
  app.register(async (inst) => {
    inst.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as any).rawBody = body;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (e) {
        done(e as Error);
      }
    });

    inst.post('/api/academy/webhook/:tenantId', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { tenantId } = z.object({ tenantId: z.string().uuid() }).parse(req.params);
      const raw = String((req as any).rawBody ?? '');
      const secret = await withTenant(tenantId, (c) => readSecret(c));
      if (!verify(secret, String(req.headers['x-academy-timestamp'] ?? ''), raw, String(req.headers['x-academy-signature'] ?? ''))) {
        return reply.code(401).send({ error: 'Bad signature' });
      }
      const p = payload.safeParse(req.body);
      if (!p.success) return reply.code(400).send({ error: 'Bad payload' });
      if (p.data.event === 'ping') {
        const u = p.data.certificate?.url ? siteOrigin(p.data.certificate.url) : null;
        if (u) await withTenant(tenantId, async (c) => { if (!(await readAcademy(c)).url) await writeAcademy(c, tenantId, { url: u }, null); });
        return { ok: true, pong: true };
      }
      if (p.data.event !== 'certificate.issued' || !p.data.certificate || !p.data.user) return { ok: true, ignored: true };
      const cert = p.data.certificate;
      const email = p.data.user.email || p.data.user.username;
      if (!email) return reply.code(400).send({ error: 'No email' });
      const matched = await withTenant(tenantId, async (c) => {
        const certUrl = cert.url && siteOrigin(cert.url) ? cert.url : null;
        const ins = await c.query(
          `INSERT INTO academy_certs (tenant_id, code, email, username, title, kind, issued_at, url, student_name)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (tenant_id, code) DO UPDATE SET email = EXCLUDED.email, url = COALESCE(EXCLUDED.url, academy_certs.url),
             student_name = COALESCE(EXCLUDED.student_name, academy_certs.student_name)
           RETURNING id, code, email, username, title, kind, issued_at, student_name, url, user_id, applied_at`,
          [tenantId, cert.code, email.toLowerCase(), p.data.user!.username || null, cert.title, cert.type ?? 'course', cert.issued_at, certUrl, cert.student_name || null],
        );
        // The first signed delivery tells us where the academy lives, if no one has entered it yet.
        if (certUrl) {
          const cfg = await readAcademy(c);
          if (!cfg.url) await writeAcademy(c, tenantId, { url: siteOrigin(certUrl)! }, null);
        }
        const row = ins.rows[0];
        if (row.applied_at) { // already imported: a repeat delivery. Make sure the PDF exists.
          await ensurePdf(c, tenantId, row);
          return true;
        }
        return applyCert(c, tenantId, ins.rows[0]);
      });
      return { ok: true, matched };
    });
  });
}
