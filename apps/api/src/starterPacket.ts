import PDFDocument from 'pdfkit';
import type { PdfField } from './docs';

/**
 * A generic onboarding packet: plain-language PDFs a company can use as they are, with the fields people fill in
 * and sign already placed. The wording is deliberately general (it names no law and promises nothing about pay rates
 * or benefits), so it suits both employees and contractors. A company that needs different wording uploads its own PDF.
 * Government forms (W-4, W-9, I-9) and bank details are left out on purpose: those come from the IRS/USCIS and the
 * payroll provider.
 */
type Built = { name: string; fileName: string; pdf: Buffer; pages: number; fields: PdfField[] };
type Item =
  | { h: string }                                  // section heading
  | { p: string }                                  // paragraph
  | { bullets: string[] }
  | { check: string; id: string }                  // a box the person ticks
  | { fields: { id: string; label: string; w?: number; required?: boolean }[] }  // a row of fill-in lines
  | { checks: { id: string; label: string }[]; label?: string }                  // optional tick boxes on one row
  | { area: { id: string; label: string; lines: number; required?: boolean } }   // a box for a few sentences
  | { signer: { id: string; label: string; required?: boolean; phone?: boolean } } // another person: name, (phone,) signature
  | { gap: number };
type Spec = { name: string; kicker: string; intro: string; items: Item[]; signLabel?: string; signTitle?: string };

const W = 612, H = 792, M = 54, CW = W - M * 2;
const INK = '#16202E', MUTED = '#5A6B82', RULE = '#9AA7B8';

function build(spec: Spec, company: string): Promise<Built> {
  const doc = new PDFDocument({ size: 'LETTER', margin: M, bufferPages: true, info: { Title: spec.name } });
  const chunks: Buffer[] = [];
  doc.on('data', (b: Buffer) => chunks.push(b));
  const fields: PdfField[] = [];
  let page = 0;
  let y = M;
  const fill = (s: string) => s.replace(/\{company\}/g, company);
  const room = (h: number) => { if (y + h > H - 70) { doc.addPage(); page++; y = M; } };
  const add = (f: Omit<PdfField, 'page' | 'x' | 'y' | 'w' | 'h'> & { x: number; y: number; w: number; h: number }) =>
    fields.push({ ...f, page, x: f.x / W, y: f.y / H, w: f.w / W, h: f.h / H });

  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED).text(spec.kicker.toUpperCase(), M, y, { characterSpacing: 1, width: CW - 180 });
  doc.font('Helvetica-Bold').fontSize(20).fillColor(INK).text(spec.name, M, doc.y + 2, { width: CW - 180 });
  const lb = doc.y;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK).text(company, M + CW - 180, M, { width: 180, align: 'right' });
  y = Math.max(lb, doc.y) + 8;
  doc.moveTo(M, y).lineTo(M + CW, y).lineWidth(2).strokeColor(INK).stroke();
  y += 14;
  doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(fill(spec.intro), M, y, { width: CW, lineGap: 2 });
  y = doc.y + 12;

  for (const it of spec.items) {
    if ('gap' in it) { y += it.gap; continue; }
    if ('h' in it) {
      room(40);
      y += 4;
      doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(fill(it.h), M, y, { width: CW });
      y = doc.y + 6;
    } else if ('p' in it) {
      const t = fill(it.p);
      room(doc.font('Helvetica').fontSize(10.5).heightOfString(t, { width: CW, lineGap: 2 }) + 8);
      doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(t, M, y, { width: CW, lineGap: 2 });
      y = doc.y + 8;
    } else if ('bullets' in it) {
      for (const b of it.bullets) {
        const t = fill(b);
        room(doc.font('Helvetica').fontSize(10.5).heightOfString(t, { width: CW - 16, lineGap: 2 }) + 5);
        doc.circle(M + 4, y + 5.5, 1.6).fill(INK);
        doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(t, M + 16, y, { width: CW - 16, lineGap: 2 });
        y = doc.y + 5;
      }
      y += 4;
    } else if ('check' in it) {
      const t = fill(it.check);
      const h = doc.font('Helvetica').fontSize(10.5).heightOfString(t, { width: CW - 26, lineGap: 2 });
      room(h + 10);
      doc.rect(M, y, 13, 13).lineWidth(1).strokeColor(INK).stroke();
      add({ id: it.id, type: 'checkbox', x: M, y, w: 13, h: 13, label: t.length > 78 ? t.slice(0, 75) + '...' : t, required: true });
      doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(t, M + 26, y + 1, { width: CW - 26, lineGap: 2 });
      y = Math.max(doc.y, y + 13) + 9;
    } else if ('checks' in it) {
      room(40);
      if (it.label) { doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(it.label.toUpperCase(), M, y, { width: CW, characterSpacing: 0.5 }); y += 13; }
      let x = M;
      for (const k of it.checks) {
        const tw = doc.font('Helvetica').fontSize(10.5).widthOfString(k.label);
        if (x + 20 + tw > M + CW) { x = M; y += 20; }
        doc.rect(x, y, 12, 12).lineWidth(1).strokeColor(INK).stroke();
        add({ id: k.id, type: 'checkbox', x, y, w: 12, h: 12, label: k.label, required: false });
        doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(k.label, x + 18, y + 1, { lineBreak: false });
        x += 18 + tw + 22;
      }
      y += 24;
    } else if ('area' in it) {
      const h = it.area.lines * 14 + 8;
      room(h + 22);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(it.area.label.toUpperCase(), M, y, { width: CW, characterSpacing: 0.5, lineBreak: false });
      doc.rect(M, y + 12, CW, h).lineWidth(0.8).strokeColor(RULE).stroke();
      add({ id: it.area.id, type: 'text', x: M + 1, y: y + 13, w: CW - 2, h: h - 2, label: it.area.label, required: it.area.required ?? true });
      y += h + 22;
    } else if ('signer' in it) {
      room(64);
      const g = it.signer;
      const nw = CW * (g.phone ? 0.3 : 0.4), pw = g.phone ? CW * 0.2 : 0, sw = CW - nw - pw - (g.phone ? 32 : 16);
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
      doc.text(`${g.label} name`.toUpperCase(), M, y, { width: nw, characterSpacing: 0.5, lineBreak: false });
      if (g.phone) doc.text('PHONE', M + nw + 16, y, { width: pw, characterSpacing: 0.5, lineBreak: false });
      const sx = M + nw + 16 + (g.phone ? pw + 16 : 0);
      doc.text(`${g.label} signature`.toUpperCase(), sx, y, { width: sw, characterSpacing: 0.5, lineBreak: false });
      add({ id: `${g.id}_name`, type: 'text', x: M, y: y + 22, w: nw, h: 17, label: `${g.label} name`, required: g.required ?? false });
      if (g.phone) add({ id: `${g.id}_phone`, type: 'text', x: M + nw + 16, y: y + 22, w: pw, h: 17, label: `${g.label} phone`, required: false });
      add({ id: `${g.id}_sig`, type: 'sign_other', x: sx, y: y + 10, w: sw, h: 30, label: `${g.label} signature`, required: g.required ?? false });
      doc.moveTo(M, y + 40).lineTo(M + nw, y + 40).lineWidth(0.8).strokeColor(RULE).stroke();
      if (g.phone) doc.moveTo(M + nw + 16, y + 40).lineTo(M + nw + 16 + pw, y + 40).stroke();
      doc.moveTo(sx, y + 40).lineTo(sx + sw, y + 40).stroke();
      y += 52;
    } else if ('fields' in it) {
      room(44);
      const gap = 16;
      const total = it.fields.reduce((n, f) => n + (f.w ?? 1), 0);
      const unit = (CW - gap * (it.fields.length - 1)) / total;
      let x = M;
      for (const f of it.fields) {
        const w = unit * (f.w ?? 1);
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(f.label.toUpperCase(), x, y, { width: w, characterSpacing: 0.5, lineBreak: false });
        doc.moveTo(x, y + 30).lineTo(x + w, y + 30).lineWidth(0.8).strokeColor(RULE).stroke();
        add({ id: f.id, type: 'text', x, y: y + 12, w, h: 17, label: f.label, required: f.required ?? true });
        x += w + gap;
      }
      y += 42;
    }
  }

  // Signature block: printed name, signature and date.
  room(120);
  y += 10;
  if (spec.signTitle) { doc.font('Helvetica-Bold').fontSize(12).fillColor(INK).text(spec.signTitle, M, y, { width: CW }); y = doc.y + 6; }
  doc.font('Helvetica').fontSize(10.5).fillColor(INK).text(fill(spec.signLabel ?? 'By signing, I confirm that I have read this document and that what I entered is true and complete.'), M, y, { width: CW, lineGap: 2 });
  y = doc.y + 14;
  const sw = CW * 0.46, nw = CW * 0.3, dw = CW - sw - nw - 32;
  add({ id: 'signature', type: 'signature', x: M, y, w: sw, h: 40, label: 'Signature', required: true });
  add({ id: 'signer', type: 'name', x: M + sw + 16, y: y + 22, w: nw, h: 17, label: 'Signer’s name', required: true });
  add({ id: 'signed', type: 'date', x: M + sw + nw + 32, y: y + 22, w: dw, h: 17, label: 'Date signed', required: true });
  y += 42;
  doc.moveTo(M, y).lineTo(M + sw, y).lineWidth(0.8).strokeColor(INK).stroke();
  doc.moveTo(M + sw + 16, y).lineTo(M + sw + 16 + nw, y).stroke();
  doc.moveTo(M + sw + nw + 32, y).lineTo(M + CW, y).stroke();
  doc.font('Helvetica').fontSize(8.5).fillColor(MUTED);
  doc.text('Signature', M, y + 4, { width: sw, lineBreak: false });
  doc.text('Printed name', M + sw + 16, y + 4, { width: nw, lineBreak: false });
  doc.text('Date', M + sw + nw + 32, y + 4, { width: dw, lineBreak: false });

  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    doc.text(`${company} - ${spec.name}`, M, H - 34, { width: CW - 100, lineBreak: false });
    doc.text(`Page ${i + 1} of ${range.count}`, W - M - 100, H - 34, { width: 100, align: 'right', lineBreak: false });
  }
  return new Promise((resolve, reject) => {
    doc.on('end', () => resolve({ name: spec.name, fileName: `${spec.name}.pdf`, pdf: Buffer.concat(chunks), pages: range.count, fields }));
    doc.on('error', reject);
    doc.end();
  });
}

const SPECS: Spec[] = [
  {
    name: 'Your details and emergency contact',
    kicker: 'Onboarding · step 1',
    intro: 'Welcome to {company}. We use these details to reach you about work and to know who to call if something happens on site. Tell your coordinator whenever any of this changes.',
    items: [
      { h: 'About you' },
      { fields: [{ id: 'legal_name', label: 'Full legal name', w: 2 }, { id: 'preferred_name', label: 'Name you go by', required: false }] },
      { fields: [{ id: 'address', label: 'Street address', w: 2 }, { id: 'unit', label: 'Apt / unit', w: 0.6, required: false }] },
      { fields: [{ id: 'city', label: 'City', w: 1.4 }, { id: 'state', label: 'State', w: 0.5 }, { id: 'zip', label: 'ZIP code', w: 0.7 }] },
      { fields: [{ id: 'mobile', label: 'Mobile phone' }, { id: 'email', label: 'Email' }] },
      { h: 'Emergency contact' },
      { fields: [{ id: 'ec_name', label: 'Contact’s name', w: 1.4 }, { id: 'ec_relationship', label: 'Relationship' }] },
      { fields: [{ id: 'ec_phone', label: 'Contact’s phone' }, { id: 'ec_phone2', label: 'Second phone', required: false }] },
      { h: 'Good to know (optional)' },
      { fields: [{ id: 'shirt', label: 'Shirt size', w: 0.5, required: false }, { id: 'languages', label: 'Languages you speak', required: false }, { id: 'transport', label: 'How you usually get to work', required: false }] },
      { fields: [{ id: 'notes', label: 'Anything we should know to keep you safe at work', required: false }] },
    ],
    signLabel: 'By signing, I confirm that the details above are correct and that {company} may contact the person I listed in an emergency.',
  },
  {
    name: 'Workplace policies',
    kicker: 'Onboarding · step 2',
    intro: 'These are the basics of working with {company}. Read each section and tick the box beside it. Ask your coordinator about anything that is unclear before you sign.',
    items: [
      { h: 'Showing up' },
      { bullets: ['Accept or decline every offer promptly so the crew can be finalized.', 'Arrive ready to work at your call time, in the dress and footwear named for the job.', 'If you are sick or running late, tell your coordinator as early as you can. Not showing up without notice may mean you are not booked again.'] },
      { check: 'I understand what is expected when I accept a shift.', id: 'ack_attendance' },
      { h: 'Respect at work' },
      { bullets: ['{company} does not tolerate harassment, discrimination, threats or bullying by or toward anyone: crew, staff, customers, venue staff or the public.', 'Report a concern to your lead, your coordinator or company management. Nobody is punished for raising a concern in good faith.'] },
      { check: 'I will treat everyone on site with respect and report problems I see.', id: 'ack_respect' },
      { h: 'Fit for work' },
      { bullets: ['Do not work under the influence of alcohol or drugs, or while taking anything that makes the work unsafe.', 'Tell your lead if you are too tired, hurt or unwell to work safely.'] },
      { check: 'I will only work when I am fit to do so safely.', id: 'ack_fit' },
      { h: 'Customers, venues and what you see there' },
      { bullets: ['Follow the venue’s and the customer’s rules, including badge, parking and backstage rules.', 'What you see or hear on a job (guest lists, show content, schedules, prices) stays private.', 'Do not take or post photos or video from a job unless your lead says it is allowed.'] },
      { check: 'I will keep customer and venue information private and follow their rules.', id: 'ack_private' },
      { h: 'Phones, property and conduct' },
      { bullets: ['Keep personal phone use to breaks unless the job needs it.', 'Look after tools and equipment, and return anything issued to you.', 'Theft, fighting, or bringing a weapon to a job site ends your work with {company}.'] },
      { check: 'I have read these policies and agree to follow them.', id: 'ack_conduct' },
    ],
    signLabel: 'By signing, I confirm that I have read and understood these policies. I understand they may be updated and that I will be told when they are.',
  },
  {
    name: 'Safety on site',
    kicker: 'Onboarding · step 3',
    intro: 'Event work includes lifting, moving heavy cases, working around vehicles and forklifts, and sometimes working at height. Everyone goes home safe when everyone follows the same rules.',
    items: [
      { h: 'Before the work starts' },
      { bullets: ['Wear the protective gear named for the job. Closed-toe work boots are the minimum on every load-in and load-out.', 'Listen to the safety talk and ask questions. If you were not shown how to do something, say so.', 'Only operate forklifts, lifts, rigging or power tools if you are trained and your certificate is on file.'] },
      { check: 'I will wear the required protective gear and only do work I am trained for.', id: 'ack_ppe' },
      { h: 'During the work' },
      { bullets: ['Lift with a partner when a load is heavy or awkward, and use carts, ramps and lift gates.', 'Keep clear of moving vehicles, suspended loads and marked-off areas.', 'Stop and tell your lead if something looks unsafe. You will never be in trouble for stopping unsafe work.', 'Take your breaks and drink water, especially outdoors and in heat.'] },
      { check: 'I will stop and speak up when something is unsafe.', id: 'ack_stop' },
      { h: 'If something goes wrong' },
      { bullets: ['Report every injury, near miss or damage to your lead the same day, even if it seems minor.', 'In an emergency call 911 first, then tell your lead and your coordinator.'] },
      { check: 'I will report any injury, near miss or damage on the day it happens.', id: 'ack_report' },
      { h: 'Your certificates (optional)' },
      { fields: [{ id: 'certs', label: 'Certificates you hold (forklift, lift, rigging, first aid, OSHA)', required: false }] },
    ],
    signLabel: 'By signing, I confirm that I have read and understood these safety rules and agree to follow them on every job.',
  },
  {
    name: 'Time, breaks and pay',
    kicker: 'Onboarding · step 4',
    intro: 'This explains how your time is recorded and how you are paid by {company}. Your rate for each shift is shown on the offer before you accept it.',
    items: [
      { h: 'Recording your time' },
      { bullets: ['Clock in when you start work and clock out when you finish, in the LaborOps app or with the lead or coordinator on site.', 'Record only your own time. Clocking in or out for someone else is not allowed.', 'If a punch is wrong or missing, tell your coordinator within two days so it can be fixed before payroll.'] },
      { check: 'I will record my own time accurately.', id: 'ack_time' },
      { h: 'Breaks' },
      { bullets: ['Take the meal and rest breaks you are given. Tell your lead if you did not get one.', 'Do not work off the clock, before or after your shift or during an unpaid meal break.'] },
      { check: 'I will take my breaks and will not work off the clock.', id: 'ack_breaks' },
      { h: 'Pay' },
      { bullets: ['You are paid for the time you work at the rate shown on the shift you accepted, on the regular pay schedule.', 'Overtime, minimum calls and other premiums are paid as the law and the job’s terms require.', 'Check each pay statement and raise any question with your coordinator right away.'] },
      { check: 'I understand how my time is recorded and how I am paid.', id: 'ack_pay' },
    ],
    signLabel: 'By signing, I confirm that I have read and understood how time, breaks and pay work at {company}.',
  },
  {
    name: 'Messages and use of your details',
    kicker: 'Onboarding · step 5',
    intro: '{company} uses the LaborOps app, email and text messages to offer you work and tell you about changes. This step records what you agree to.',
    items: [
      { h: 'Work messages' },
      { p: 'Offers, schedule changes, reminders and call sheets are sent in the app and by email, and by text message when it is urgent. Message and data rates may apply. You can change how you are notified in your profile at any time.' },
      { check: 'I agree to receive work messages from {company} by app notification, email and text.', id: 'ack_messages' },
      { h: 'Your details' },
      { p: 'Your name and phone number may be shared with the leads and crew you work with, and on call sheets, so the team can reach each other on the job. Customers see your name and role, never your pay or contact details.' },
      { check: 'I agree that my name and phone number can appear on call sheets for jobs I work.', id: 'ack_callsheet' },
      { h: 'Electronic signatures' },
      { p: 'Documents you sign in LaborOps are signed electronically. An electronic signature has the same effect as one written on paper. You can ask your coordinator for a copy of anything you sign, and you can open your signed copies in the app at any time.' },
      { check: 'I agree to sign documents electronically.', id: 'ack_esign' },
    ],
    signLabel: 'By signing, I confirm the choices I ticked above.',
  },
];

export const STARTER_NAMES = SPECS.map((s) => s.name);
export const starterPacket = (company: string): Promise<Built[]> => Promise.all(SPECS.map((s) => build(s, company)));

const INCIDENT: Spec = {
  name: 'Incident report',
  kicker: 'Fill in the same day',
  intro: 'Use this for any injury, near miss, damage or other incident on a job for {company}. Write what you saw and did, in your own words. If someone needs urgent help, call 911 first and fill this in afterwards.',
  items: [
    { h: 'When and where' },
    { fields: [{ id: 'inc_date', label: 'Date of incident' }, { id: 'inc_time', label: 'Time' }, { id: 'inc_event', label: 'Event or job', w: 1.6 }] },
    { fields: [{ id: 'inc_place', label: 'Exact place (venue, dock, stage, truck)', w: 2 }, { id: 'reporter_role', label: 'Your position that day' }] },
    { h: 'What happened' },
    { checks: [{ id: 't_injury', label: 'Injury' }, { id: 't_near', label: 'Near miss' }, { id: 't_damage', label: 'Property or equipment damage' }, { id: 't_vehicle', label: 'Vehicle' }, { id: 't_other', label: 'Other' }], label: 'Type of incident (tick all that apply)' },
    { area: { id: 'what', label: 'Describe what happened, in order', lines: 6 } },
    { area: { id: 'cause', label: 'What do you think caused it?', lines: 2, required: false } },
    { h: 'People hurt (leave blank if nobody was)' },
    { fields: [{ id: 'hurt_name', label: 'Name of the person hurt', w: 1.4, required: false }, { id: 'hurt_employer', label: 'Works for', required: false }, { id: 'hurt_phone', label: 'Phone', required: false }] },
    { fields: [{ id: 'hurt_what', label: 'Injury and part of the body', required: false }] },
    { checks: [{ id: 'c_none', label: 'No treatment' }, { id: 'c_firstaid', label: 'First aid on site' }, { id: 'c_clinic', label: 'Clinic or doctor' }, { id: 'c_er', label: 'Emergency room' }, { id: 'c_911', label: '911 called' }], label: 'Care given' },
    { fields: [{ id: 'care_by', label: 'Who gave first aid, and where they were taken', required: false }] },
    { h: 'Damage (leave blank if there was none)' },
    { area: { id: 'damage', label: 'What was damaged, and who owns it', lines: 2, required: false } },
    { h: 'What was done about it' },
    { area: { id: 'action', label: 'Steps taken right away (area closed off, equipment tagged out, cleaned up)', lines: 2, required: false } },
    { fields: [{ id: 'told_who', label: 'Lead or supervisor told', w: 1.4 }, { id: 'told_when', label: 'Time they were told' }, { id: 'photos', label: 'Photos taken? Who has them', w: 1.4, required: false }] },
    { h: 'Witnesses' },
    { p: 'Anyone who saw it. Each witness writes their name and signs here, on this device. A witness signs only to say they saw the incident, not that they agree with every word above.' },
    { signer: { id: 'w1', label: 'Witness 1', phone: true } },
    { signer: { id: 'w2', label: 'Witness 2', phone: true } },
    { area: { id: 'w_notes', label: 'Anything a witness wants to add', lines: 2, required: false } },
    { h: 'Lead or supervisor' },
    { signer: { id: 'sup', label: 'Lead or supervisor' } },
  ],
  signTitle: 'Person making this report',
  signLabel: 'By signing, I confirm that this report is true and complete to the best of my knowledge.',
};
export const incidentReport = (company: string): Promise<Built> => build(INCIDENT, company);
