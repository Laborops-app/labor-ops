import webpush from 'web-push';
import { pool } from '../db';
import { config } from '../config';
import { decrypt, encrypt } from '../crypto';

type Vapid = { publicKey: string; privateKey: string };
let cached: Vapid | null = null;

/** Browser-push signing keys: from the environment if set, otherwise generated once and stored (encrypted). */
export async function vapid(): Promise<Vapid> {
  if (cached) return cached;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return (cached = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY });
  }
  const { rows } = await pool.query("SELECT value_enc FROM app_secrets WHERE key = 'vapid'");
  if (rows[0]) return (cached = JSON.parse(decrypt(rows[0].value_enc)));
  const keys = webpush.generateVAPIDKeys();
  await pool.query("INSERT INTO app_secrets (key, value_enc) VALUES ('vapid', $1) ON CONFLICT DO NOTHING", [encrypt(JSON.stringify(keys))]);
  const again = await pool.query("SELECT value_enc FROM app_secrets WHERE key = 'vapid'");
  return (cached = JSON.parse(decrypt(again.rows[0].value_enc)));
}

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

export async function sendPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: object): Promise<PushResult> {
  const k = await vapid();
  const subject = config.appUrl.startsWith('https') ? config.appUrl : 'mailto:no-reply@laborops.app';
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { vapidDetails: { subject, publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 60 * 60 * 12, timeout: 10_000 },
    );
    return { ok: true };
  } catch (e: any) {
    const code = Number(e?.statusCode ?? 0);
    return { ok: false, gone: code === 404 || code === 410, error: `Push ${code || 'error'}: ${String(e?.body ?? e?.message ?? e).slice(0, 200)}` };
  }
}
