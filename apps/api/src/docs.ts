import PDFDocument from 'pdfkit';
import { PDFDocument as PdfLib, StandardFonts, rgb } from 'pdf-lib';
import type { PoolClient } from 'pg';
import { z } from 'zod';

/**
 * Documents and forms. A template is either an uploaded PDF with fields placed on its pages, or a form built in the
 * app. Filling one in produces a signed PDF: the uploaded PDF with the answers and signature stamped on, or a page
 * laid out from the form's questions. Every signed PDF ends with a record of who signed it, when and from where.
 */
const frac = z.number().min(0).max(1);
export const pdfField = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(['signature', 'date', 'name', 'text', 'checkbox']),
  page: z.number().int().min(0).max(500),
  /** Position and size as fractions of the page, from its top-left corner. */
  x: frac, y: frac, w: frac, h: frac,
  label: z.string().trim().max(80).default(''),
  required: z.boolean().default(true),
});
export const formField = z.object({
  id: z.string().min(1).max(40),
  type: z.enum(['checkbox', 'yesno', 'text', 'number', 'photo', 'person', 'signature']),
  label: z.string().trim().min(1, 'Every question needs a label').max(200),
  required: z.boolean().default(true),
});
export type PdfField = z.infer<typeof pdfField>;
export type FormField = z.infer<typeof formField>;
export const templateSettings = z.object({
  /** Onboarding: must be done; shift forms: must be done by whoever it is for. */
  required: z.boolean().default(true),
  /** Shift forms: who fills it in. */
  who: z.enum(['lead', 'everyone', 'coordinator']).default('lead'),
  when: z.enum(['clock_in', 'clock_out', 'any']).default('any'),
  /** Shift forms: which shifts it is on. */
  useOn: z.enum(['all', 'days', 'roles']).default('all'),
  dayContains: z.string().trim().max(60).default(''),
  roles: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  alertOnNo: z.boolean().default(true),
  blockClockIn: z.boolean().default(false),
});
export type TemplateSettings = z.infer<typeof templateSettings>;

const png = z.string().max(400_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
const photo = z.string().max(700_000).regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/);
export const answerValue = z.union([z.string().max(2000), z.boolean(), z.number(), z.null()]);
export const submitBody = z.object({
  answers: z.record(z.string().max(40), z.union([answerValue, photo, png])).default({}),
  signature: png.optional(),
  signedName: z.string().trim().min(1).max(120).optional(),
  consent: z.boolean().default(false),
  shiftId: z.string().uuid().optional(),
});
export type SubmitBody = z.infer<typeof submitBody>;
const dataUrlBytes = (u: string) => Buffer.from(u.slice(u.indexOf(',') + 1), 'base64');

export type Signer = { name: string; email: string; at: Date; ip: string | null; device: string | null; tz: string; company: string; recordId: string };
const stamp = (s: Signer) => new Intl.DateTimeFormat('en-US', { timeZone: s.tz, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(s.at);
const dateOnly = (s: Signer) => new Intl.DateTimeFormat('en-US', { timeZone: s.tz, month: 'short', day: 'numeric', year: 'numeric' }).format(s.at);
const deviceOf = (ua: string | null) => {
  if (!ua) return 'Unknown device';
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os}, ${br}`;
};
// Standard PDF fonts only cover Latin-1; anything else would make the PDF fail to build.
const latin = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, '?');

export async function pdfPageCount(data: Buffer): Promise<number> {
  const doc = await PdfLib.load(data, { ignoreEncryption: true });
  return doc.getPageCount();
}

/** What is missing before a submission can be accepted. */
export function missing(kind: 'pdf' | 'form', fields: (PdfField | FormField)[], b: SubmitBody): string | null {
  const needsSig = fields.some((f) => f.type === 'signature');
  if (needsSig && !b.signature) return 'Add your signature.';
  if (needsSig && !b.consent) return 'Tick the box to agree that this is your electronic signature.';
  for (const f of fields) {
    if (!f.required || f.type === 'signature' || f.type === 'date' || f.type === 'name') continue;
    const v = b.answers[f.id];
    const label = f.label || (f.type === 'checkbox' ? 'the checkbox' : 'every field');
    if (f.type === 'checkbox') { if (v !== true) return kind === 'form' ? `Tick "${label}".` : `Tick ${label}.`; continue; }
    if (v === undefined || v === null || v === '') return `Fill in "${label}".`;
  }
  return null;
}

/** Stamp the answers and signature onto the uploaded PDF, and add the signing record as a last page. */
export async function signPdf(original: Buffer, fields: PdfField[], b: SubmitBody, who: Signer, title: string): Promise<Buffer> {
  const doc = await PdfLib.load(original, { ignoreEncryption: true });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const sig = b.signature ? await doc.embedPng(dataUrlBytes(b.signature)) : null;
  const pages = doc.getPages();
  const ink = rgb(0.06, 0.1, 0.2);
  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;
    const { width, height } = page.getSize();
    const x = f.x * width, w = f.w * width, h = f.h * height, y = height - f.y * height - h;
    if (f.type === 'signature') {
      if (!sig) continue;
      const s = Math.min(w / sig.width, h / sig.height);
      page.drawImage(sig, { x, y: y + (h - sig.height * s) / 2, width: sig.width * s, height: sig.height * s });
      continue;
    }
    if (f.type === 'checkbox') {
      if (b.answers[f.id] === true) {
        const s = Math.min(w, h);
        page.drawLine({ start: { x: x + s * 0.15, y: y + s * 0.5 }, end: { x: x + s * 0.4, y: y + s * 0.2 }, thickness: Math.max(1.2, s * 0.12), color: ink });
        page.drawLine({ start: { x: x + s * 0.4, y: y + s * 0.2 }, end: { x: x + s * 0.88, y: y + s * 0.85 }, thickness: Math.max(1.2, s * 0.12), color: ink });
      }
      continue;
    }
    const text = latin(f.type === 'date' ? dateOnly(who) : f.type === 'name' ? (b.signedName ?? who.name) : String(b.answers[f.id] ?? ''));
    if (!text) continue;
    let size = Math.min(12, Math.max(6, h * 0.62));
    while (size > 6 && font.widthOfTextAtSize(text, size) > w - 4) size -= 0.5;
    page.drawText(text, { x: x + 2, y: y + (h - size) / 2 + size * 0.18, size, font, color: ink, maxWidth: w });
  }
  // Signing record
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const p = doc.addPage([612, 792]);
  let y = 730;
  p.drawText('Signing record', { x: 54, y, size: 18, font: bold, color: ink });
  y -= 26;
  p.drawText(latin(title), { x: 54, y, size: 11, font, color: ink });
  y -= 30;
  const rows: [string, string][] = [
    ['Signed by', b.signedName && b.signedName !== who.name ? `${b.signedName} (account: ${who.name})` : who.name],
    ['Email', who.email], ['Signed', stamp(who)], ['Device', who.device ?? 'Unknown device'], ['Network address', who.ip ?? 'Not recorded'],
    ['Company', who.company], ['Record', who.recordId],
  ];
  for (const [k, v] of rows) {
    p.drawText(k, { x: 54, y, size: 9, font: bold, color: rgb(0.35, 0.42, 0.51) });
    p.drawText(latin(v), { x: 170, y, size: 10, font, color: ink });
    y -= 20;
  }
  if (sig) {
    y -= 10;
    const s = Math.min(220 / sig.width, 70 / sig.height);
    p.drawImage(sig, { x: 54, y: y - sig.height * s, width: sig.width * s, height: sig.height * s });
    y -= sig.height * s + 16;
  }
  p.drawText('The signer agreed that this electronic signature has the same effect as signing on paper. Signed in LaborOps.', { x: 54, y, size: 8.5, font, color: rgb(0.35, 0.42, 0.51), maxWidth: 500 });
  return Buffer.from(await doc.save());
}

export type FormContext = { event: string | null; shift: string | null; when: string | null; people: Map<string, string> };

/** Lay a filled-in form out as a PDF. */
export function formPdf(title: string, fields: FormField[], b: SubmitBody, who: Signer, ctx: FormContext): Promise<Buffer> {
  const M = 44, INK = '#16202E', MUTED = '#5A6B82', RULE = '#D5DCE6';
  const doc = new PDFDocument({ size: 'LETTER', margin: M, bufferPages: true, info: { Title: title } });
  const chunks: Buffer[] = [];
  doc.on('data', (x: Buffer) => chunks.push(x));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });
  const W = doc.page.width - M * 2;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(latin(title).toUpperCase(), M, M, { characterSpacing: 1, width: W - 170 });
  doc.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(latin(ctx.event ?? title), M, doc.y + 2, { width: W - 170 });
  if (ctx.when) doc.font('Helvetica').fontSize(10).text(latin(ctx.when), M, doc.y + 1, { width: W - 170 });
  const lb = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).text(latin(who.company), M + W - 170, M, { width: 170, align: 'right' });
  if (ctx.shift) doc.font('Helvetica').fontSize(9.5).text(latin(ctx.shift), M + W - 170, doc.y + 1, { width: 170, align: 'right' });
  let y = Math.max(lb, doc.y) + 8;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(2).strokeColor(INK).stroke();
  y += 12;
  const photos: { label: string; data: string }[] = [];
  for (const f of fields) {
    if (f.type === 'signature') continue;
    const v = b.answers[f.id];
    let text: string;
    if (f.type === 'photo') { const has = typeof v === 'string' && v.startsWith('data:image'); if (has) photos.push({ label: f.label, data: v as string }); text = has ? 'Photo attached' : 'No photo'; }
    else if (f.type === 'checkbox') text = v === true ? 'Checked' : 'Not checked';
    else if (f.type === 'yesno') text = v === true || v === 'yes' ? 'Yes' : v === false || v === 'no' ? 'No' : 'Not answered';
    else if (f.type === 'person') text = (typeof v === 'string' && ctx.people.get(v)) || (typeof v === 'string' && v ? v : 'Not answered');
    else text = v === undefined || v === null || v === '' ? 'Not answered' : String(v);
    const lw = W * 0.58, aw = W - lw - 12;
    const h = Math.max(doc.font('Helvetica').fontSize(10).heightOfString(latin(f.label), { width: lw }), doc.font('Helvetica-Bold').fontSize(10).heightOfString(latin(text), { width: aw }));
    if (y + h > doc.page.height - 150) { doc.addPage(); y = M; }
    doc.font('Helvetica').fontSize(10).fillColor(INK).text(latin(f.label), M, y, { width: lw });
    doc.font('Helvetica-Bold').fontSize(10).fillColor(text === 'No' || text === 'Not checked' || text === 'Not answered' ? '#B42318' : INK).text(latin(text), M + lw + 12, y, { width: aw, align: 'right' });
    y += h + 6;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(0.5).strokeColor(RULE).stroke();
    y += 6;
  }
  for (const ph of photos) {
    if (y > doc.page.height - 300) { doc.addPage(); y = M; }
    doc.font('Helvetica-Bold').fontSize(9).fillColor(MUTED).text(latin(ph.label), M, y, { width: W });
    y = doc.y + 4;
    try { doc.image(dataUrlBytes(ph.data), M, y, { fit: [W, 220] }); y += 228; } catch { doc.font('Helvetica').fontSize(9).text('(The photo could not be added.)', M, y); y = doc.y + 6; }
  }
  if (y > doc.page.height - 140) { doc.addPage(); y = M; }
  y += 16;
  const half = (W - 30) / 2;
  if (b.signature) { try { doc.image(dataUrlBytes(b.signature), M, y, { fit: [half, 50] }); } catch { /* signature is in the record line below */ } }
  doc.font('Helvetica').fontSize(10).fillColor(INK).text(stamp(who), M + half + 30, y + 36, { width: half });
  y += 54;
  doc.moveTo(M, y).lineTo(M + half, y).lineWidth(0.8).strokeColor(INK).stroke();
  doc.moveTo(M + half + 30, y).lineTo(M + W, y).stroke();
  doc.font('Helvetica').fontSize(9).text(latin(b.signedName ?? who.name), M, y + 4, { width: half });
  doc.text('Signed', M + half + 30, y + 4, { width: half });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(latin(`Signed in LaborOps by ${who.name} (${who.email}) · record ${who.recordId} · ${who.device ?? 'Unknown device'}${who.ip ? ` · ${who.ip}` : ''}`), M, y + 24, { width: W });
  doc.end();
  return done;
}

export const signerOf = async (c: PoolClient, userId: string, req: { ip?: string; headers: Record<string, unknown> }, recordId: string): Promise<Signer> => {
  const u = (await c.query('SELECT u.name, u.email, t.name AS company, t.timezone FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1', [userId])).rows[0];
  const ua = typeof req.headers['user-agent'] === 'string' ? (req.headers['user-agent'] as string) : null;
  return { name: u.name, email: u.email, at: new Date(), ip: req.ip ?? null, device: deviceOf(ua), tz: u.timezone || 'UTC', company: u.company, recordId: recordId.slice(0, 8).toUpperCase() };
};

/** Shift forms that apply to one shift, by its day name and role. */
export function appliesTo(s: TemplateSettings, shift: { role_name: string; phase: string | null }): boolean {
  if (s.useOn === 'days') return !!s.dayContains && (shift.phase ?? '').toLowerCase().includes(s.dayContains.toLowerCase());
  if (s.useOn === 'roles') return s.roles.some((r) => r.trim().toLowerCase() === shift.role_name.trim().toLowerCase());
  return true;
}

/** Onboarding steps a person still has to do (required ones only). */
export async function onboardingLeft(c: PoolClient, userId: string): Promise<{ id: string; name: string }[]> {
  const on = (await c.query('SELECT onboarding_on FROM staffing_settings')).rows[0]?.onboarding_on;
  if (!on) return [];
  return (
    await c.query(
      `SELECT t.id, t.name FROM doc_templates t
        WHERE t.purpose = 'onboarding' AND t.active AND COALESCE((t.settings->>'required')::boolean, true)
          AND NOT EXISTS (SELECT 1 FROM doc_submissions s WHERE s.template_id = t.id AND s.user_id = $1)
        ORDER BY t.sort, t.created_at`,
      [userId],
    )
  ).rows;
}

/** Forms this person still has to fill in for one of their shifts. `when` narrows to those that gate a clock-in. */
export async function shiftFormsFor(c: PoolClient, userId: string, shiftId: string) {
  const on = (await c.query('SELECT forms_on FROM staffing_settings')).rows[0]?.forms_on;
  if (!on) return [];
  const shift = (
    await c.query(
      `SELECT s.id, s.role_name, s.event_id, p.label AS phase,
              (SELECT a.is_lead FROM shift_assignments a WHERE a.shift_id = s.id AND a.user_id = $2 AND a.status = 'accepted') AS is_lead,
              EXISTS (SELECT 1 FROM shift_assignments a WHERE a.shift_id = s.id AND a.is_lead AND a.status = 'accepted') AS has_lead
         FROM shifts s LEFT JOIN event_phases p ON p.id = s.phase_id WHERE s.id = $1`,
      [shiftId, userId],
    )
  ).rows[0];
  if (!shift || shift.is_lead === null) return [];
  const tpls = (await c.query("SELECT id, name, kind, settings FROM doc_templates WHERE purpose = 'shift' AND active ORDER BY sort, created_at")).rows;
  const out: { id: string; name: string; kind: string; settings: TemplateSettings; done: boolean; submissionId: string | null }[] = [];
  for (const t of tpls) {
    const s = templateSettings.parse(t.settings ?? {});
    if (!appliesTo(s, shift)) continue;
    // "The lead" means the lead when the shift has one, otherwise whoever is on it.
    if (s.who === 'coordinator' || (s.who === 'lead' && shift.has_lead && !shift.is_lead)) continue;
    // A lead's form is done once for the shift; an everyone form once per person.
    const sub = (await c.query(`SELECT id FROM doc_submissions WHERE template_id = $1 AND shift_id = $2 AND ($3::boolean OR user_id = $4) ORDER BY signed_at DESC LIMIT 1`, [t.id, shiftId, s.who === 'lead', userId])).rows[0];
    out.push({ id: t.id, name: t.name, kind: t.kind, settings: s, done: !!sub, submissionId: sub?.id ?? null });
  }
  return out;
}

/** The name of a form that must be filled in before this person can clock in on a shift, if any. */
export async function clockInBlock(c: PoolClient, userId: string, assignmentId: string): Promise<{ name: string; id: string; shiftId: string } | null> {
  const a = (await c.query('SELECT shift_id FROM shift_assignments WHERE id = $1', [assignmentId])).rows[0];
  if (!a) return null;
  const f = (await shiftFormsFor(c, userId, a.shift_id)).find((x) => !x.done && x.settings.blockClockIn && x.settings.when === 'clock_in');
  return f ? { name: f.name, id: f.id, shiftId: a.shift_id } : null;
}
