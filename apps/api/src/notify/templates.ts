import { config } from '../config';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export const absUrl = (link?: string | null) => (link ? (link.startsWith('http') ? link : config.appUrl + link) : config.appUrl);

export function renderEmail(opts: { title: string; body: string; link?: string | null; linkLabel?: string; footer?: string; actions?: { label: string; url: string; kind: 'accept' | 'decline' }[] }) {
  const url = absUrl(opts.link);
  const label = opts.linkLabel ?? 'Open LaborOps';
  const footer = opts.footer ?? 'You are receiving this because of your notification settings in LaborOps. You can change them on your profile page.';
  const acts = opts.actions ?? [];
  const actText = acts.map((a) => `${a.label}: ${a.url}`).join('\n');
  const text = `${opts.body}\n\n${actText ? actText + '\n' : ''}${label}: ${url}\n\n— LaborOps\n${footer}`;
  const btn = (a: { label: string; url: string; kind: string }) =>
    `<a href="${esc(a.url)}" style="background:${a.kind === 'accept' ? '#15803d' : '#b91c1c'};color:#fff;text-decoration:none;padding:11px 22px;border-radius:8px;display:inline-block;font-weight:600;margin:0 8px 8px 0">${esc(a.label)}</a>`;
  const actHtml = acts.length ? `<p style="margin:20px 0 0">${acts.map(btn).join('')}</p>` : '';
  const paras = opts.body.split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px;line-height:1.5">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<!doctype html><html><body style="margin:0;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="font-weight:700;font-size:18px;margin-bottom:12px">LaborOps</div>
<div style="background:#fff;border-radius:10px;padding:24px;border:1px solid #e5e7eb">
<h1 style="font-size:18px;margin:0 0 14px">${esc(opts.title)}</h1>${paras}
${actHtml}<p style="margin:${acts.length ? '6px' : '20px'} 0 0"><a href="${esc(url)}" style="${acts.length ? 'color:#2563eb;text-decoration:underline;font-weight:600' : 'background:#2563eb;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block;font-weight:600'}">${esc(label)}</a></p>
</div>
<p style="font-size:12px;color:#6b7280;line-height:1.4;margin:14px 4px">${esc(footer)}</p>
</div></body></html>`;
  return { text, html };
}

/** Format an instant in the tenant's time zone, e.g. "Sat, Oct 11, 6:00 PM". */
export function fmtWhen(d: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(d));
}
export function fmtTimeOnly(d: Date | string, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(d));
}
