import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';

export type SendResult = { ok: true; id: string; logged?: boolean } | { ok: false; permanent: boolean; error: string };

export const emailConfigured = () => !!(config.email.host && config.email.user && config.email.pass);
export const smsConfigured = () => !!(config.sms.sid && config.sms.token && config.sms.from);

let transport: Transporter | null = null;
function getTransport() {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.port === 465,
      auth: { user: config.email.user, pass: config.email.pass },
      connectionTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transport;
}

export async function sendEmail(m: { to: string; subject: string; text: string; html?: string | null }): Promise<SendResult> {
  if (!emailConfigured()) {
    console.log(`[email:log-only] to=${m.to} subject=${JSON.stringify(m.subject)}`);
    return { ok: true, id: 'log-only', logged: true };
  }
  try {
    const info = await getTransport().sendMail({
      from: config.email.from,
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

export async function sendSms(m: { to: string; body: string }): Promise<SendResult> {
  if (!smsConfigured()) {
    console.log(`[sms:log-only] to=${m.to} chars=${m.body.length}`);
    return { ok: true, id: 'log-only', logged: true };
  }
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${config.sms.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${config.sms.sid}:${config.sms.token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: m.to, From: config.sms.from, Body: m.body }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: String(data.sid ?? '') };
    // 4xx = bad number, unsubscribed recipient, unverified trial number, etc. Retrying will not help.
    return {
      ok: false,
      permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
      error: `Twilio ${data.code ?? res.status}: ${String(data.message ?? 'request failed').slice(0, 250)}`,
    };
  } catch (e: any) {
    return { ok: false, permanent: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}
