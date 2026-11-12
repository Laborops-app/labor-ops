import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard } from '../auth';
import { config } from '../config';
import { withTenant, audit } from '../db';
import { callSheetPdf, wrapReportPdf } from '../eventDocs';
import { notify } from '../notify';
import { absUrl, renderEmail } from '../notify/templates';

/**
 * Call sheets and wrap reports as PDFs. Coordinators download them signed in; crew and customers open them from a
 * signed link (30 days) sent by push, text or email, so nobody needs an attachment or an account.
 */
const TTL_DAYS = 30;
const mac = (p: string) => createHmac('sha256', config.jwtSecret + ':eventdoc').update(p).digest('base64url');
type Tok = { tid: string; eid: string; kind: 'call' | 'wrap'; phase: string | null; flags: string };
function docToken(t: Tok): string {
  const payload = [t.tid, t.eid, t.kind, t.phase ?? '-', t.flags, Math.floor(Date.now() / 1000) + TTL_DAYS * 86400].join('.');
  return Buffer.from(payload).toString('base64url') + '.' + mac(payload);
}
function readDocToken(raw: string): Tok | null {
  const [p, sig] = String(raw).split('.');
  if (!p || !sig) return null;
  let payload: string;
  try { payload = Buffer.from(p, 'base64url').toString(); } catch { return null; }
  const want = Buffer.from(mac(payload)), got = Buffer.from(sig);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  const [tid, eid, kind, phase, flags, exp] = payload.split('.');
  if (!tid || !eid || (kind !== 'call' && kind !== 'wrap') || Number(exp) < Date.now() / 1000) return null;
  return { tid, eid, kind, phase: phase === '-' ? null : phase!, flags: flags ?? '' };
}

const uuid = z.string().uuid();
const flag = z.union([z.boolean(), z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true')]);
const callOpts = z.object({ phase: uuid.nullish(), phaseId: uuid.nullish(), phones: flag.default(true), unconfirmed: flag.default(true) });
const wrapOpts = z.object({ signature: flag.default(true) });
const sendPdf = (reply: any, out: { pdf: Buffer; name: string }, download: boolean) =>
  reply.header('content-type', 'application/pdf').header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${out.name}"`).header('cache-control', 'no-store').send(out.pdf);

export async function eventDocRoutes(app: FastifyInstance) {
  const mgr = guard('admin', 'manager');
  const limit = { rateLimit: { max: 60, timeWindow: '1 minute' } };

  app.get('/api/events/:id/call-sheet.pdf', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = callOpts.extend({ download: flag.default(false) }).parse(req.query);
    const out = await withTenant(req.user.tid, (c) => callSheetPdf(c, id, { phaseId: q.phase ?? q.phaseId ?? null, phones: q.phones, unconfirmed: q.unconfirmed }));
    return out ? sendPdf(reply, out, q.download) : reply.code(404).send({ error: 'Event not found' });
  });
  app.get('/api/events/:id/wrap-report.pdf', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = wrapOpts.extend({ download: flag.default(false) }).parse(req.query);
    const out = await withTenant(req.user.tid, (c) => wrapReportPdf(c, id, { signature: q.signature }));
    return out ? sendPdf(reply, out, q.download) : reply.code(404).send({ error: 'Event not found' });
  });

  // Opened from a link in a notification or email. The link carries what to show; nothing else about the event is exposed.
  app.get('/api/event-doc', { config: limit }, async (req, reply) => {
    const tok = readDocToken(z.object({ t: z.string().max(600) }).parse(req.query).t);
    if (!tok) return reply.code(404).send({ error: 'This link has expired. Ask for a new one.' });
    const out = await withTenant(tok.tid, (c) =>
      tok.kind === 'call'
        ? callSheetPdf(c, tok.eid, { phaseId: tok.phase, phones: tok.flags.includes('p'), unconfirmed: tok.flags.includes('u') })
        : wrapReportPdf(c, tok.eid, { signature: tok.flags.includes('s') }),
    );
    return out ? sendPdf(reply, out, false) : reply.code(404).send({ error: 'Not found' });
  });

  // Send the call sheet to the crew confirmed on that day (or the whole event).
  app.post('/api/events/:id/call-sheet/send', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = callOpts.extend({ text: z.boolean().default(false) }).parse(req.body ?? {});
    const phaseId = b.phase ?? b.phaseId ?? null;
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT name FROM events WHERE id = $1', [id])).rows[0];
      if (!ev) return { code: 404, error: 'Event not found' };
      const phase = phaseId ? (await c.query('SELECT label FROM event_phases WHERE id = $1 AND event_id = $2', [phaseId, id])).rows[0] : null;
      if (phaseId && !phase) return { code: 404, error: 'That day is not on this event' };
      const crew = (
        await c.query(
          `SELECT DISTINCT a.user_id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id AND u.active
            WHERE s.event_id = $1 AND a.status = 'accepted' AND s.ends_at > now() AND ($2::uuid IS NULL OR s.phase_id = $2)`,
          [id, phaseId],
        )
      ).rows.map((r) => r.user_id as string);
      if (!crew.length) return { code: 409, error: 'Nobody is confirmed on this day yet, so there is no one to send it to.' };
      const link = `/api/event-doc?t=${docToken({ tid: req.user.tid, eid: id, kind: 'call', phase: phaseId, flags: `${b.phones ? 'p' : ''}${b.unconfirmed ? 'u' : ''}` })}`;
      const title = `${ev.name}: call sheet${phase ? ` for ${phase.label}` : ''}`;
      await notify(c, req.user.tid, crew.map((userId) => ({
        userId, category: 'event_update' as const, title,
        body: `The call sheet${phase ? ` for ${phase.label}` : ''} is ready: call times, venue, site contact and who you're working with.`,
        sms: `${title}. Open it: ${absUrl(link)}`.slice(0, 300), link, linkLabel: 'Open the call sheet (PDF)', allowSms: b.text,
      })));
      await audit(c, req.user.tid, req.user.sub, 'event.call_sheet_sent', 'event', id, { phaseId, recipients: crew.length, text: b.text });
      return { code: 200, recipients: crew.length };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });

  // Email the wrap report to the customer.
  app.post('/api/events/:id/wrap-report/send', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = wrapOpts.extend({ to: z.string().trim().email().max(200).optional(), message: z.string().trim().max(3000).optional() }).parse(req.body ?? {});
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = (await c.query('SELECT e.name, e.customer_id, t.name AS company FROM events e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1', [id])).rows[0];
      if (!ev) return { code: 404, error: 'Event not found' };
      const contact = ev.customer_id ? (await c.query('SELECT name, email FROM customer_contacts WHERE customer_id = $1 AND email IS NOT NULL ORDER BY is_primary DESC, created_at LIMIT 1', [ev.customer_id])).rows[0] : null;
      const to = b.to ?? contact?.email;
      if (!to) return { code: 400, error: 'Type the customer’s email address, or add one to the customer’s contacts.' };
      const link = `/api/event-doc?t=${docToken({ tid: req.user.tid, eid: id, kind: 'wrap', phase: null, flags: b.signature ? 's' : '' })}`;
      const subject = `${ev.company}: wrap report for ${ev.name}`;
      const m = renderEmail({
        title: subject,
        body: [contact?.name && !b.to ? `Hi ${String(contact.name).split(' ')[0]},` : 'Hello,', b.message ?? `Here is the wrap report for ${ev.name}: scheduled and worked hours by role, overtime and attendance.`, 'The link works for 30 days.'].join('\n\n'),
        link, linkLabel: 'Open the wrap report (PDF)', footer: `You received this because ${ev.company} sent you a report.`,
      });
      await c.query(`INSERT INTO deliveries (tenant_id, user_id, channel, category, to_addr, subject, body, html) VALUES ($1,$2,'email','account',$3,$4,$5,$6)`, [req.user.tid, req.user.sub, to, subject, m.text, m.html]);
      await audit(c, req.user.tid, req.user.sub, 'event.wrap_report_sent', 'event', id, { to });
      return { code: 200, sentTo: to };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });
}
