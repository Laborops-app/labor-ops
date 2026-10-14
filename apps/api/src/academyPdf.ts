import PDFDocument from 'pdfkit';

export type AcademyCertPdf = {
  studentName: string;
  title: string;
  kind: 'course' | 'group';
  issuedAt: Date;
  code: string;
  verifyUrl?: string | null;
};

const INK = '#181926';
const NAVY = '#274156';
const RED = '#E61E26';
const MUTED = '#5B6376';

/** A one-page landscape certificate that matches the academy's printable certificate. */
export function academyCertificatePdf(c: AcademyCertPdf): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 0, info: { Title: `Certificate - ${c.studentName}`, Author: 'Upstage Academy' } });
    const chunks: Buffer[] = [];
    doc.on('data', (d) => chunks.push(d));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W = doc.page.width;
    const H = doc.page.height;
    doc.rect(0, 0, W, H).fill('#ffffff');
    doc.lineWidth(10).strokeColor(INK).rect(24, 24, W - 48, H - 48).stroke();
    doc.lineWidth(2).strokeColor(RED).rect(40, 40, W - 80, H - 80).stroke();

    const center = (text: string, y: number, size: number, font: string, color: string, opts: { width?: number; spacing?: number } = {}) => {
      const width = opts.width ?? W - 160;
      doc.font(font).fontSize(size).fillColor(color).text(text, (W - width) / 2, y, { width, align: 'center', characterSpacing: opts.spacing ?? 0 });
    };

    center('UPSTAGE ACADEMY', 74, 20, 'Helvetica-Bold', INK, { spacing: 6 });
    doc.rect(W / 2 - 30, 108, 60, 3).fill(RED);
    center('CERTIFICATE OF COMPLETION', 130, 32, 'Helvetica-Bold', INK, { spacing: 1 });
    center('This certifies that', 184, 14, 'Helvetica', MUTED);
    center(c.studentName, 208, 40, 'Times-Italic', INK);
    doc.lineWidth(0.75).strokeColor('#DCE0E6').moveTo(W / 2 - 170, 262).lineTo(W / 2 + 170, 262).stroke();
    center(c.kind === 'group' ? 'has successfully completed all courses in' : 'has successfully completed the course', 276, 14, 'Helvetica', MUTED);
    center(c.title, 302, 26, 'Helvetica-Bold', RED, { width: W - 200 });

    const date = c.issuedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'America/Denver' });
    const colW = 200;
    const y = H - 150;
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('DATE', 120, y, { width: colW, align: 'center', characterSpacing: 1.5 });
    doc.font('Helvetica').fontSize(13).fillColor(INK).text(date, 120, y + 16, { width: colW, align: 'center' });
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text('CERTIFICATE ID', W - 120 - colW, y, { width: colW, align: 'center', characterSpacing: 1.5 });
    doc.font('Helvetica').fontSize(13).fillColor(INK).text(c.code, W - 120 - colW, y + 16, { width: colW, align: 'center' });

    const verify = (c.verifyUrl ?? '').replace(/^https?:\/\//, '');
    center(`Upstage Companies, Salt Lake City, UT${verify ? '  ·  ' + verify : ''}`, H - 84, 9, 'Helvetica', MUTED);
    doc.end();
  });
}
