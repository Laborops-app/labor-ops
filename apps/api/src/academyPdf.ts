import PDFDocument from 'pdfkit';
import path from 'node:path';

export type AcademyCertPdf = {
  studentName: string;
  title: string;
  kind: 'course' | 'group';
  issuedAt: Date;
  code: string;
  verifyUrl?: string | null;
};

// Same colors and proportions as the printable certificate on the academy site (11 x 8.5 in, drawn in CSS pixels).
const INK = '#181926';
const RED = '#E61E26';
const MUTED = '#5B6376';
const LINE = '#DCE0E6';
const FONTS = path.resolve(__dirname, '../assets/fonts');
const F = { head: 'Archivo-ExtraBold', sub: 'Archivo-Bold', body: 'Barlow', italic: 'Times-Italic' };

/** The Upstage mark (red A with an arrow, on a truss), drawn from its SVG paths. */
function drawMark(doc: PDFKit.PDFDocument, x: number, y: number, size: number) {
  const k = size / 124;
  doc.save();
  doc.translate(x, y).scale(k);
  doc.save();
  doc.translate(18, 0).transform(1, 0, Math.tan((-10 * Math.PI) / 180), 1, 0, 0); // skewX(-10)
  doc.path('M46 8H74L104 92H80L75 76H45L40 92H16Z M60 26L71 70H49Z').fill('#E61E26', 'evenodd');
  doc.path('M60 34L69 54H63V66H57V54H51Z').fill('#FFFFFF');
  doc.restore();
  doc.lineJoin('round').lineWidth(2.4).strokeColor('#9AA1AE');
  doc.path('M4 102H120M4 118H120').stroke();
  doc.path('M4 118L16 102L28 118L40 102L52 118L64 102L76 118L88 102L100 118L112 102L120 110').stroke();
  doc.restore();
}

/** A one-page landscape certificate that matches the academy's printable certificate. */
export function academyCertificatePdf(c: AcademyCertPdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 0, info: { Title: `Certificate - ${c.studentName}`, Author: 'Upstage Academy' } });
    const chunks: Buffer[] = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont(F.head, path.join(FONTS, 'Archivo-ExtraBold.ttf'));
    doc.registerFont(F.sub, path.join(FONTS, 'Archivo-Bold.ttf'));
    doc.registerFont(F.body, path.join(FONTS, 'Barlow-Regular.ttf'));

    // Draw in CSS pixels: 1056 x 816 px is 11 x 8.5 in.
    const W = 1056;
    const H = 816;
    (doc.page as any).maxY = () => 1e9; // we draw in scaled units, so never let the text flow onto a new page
    doc.scale(0.75);
    doc.rect(0, 0, W, H).fill('#ffffff');
    doc.lineWidth(10).strokeColor(INK).rect(5, 5, W - 10, H - 10).stroke();
    doc.lineWidth(3).strokeColor(RED).rect(20.5, 20.5, W - 41, H - 41).stroke();

    const text = (t: string, y: number, size: number, font: string, color: string, o: { w?: number; spacing?: number; x?: number } = {}) => {
      const w = o.w ?? W - 144;
      doc.font(font).fontSize(size).fillColor(color).text(t, o.x ?? (W - w) / 2, y, { width: w, align: 'center', characterSpacing: o.spacing ?? 0, lineBreak: true });
    };

    // Lay the block out relative to its top, then center it vertically like the printed page does.
    const date = c.issuedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Denver' });
    const verify = (c.verifyUrl ?? '').replace(/^https?:\/\//, '') || 'academy.upstagecompanies.com';
    const BLOCK = 64 + 10 + 34 + 6 + 3 + 12 + 51 + 16 + 26 + 8 + 56 + 6 + 14 + 26 + 6 + 40 + 40 + 62 + 18;
    let y = Math.round((H - BLOCK) / 2);
    drawMark(doc, W / 2 - 32, y, 64);
    y += 64 + 10;
    text('UPSTAGE ACADEMY', y, 28, F.head, INK, { spacing: 28 * 0.14 });
    y += 34 + 6;
    doc.rect(W / 2 - 32, y, 64, 3).fill(RED);
    y += 3 + 12;
    text('CERTIFICATE OF COMPLETION', y, 46, F.head, INK, { spacing: -0.46 });
    y += 51 + 16;
    text('This certifies that', y, 18, F.body, MUTED);
    y += 26 + 8;
    text(c.studentName, y, 48, F.italic, INK, { w: W - 200 });
    y += 56 + 6;
    doc.lineWidth(1).strokeColor(LINE).moveTo(W / 2 - 230, y).lineTo(W / 2 + 230, y).stroke();
    y += 14;
    text(c.kind === 'group' ? 'has successfully completed all courses in' : 'has successfully completed the course', y, 18, F.body, MUTED);
    y += 26 + 6;
    text(c.title, y, 28, F.sub, RED, { w: W - 200 });
    y += 40 + 40;

    // Two equal columns inside the 72px side padding, like the printed page.
    const colW = 444;
    const left = 72 + colW / 2;
    const right = 72 + colW + 24 + colW / 2;
    const label = (t: string, cx: number) => text(t, y, 12, F.body, MUTED, { w: colW, x: cx - colW / 2, spacing: 12 * 0.12 });
    const value = (t: string, cx: number) => text(t, y + 20, 16, F.body, INK, { w: colW, x: cx - colW / 2 });
    label('DATE', left);
    value(date, left);
    label('CERTIFICATE ID', right);
    value(c.code, right);
    y += 62;
    text(`Upstage Companies, Salt Lake City, UT  ·  ${verify}`, y, 13, F.body, MUTED);
    doc.end();
  });
}
