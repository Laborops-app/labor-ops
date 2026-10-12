import PDFDocument from 'pdfkit';
import { z } from 'zod';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const align = z.enum(['left', 'center', 'right']);
const str = (n: number) => z.string().max(n);

const blockBase = { id: z.string().max(40) };
export const blockSchema = z.discriminatedUnion('type', [
  z.object({ ...blockBase, type: z.literal('header'), showLogo: z.boolean(), logoAlign: align, logoHeight: z.number().min(20).max(160), companyName: str(120), lines: str(600), align }),
  z.object({ ...blockBase, type: z.literal('title'), label: str(60), showNumber: z.boolean(), showDates: z.boolean(), align }),
  z.object({ ...blockBase, type: z.literal('billto'), heading: str(60), showEvent: z.boolean() }),
  z.object({ ...blockBase, type: z.literal('text'), heading: str(100), body: str(4000), align }),
  z.object({ ...blockBase, type: z.literal('lines'), groupBySection: z.boolean(), showDate: z.boolean(), showPeople: z.boolean(), showHours: z.boolean(), showRate: z.boolean(), zebra: z.boolean() }),
  z.object({ ...blockBase, type: z.literal('totals') }),
  z.object({ ...blockBase, type: z.literal('terms'), heading: str(100) }),
  z.object({ ...blockBase, type: z.literal('signature'), heading: str(100), text: str(1000) }),
  z.object({ ...blockBase, type: z.literal('divider') }),
  z.object({ ...blockBase, type: z.literal('spacer'), height: z.number().min(4).max(200) }),
]);
export type Block = z.infer<typeof blockSchema>;

export const layoutSchema = z.object({
  page: z.enum(['letter', 'a4']),
  margin: z.number().min(24).max(90),
  font: z.enum(['Helvetica', 'Times', 'Courier']),
  fontSize: z.number().min(8).max(13),
  accent: color,
  textColor: color,
  logo: z.string().max(900_000).regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/).nullable(),
  footer: str(300),
  pageNumbers: z.boolean(),
  blocks: z.array(blockSchema).max(40),
});
export type Layout = z.infer<typeof layoutSchema>;

let n = 0;
const bid = () => `b${Date.now().toString(36)}${n++}`;
export const DEFAULT_LAYOUT: Layout = {
  page: 'letter', margin: 48, font: 'Helvetica', fontSize: 10, accent: '#1f4fd8', textColor: '#1b1f2a', logo: null, footer: '', pageNumbers: true,
  blocks: [
    { id: bid(), type: 'header', showLogo: true, logoAlign: 'left', logoHeight: 48, companyName: '{{company}}', lines: '', align: 'left' },
    { id: bid(), type: 'title', label: 'Quote', showNumber: true, showDates: true, align: 'left' },
    { id: bid(), type: 'billto', heading: 'Prepared for', showEvent: true },
    { id: bid(), type: 'text', heading: '', body: '{{intro}}', align: 'left' },
    { id: bid(), type: 'lines', groupBySection: true, showDate: true, showPeople: true, showHours: true, showRate: true, zebra: true },
    { id: bid(), type: 'totals' },
    { id: bid(), type: 'terms', heading: 'Terms' },
    { id: bid(), type: 'signature', heading: 'Acceptance', text: 'By signing below you accept this quote.' },
  ],
};

export type QuoteData = {
  company: string; number: number; title: string; status: string; customer: string | null; contact: string | null; event: string | null;
  createdAt: string; validUntil: string | null; intro: string | null; terms: string | null; taxPct: number;
  lines: { section: string | null; description: string; day: string | null; start: string | null; end: string | null; qty: number; hours: number; rate: number; amount: number }[];
  totals: { subtotal: number; discount: number; tax: number; total: number };
};

const money = (v: number) => '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDay = (d: string | null) => (d ? new Date(d.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }) : '');
const fmtT = (t: string | null) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
// The built-in PDF fonts only cover Latin-1; swap common punctuation and drop the rest rather than print garbage.
const MAP: Record<string, string> = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', ' ': ' ', '•': '*' };
const clean = (s: unknown) => String(s ?? '').replace(/[‘’“”–—… •]/g, (c) => MAP[c]).replace(/[^\n\x20-\x7e¡-ÿ]/g, '');

export function fillTokens(text: string, d: QuoteData): string {
  const t: Record<string, string> = {
    company: d.company, customer: d.customer ?? '', contact: d.contact ?? '', quote_number: String(d.number), quote_title: d.title, event: d.event ?? '',
    total: money(d.totals.total), valid_until: d.validUntil ?? '', date: new Date(d.createdAt).toLocaleDateString('en-US'), intro: d.intro ?? '',
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => t[k] ?? '');
}

export function renderQuotePdf(layout: Layout, d: QuoteData): Promise<Buffer> {
  const doc = new PDFDocument({ size: layout.page === 'a4' ? 'A4' : 'LETTER', margin: layout.margin, bufferPages: true, info: { Title: `Quote ${d.number} - ${clean(d.title)}`, Author: clean(d.company) } });
  const chunks: Buffer[] = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise<Buffer>((res, rej) => { doc.on('end', () => res(Buffer.concat(chunks))); doc.on('error', rej); });

  const reg = layout.font === 'Times' ? 'Times-Roman' : layout.font;
  const bold = layout.font === 'Times' ? 'Times-Bold' : `${layout.font}-Bold`;
  const fs = layout.fontSize;
  const L = layout.margin;
  const W = doc.page.width - layout.margin * 2;
  const bottom = () => doc.page.height - layout.margin - (layout.footer || layout.pageNumbers ? 18 : 0);
  const ensure = (h: number) => { if (doc.y + h > bottom()) doc.addPage(); };
  const txt = (s: string, o: PDFKit.Mixins.TextOptions & { x?: number; y?: number; font?: string; size?: number; color?: string } = {}) => {
    const { x, y, font, size, color: col, ...rest } = o;
    doc.font(font ?? reg).fontSize(size ?? fs).fillColor(col ?? layout.textColor);
    if (x !== undefined) doc.text(clean(s), x, y ?? doc.y, { width: W, ...rest });
    else doc.text(clean(s), L, doc.y, { width: W, ...rest });
  };
  const logo = layout.logo ? Buffer.from(layout.logo.split(',')[1], 'base64') : null;

  for (const b of layout.blocks) {
    switch (b.type) {
      case 'header': {
        const name = clean(fillTokens(b.companyName, d));
        let y = doc.y;
        if (b.showLogo && logo) {
          ensure(b.logoHeight + 8);
          y = doc.y;
          try {
            const img = (doc as any).openImage(logo) as { width: number; height: number };
            const sc = Math.min(1, 240 / img.width, b.logoHeight / img.height);
            const w = img.width * sc;
            doc.image(logo, b.logoAlign === 'left' ? L : b.logoAlign === 'center' ? L + (W - w) / 2 : L + W - w, y, { width: w });
          } catch { /* a logo that cannot be read is skipped */ }
          doc.y = y + b.logoHeight + 6;
        }
        if (name) txt(name, { font: bold, size: fs + 6, align: b.align, color: layout.accent });
        if (b.lines.trim()) txt(fillTokens(b.lines, d), { align: b.align, size: fs - 1, color: '#555555' });
        doc.moveDown(0.6);
        break;
      }
      case 'title': {
        ensure(60);
        txt(`${b.label}${b.showNumber ? ` #${d.number}` : ''}`, { font: bold, size: fs + 12, align: b.align, color: layout.accent });
        txt(d.title, { font: bold, size: fs + 2, align: b.align });
        if (b.showDates) txt(`Date: ${new Date(d.createdAt).toLocaleDateString('en-US')}${d.validUntil ? `    Valid until: ${d.validUntil}` : ''}`, { align: b.align, size: fs - 1, color: '#555555' });
        doc.moveDown(0.6);
        break;
      }
      case 'billto': {
        ensure(60);
        txt(b.heading || 'Prepared for', { font: bold, size: fs - 1, color: layout.accent });
        txt([d.customer, d.contact && d.contact !== d.customer ? `Attn: ${d.contact}` : '', b.showEvent && d.event ? `Event: ${d.event}` : ''].filter(Boolean).join('\n') || '-');
        doc.moveDown(0.6);
        break;
      }
      case 'text': {
        const body = fillTokens(b.body, d).trim();
        if (!body && !b.heading) break;
        ensure(40);
        if (b.heading) txt(b.heading, { font: bold, size: fs + 1, color: layout.accent, align: b.align });
        if (body) txt(body, { align: b.align });
        doc.moveDown(0.6);
        break;
      }
      case 'lines': {
        const cols: { key: string; label: string; w: number; right?: boolean }[] = [{ key: 'desc', label: 'Description', w: 0 }];
        if (b.showDate) cols.push({ key: 'when', label: 'Date / time', w: 118 });
        if (b.showPeople) cols.push({ key: 'qty', label: 'People', w: 44, right: true });
        if (b.showHours) cols.push({ key: 'hours', label: 'Hours', w: 42, right: true });
        if (b.showRate) cols.push({ key: 'rate', label: 'Rate', w: 56, right: true });
        cols.push({ key: 'amt', label: 'Amount', w: 66, right: true });
        cols[0].w = W - cols.slice(1).reduce((a, c) => a + c.w, 0);
        const pad = 4;
        const header = () => {
          ensure(40);
          const y = doc.y;
          doc.rect(L, y, W, fs + 8).fill(layout.accent);
          let x = L;
          for (const c of cols) { doc.font(bold).fontSize(fs - 1).fillColor('#ffffff').text(c.label, x + pad, y + 4, { width: c.w - pad * 2, align: c.right ? 'right' : 'left', lineBreak: false }); x += c.w; }
          doc.y = y + fs + 8;
        };
        const val = (c: { key: string }, l: QuoteData['lines'][number]) =>
          c.key === 'desc' ? l.description : c.key === 'when' ? [fmtDay(l.day), l.start && l.end ? `${fmtT(l.start)}-${fmtT(l.end)}` : ''].filter(Boolean).join('\n') : c.key === 'qty' ? String(l.qty) : c.key === 'hours' ? String(l.hours) : c.key === 'rate' ? money(l.rate) : money(l.amount);
        const groups: { name: string | null; rows: QuoteData['lines'] }[] = [];
        for (const l of d.lines) {
          const name = b.groupBySection ? l.section : null;
          const g = groups.find((x) => x.name === name);
          g ? g.rows.push(l) : groups.push({ name, rows: [l] });
        }
        header();
        let i = 0;
        for (const g of groups) {
          if (g.name) {
            ensure(fs + 40);
            doc.font(bold).fontSize(fs).fillColor(layout.accent).text(clean(g.name), L + pad, doc.y + 6, { width: W });
            doc.y += 2;
          }
          for (const l of g.rows) {
            doc.font(reg).fontSize(fs);
            const h = Math.max(...cols.map((c) => doc.heightOfString(clean(val(c, l)), { width: c.w - pad * 2 }))) + pad * 2;
            if (doc.y + h > bottom()) { doc.addPage(); header(); }
            const y = doc.y;
            if (b.zebra && i % 2 === 1) doc.rect(L, y, W, h).fill('#f3f5f9');
            let x = L;
            for (const c of cols) { doc.font(c.key === 'amt' ? bold : reg).fontSize(fs).fillColor(layout.textColor).text(clean(val(c, l)), x + pad, y + pad, { width: c.w - pad * 2, align: c.right ? 'right' : 'left' }); x += c.w; }
            doc.y = y + h;
            i++;
          }
        }
        doc.moveTo(L, doc.y).lineTo(L + W, doc.y).strokeColor('#cfd5df').lineWidth(0.5).stroke();
        doc.moveDown(0.6);
        break;
      }
      case 'totals': {
        ensure(80);
        const rows: [string, string, boolean?][] = [['Subtotal', money(d.totals.subtotal)]];
        if (d.totals.discount > 0) rows.push(['Discount', '-' + money(d.totals.discount)]);
        if (d.totals.tax > 0) rows.push([`Tax (${d.taxPct}%)`, money(d.totals.tax)]);
        rows.push(['Total', money(d.totals.total), true]);
        const bx = L + W - 220;
        for (const [k, v, strong] of rows) {
          const y = doc.y;
          doc.font(strong ? bold : reg).fontSize(strong ? fs + 3 : fs).fillColor(strong ? layout.accent : layout.textColor);
          doc.text(k, bx, y, { width: 110, lineBreak: false });
          doc.text(v, bx + 110, y, { width: 110, align: 'right' });
          doc.y = y + (strong ? fs + 8 : fs + 4);
        }
        doc.moveDown(0.8);
        break;
      }
      case 'terms': {
        if (!d.terms?.trim()) break;
        ensure(50);
        txt(b.heading || 'Terms', { font: bold, size: fs + 1, color: layout.accent });
        txt(d.terms, { size: fs - 1 });
        doc.moveDown(0.8);
        break;
      }
      case 'signature': {
        ensure(110);
        txt(b.heading || 'Acceptance', { font: bold, size: fs + 1, color: layout.accent });
        if (b.text) txt(fillTokens(b.text, d), { size: fs - 1 });
        doc.moveDown(2);
        const y = doc.y;
        doc.strokeColor('#555555').lineWidth(0.6);
        doc.moveTo(L, y).lineTo(L + W * 0.55, y).stroke();
        doc.moveTo(L + W * 0.65, y).lineTo(L + W, y).stroke();
        doc.font(reg).fontSize(fs - 2).fillColor('#555555');
        doc.text('Name / signature', L, y + 3, { width: W * 0.55, lineBreak: false });
        doc.text('Date', L + W * 0.65, y + 3, { width: W * 0.35, lineBreak: false });
        doc.y = y + 20;
        break;
      }
      case 'divider': {
        ensure(10);
        doc.moveTo(L, doc.y + 3).lineTo(L + W, doc.y + 3).strokeColor(layout.accent).lineWidth(1).stroke();
        doc.y += 10;
        break;
      }
      case 'spacer':
        doc.y += b.height;
        break;
    }
  }

  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    doc.page.margins.bottom = 0; // footer sits in the bottom margin; without this pdfkit would start a new page for it
    const y = doc.page.height - layout.margin + 4;
    doc.font(reg).fontSize(8).fillColor('#777777');
    if (layout.footer) doc.text(clean(fillTokens(layout.footer, d)), L, y, { width: W - 60, lineBreak: false, height: 10 });
    if (layout.pageNumbers) doc.text(`Page ${i + 1} of ${pages.count}`, L + W - 80, y, { width: 80, align: 'right', lineBreak: false });
  }
  doc.end();
  return done;
}
