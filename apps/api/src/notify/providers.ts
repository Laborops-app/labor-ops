import { SNSClient, PublishCommand, ListPhoneNumbersOptedOutCommand } from '@aws-sdk/client-sns';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';

export type SendResult = { ok: true; id: string; logged?: boolean } | { ok: false; permanent: boolean; error: string };

export const emailConfigured = () => !!(config.email.host && config.email.user && config.email.pass);
export const smsConfigured = () =>
  config.sms.provider === 'sns'
    ? !!(config.sms.sns.accessKeyId && config.sms.sns.secretAccessKey)
    : !!(config.sms.sid && config.sms.token && config.sms.from);
/** Display name of the sender for the admin page. */
export const smsSender = () =>
  config.sms.provider === 'sns' ? config.sms.sns.originationNumber || config.sms.sns.senderId || 'Amazon SNS' : config.sms.from || null;

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

let sns: SNSClient | null = null;
const getSns = () =>
  (sns ??= new SNSClient({
    region: config.sms.sns.region,
    credentials: { accessKeyId: config.sms.sns.accessKeyId, secretAccessKey: config.sms.sns.secretAccessKey },
  }));

// Errors where retrying cannot help (bad number, opted out, sandbox/unverified destination, bad credentials).
const SNS_PERMANENT = new Set([
  'InvalidParameterException', 'InvalidParameter', 'OptedOutException', 'OptedOut', 'VerificationException',
  'AuthorizationErrorException', 'AuthorizationError', 'InvalidClientTokenId', 'UnrecognizedClientException', 'SignatureDoesNotMatch',
]);

async function sendSnsSms(m: { to: string; body: string }): Promise<SendResult> {
  try {
    const attrs: Record<string, { DataType: string; StringValue: string }> = {
      'AWS.SNS.SMS.SMSType': { DataType: 'String', StringValue: 'Transactional' },
    };
    if (config.sms.sns.originationNumber) attrs['AWS.MM.SMS.OriginationNumber'] = { DataType: 'String', StringValue: config.sms.sns.originationNumber };
    else if (config.sms.sns.senderId) attrs['AWS.SNS.SMS.SenderID'] = { DataType: 'String', StringValue: config.sms.sns.senderId };
    const r = await getSns().send(new PublishCommand({ PhoneNumber: m.to, Message: m.body, MessageAttributes: attrs }), { abortSignal: AbortSignal.timeout(15_000) });
    return { ok: true, id: String(r.MessageId ?? '') };
  } catch (e: any) {
    const name = String(e?.name ?? e?.Code ?? '');
    return { ok: false, permanent: SNS_PERMANENT.has(name), error: `SNS ${name || 'error'}: ${String(e?.message ?? e).slice(0, 250)}` };
  }
}

/** Numbers that replied STOP to an AWS-owned sender. Returns last-10-digit strings. Empty when not using SNS or on error. */
export async function snsOptedOut(): Promise<string[]> {
  if (config.sms.provider !== 'sns' || !smsConfigured()) return [];
  const out: string[] = [];
  try {
    let token: string | undefined;
    do {
      const r = await getSns().send(new ListPhoneNumbersOptedOutCommand({ nextToken: token }));
      for (const n of r.phoneNumbers ?? []) out.push(n.replace(/\D/g, '').slice(-10));
      token = r.nextToken;
    } while (token && out.length < 5000);
  } catch (e: any) {
    console.error('sns opt-out sync failed:', e?.name ?? e);
  }
  return out;
}

export async function sendSms(m: { to: string; body: string }): Promise<SendResult> {
  if (config.sms.provider === 'sns' && smsConfigured()) return sendSnsSms(m);
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
