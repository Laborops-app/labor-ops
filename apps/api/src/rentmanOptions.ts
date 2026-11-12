import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { decrypt, encrypt } from './crypto';

/** The optional Rentman features, each switched on under Integrations › Rentman. */
export const OPTION_KEYS = [
  'webhooks', 'crew_link', 'rates_source', 'quoted_bill_rates', 'push_hours', 'push_time_off',
  'show_invoices', 'show_files', 'show_contacts', 'show_vehicles', 'show_equipment_leads',
] as const;
export type OptionKey = (typeof OPTION_KEYS)[number];
export type Options = Record<OptionKey, boolean> & {
  filesFolder: string | null; webhookKey: string | null; hasWebhookToken: boolean; webhookLastAt: string | null;
  ratesLastAt: string | null; ratesLastResult: unknown; accountName: string | null;
};

export async function loadOptions(c: PoolClient): Promise<Options> {
  const r = (await c.query('SELECT * FROM rentman_settings LIMIT 1')).rows[0] ?? {};
  // Billing at Rentman's quoted prices is on unless a company switches it off; everything else starts off.
  const o = Object.fromEntries(OPTION_KEYS.map((k) => [k, k in r ? !!r[k] : k === 'quoted_bill_rates'])) as Record<OptionKey, boolean>;
  return {
    ...o, filesFolder: r.files_folder ?? null, webhookKey: r.webhook_key ?? null, hasWebhookToken: !!r.webhook_token_enc,
    webhookLastAt: r.webhook_last_at ?? null, ratesLastAt: r.rates_last_at ?? null, ratesLastResult: r.rates_last_result ?? null, accountName: r.account_name ?? null,
  };
}

/** Change some options. Turning webhooks on gives the company its own random webhook address. */
export async function saveOptions(c: PoolClient, tid: string, by: string, patch: Partial<Record<OptionKey, boolean>> & { filesFolder?: string | null; webhookToken?: string | null; accountName?: string | null }) {
  await c.query('INSERT INTO rentman_settings (tenant_id, updated_by) VALUES ($1,$2) ON CONFLICT (tenant_id) DO NOTHING', [tid, by]);
  for (const k of OPTION_KEYS) if (patch[k] !== undefined) await c.query(`UPDATE rentman_settings SET ${k} = $1, updated_by = $2, updated_at = now()`, [patch[k], by]);
  if (patch.filesFolder !== undefined) await c.query('UPDATE rentman_settings SET files_folder = $1', [patch.filesFolder?.trim() || null]);
  if (patch.webhookToken !== undefined) await c.query('UPDATE rentman_settings SET webhook_token_enc = $1', [patch.webhookToken ? encrypt(patch.webhookToken.trim()) : null]);
  if (patch.accountName !== undefined) {
    // "yourcompany", "yourcompany.rentmanapp.com" or a pasted Rentman address → "yourcompany"
    const a = (patch.accountName ?? '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[./#]/)[0] || null;
    await c.query('UPDATE rentman_settings SET account_name = $1', [a && /^[a-z0-9][a-z0-9-]{1,62}$/.test(a) ? a : null]);
  }
  if (patch.webhooks) await c.query("UPDATE rentman_settings SET webhook_key = COALESCE(webhook_key, $1)", [crypto.randomBytes(24).toString('base64url')]);
}

export async function webhookToken(c: PoolClient): Promise<string | null> {
  const r = (await c.query('SELECT webhook_token_enc FROM rentman_settings LIMIT 1')).rows[0];
  if (!r?.webhook_token_enc) return null;
  try {
    return decrypt(r.webhook_token_enc);
  } catch {
    return null;
  }
}

/**
 * Rentman signs each webhook: a Digest header "<algorithm>=<value>", the value an HMAC of the raw body keyed with the
 * token Rentman showed when the webhook was set up. Accepts hex or base64 values; compares in constant time.
 */
export function verifyDigest(raw: string, header: string | undefined, token: string): boolean {
  if (!header || !token) return false;
  const m = /^\s*([a-z0-9-]+)\s*=\s*(.+?)\s*$/i.exec(header);
  if (!m) return false;
  const algo = m[1].toLowerCase().replace(/^sha-/, 'sha');
  if (!['sha256', 'sha384', 'sha512', 'sha1'].includes(algo)) return false;
  const mac = crypto.createHmac(algo, token).update(raw, 'utf8').digest();
  const given = m[2];
  const tries = [Buffer.from(given, 'hex'), Buffer.from(given, 'base64')].filter((b) => b.length === mac.length);
  return tries.some((b) => crypto.timingSafeEqual(b, mac));
}

/** The Rentman web address of a project, when the account is known. */
export const rentmanProjectUrl = (account: string | null | undefined, projectId: number | null | undefined) =>
  account && projectId ? `https://${account}.rentmanapp.com/#/projects/${projectId}/details` : null;
