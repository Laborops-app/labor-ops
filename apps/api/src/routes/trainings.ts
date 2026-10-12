import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { guard, authenticate } from '../auth';
import { notify, notifyStaff } from '../notify';

const uuid = z.string().uuid();
const mgr = guard('admin', 'manager');

const body = z.object({
  title: z.string().trim().min(1).max(150),
  description: z.string().trim().max(2000).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  capacity: z.number().int().min(1).max(1000),
  grantsCert: z.string().trim().max(80).optional().nullable(),
  certValidMonths: z.number().int().min(1).max(120).optional().nullable(),
});

const approvedCount = async (c: PoolClient, trainingId: string) =>
  (await c.query("SELECT count(*)::int AS n FROM training_applications WHERE training_id = $1 AND status IN ('approved','completed')", [trainingId])).rows[0].n as number;

const when = (t: { starts_at: string; location: string | null }, tz: string) =>
  `${new Date(t.starts_at).toLocaleString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}${t.location ? ' · ' + t.location : ''}`;
const tzOf = async (c: PoolClient) => (await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0].timezone as string;

/** A seat opened up: the longest-waiting person on the waitlist is approved and told. */
async function promoteWaitlist(c: PoolClient, tid: string, trainingId: string) {
  const t = (await c.query('SELECT * FROM trainings WHERE id = $1', [trainingId])).rows[0];
  if (!t || t.status !== 'open') return;
  while ((await approvedCount(c, trainingId)) < t.capacity) {
    const w = (await c.query("SELECT id, user_id FROM training_applications WHERE training_id = $1 AND status = 'waitlisted' ORDER BY created_at LIMIT 1", [trainingId])).rows[0];
    if (!w) return;
    await c.query("UPDATE training_applications SET status = 'approved' WHERE id = $1", [w.id]);
    await notify(c, tid, { userId: w.user_id, category: 'training', title: `You're in: ${t.title}`, body: `A seat opened up.\n${when(t, await tzOf(c))}`, link: '/trainings' });
  }
}

export async function trainingRoutes(app: FastifyInstance) {
  // Everyone: upcoming trainings with their own application. Coordinators also get the applicants.
  app.get('/api/trainings', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const staff = req.user.role !== 'crew';
      const rows = (
        await c.query(
          `SELECT t.*,
             (SELECT count(*)::int FROM training_applications a WHERE a.training_id = t.id AND a.status IN ('approved','completed')) AS approved_count,
             (SELECT count(*)::int FROM training_applications a WHERE a.training_id = t.id AND a.status = 'waitlisted') AS waitlist_count,
             (SELECT a.status FROM training_applications a WHERE a.training_id = t.id AND a.user_id = $1) AS my_status
           FROM trainings t
           WHERE ($2::boolean OR t.status <> 'cancelled') AND (t.ends_at > now() - interval '30 days')
           ORDER BY t.starts_at`,
          [req.user.sub, staff],
        )
      ).rows;
      if (!staff) return { trainings: rows };
      const apps = (
        await c.query(
          `SELECT a.id, a.training_id, a.user_id, a.status, a.created_at, u.name AS user_name,
             (SELECT string_agg(r.role_key || ' ' || r.stars || '★', ', ') FROM crew_ratings r WHERE r.user_id = u.id) AS ratings
           FROM training_applications a JOIN users u ON u.id = a.user_id ORDER BY a.created_at`,
        )
      ).rows;
      return { trainings: rows.map((t) => ({ ...t, applications: apps.filter((a) => a.training_id === t.id) })) };
    }),
  );

  // Create one. Crew who could use it are told by in-app notification, push, and email.
  app.post('/api/trainings', { preHandler: mgr }, async (req, reply) => {
    const b = body.parse(req.body);
    if (+new Date(b.endsAt) <= +new Date(b.startsAt)) return reply.code(400).send({ error: 'The end must be after the start' });
    const t = await withTenant(req.user.tid, async (c) => {
      const t = (
        await c.query(
          `INSERT INTO trainings (tenant_id, title, description, location, starts_at, ends_at, capacity, grants_cert, cert_valid_months)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [req.user.tid, b.title, b.description || null, b.location || null, b.startsAt, b.endsAt, b.capacity, b.grantsCert || null, b.grantsCert ? b.certValidMonths ?? null : null],
        )
      ).rows[0];
      // Crew who already hold a valid copy of the certificate it grants do not need the announcement.
      const crew = (
        await c.query(
          `SELECT u.id FROM users u WHERE u.role = 'crew' AND u.active AND NOT ($1::text IS NOT NULL AND EXISTS (
             SELECT 1 FROM user_certs k WHERE k.user_id = u.id AND lower(k.name) = lower($1) AND k.verified AND (k.expires_on IS NULL OR k.expires_on > $2::date)))`,
          [t.grants_cert, new Date(t.ends_at).toISOString().slice(0, 10)],
        )
      ).rows;
      const tz = await tzOf(c);
      await notify(c, req.user.tid, crew.map((u) => ({
        userId: u.id, category: 'training' as const, title: `Training open: ${t.title}`,
        body: `${when(t, tz)}\n${t.capacity} seat${t.capacity > 1 ? 's' : ''}${t.grants_cert ? `\nEarns your ${t.grants_cert} certificate` : ''}\n\nApply in LaborOps.`, link: '/trainings',
      })));
      await audit(c, req.user.tid, req.user.sub, 'training.create', 'training', t.id, { title: t.title, notified: crew.length });
      return { ...t, notified: crew.length };
    });
    return reply.code(201).send({ training: t });
  });

  app.patch('/api/trainings/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = body.partial().extend({ status: z.enum(['open', 'cancelled']).optional() }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      const cur = (await c.query('SELECT * FROM trainings WHERE id = $1', [id])).rows[0];
      if (!cur) return null;
      if (cur.status === 'completed') return { error: 'A completed training cannot be changed' };
      if (b.capacity !== undefined && b.capacity < (await approvedCount(c, id))) return { error: 'More people than that are already approved' };
      const n = { ...cur, title: b.title ?? cur.title, description: b.description !== undefined ? b.description || null : cur.description, location: b.location !== undefined ? b.location || null : cur.location };
      const t = (
        await c.query(
          `UPDATE trainings SET title=$2, description=$3, location=$4, starts_at=$5, ends_at=$6, capacity=$7, grants_cert=$8, cert_valid_months=$9, status=$10 WHERE id=$1 RETURNING *`,
          [id, n.title, n.description, n.location, b.startsAt ?? cur.starts_at, b.endsAt ?? cur.ends_at, b.capacity ?? cur.capacity,
           b.grantsCert !== undefined ? b.grantsCert || null : cur.grants_cert, b.certValidMonths !== undefined ? b.certValidMonths : cur.cert_valid_months, b.status ?? cur.status],
        )
      ).rows[0];
      if (b.status === 'cancelled' && cur.status !== 'cancelled') {
        const who = (await c.query("SELECT user_id FROM training_applications WHERE training_id = $1 AND status IN ('applied','approved','waitlisted')", [id])).rows;
        await notify(c, req.user.tid, who.map((w) => ({ userId: w.user_id, category: 'training' as const, title: `Training cancelled: ${t.title}`, body: 'This training was cancelled.', link: '/trainings' })));
      } else await promoteWaitlist(c, req.user.tid, id);
      await audit(c, req.user.tid, req.user.sub, 'training.update', 'training', id, b);
      return { training: t };
    });
    if (!r) return reply.code(404).send({ error: 'Training not found' });
    return 'error' in r ? reply.code(409).send(r) : r;
  });

  // Crew: apply / withdraw.
  app.post('/api/trainings/:id/apply', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await withTenant(req.user.tid, async (c) => {
      const t = (await c.query('SELECT * FROM trainings WHERE id = $1', [id])).rows[0];
      if (!t || t.status !== 'open' || new Date(t.starts_at) <= new Date()) return { code: 404, error: 'This training is not open for applications' };
      if ((await c.query('SELECT 1 FROM training_applications WHERE training_id = $1 AND user_id = $2', [id, req.user.sub])).rowCount) return { code: 409, error: 'You have already applied' };
      const a = (await c.query("INSERT INTO training_applications (tenant_id, training_id, user_id) VALUES ($1,$2,$3) RETURNING id, status", [req.user.tid, id, req.user.sub])).rows[0];
      const me = (await c.query('SELECT name FROM users WHERE id = $1', [req.user.sub])).rows[0];
      await notifyStaff(c, req.user.tid, { category: 'training', title: `Training application: ${t.title}`, body: `${me.name} applied.`, link: '/trainings', quiet: true } as any);
      return { code: 201, application: a };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  app.delete('/api/trainings/:id/apply', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query("DELETE FROM training_applications WHERE training_id = $1 AND user_id = $2 AND status <> 'completed'", [id, req.user.sub]);
      if (r.rowCount) await promoteWaitlist(c, req.user.tid, id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'No application to withdraw' });
  });

  // Coordinator decision. Approving a full class puts the person on the waitlist instead.
  app.patch('/api/training-applications/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { status } = z.object({ status: z.enum(['approved', 'declined', 'waitlisted']) }).parse(req.body);
    const r = await withTenant(req.user.tid, async (c) => {
      const a = (await c.query('SELECT a.*, t.title, t.status AS t_status, t.capacity, t.starts_at, t.location FROM training_applications a JOIN trainings t ON t.id = a.training_id WHERE a.id = $1', [id])).rows[0];
      if (!a) return { code: 404, error: 'Application not found' };
      if (a.t_status !== 'open' || a.status === 'completed') return { code: 409, error: 'This training is closed' };
      let final: string = status;
      if (status === 'approved' && a.status !== 'approved' && (await approvedCount(c, a.training_id)) >= a.capacity) final = 'waitlisted';
      await c.query('UPDATE training_applications SET status = $2 WHERE id = $1', [id, final]);
      const tz = await tzOf(c);
      const msg = final === 'approved' ? { title: `You're in: ${a.title}`, body: when(a, tz) } : final === 'waitlisted' ? { title: `Waitlisted: ${a.title}`, body: "The class is full. We'll tell you if a seat opens." } : { title: `Training application: ${a.title}`, body: "We couldn't offer you a seat this time." };
      if (final !== a.status) await notify(c, req.user.tid, { userId: a.user_id, category: 'training', ...msg, link: '/trainings' });
      if (a.status === 'approved' && final !== 'approved') await promoteWaitlist(c, req.user.tid, a.training_id);
      await audit(c, req.user.tid, req.user.sub, 'training.application', 'training_application', id, { status: final });
      return { code: 200, status: final };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // Mark the training done. Attendees (default: everyone approved) are completed and get the certificate it grants.
  app.post('/api/trainings/:id/complete', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { userIds } = z.object({ userIds: z.array(uuid).max(1000).optional() }).parse(req.body ?? {});
    const r = await withTenant(req.user.tid, async (c) => {
      const t = (await c.query('SELECT * FROM trainings WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!t) return { code: 404, error: 'Training not found' };
      if (t.status !== 'open') return { code: 409, error: 'This training is already closed' };
      const done = (
        await c.query(
          "UPDATE training_applications SET status = 'completed' WHERE training_id = $1 AND status = 'approved' AND ($2::uuid[] IS NULL OR user_id = ANY($2::uuid[])) RETURNING user_id",
          [id, userIds ?? null],
        )
      ).rows;
      await c.query("UPDATE trainings SET status = 'completed' WHERE id = $1", [id]);
      if (t.grants_cert && done.length)
        await c.query(
          `INSERT INTO user_certs (tenant_id, user_id, name, expires_on, verified)
           SELECT $1, x, $2, CASE WHEN $4::int IS NULL THEN NULL ELSE ((($5::timestamptz AT TIME ZONE (SELECT timezone FROM tenants LIMIT 1))::date) + make_interval(months => $4::int))::date END, true
             FROM unnest($3::uuid[]) x
           ON CONFLICT (user_id, lower(name)) DO UPDATE SET expires_on = EXCLUDED.expires_on, verified = true`,
          [req.user.tid, t.grants_cert, done.map((d) => d.user_id), t.cert_valid_months, t.ends_at],
        );
      await notify(c, req.user.tid, done.map((d) => ({
        userId: d.user_id, category: 'training' as const, title: `Training completed: ${t.title}`,
        body: t.grants_cert ? `Your ${t.grants_cert} certificate was added to your profile.` : 'Nice work.', link: t.grants_cert ? '/profile' : '/trainings',
      })));
      await audit(c, req.user.tid, req.user.sub, 'training.complete', 'training', id, { completed: done.length, cert: t.grants_cert });
      return { code: 200, completed: done.length, certGranted: !!t.grants_cert };
    });
    const { code, ...rest } = r as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });
}
