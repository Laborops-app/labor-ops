import crypto from 'node:crypto';
import type { Podium } from './settings';
import type { SendResult } from './providers';

const API = 'https://api.podium.com';
export const PODIUM_SCOPES = 'read_messages write_messages read_locations';

export const authorizeUrl = (p: Podium, redirectUri: string, state: string) =>
  `${API}/oauth/authorize?` + new URLSearchParams({ client_id: p.clientId, redirect_uri: redirectUri, scope: PODIUM_SCOPES, state }).toString();

type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw Object.assign(new Error(`Podium ${res.status}: ${j.error_description ?? j.error ?? j.message ?? 'token request failed'}`), { status: res.status });
  return {
    accessToken: String(j.access_token),
    refreshToken: String(j.refresh_token ?? body.refresh_token ?? ''),
    expiresAt: Date.now() + (Number(j.expires_in) || 36000) * 1000,
  };
}

export const exchangeCode = (p: Podium, code: string, redirectUri: string) =>
  tokenRequest({ client_id: p.clientId, client_secret: p.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code });

export const refreshTokens = (p: Podium) =>
  tokenRequest({ client_id: p.clientId, client_secret: p.clientSecret, grant_type: 'refresh_token', refresh_token: p.refreshToken });

/** A valid access token, refreshing (and persisting the result) when it is about to expire. */
export async function accessToken(p: Podium, persist?: (t: Tokens) => Promise<void>): Promise<string> {
  if (p.accessToken && p.expiresAt - 60_000 > Date.now()) return p.accessToken;
  const t = await refreshTokens(p);
  Object.assign(p, t);
  if (persist) await persist(t);
  return t.accessToken;
}

export async function sendPodiumText(
  p: Podium, m: { to: string; body: string; contactName?: string }, persist?: (t: Tokens) => Promise<void>,
): Promise<SendResult> {
  try {
    const token = await accessToken(p, persist);
    const res = await fetch(`${API}/v4/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        body: m.body,
        channel: { type: 'phone', identifier: m.to },
        locationUid: p.locationUid,
        senderName: 'LaborOps',
        setOpenInbox: true,
        ...(m.contactName ? { contactName: m.contactName } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const j: any = await res.json().catch(() => ({}));
    if (res.ok) return { ok: true, id: String(j?.data?.uid ?? j?.uid ?? '') };
    const detail = j?.message ?? j?.error ?? j?.errors?.[0]?.message ?? 'request failed';
    // 4xx (except rate limiting) will not succeed on retry.
    return { ok: false, permanent: res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 401, error: `Podium ${res.status}: ${String(detail).slice(0, 250)}` };
  } catch (e: any) {
    const bad = e?.status >= 400 && e?.status < 500;
    return { ok: false, permanent: !!bad, error: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Ask Podium to send message events to our webhook URL. Request shape per Podium's "Create a webhook" reference. */
export async function registerWebhook(p: Podium, url: string, secret: string, persist?: (t: Tokens) => Promise<void>) {
  const token = await accessToken(p, persist);
  const res = await fetch(`${API}/v4/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ url, secret, locationUid: p.locationUid, eventTypes: ['message.received', 'message.failed'], disabled: false }),
    signal: AbortSignal.timeout(15_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Podium ${res.status}: ${String(j?.message ?? j?.error ?? 'could not create the webhook').slice(0, 250)}`);
  return String(j?.data?.uid ?? j?.uid ?? 'registered');
}

/** Podium signs `${timestamp}.${rawBody}` with HMAC-SHA256. The docs do not name the encoding, so hex or base64 are accepted. */
export function verifyPodiumSignature(secret: string, timestamp: string, raw: string, signature: string, now = Date.now()): boolean {
  if (!secret || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const ms = ts < 1e12 ? ts * 1000 : ts; // seconds or milliseconds
  if (Math.abs(now - ms) > 5 * 60_000) return false;
  const hex = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex');
  const b64 = crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('base64');
  const sig = signature.trim();
  const eq = (a: string) => a.length === sig.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(sig));
  return eq(hex) || eq(b64);
}
