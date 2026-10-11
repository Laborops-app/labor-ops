import type { PoolClient } from 'pg';
import { config } from '../config';
import { decrypt, encrypt } from '../crypto';

export type Provider = 'ses' | 'twilio' | 'sns' | 'podium';
export type SmsProvider = 'none' | 'twilio' | 'sns' | 'podium';

export type Ses = { host: string; port: number; user: string; pass: string; from: string };
export type Twilio = { sid: string; token: string; from: string };
export type Sns = { region: string; accessKeyId: string; secretAccessKey: string; originationNumber: string; senderId: string };
export type Podium = {
  clientId: string; clientSecret: string; locationUid: string;
  accessToken: string; refreshToken: string; expiresAt: number; connectedAt: string;
  webhookSecret: string; webhookUid: string;
};

export type Resolved = {
  ses: Ses & { source: 'company' | 'server' };
  twilio: Twilio & { source: 'company' | 'server' };
  sns: Sns & { source: 'company' | 'server' };
  podium: Podium;
  smsProvider: SmsProvider;
};

// Which fields are secret (never sent back to the browser, kept when left blank on save).
export const SECRET_FIELDS: Record<Provider, string[]> = {
  ses: ['pass'],
  twilio: ['token'],
  sns: ['secretAccessKey'],
  podium: ['clientSecret', 'accessToken', 'refreshToken', 'webhookSecret'],
};

const serverDefaults = {
  ses: { host: config.email.host, port: config.email.port, user: config.email.user, pass: config.email.pass, from: config.email.from },
  twilio: { sid: config.sms.sid, token: config.sms.token, from: config.sms.from },
  sns: { ...config.sms.sns },
  podium: { clientId: '', clientSecret: '', locationUid: '', accessToken: '', refreshToken: '', expiresAt: 0, connectedAt: '', webhookSecret: '', webhookUid: '' },
};

async function readRaw(c: PoolClient, provider: Provider): Promise<Record<string, any> | null> {
  const { rows } = await c.query('SELECT config_enc FROM integration_settings WHERE provider = $1', [provider]);
  if (!rows[0]) return null;
  try {
    return JSON.parse(decrypt(rows[0].config_enc));
  } catch {
    return null; // unreadable (key changed): treated as not set
  }
}

/** Company settings (decrypted) layered over the server defaults from the environment. */
export async function loadSettings(c: PoolClient, tenantId: string): Promise<Resolved> {
  const [ses, twilio, sns, podium] = await Promise.all((['ses', 'twilio', 'sns', 'podium'] as Provider[]).map((p) => readRaw(c, p)));
  const t = (await c.query('SELECT sms_provider FROM tenants WHERE id = $1', [tenantId])).rows[0];
  return {
    ses: { ...serverDefaults.ses, ...(ses ?? {}), source: ses ? 'company' : 'server' },
    twilio: { ...serverDefaults.twilio, ...(twilio ?? {}), source: twilio ? 'company' : 'server' },
    sns: { ...serverDefaults.sns, ...(sns ?? {}), source: sns ? 'company' : 'server' },
    podium: { ...serverDefaults.podium, ...(podium ?? {}) },
    smsProvider: (t?.sms_provider as SmsProvider | null) ?? config.sms.provider,
  };
}

/**
 * Merge a patch into a provider's stored settings. Blank secret fields keep their old value.
 * `raw: true` is for system updates (token refresh) where blanks are meaningful.
 */
export async function saveIntegration(
  c: PoolClient, tenantId: string, userId: string | null, provider: Provider, patch: Record<string, any>, opts: { raw?: boolean } = {},
) {
  const current = (await readRaw(c, provider)) ?? {};
  const next: Record<string, any> = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (!opts.raw && SECRET_FIELDS[provider].includes(k) && (v === '' || v == null)) continue;
    next[k] = typeof v === 'string' ? v.trim() : v;
  }
  await c.query(
    `INSERT INTO integration_settings (tenant_id, provider, config_enc, updated_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET config_enc = EXCLUDED.config_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tenantId, provider, encrypt(JSON.stringify(next)), userId],
  );
}

export async function clearIntegration(c: PoolClient, provider: Provider) {
  await c.query('DELETE FROM integration_settings WHERE provider = $1', [provider]);
}

export const emailLive = (r: Resolved) => !!(r.ses.host && r.ses.user && r.ses.pass);
export const podiumConnected = (p: Podium) => !!(p.refreshToken && p.locationUid);
export function smsLive(r: Resolved): boolean {
  switch (r.smsProvider) {
    case 'sns': return !!(r.sns.accessKeyId && r.sns.secretAccessKey);
    case 'twilio': return !!(r.twilio.sid && r.twilio.token && r.twilio.from);
    case 'podium': return podiumConnected(r.podium);
    default: return false;
  }
}
export function smsSender(r: Resolved): string | null {
  switch (r.smsProvider) {
    case 'sns': return r.sns.originationNumber || r.sns.senderId || 'Amazon SNS';
    case 'twilio': return r.twilio.from || null;
    case 'podium': return podiumConnected(r.podium) ? `Podium location ${r.podium.locationUid.slice(0, 8)}…` : null;
    default: return null;
  }
}

/** What the browser may see: everything except secret values, which show only as "set". */
export function publicView(r: Resolved) {
  const strip = <T extends Record<string, any>>(p: Provider, o: T) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(o)) {
      if (SECRET_FIELDS[p].includes(k)) out[`${k}Set`] = !!v;
      else out[k] = v;
    }
    return out;
  };
  return {
    ses: strip('ses', r.ses),
    twilio: strip('twilio', r.twilio),
    sns: strip('sns', r.sns),
    podium: {
      clientId: r.podium.clientId, locationUid: r.podium.locationUid, clientSecretSet: !!r.podium.clientSecret,
      connected: podiumConnected(r.podium), connectedAt: r.podium.connectedAt || null,
      webhookSecretSet: !!r.podium.webhookSecret, webhookRegistered: !!r.podium.webhookUid,
    },
  };
}
