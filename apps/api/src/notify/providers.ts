import crypto from 'node:crypto';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Resolved } from './settings';
import { emailLive, smsLive } from './settings';
import { sendPodiumText } from './podium';

export type SendResult = { ok: true; id: string; logged?: boolean } | { ok: false; permanent: boolean; error: string; optedOut?: boolean };

const transports = new Map<string, Transporter>();
function getTransport(c: Resolved['ses']) {
  const k = `${c.host}:${c.port}:${c.user}:${c.pass.length}`;
  let t = transports.get(k);
  if (!t) {
    if (transports.size > 50) transports.clear();
    t = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.port === 465,
      auth: { user: c.user, pass: c.pass },
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
    transports.set(k, t);
  }
  return t;
}

export async function sendEmail(cfg: Resolved, m: { to: string; subject: string; text: string; html?: string | null }): Promise<SendResult> {
  if (!emailLive(cfg)) {
    console.log(`[email:log-only] to=${m.to} subject=${JSON.stringify(m.subject)}`);
    return { ok: true, id: 'log-only', logged: true };
  }
  try {
    const info = await getTransport(cfg.ses).sendMail({
      from: cfg.ses.from,
      to: m.to,
      subject: m.subject,
      text: m.text,
      html: m.html ?? undefined,
    });
    return { ok: true, id: String(info.messageId ?? '') };
  } catch (e: any) {
    const code = Number(e?.responseCode ?? 0);
    // 5xx from the SMTP server means the message itself was refused; anything else is worth retrying.
    return { ok: false, permanent: code >= 500 && code < 600, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Normalise a phone number to E.164. Numbers without a country code are treated as US/Canada. */
export function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

/** Zernio's API (overridable for tests). */
export const ZERNIO_API = () => (process.env.ZERNIO_API_BASE ?? 'https://zernio.com/api/v1').replace(/\/+$/, '');

async function sendZernioSms(c: Resolved['zernio'], m: { to: string; body: string; key?: string }): Promise<SendResult> {
  try {
    const res = await fetch(`${ZERNIO_API()}/sms/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.apiKey}`,
        'Content-Type': 'application/json',
        // A retry of the same delivery replays Zernio's first answer instead of texting twice.
        'Idempotency-Key': m.key ?? crypto.randomUUID(),
      },
      body: JSON.stringify({ from: c.from, to: m.to, text: m.body }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: String(data.id ?? '') };
    const msg = String(data.error?.message ?? data.error ?? data.message ?? 'request failed').slice(0, 250);
    // 409: the person replied STOP (or the same send is still in flight); 404: no such sending number; 401/403: bad key.
    return { ok: false, permanent: res.status >= 400 && res.status < 500 && res.status !== 429, error: `Zernio ${res.status}: ${msg}`, optedOut: res.status === 409 && /opt/i.test(msg) };
  } catch (e: any) {
    return { ok: false, permanent: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Numbers that replied STOP to the Zernio sender. Returns last-10-digit strings; empty when not using Zernio or on error. */
export async function zernioOptedOut(cfg: Resolved): Promise<string[]> {
  if (cfg.smsProvider !== 'zernio' || !smsLive(cfg)) return [];
  try {
    const res = await fetch(`${ZERNIO_API()}/sms/opt-outs?limit=5000`, { headers: { Authorization: `Bearer ${cfg.zernio.apiKey}` }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return [];
    const data: any = await res.json().catch(() => ({}));
    return (data.optOuts ?? []).map((o: any) => String(o.phoneNumber ?? '').replace(/\D/g, '').slice(-10)).filter((d: string) => d.length === 10);
  } catch (e: any) {
    console.error('zernio opt-out sync failed:', e?.message ?? e);
    return [];
  }
}

export type SmsContext = { persistPodium?: (t: { accessToken: string; refreshToken: string; expiresAt: number }) => Promise<void>; contactName?: string; key?: string };

export async function sendSms(cfg: Resolved, m: { to: string; body: string }, ctx: SmsContext = {}): Promise<SendResult> {
  if (!smsLive(cfg)) {
    console.log(`[sms:log-only] provider=${cfg.smsProvider} to=${m.to} chars=${m.body.length}`);
    return { ok: true, id: 'log-only', logged: true };
  }
  if (cfg.smsProvider === 'podium') return sendPodiumText(cfg.podium, { ...m, contactName: ctx.contactName }, ctx.persistPodium);
  return sendZernioSms(cfg.zernio, { ...m, key: ctx.key });
}
