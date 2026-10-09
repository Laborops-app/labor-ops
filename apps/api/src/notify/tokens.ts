import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { config } from '../config';
import { enqueueAccountEmail } from './index';

export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

/** Create a single-use token (older unused ones of the same kind are voided) and return the raw value for the link. */
export async function issueToken(c: PoolClient, tenantId: string, userId: string, kind: 'reset' | 'invite', ttlHours: number) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await c.query("UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND kind = $2 AND used_at IS NULL", [userId, kind]);
  await c.query(
    "INSERT INTO auth_tokens (tenant_id, user_id, kind, token_hash, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(hours => $5))",
    [tenantId, userId, kind, hashToken(raw), ttlHours],
  );
  return raw;
}

export async function sendInvite(c: PoolClient, tenantId: string, u: { id: string; email: string; name: string }) {
  const company = (await c.query('SELECT name FROM tenants WHERE id = $1', [tenantId])).rows[0]?.name ?? 'your company';
  const raw = await issueToken(c, tenantId, u.id, 'invite', 24 * 7);
  await enqueueAccountEmail(c, tenantId, {
    userId: u.id, to: u.email, subject: `You're invited to ${company} on LaborOps`,
    body: `Hi ${u.name.split(' ')[0]},\n\n${company} added you to LaborOps, where you'll see your shifts, clock in and out, and get schedule updates.\n\nUse the button below to choose your password. This link works for 7 days.`,
    link: `${config.appUrl}/reset?token=${raw}&invite=1`, linkLabel: 'Set my password',
  });
}

export async function sendReset(c: PoolClient, tenantId: string, u: { id: string; email: string; name: string }) {
  const raw = await issueToken(c, tenantId, u.id, 'reset', 1);
  await enqueueAccountEmail(c, tenantId, {
    userId: u.id, to: u.email, subject: 'Reset your LaborOps password',
    body: `Hi ${u.name.split(' ')[0]},\n\nWe received a request to reset your password. Use the button below to choose a new one. The link works for 1 hour and can be used once.\n\nIf you didn't ask for this, you can ignore this email and your password won't change.`,
    link: `${config.appUrl}/reset?token=${raw}`, linkLabel: 'Reset password',
  });
}
