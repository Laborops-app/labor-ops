import PDFDocument from 'pdfkit';
import type { PoolClient } from 'pg';
import { eventReport } from './eventReport';

/**
 * Printable event documents made from what is already on the event:
 *  - Call sheet: one page (or more) per day with venue, site contact, first call, crew notes and every position's
 *    call time and people. For the crew.
 *  - Wrap report: scheduled against worked hours by role, overtime and attendance, with a signature line.
 *    For the customer; never shows pay.
 */
export type CallSheetOpts = { phaseId: string | null; phones: boolean; unconfirmed: boolean };
export type WrapOpts = { signature: boolean };

const INK = '#16202E', MUTED = '#5A6B82', RULE = '#D5DCE6', TINT = '#F1F4F8';
const M = 40;

const fmt = (tz: string) => ({
  time: (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(d),
  day: (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(d),
  short: (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric' }).format(d),
  stamp: (d: Date) => new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d),
  ymd: (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d),
});
const dateOnly = (v: unknown) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const noon = (ymd: string) => new Date(`${ymd}T12:00:00Z`);
const hrs = (n: number) => `${Math.round(n * 100) / 100} h`;

function finish(doc: PDFKit.PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (b: Buffer) => chunks.push(b));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}

/** A small label over a value (the "VENUE / SITE CONTACT / FIRST CALL" row). Returns the bottom y. */
function block(doc: PDFKit.PDFDocument, x: number, y: number, w: number, label: string, lines: (string | null | undefined)[], big = false) {
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: w, characterSpacing: 0.6 });
  let yy = doc.y + 2;
  const list = lines.filter(Boolean) as string[];
  list.forEach((l, i) => {
    doc.font(i === 0 ? 'Helvetica-Bold' : 'Helvetica').fontSize(i === 0 && big ? 15 : 9.5).fillColor(INK).text(l, x, yy, { width: w });
    yy = doc.y + 1;
  });
  if (!list.length) { doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text('Not set', x, yy, { width: w }); yy = doc.y; }
  return yy;
}

type Col = { label: string; w: number; align?: 'left' | 'right' };
function tableHead(doc: PDFKit.PDFDocument, cols: Col[], y: number) {
  let x = M;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
  for (const c of cols) { doc.text(c.label.toUpperCase(), x + 4, y, { width: c.w - 8, align: c.align ?? 'left', characterSpacing: 0.5 }); x += c.w; }
  const b = y + 12;
  doc.moveTo(M, b).lineTo(M + cols.reduce((n, c) => n + c.w, 0), b).lineWidth(0.8).strokeColor(INK).stroke();
  return b + 4;
}
function tableRow(doc: PDFKit.PDFDocument, cols: Col[], cells: { text: string; bold?: boolean; muted?: boolean }[], y: number) {
  const hgt = Math.max(...cells.map((c, i) => doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).heightOfString(c.text || ' ', { width: cols[i]!.w - 8 })));
  let x = M;
  cells.forEach((c, i) => {
    doc.font(c.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(c.muted ? MUTED : INK).text(c.text, x + 4, y, { width: cols[i]!.w - 8, align: cols[i]!.align ?? 'left' });
    x += cols[i]!.w;
  });
  const b = y + hgt + 4;
  doc.moveTo(M, b).lineTo(M + cols.reduce((n, c) => n + c.w, 0), b).lineWidth(0.5).strokeColor(RULE).stroke();
  return b + 4;
}
function footers(doc: PDFKit.PDFDocument, left: string) {
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0; // writing below the bottom margin would otherwise start a new page
    const y = doc.page.height - 30;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    doc.text(left, M, y, { width: 360, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, doc.page.width - M - 100, y, { width: 100, align: 'right', lineBreak: false });
  }
}

export async function callSheetPdf(c: PoolClient, eventId: string, o: CallSheetOpts): Promise<{ pdf: Buffer; name: string } | null> {
  const ev = (
    await c.query(
      `SELECT e.id, e.name, e.venue, e.address, e.notes, e.start_date, e.end_date, e.customer_id, t.name AS company, t.timezone
         FROM events e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1`,
      [eventId],
    )
  ).rows[0];
  if (!ev) return null;
  const tz: string = ev.timezone || 'UTC';
  const f = fmt(tz);
  const contact = ev.customer_id
    ? (await c.query('SELECT name, phone FROM customer_contacts WHERE customer_id = $1 ORDER BY is_primary DESC, created_at LIMIT 1', [ev.customer_id])).rows[0]
    : null;
  const phases = (await c.query('SELECT id, label, starts_on, ends_on FROM event_phases WHERE event_id = $1 ORDER BY starts_on, created_at', [eventId])).rows;
  const shifts = (
    await c.query(
      `SELECT s.id, s.role_name, s.starts_at, s.ends_at, s.headcount, s.phase_id, g.label AS group_label
         FROM shifts s LEFT JOIN phase_groups g ON g.id = s.group_id WHERE s.event_id = $1 ORDER BY s.starts_at, s.role_name`,
      [eventId],
    )
  ).rows;
  const people = (
    await c.query(
      `SELECT a.shift_id, a.status, a.is_lead, u.name, u.phone
         FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id JOIN users u ON u.id = a.user_id
        WHERE s.event_id = $1 AND a.status = 'accepted' ORDER BY a.is_lead DESC, u.name`,
      [eventId],
    )
  ).rows;
  const byShift = new Map<string, typeof people>();
  for (const p of people) byShift.set(p.shift_id, [...(byShift.get(p.shift_id) ?? []), p]);

  // One section per day: the chosen phase, every phase, or (no phases) each calendar day that has shifts.
  type Section = { label: string; date: string; of: string; shifts: typeof shifts };
  let sections: Section[];
  if (phases.length) {
    const list = o.phaseId ? phases.filter((p) => p.id === o.phaseId) : phases;
    sections = list.map((p) => ({
      label: p.label,
      date: dateOnly(p.starts_on) === dateOnly(p.ends_on) ? f.day(noon(dateOnly(p.starts_on))) : `${f.day(noon(dateOnly(p.starts_on)))} to ${f.day(noon(dateOnly(p.ends_on)))}`,
      of: `Day ${phases.indexOf(p) + 1} of ${phases.length}`,
      shifts: shifts.filter((s) => s.phase_id === p.id),
    }));
    const loose = shifts.filter((s) => !s.phase_id || !phases.some((p) => p.id === s.phase_id));
    if (!o.phaseId && loose.length) sections.push({ label: 'Other shifts', date: '', of: '', shifts: loose });
  } else {
    const days = [...new Set(shifts.map((s) => f.ymd(s.starts_at)))];
    sections = days.map((d, i) => ({ label: 'Call sheet', date: f.day(noon(d)), of: days.length > 1 ? `Day ${i + 1} of ${days.length}` : '', shifts: shifts.filter((s) => f.ymd(s.starts_at) === d) }));
  }
  if (!sections.length) sections = [{ label: 'Call sheet', date: f.day(noon(dateOnly(ev.start_date))), of: '', shifts: [] }];

  const doc = new PDFDocument({ size: 'LETTER', margin: M, bufferPages: true, info: { Title: `Call sheet - ${ev.name}` } });
  const W = doc.page.width - M * 2;
  const cols: Col[] = o.phones
    ? [{ label: 'Call', w: 70 }, { label: 'Role', w: 130 }, { label: 'Name', w: W - 310 }, { label: 'Phone', w: 110 }]
    : [{ label: 'Call', w: 80 }, { label: 'Role', w: 160 }, { label: 'Name', w: W - 240 }];
  sections.forEach((sec, si) => {
    if (si > 0) doc.addPage();
    const crew = sec.shifts.reduce((n, s) => n + (byShift.get(s.id)?.length ?? 0), 0);
    doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(`CALL SHEET${sec.label && sec.label !== 'Call sheet' ? ` · ${sec.label.toUpperCase()}` : ''}`, M, M, { characterSpacing: 1, width: W - 160 });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(ev.name, M, doc.y + 2, { width: W - 160 });
    if (sec.date) doc.font('Helvetica').fontSize(10).text(sec.date, M, doc.y + 1, { width: W - 160 });
    const leftBottom = doc.y;
    doc.font('Helvetica-Bold').fontSize(10).text(ev.company, M + W - 160, M, { width: 160, align: 'right' });
    doc.font('Helvetica').fontSize(9.5).text([sec.of, `${crew} crew confirmed`].filter(Boolean).join('\n'), M + W - 160, doc.y + 1, { width: 160, align: 'right' });
    let y = Math.max(leftBottom, doc.y) + 8;
    doc.moveTo(M, y).lineTo(M + W, y).lineWidth(2).strokeColor(INK).stroke();
    y += 10;
    const third = (W - 20) / 3;
    const first = sec.shifts[0];
    const b = Math.max(
      block(doc, M, y, third, 'Venue', [ev.venue, ev.address]),
      block(doc, M + third + 10, y, third, 'Site contact', contact ? [contact.name, contact.phone] : []),
      block(doc, M + (third + 10) * 2, y, third, 'First call', first ? [f.time(first.starts_at)] : [], true),
    );
    y = b + 10;
    if (ev.notes && String(ev.notes).trim()) {
      const text = `Notes for the crew: ${String(ev.notes).trim()}`;
      const h = doc.font('Helvetica').fontSize(9.5).heightOfString(text, { width: W - 16 }) + 12;
      doc.rect(M, y, W, h).fill(TINT);
      doc.fillColor(INK).text(text, M + 8, y + 6, { width: W - 16 });
      y += h + 10;
    }
    y = tableHead(doc, cols, y);
    if (!sec.shifts.length) doc.font('Helvetica').fontSize(9.5).fillColor(MUTED).text('No shifts on this day yet.', M + 4, y);
    for (const s of sec.shifts) {
      const list = byShift.get(s.id) ?? [];
      const rows: { name: string; phone: string; muted?: boolean }[] = list.map((p) => ({ name: `${p.name}${p.is_lead ? ' (lead)' : ''}`, phone: p.phone ?? '' }));
      const open = Math.max(0, Number(s.headcount) - list.length);
      if (open && o.unconfirmed) rows.push({ name: `${open} ${open === 1 ? 'spot' : 'spots'} to be confirmed`, phone: '', muted: true });
      if (!rows.length) rows.push({ name: 'To be confirmed', phone: '', muted: true });
      rows.forEach((r, i) => {
        if (y > doc.page.height - 70) { doc.addPage(); y = tableHead(doc, cols, M); }
        const cells = [
          { text: i === 0 ? f.time(s.starts_at) : '', bold: true },
          { text: i === 0 ? `${s.role_name}${s.group_label ? `\n${s.group_label}` : ''}` : '', bold: true },
          { text: r.name, muted: r.muted },
          ...(o.phones ? [{ text: r.phone }] : []),
        ];
        y = tableRow(doc, cols, cells, y);
      });
    }
  });
  footers(doc, `Made in LaborOps · updated ${f.stamp(new Date())}`);
  return { pdf: await finish(doc), name: `Call sheet - ${String(ev.name).replace(/[^\w .-]+/g, '').trim() || 'event'}.pdf` };
}

export async function wrapReportPdf(c: PoolClient, eventId: string, o: WrapOpts): Promise<{ pdf: Buffer; name: string } | null> {
  const r = await eventReport(c, eventId);
  if (!r) return null;
  const meta = (await c.query('SELECT t.name AS company, t.timezone FROM events e JOIN tenants t ON t.id = e.tenant_id WHERE e.id = $1', [eventId])).rows[0];
  const tz: string = meta?.timezone || 'UTC';
  const f = fmt(tz);
  // Per day and role: people, scheduled and worked hours.
  const rows = (
    await c.query(
      `SELECT COALESCE(p.label, to_char(s.starts_at AT TIME ZONE $2, 'Mon DD')) AS day, min(s.starts_at) AS first, s.role_name,
              count(*) FILTER (WHERE a.status = 'accepted')::int AS crew,
              COALESCE(sum(extract(epoch FROM s.ends_at - s.starts_at) / 3600) FILTER (WHERE a.status = 'accepted'), 0)::float AS scheduled,
              COALESCE(sum(extract(epoch FROM te.clock_out - te.clock_in) / 3600), 0)::float AS worked
         FROM shifts s LEFT JOIN event_phases p ON p.id = s.phase_id
         LEFT JOIN shift_assignments a ON a.shift_id = s.id
         LEFT JOIN LATERAL (SELECT min(clock_in) AS clock_in, max(clock_out) AS clock_out FROM time_entries t WHERE t.assignment_id = a.id AND t.clock_out IS NOT NULL) te ON true
        WHERE s.event_id = $1 GROUP BY 1, s.role_name ORDER BY min(s.starts_at), s.role_name`,
      [eventId, tz],
    )
  ).rows as { day: string; role_name: string; crew: number; scheduled: number; worked: number }[];
  const doc = new PDFDocument({ size: 'LETTER', margin: M, bufferPages: true, info: { Title: `Wrap report - ${r.event.name}` } });
  const W = doc.page.width - M * 2;
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(`WRAP REPORT${r.event.customer ? ` · FOR ${String(r.event.customer).toUpperCase()}` : ''}`, M, M, { characterSpacing: 1, width: W - 160 });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(r.event.name, M, doc.y + 2, { width: W - 160 });
  const span = r.event.start === r.event.end ? f.short(noon(r.event.start)) : `${f.short(noon(r.event.start))} to ${f.short(noon(r.event.end))}`;
  doc.font('Helvetica').fontSize(10).text(`${span}, ${r.event.start.slice(0, 4)} · ${r.staffing.slots} crew position${r.staffing.slots === 1 ? '' : 's'}${r.event.venue ? ` · ${r.event.venue}` : ''}`, M, doc.y + 1, { width: W - 160 });
  const lb = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).text(meta?.company ?? '', M + W - 160, M, { width: 160, align: 'right' });
  let y = Math.max(lb, doc.y) + 8;
  doc.moveTo(M, y).lineTo(M + W, y).lineWidth(2).strokeColor(INK).stroke();
  y += 12;
  // Headline tiles
  const worked = r.hours.worked, sched = r.hours.scheduled;
  const onTime = Math.max(0, r.staffing.accepted - r.staffing.late - r.staffing.noShows);
  const tiles: [string, string][] = [['Scheduled', hrs(sched)], ['Worked', hrs(worked)], ['On time', `${onTime} of ${r.staffing.accepted}`], ['No-shows', String(r.staffing.noShows)]];
  const tw = (W - 24) / 4;
  tiles.forEach(([k, v], i) => {
    const x = M + i * (tw + 8);
    doc.rect(x, y, tw, 44).fill(TINT);
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(k.toUpperCase(), x + 8, y + 8, { width: tw - 16, characterSpacing: 0.5 });
    doc.font('Helvetica-Bold').fontSize(15).fillColor(INK).text(v, x + 8, y + 20, { width: tw - 16 });
  });
  y += 58;
  const cols: Col[] = [{ label: 'Day', w: 130 }, { label: 'Role', w: W - 130 - 60 - 90 - 90 }, { label: 'Crew', w: 60, align: 'right' }, { label: 'Scheduled', w: 90, align: 'right' }, { label: 'Worked', w: 90, align: 'right' }];
  y = tableHead(doc, cols, y);
  let last = '';
  for (const x of rows) {
    if (y > doc.page.height - 120) { doc.addPage(); y = tableHead(doc, cols, M); }
    y = tableRow(doc, cols, [{ text: x.day === last ? '' : x.day, bold: true }, { text: x.role_name }, { text: String(x.crew) }, { text: hrs(x.scheduled) }, { text: x.worked ? hrs(x.worked) : '–', muted: !x.worked }], y);
    last = x.day;
  }
  y = tableRow(doc, cols, [{ text: 'Total', bold: true }, { text: '' }, { text: String(rows.reduce((n, x) => n + x.crew, 0)), bold: true }, { text: hrs(sched), bold: true }, { text: hrs(worked), bold: true }], y);
  y += 8;
  const notes = [
    `Overtime: ${hrs(r.hours.overtime)}${r.hours.double ? `, double time: ${hrs(r.hours.double)}` : ''}.`,
    r.staffing.late ? `${r.staffing.late} late arrival${r.staffing.late === 1 ? '' : 's'}.` : 'No late arrivals.',
    r.staffing.noShows ? `${r.staffing.noShows} no-show${r.staffing.noShows === 1 ? '' : 's'}.` : 'No no-shows.',
    r.hours.unapproved ? `${r.hours.unapproved} timesheet${r.hours.unapproved === 1 ? ' is' : 's are'} still waiting for approval, so worked hours may change.` : 'All timesheets are approved.',
  ];
  if (y > doc.page.height - 150) { doc.addPage(); y = M; }
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text('Attendance notes', M, y);
  doc.font('Helvetica').fontSize(9.5).text(notes.join(' '), M, doc.y + 2, { width: W });
  y = doc.y + 40;
  if (o.signature) {
    if (y > doc.page.height - 80) { doc.addPage(); y = M + 40; }
    const half = (W - 30) / 2;
    doc.moveTo(M, y).lineTo(M + half, y).lineWidth(0.8).strokeColor(INK).stroke();
    doc.moveTo(M + half + 30, y).lineTo(M + W, y).stroke();
    doc.font('Helvetica').fontSize(9).fillColor(INK).text('Approved by (customer)', M, y + 4, { width: half });
    doc.text('Date', M + half + 30, y + 4, { width: half });
  }
  footers(doc, `Made in LaborOps · ${f.stamp(new Date())}`);
  return { pdf: await finish(doc), name: `Wrap report - ${String(r.event.name).replace(/[^\w .-]+/g, '').trim() || 'event'}.pdf` };
}
