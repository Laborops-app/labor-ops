import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { authenticate, guard } from '../auth';
import { pool, withTenant, audit } from '../db';
import { appliesTo, formField, formPdf, missing, onboardingLeft, pdfField, pdfPageCount, shiftFormsFor, signPdf, signerOf, submitBody, templateSettings, type FormField, type PdfField } from '../docs';
import { notify, notifyStaff } from '../notify';
import { STARTER_NAMES, starterPacket } from '../starterPacket';

const uuid = z.string().uuid();
const idParam = z.object({ id: uuid });
const MAX_PDF = 10 * 1024 * 1024;
const staff = (role: string) => role === 'admin' || role === 'manager';

const fieldsFor = (kind: string, raw: unknown): (PdfField | FormField)[] => (kind === 'pdf' ? z.array(pdfField).max(200).parse(raw ?? []) : z.array(formField).max(80).parse(raw ?? []));
const settingsRow = async (c: PoolClient) => {
  const r = (await c.query('SELECT onboarding_on, onboarding_block, onboarding_remind, forms_on FROM staffing_settings')).rows[0];
  return { onboardingOn: !!r?.onboarding_on, onboardingBlock: !!r?.onboarding_block, onboardingRemind: r ? !!r.onboarding_remind : true, formsOn: !!r?.forms_on };
};

/** Remind people with onboarding steps left. `only` limits it to one person; otherwise everyone not reminded in 2 days. */
export async function remindOnboarding(c: PoolClient, tid: string, only?: string): Promise<number> {
  const s = await settingsRow(c);
  if (!s.onboardingOn || (!only && !s.onboardingRemind)) return 0;
  const people = (
    await c.query(
      `SELECT u.id FROM users u WHERE u.role = 'crew' AND u.active AND ($1::uuid IS NOT NULL AND u.id = $1 OR $1::uuid IS NULL AND (u.onboarding_reminded_at IS NULL OR u.onboarding_reminded_at < now() - interval '2 days'))`,
      [only ?? null],
    )
  ).rows;
  let n = 0;
  for (const p of people) {
    const left = await onboardingLeft(c, p.id);
    if (!left.length) continue;
    await notify(c, tid, { userId: p.id, category: 'account', title: `Finish your onboarding: ${left.length} ${left.length === 1 ? 'step' : 'steps'} left`, body: `Still to do: ${left.map((l) => l.name).join(', ')}.\n\nEach one opens in LaborOps and takes a minute or two to fill in and sign.`, link: '/my-documents', linkLabel: 'Open my documents' });
    await c.query('UPDATE users SET onboarding_reminded_at = now() WHERE id = $1', [p.id]);
    n++;
  }
  return n;
}
export async function runOnboardingReminders(): Promise<number> {
  const { rows } = await pool.query('SELECT id FROM notify_tenants()');
  let n = 0;
  for (const t of rows) n += await withTenant(t.id, (c) => remindOnboarding(c, t.id)).catch(() => 0);
  return n;
}

export async function docRoutes(app: FastifyInstance) {
  const mgr = guard('admin', 'manager');
  const adminOnly = guard('admin');
  const big = { bodyLimit: 15 * 1024 * 1024 };

  app.get('/api/docs/settings', { preHandler: authenticate }, async (req) => withTenant(req.user.tid, settingsRow));
  app.put('/api/docs/settings', { preHandler: adminOnly }, async (req) => {
    const b = z.object({ onboardingOn: z.boolean().optional(), onboardingBlock: z.boolean().optional(), onboardingRemind: z.boolean().optional(), formsOn: z.boolean().optional() }).parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      await c.query(
        `INSERT INTO staffing_settings (tenant_id, onboarding_on, onboarding_block, onboarding_remind, forms_on) VALUES ($1, COALESCE($2, false), COALESCE($3, false), COALESCE($4, true), COALESCE($5, false))
         ON CONFLICT (tenant_id) DO UPDATE SET onboarding_on = COALESCE($2, staffing_settings.onboarding_on), onboarding_block = COALESCE($3, staffing_settings.onboarding_block),
           onboarding_remind = COALESCE($4, staffing_settings.onboarding_remind), forms_on = COALESCE($5, staffing_settings.forms_on), updated_at = now()`,
        [req.user.tid, b.onboardingOn ?? null, b.onboardingBlock ?? null, b.onboardingRemind ?? null, b.formsOn ?? null],
      );
      await audit(c, req.user.tid, req.user.sub, 'docs.settings', 'settings', null, b);
      return settingsRow(c);
    });
  });

  // ----- templates -----
  app.get('/api/docs/templates', { preHandler: mgr }, async (req) => {
    const { purpose } = z.object({ purpose: z.enum(['onboarding', 'shift']).optional() }).parse(req.query);
    return withTenant(req.user.tid, async (c) => ({
      templates: (
        await c.query(
          `SELECT t.id, t.name, t.kind, t.purpose, t.file_name, t.page_count, t.fields, t.settings, t.sort, t.active, t.updated_at,
                  (SELECT count(*)::int FROM doc_submissions s WHERE s.template_id = t.id) AS completed
             FROM doc_templates t WHERE ($1::text IS NULL OR t.purpose = $1) ORDER BY t.purpose, t.sort, t.created_at`,
          [purpose ?? null],
        )
      ).rows.map((t) => ({ ...t, settings: templateSettings.parse(t.settings ?? {}) })),
    }));
  });
  app.post('/api/docs/templates', { preHandler: mgr, ...big }, async (req, reply) => {
    const b = z
      .object({
        name: z.string().trim().min(1, 'Give it a name').max(120), kind: z.enum(['pdf', 'form']), purpose: z.enum(['onboarding', 'shift']),
        file: z.string().max(14_500_000).optional(), fileName: z.string().trim().max(200).optional(), fields: z.unknown().optional(), settings: templateSettings.partial().optional(),
      })
      .safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the form' });
    const d = b.data;
    let data: Buffer | null = null, pages: number | null = null;
    if (d.kind === 'pdf') {
      if (!d.file) return reply.code(400).send({ error: 'Choose a PDF to upload.' });
      data = Buffer.from(d.file, 'base64');
      if (data.length > MAX_PDF) return reply.code(413).send({ error: 'That PDF is over 10 MB. Save a smaller copy and try again.' });
      if (data.subarray(0, 5).toString() !== '%PDF-') return reply.code(400).send({ error: 'That file isn’t a PDF.' });
      try { pages = await pdfPageCount(data); } catch { return reply.code(400).send({ error: 'That PDF couldn’t be read. If it is password-protected, save an unprotected copy.' }); }
    }
    let fields: unknown[];
    try { fields = fieldsFor(d.kind, d.fields); } catch (e) { return reply.code(400).send({ error: (e as z.ZodError).issues?.[0]?.message ?? 'Check the fields' }); }
    const row = await withTenant(req.user.tid, async (c) => {
      const sort = (await c.query('SELECT COALESCE(max(sort), 0) + 1 AS n FROM doc_templates WHERE purpose = $1', [d.purpose])).rows[0].n;
      const r = (
        await c.query(
          `INSERT INTO doc_templates (tenant_id, name, kind, purpose, data, file_name, size, page_count, fields, settings, sort, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
          [req.user.tid, d.name, d.kind, d.purpose, data, d.fileName ?? null, data?.length ?? null, pages, JSON.stringify(fields), JSON.stringify(templateSettings.parse(d.settings ?? {})), sort, req.user.sub],
        )
      ).rows[0];
      await audit(c, req.user.tid, req.user.sub, 'docs.template_create', 'doc_template', r.id, { name: d.name, kind: d.kind, purpose: d.purpose });
      return r;
    });
    return reply.code(201).send({ id: row.id });
  });
  // Anyone in the company can read a template to fill it in.
  app.get('/api/docs/templates/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const t = await withTenant(req.user.tid, async (c) => (await c.query('SELECT id, name, kind, purpose, file_name, page_count, fields, settings, active FROM doc_templates WHERE id = $1', [id])).rows[0]);
    if (!t || (!t.active && !staff(req.user.role))) return reply.code(404).send({ error: 'Document not found' });
    return { template: { ...t, settings: templateSettings.parse(t.settings ?? {}) } };
  });
  app.get('/api/docs/templates/:id/file', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const t = await withTenant(req.user.tid, async (c) => (await c.query("SELECT data, file_name FROM doc_templates WHERE id = $1 AND kind = 'pdf'", [id])).rows[0]);
    if (!t?.data) return reply.code(404).send({ error: 'Document not found' });
    return reply.header('content-type', 'application/pdf').header('cache-control', 'private, max-age=300').send(t.data);
  });
  app.put('/api/docs/templates/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(120).optional(), fields: z.unknown().optional(), settings: templateSettings.partial().optional(), active: z.boolean().optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? 'Check the form' });
    const out = await withTenant(req.user.tid, async (c) => {
      const cur = (await c.query('SELECT kind, settings FROM doc_templates WHERE id = $1', [id])).rows[0];
      if (!cur) return { code: 404, error: 'Document not found' };
      let fields: unknown[] | null = null;
      if (b.data.fields !== undefined) { try { fields = fieldsFor(cur.kind, b.data.fields); } catch (e) { return { code: 400, error: (e as z.ZodError).issues?.[0]?.message ?? 'Check the fields' }; } }
      const settings = b.data.settings ? templateSettings.parse({ ...(cur.settings ?? {}), ...b.data.settings }) : null;
      await c.query(
        `UPDATE doc_templates SET name = COALESCE($2, name), fields = COALESCE($3::jsonb, fields), settings = COALESCE($4::jsonb, settings), active = COALESCE($5, active), updated_at = now() WHERE id = $1`,
        [id, b.data.name ?? null, fields ? JSON.stringify(fields) : null, settings ? JSON.stringify(settings) : null, b.data.active ?? null],
      );
      await audit(c, req.user.tid, req.user.sub, 'docs.template_update', 'doc_template', id);
      return { code: 200, ok: true };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });
  app.put('/api/docs/templates-order', { preHandler: mgr }, async (req) => {
    const { ids } = z.object({ ids: z.array(uuid).max(200) }).parse(req.body);
    return withTenant(req.user.tid, async (c) => {
      for (let i = 0; i < ids.length; i++) await c.query('UPDATE doc_templates SET sort = $2 WHERE id = $1', [ids[i], i + 1]);
      return { ok: true };
    });
  });
  // Signed copies are kept when a template is removed.
  app.delete('/api/docs/templates/:id', { preHandler: mgr }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('DELETE FROM doc_templates WHERE id = $1', [id]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, 'docs.template_delete', 'doc_template', id);
      return r.rowCount;
    });
    return n ? { ok: true } : reply.code(404).send({ error: 'Document not found' });
  });

  // A ready-made onboarding packet: generic PDFs with the fields already placed. Ones already in the packet are skipped.
  app.post('/api/docs/starter-packet', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const company = (await c.query('SELECT name FROM tenants WHERE id = $1', [req.user.tid])).rows[0]?.name ?? 'the company';
      const have = new Set((await c.query("SELECT lower(name) AS n FROM doc_templates WHERE purpose = 'onboarding'")).rows.map((r) => r.n as string));
      let sort = (await c.query("SELECT COALESCE(max(sort), 0) AS n FROM doc_templates WHERE purpose = 'onboarding'")).rows[0].n as number;
      const added: string[] = [];
      for (const d of await starterPacket(company)) {
        if (have.has(d.name.toLowerCase())) continue;
        await c.query(
          `INSERT INTO doc_templates (tenant_id, name, kind, purpose, data, file_name, size, page_count, fields, settings, sort, created_by) VALUES ($1,$2,'pdf','onboarding',$3,$4,$5,$6,$7,$8,$9,$10)`,
          [req.user.tid, d.name, d.pdf, d.fileName, d.pdf.length, d.pages, JSON.stringify(d.fields), JSON.stringify(templateSettings.parse({})), ++sort, req.user.sub],
        );
        added.push(d.name);
      }
      if (added.length) await audit(c, req.user.tid, req.user.sub, 'docs.starter_packet', 'doc_template', null, { added });
      return { added, skipped: STARTER_NAMES.length - added.length };
    }),
  );

  // ----- filling in and signing -----
  app.post('/api/docs/templates/:id/submit', { preHandler: authenticate, bodyLimit: 8 * 1024 * 1024 }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const parsed = submitBody.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Something in the form couldn’t be read. A photo may be too large; try a smaller one.' });
    const b = parsed.data;
    const out = await withTenant(req.user.tid, async (c) => {
      const t = (await c.query('SELECT id, name, kind, purpose, data, fields, settings, active FROM doc_templates WHERE id = $1', [id])).rows[0];
      if (!t || !t.active) return { code: 404, error: 'This document is no longer in use.' };
      const settings = templateSettings.parse(t.settings ?? {});
      const fields = fieldsFor(t.kind, t.fields);
      let shift: { id: string; event_id: string; role_name: string; starts_at: Date; phase: string | null; event: string } | null = null;
      if (t.purpose === 'shift') {
        if (!b.shiftId) return { code: 400, error: 'Open this form from the shift it is for.' };
        shift = (await c.query('SELECT s.id, s.event_id, s.role_name, s.starts_at, p.label AS phase, e.name AS event FROM shifts s JOIN events e ON e.id = s.event_id LEFT JOIN event_phases p ON p.id = s.phase_id WHERE s.id = $1', [b.shiftId])).rows[0] ?? null;
        if (!shift) return { code: 404, error: 'Shift not found' };
        const onIt = (await c.query("SELECT 1 FROM shift_assignments WHERE shift_id = $1 AND user_id = $2 AND status = 'accepted'", [b.shiftId, req.user.sub])).rowCount;
        if (!onIt && !staff(req.user.role)) return { code: 403, error: 'Only people on this shift can fill in its forms.' };
        if (!appliesTo(settings, shift)) return { code: 409, error: 'This form isn’t used on that shift.' };
      } else {
        const done = (await c.query('SELECT id FROM doc_submissions WHERE template_id = $1 AND user_id = $2', [id, req.user.sub])).rows[0];
        if (done) return { code: 409, error: 'You’ve already completed this one.', submissionId: done.id };
      }
      const miss = missing(t.kind, fields, b);
      if (miss) return { code: 400, error: miss };
      const sid = randomUUID();
      const who = await signerOf(c, req.user.sub, req, sid);
      let pdf: Buffer;
      try {
        if (t.kind === 'pdf') pdf = await signPdf(t.data, fields as PdfField[], b, who, t.name);
        else {
          const people = new Map<string, string>();
          if (shift) for (const p of (await c.query("SELECT u.id, u.name FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id WHERE s.event_id = $1 AND a.status = 'accepted'", [shift.event_id])).rows) people.set(p.id, p.name);
          const when = shift ? `${shift.phase ? `${shift.phase} · ` : ''}${new Intl.DateTimeFormat('en-US', { timeZone: who.tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(shift.starts_at)}` : null;
          pdf = await formPdf(t.name, fields as FormField[], b, who, { event: shift?.event ?? null, shift: shift ? `${shift.role_name} shift, ${new Intl.DateTimeFormat('en-US', { timeZone: who.tz, hour: 'numeric', minute: '2-digit' }).format(shift.starts_at)}` : null, when, people });
        }
      } catch (e) {
        req.log.error(e);
        return { code: 500, error: 'The signed PDF couldn’t be made. Try again, and tell your coordinator if it keeps happening.' };
      }
      // Photos live in the PDF; keep the stored answers small.
      const answers = Object.fromEntries(Object.entries(b.answers).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('data:image') ? '[photo]' : v]));
      const flagged = t.kind === 'form' && (fields as FormField[]).some((f) => f.type === 'yesno' && (b.answers[f.id] === false || b.answers[f.id] === 'no'));
      await c.query(
        `INSERT INTO doc_submissions (id, tenant_id, template_id, template_name, purpose, user_id, shift_id, event_id, answers, flagged, signed_name, signed_at, ip, user_agent, data, size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [sid, req.user.tid, id, t.name, t.purpose, req.user.sub, shift?.id ?? null, shift?.event_id ?? null, JSON.stringify(answers), flagged, b.signedName ?? who.name, who.at, who.ip, String(req.headers['user-agent'] ?? '').slice(0, 300), pdf, pdf.length],
      );
      await audit(c, req.user.tid, req.user.sub, 'docs.signed', 'doc_submission', sid, { template: t.name });
      if (flagged && settings.alertOnNo && shift)
        await notifyStaff(c, req.user.tid, { category: 'approval_request', title: `${t.name}: a "No" answer on ${shift.event}`, body: `${who.name} answered No to a question on ${t.name} (${shift.role_name}). Open the form to see which.`, link: `/events/${shift.event_id}` }, req.user.sub);
      const left = t.purpose === 'onboarding' ? await onboardingLeft(c, req.user.sub) : [];
      if (t.purpose === 'onboarding' && !left.length)
        await notifyStaff(c, req.user.tid, { category: 'approval_result', title: `${who.name} finished onboarding`, body: `${who.name} has completed every onboarding step. The signed copies are on their profile.`, link: `/crew/${req.user.sub}` }, req.user.sub);
      return { code: 201, submissionId: sid, left: left.length };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  app.get('/api/docs/submissions/:id/pdf', { preHandler: authenticate }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const s = await withTenant(req.user.tid, async (c) => (await c.query('SELECT data, template_name, user_id FROM doc_submissions WHERE id = $1', [id])).rows[0]);
    if (!s || (s.user_id !== req.user.sub && !staff(req.user.role) && req.user.role !== 'hr')) return reply.code(404).send({ error: 'Document not found' });
    const dl = (req.query as { download?: string }).download === '1';
    return reply.header('content-type', 'application/pdf').header('content-disposition', `${dl ? 'attachment' : 'inline'}; filename="${String(s.template_name).replace(/[^\w .-]+/g, '') || 'document'}.pdf"`).header('cache-control', 'private, no-store').send(s.data);
  });
  app.get('/api/docs/submissions', { preHandler: authenticate }, async (req, reply) => {
    const q = z.object({ userId: uuid.optional(), eventId: uuid.optional() }).parse(req.query);
    const mine = !staff(req.user.role) && req.user.role !== 'hr';
    if (mine && q.userId && q.userId !== req.user.sub) return reply.code(403).send({ error: 'Not allowed' });
    if (mine && q.eventId) return reply.code(403).send({ error: 'Not allowed' });
    return withTenant(req.user.tid, async (c) => ({
      submissions: (
        await c.query(
          `SELECT s.id, s.template_name, s.purpose, s.user_id, u.name AS user_name, s.shift_id, s.event_id, s.flagged, s.signed_at, sh.role_name, e.name AS event_name
             FROM doc_submissions s JOIN users u ON u.id = s.user_id LEFT JOIN shifts sh ON sh.id = s.shift_id LEFT JOIN events e ON e.id = s.event_id
            WHERE ($1::uuid IS NULL OR s.user_id = $1) AND ($2::uuid IS NULL OR s.event_id = $2) ORDER BY s.signed_at DESC LIMIT 500`,
          [mine ? req.user.sub : q.userId ?? null, q.eventId ?? null],
        )
      ).rows,
    }));
  });

  // ----- crew -----
  app.get('/api/my/documents', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const s = await settingsRow(c);
      const steps = s.onboardingOn
        ? (
            await c.query(
              `SELECT t.id, t.name, t.kind, COALESCE((t.settings->>'required')::boolean, true) AS required,
                      (SELECT d.id FROM doc_submissions d WHERE d.template_id = t.id AND d.user_id = $1 LIMIT 1) AS submission_id
                 FROM doc_templates t WHERE t.purpose = 'onboarding' AND t.active ORDER BY t.sort, t.created_at`,
              [req.user.sub],
            )
          ).rows
        : [];
      const signed = (await c.query(`SELECT s.id, s.template_name, s.purpose, s.signed_at, e.name AS event_name FROM doc_submissions s LEFT JOIN events e ON e.id = s.event_id WHERE s.user_id = $1 ORDER BY s.signed_at DESC LIMIT 200`, [req.user.sub])).rows;
      return { onboardingOn: s.onboardingOn, formsOn: s.formsOn, steps, signed };
    }),
  );
  app.get('/api/my/shifts/:id/forms', { preHandler: authenticate }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withTenant(req.user.tid, async (c) => ({
      forms: await shiftFormsFor(c, req.user.sub, id),
      people: (await c.query("SELECT DISTINCT u.id, u.name FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id WHERE a.status = 'accepted' AND s.event_id = (SELECT event_id FROM shifts WHERE id = $1) ORDER BY u.name", [id])).rows,
    }));
  });

  // ----- coordinators -----
  app.get('/api/docs/onboarding/progress', { preHandler: mgr }, async (req) =>
    withTenant(req.user.tid, async (c) => {
      const tpls = (await c.query("SELECT id, name, COALESCE((settings->>'required')::boolean, true) AS required FROM doc_templates WHERE purpose = 'onboarding' AND active ORDER BY sort, created_at")).rows;
      const done = (await c.query("SELECT s.user_id, s.template_id, s.signed_at FROM doc_submissions s WHERE s.purpose = 'onboarding' AND s.template_id IS NOT NULL")).rows;
      const crew = (await c.query("SELECT id, name, created_at, onboarding_reminded_at FROM users WHERE role = 'crew' AND active ORDER BY name")).rows;
      const need = tpls.filter((t) => t.required);
      return {
        total: need.length,
        people: crew.map((u) => {
          const mine = new Set(done.filter((d) => d.user_id === u.id).map((d) => d.template_id as string));
          const left = need.filter((t) => !mine.has(t.id)).map((t) => t.name as string);
          const last = done.filter((d) => d.user_id === u.id).map((d) => +new Date(d.signed_at)).sort((a, b) => b - a)[0];
          return { id: u.id, name: u.name, done: need.length - left.length, left, reminded_at: u.onboarding_reminded_at, finished_at: !left.length && last ? new Date(last).toISOString() : null };
        }),
      };
    }),
  );
  app.post('/api/docs/onboarding/remind', { preHandler: mgr }, async (req) => {
    const { userId } = z.object({ userId: uuid.optional() }).parse(req.body ?? {});
    return withTenant(req.user.tid, async (c) => {
      let n = 0;
      if (userId) n = await remindOnboarding(c, req.user.tid, userId);
      else for (const u of (await c.query("SELECT id FROM users WHERE role = 'crew' AND active")).rows) n += await remindOnboarding(c, req.user.tid, u.id);
      return { reminded: n };
    });
  });
  // For the event page: each shift's forms and whether they're done, plus every completed form.
  app.get('/api/events/:id/forms', { preHandler: mgr }, async (req) => {
    const { id } = idParam.parse(req.params);
    return withTenant(req.user.tid, async (c) => {
      const s = await settingsRow(c);
      if (!s.formsOn) return { formsOn: false, shifts: [], submissions: [] };
      const tpls = (await c.query("SELECT id, name, settings FROM doc_templates WHERE purpose = 'shift' AND active ORDER BY sort, created_at")).rows.map((t) => ({ ...t, settings: templateSettings.parse(t.settings ?? {}) }));
      const shifts = (await c.query('SELECT s.id, s.role_name, s.starts_at, p.label AS phase FROM shifts s LEFT JOIN event_phases p ON p.id = s.phase_id WHERE s.event_id = $1 ORDER BY s.starts_at', [id])).rows;
      const subs = (await c.query(`SELECT s.id, s.template_id, s.template_name, s.shift_id, s.flagged, s.signed_at, u.name AS user_name, sh.role_name FROM doc_submissions s JOIN users u ON u.id = s.user_id LEFT JOIN shifts sh ON sh.id = s.shift_id WHERE s.event_id = $1 ORDER BY s.signed_at DESC`, [id])).rows;
      return {
        formsOn: true,
        shifts: shifts.map((sh) => ({ id: sh.id, forms: tpls.filter((t) => appliesTo(t.settings, sh)).map((t) => ({ id: t.id, name: t.name, who: t.settings.who, done: subs.filter((x) => x.template_id === t.id && x.shift_id === sh.id).length })) })).filter((x) => x.forms.length),
        submissions: subs,
      };
    });
  });
}
