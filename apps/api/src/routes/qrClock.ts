import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';
import { z } from 'zod';
import { authenticate, guard } from '../auth';
import { autoApprove } from '../autoApprove';
import { config } from '../config';
import { withTenant, audit } from '../db';
import { distanceM } from './time';

/**
 * QR clock-in. The venue screen shows a code that changes every 30 seconds; crew scan it with their phone's camera,
 * which opens LaborOps and clocks them in (or out, when they are already in). A photo of an old code stops working
 * after about a minute. A printed poster uses a code that doesn't change, so it also checks the phone is at the venue.
 */
const STEP_S = 30;
const uuid = z.string().uuid();
const codeFor = (secret: string, eventId: string, part: string) => createHmac('sha256', secret).update(`${eventId}:${part}`).digest('base64url').slice(0, 12);
const windowNow = () => Math.floor(Date.now() / 1000 / STEP_S);
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const scanUrl = (eventId: string, code: string) => `${config.appUrl}/clock?e=${eventId}&c=${code}`;

const mac = (p: string) => createHmac('sha256', config.jwtSecret + ':qrscreen').update(p).digest('base64url');
const screenToken = (tid: string, eid: string, days = 14) => {
  const payload = `${tid}.${eid}.${Math.floor(Date.now() / 1000) + days * 86400}`;
  return Buffer.from(payload).toString('base64url') + '.' + mac(payload);
};
const readScreenToken = (raw: string) => {
  const [p, sig] = String(raw).split('.');
  if (!p || !sig) return null;
  let payload: string;
  try { payload = Buffer.from(p, 'base64url').toString(); } catch { return null; }
  if (!same(mac(payload), sig)) return null;
  const [tid, eid, exp] = payload.split('.');
  return tid && eid && Number(exp) >= Date.now() / 1000 ? { tid, eid } : null;
};

/** The square of dark/light modules for some text. */
function matrix(text: string) {
  const q = QRCode.create(text, { errorCorrectionLevel: 'M' });
  return { size: q.modules.size, on: (x: number, y: number) => !!q.modules.get(y, x) };
}
function svg(text: string) {
  const m = matrix(text);
  let d = '';
  for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.on(x, y)) d += `M${x + 2} ${y + 2}h1v1h-1z`;
  const n = m.size + 4;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" role="img" aria-label="Clock-in code"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

async function eventQr(c: PoolClient, eventId: string) {
  return (
    await c.query(
      `SELECT e.id, e.name, e.venue, e.qr_clock, e.qr_secret, e.geo_lat, e.geo_lng, e.geofence_m, t.timezone, t.name AS company FROM events e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1`,
      [eventId],
    )
  ).rows[0] as { id: string; name: string; venue: string | null; qr_clock: boolean; qr_secret: string | null; geo_lat: number | null; geo_lng: number | null; geofence_m: number | null; timezone: string; company: string } | undefined;
}
/** What the venue screen shows: the current code and who is in. */
async function screenData(c: PoolClient, eventId: string) {
  const ev = await eventQr(c, eventId);
  if (!ev || !ev.qr_clock || !ev.qr_secret) return null;
  const counts = (
    await c.query(
      `SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id))::int AS seen,
              count(*) FILTER (WHERE EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id AND t.clock_out IS NULL))::int AS on_site,
              count(*)::int AS expected
         FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
        WHERE s.event_id = $1 AND a.status = 'accepted' AND now() BETWEEN s.starts_at - interval '2 hours' AND s.ends_at + interval '2 hours'`,
      [eventId],
    )
  ).rows[0];
  const w = windowNow();
  return {
    event: { name: ev.name, venue: ev.venue, company: ev.company },
    svg: svg(scanUrl(ev.id, codeFor(ev.qr_secret, ev.id, String(w)))),
    secondsLeft: STEP_S - (Math.floor(Date.now() / 1000) % STEP_S),
    counts: { in: counts.seen as number, onSite: counts.on_site as number, expected: counts.expected as number },
  };
}

export async function qrClockRoutes(app: FastifyInstance) {
  const mgr = guard('admin', 'manager');
  const limit = { rateLimit: { max: 120, timeWindow: '1 minute' } };

  app.get('/api/events/:id/qr', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ev = await withTenant(req.user.tid, (c) => eventQr(c, id));
    if (!ev) return reply.code(404).send({ error: 'Event not found' });
    return { on: ev.qr_clock, hasVenueLocation: ev.geo_lat !== null && ev.geo_lng !== null && !!ev.geofence_m, screenLink: ev.qr_clock ? `${config.appUrl}/qr-screen?t=${screenToken(req.user.tid, id)}` : null };
  });
  app.put('/api/events/:id/qr', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    const ok = await withTenant(req.user.tid, async (c) => {
      const r = await c.query('UPDATE events SET qr_clock = $2, qr_secret = COALESCE(qr_secret, $3) WHERE id = $1 RETURNING id', [id, on, randomBytes(24).toString('base64url')]);
      if (r.rowCount) await audit(c, req.user.tid, req.user.sub, on ? 'event.qr_on' : 'event.qr_off', 'event', id);
      return !!r.rowCount;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Event not found' });
  });

  // The venue screen. No sign-in: whoever has the link (a site lead's laptop, a TV) can show the code, nothing else.
  app.get('/api/qr-screen', { config: limit }, async (req, reply) => {
    const tok = readScreenToken(z.object({ t: z.string().max(400) }).parse(req.query).t);
    if (!tok) return reply.code(404).send({ error: 'This screen link has expired. Ask the coordinator for a new one.' });
    const d = await withTenant(tok.tid, (c) => screenData(c, tok.eid));
    return d ? reply.header('cache-control', 'no-store').send(d) : reply.code(409).send({ error: 'QR clock-in is turned off for this event.' });
  });

  // A poster to print: a code that doesn't change, so scanning it also checks the phone is at the venue.
  app.get('/api/events/:id/qr-poster.pdf', { preHandler: mgr }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ev = await withTenant(req.user.tid, (c) => eventQr(c, id));
    if (!ev) return reply.code(404).send({ error: 'Event not found' });
    if (!ev.qr_clock || !ev.qr_secret) return reply.code(409).send({ error: 'Turn on QR clock-in for this event first.' });
    if (ev.geo_lat === null || ev.geo_lng === null || !ev.geofence_m) return reply.code(409).send({ error: 'A poster needs the venue location, so a copied code can’t be used from somewhere else. Set it under Event settings › Clock-in.' });
    const m = matrix(scanUrl(ev.id, codeFor(ev.qr_secret, ev.id, 'poster')));
    const doc = new PDFDocument({ size: 'LETTER', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    const done = new Promise<Buffer>((res) => doc.on('end', () => res(Buffer.concat(chunks))));
    const W = doc.page.width - 96;
    doc.font('Helvetica-Bold').fontSize(13).fillColor('#5A6B82').text('CLOCK IN HERE', 48, 56, { width: W, align: 'center', characterSpacing: 2 });
    doc.font('Helvetica-Bold').fontSize(34).fillColor('#16202E').text(ev.name, 48, doc.y + 8, { width: W, align: 'center' });
    if (ev.venue) doc.font('Helvetica').fontSize(15).fillColor('#5A6B82').text(ev.venue, 48, doc.y + 4, { width: W, align: 'center' });
    const side = 380, cell = side / (m.size + 4), x0 = (doc.page.width - side) / 2, y0 = doc.y + 24;
    doc.rect(x0, y0, side, side).fill('#fff');
    doc.fillColor('#000');
    for (let y = 0; y < m.size; y++) for (let x = 0; x < m.size; x++) if (m.on(x, y)) doc.rect(x0 + (x + 2) * cell, y0 + (y + 2) * cell, cell + 0.3, cell + 0.3).fill();
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#16202E').text('Open your phone camera, point it at the code, and tap the link.', 48, y0 + side + 24, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(13).fillColor('#5A6B82').text('Scan it again when you leave to clock out. Your phone will ask for your location to check you are at the venue.', 48, doc.y + 8, { width: W, align: 'center' });
    doc.font('Helvetica').fontSize(10).text(`${ev.company} · LaborOps`, 48, doc.page.height - 70, { width: W, align: 'center' });
    doc.end();
    return reply.header('content-type', 'application/pdf').header('content-disposition', `inline; filename="Clock-in poster.pdf"`).header('cache-control', 'no-store').send(await done);
  });

  // A crew member scanned the code.
  app.post('/api/time/qr', { preHandler: authenticate, config: limit }, async (req, reply) => {
    const b = z.object({ eventId: uuid, code: z.string().min(6).max(40), lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(), accuracy: z.number().min(0).max(100000).optional() }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const ev = await eventQr(c, b.eventId);
      if (!ev || !ev.qr_clock || !ev.qr_secret) return { code: 404, error: 'QR clock-in isn’t turned on for this event. Clock in from your shift instead.' };
      const w = windowNow();
      const live = [w, w - 1, w - 2].some((n) => same(codeFor(ev.qr_secret!, ev.id, String(n)), b.code));
      const poster = !live && same(codeFor(ev.qr_secret, ev.id, 'poster'), b.code);
      if (!live && !poster) return { code: 409, reason: 'old_code', error: 'That code has expired. Scan the code on the screen again.' };
      let distance: number | null = b.lat !== undefined && b.lng !== undefined && ev.geo_lat !== null && ev.geo_lng !== null ? Math.round(distanceM(b.lat, b.lng, ev.geo_lat, ev.geo_lng)) : null;
      if (poster) {
        // A printed code can be copied, so the phone has to be at the venue.
        if (ev.geo_lat === null || ev.geo_lng === null || !ev.geofence_m) return { code: 409, error: 'This poster can’t be used yet. Scan the code on the screen, or clock in from your shift.' };
        if (distance === null) return { code: 409, reason: 'need_location', error: 'Allow location access so we can check you’re at the venue, then scan again.' };
        if (distance - Math.min(b.accuracy ?? 0, 100) > ev.geofence_m) return { code: 409, reason: 'geofence', error: `You’re about ${distance >= 1000 ? (distance / 1000).toFixed(1) + ' km' : distance + ' m'} from ${ev.name}. Scan the poster at the venue.` };
      }
      const now = new Date();
      // Already clocked in on this event: this scan clocks out.
      const open = (
        await c.query(
          `SELECT t.id, t.clock_in, s.role_name, s.starts_at, s.ends_at FROM time_entries t JOIN shift_assignments a ON a.id = t.assignment_id JOIN shifts s ON s.id = a.shift_id
            WHERE t.user_id = $1 AND t.clock_out IS NULL AND s.event_id = $2`,
          [req.user.sub, ev.id],
        )
      ).rows[0];
      if (open) {
        // A second scan within two minutes of clocking in is the same scan (a double tap), not a clock-out.
        if (now.getTime() - new Date(open.clock_in).getTime() < 120_000) return { code: 200, action: 'in', already: true, at: open.clock_in, shift: { role: open.role_name, starts_at: open.starts_at, ends_at: open.ends_at }, event: ev.name };
        await c.query('UPDATE time_breaks SET ended_at = GREATEST(started_at, $2) WHERE user_id = $1 AND ended_at IS NULL', [req.user.sub, now]);
        const r = (await c.query(`UPDATE time_entries SET clock_out = $2, status = 'submitted', out_lat = $3, out_lng = $4, out_distance_m = $5, out_accuracy_m = $6 WHERE id = $1 RETURNING id, clock_in, clock_out`, [open.id, now, b.lat ?? null, b.lng ?? null, distance, b.accuracy === undefined ? null : Math.round(b.accuracy)])).rows[0];
        await audit(c, req.user.tid, req.user.sub, 'time.clock_out', 'time_entry', r.id, { qr: poster ? 'poster' : 'screen' });
        await autoApprove(c, r.id);
        return { code: 200, action: 'out', at: r.clock_out, since: r.clock_in, shift: { role: open.role_name, starts_at: open.starts_at, ends_at: open.ends_at }, event: ev.name };
      }
      if ((await c.query('SELECT 1 FROM time_entries WHERE user_id = $1 AND clock_out IS NULL', [req.user.sub])).rowCount)
        return { code: 409, error: 'You’re still clocked in on another shift. Clock out of that one first.' };
      const a = (
        await c.query(
          `SELECT a.id, s.role_name, s.starts_at, s.ends_at,
                  (SELECT u.name FROM shift_assignments l JOIN shifts ls ON ls.id = l.shift_id JOIN users u ON u.id = l.user_id
                    WHERE ls.event_id = s.event_id AND l.is_lead AND l.status = 'accepted' AND l.user_id <> a.user_id ORDER BY abs(extract(epoch FROM ls.starts_at - s.starts_at)) LIMIT 1) AS lead
             FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
            WHERE a.user_id = $1 AND a.status = 'accepted' AND s.event_id = $2
              AND now() BETWEEN s.starts_at - interval '1 hour' AND s.ends_at + interval '2 hours'
              AND NOT EXISTS (SELECT 1 FROM time_entries t WHERE t.assignment_id = a.id AND t.clock_out IS NOT NULL AND t.clock_out > s.ends_at - interval '15 minutes')
            ORDER BY s.starts_at LIMIT 1`,
          [req.user.sub, ev.id],
        )
      ).rows[0];
      if (!a) {
        const later = (await c.query(`SELECT s.starts_at FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE a.user_id = $1 AND a.status = 'accepted' AND s.event_id = $2 AND s.starts_at > now() ORDER BY s.starts_at LIMIT 1`, [req.user.sub, ev.id])).rows[0];
        return { code: 409, reason: 'no_shift', error: later ? 'Your shift here hasn’t opened for clock-in yet. It opens 1 hour before the start.' : `You’re not confirmed on a shift at ${ev.name} right now. Find the coordinator on site.`, opensAt: later?.starts_at ?? null };
      }
      const t = (await c.query(`INSERT INTO time_entries (tenant_id, assignment_id, user_id, in_lat, in_lng, in_distance_m, clock_in, in_accuracy_m) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, clock_in`, [req.user.tid, a.id, req.user.sub, b.lat ?? null, b.lng ?? null, distance, now, b.accuracy === undefined ? null : Math.round(b.accuracy)])).rows[0];
      await c.query('UPDATE time_breaks SET ended_at = $2 WHERE user_id = $1 AND ended_at IS NULL', [req.user.sub, now]);
      await audit(c, req.user.tid, req.user.sub, 'time.clock_in', 'time_entry', t.id, { qr: poster ? 'poster' : 'screen' });
      return { code: 201, action: 'in', at: t.clock_in, assignmentId: a.id, shift: { role: a.role_name, starts_at: a.starts_at, ends_at: a.ends_at, lead: a.lead }, event: ev.name };
    });
    const { code, ...rest } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(rest);
  });
}
