import { SNSClient, PublishCommand, ListPhoneNumbersOptedOutCommand } from '@aws-sdk/client-sns';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Resolved } from './settings';
import { emailLive, smsLive } from './settings';
import { sendPodiumText } from './podium';

export type SendResult = { ok: true; id: string; logged?: boolean } | { ok: false; permanent: boolean; error: string };

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

const snsClients = new Map<string, SNSClient>();
const getSns = (c: Resolved['sns']) => {
  const k = `${c.region}:${c.accessKeyId}:${c.secretAccessKey.length}`;
  let cl = snsClients.get(k);
  if (!cl) {
    if (snsClients.size > 50) snsClients.clear();
    cl = new SNSClient({ region: c.region || 'us-west-2', credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey } });
    snsClients.set(k, cl);
  }
  return cl;
};

// Errors where retrying cannot help (bad number, opted out, sandbox/unverified destination, bad credentials).
const SNS_PERMANENT = new Set([
  'InvalidParameterException', 'InvalidParameter', 'OptedOutException', 'OptedOut', 'VerificationException',
  'AuthorizationErrorException', 'AuthorizationError', 'InvalidClientTokenId', 'UnrecognizedClientException', 'SignatureDoesNotMatch',
]);

async function sendSnsSms(c: Resolved['sns'], m: { to: string; body: string }): Promise<SendResult> {
  try {
    const attrs: Record<string, { DataType: string; StringValue: string }> = {
      'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
    };
    if (c.originationNumber) attrs['AWS.MM.SMS.OriginationNumber'] = { DataType: 'String', StringValue: c.originationNumber };
    else if (c.senderId) attrs['AWS.SNS.SMS.SenderID'] = { DataType: 'String', StringValue: c.senderId };
    const r = await getSns(c).send(new PublishCommand({ PhoneNumber: m.to, Message: m.body, MessageAttributes: attrs }), { abortSignal: AbortSignal.timeout(15_000) });
    return { ok: true, id: String(r.MessageId ?? '') };
  } catch (e: any) {
    const name = String(e?.name ?? e?.Code ?? '');
    return { ok: false, permanent: SNS_PERMANENT.has(name), error: `SNS ${name || 'error'}: ${String(e?.message ?? e).slice(0, 250)}` };
  }
}

/** Numbers that replied STOP to an AWS-owned sender. Returns last-10-digit strings. Empty when not using SNS or on error. */
export async function snsOptedOut(cfg: Resolved): Promise<string[]> {
  if (cfg.smsProvider !== 'sns' || !smsLive(cfg)) return [];
  const out: string[] = [];
  try {
    let token: string | undefined;
    do {
      const r = await getSns(cfg.sns).send(new ListPhoneNumbersOptedOutCommand({ nextToken: token }));
      for (const n of r.phoneNumbers ?? []) out.push(n.replace(/\D/g, '').slice(-10));
      token = r.nextToken;
    } while (token && out.length < 5000);
  } catch (e: any) {
    console.error('sns opt-out sync failed:', e?.name ?? e);
  }
  return out;
}

export type SmsContext = { persistPodium?: (t: { accessToken: string; refreshToken: string; expiresAt: number }) => Promise<void>; contactName?: string };

export async function sendSms(cfg: Resolved, m: { to: string; body: string }, ctx: SmsContext = {}): Promise<SendResult> {
  if (!smsLive(cfg)) {
    console.log(`[sms:log-only] provider=${cfg.smsProvider} to=${m.to} chars=${m.body.length}`);
    return { ok: true, id: 'log-only', logged: true };
  }
  if (cfg.smsProvider === 'sns') return sendSnsSms(cfg.sns, m);
  if (cfg.smsProvider === 'podium') return sendPodiumText(cfg.podium, { ...m, contactName: ctx.contactName }, ctx.persistPodium);
  return sendTwilioSms(cfg.twilio, m);
}

async function sendTwilioSms(c: Resolved['twilio'], m: { to: string; body: string }): Promise<SendResult> {
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${c.sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${c.sid}:${c.token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: m.to, From: c.from, Body: m.body }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: String(data.sid ?? '') };
    return {
      ok: false,
      permanent: res.status >= 400 && res.status < 500 && res.status !== 429,
      error: `Twilio ${data.code ?? res.status}: ${String(data.message ?? 'request failed').slice(0, 250)}`,
    };
  } catch (e: any) {
    return { ok: false, permanent: false, error: String(e?.message ?? e).slice(0, 300) };
  }
}
