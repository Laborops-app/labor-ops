import type { PoolClient } from 'pg';
import { toE164 } from './providers';
import { absUrl, renderEmail } from './templates';

export type Category = 'assignment' | 'shift_change' | 'reminder' | 'approval_request' | 'approval_result' | 'open_shift' | 'cert' | 'account';

// Categories that may also go out by text message (when the person opted in). Everything else is email + in-app only.
const SMS_CATEGORIES = new Set<Category>(['assignment', 'shift_change', 'reminder', 'approval_result']);

export type NotifyInput = {
  userId: string;
  category: Category;
  title: string;
  body: string;
  link?: string;
  /** Short text-message wording. Defaults to the title. */
  sms?: string;
};

type Target = { id: string; email: string; phone: string | null; notify_email: boolean; notify_sms: boolean; sms_consent_at: Date | null };

/**
 * Record an in-app notification and queue email/SMS deliveries according to the person's settings.
 * Runs inside the caller's tenant transaction, so a rolled-back action never sends anything.
 */
export async function notify(c: PoolClient, tenantId: string, input: NotifyInput | NotifyInput[]): Promise<void> {
  const list = Array.isArray(input) ? input : [input];
  if (!list.length) return;
  const ids = [...new Set(list.map((n) => n.userId))];
  const { rows } = await c.query<Target>(
    'SELECT id, email, phone, notify_email, notify_sms, sms_consent_at FROM users WHERE id = ANY($1::uuid[]) AND active',
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const n of list) {
    const u = byId.get(n.userId);
    if (!u) continue;
    const { rows: nr } = await c.query(
      'INSERT INTO notifications (tenant_id, user_id, category, title, body, link) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [tenantId, u.id, n.category, n.title, n.body, n.link ?? null],
    );
    const nid = nr[0].id;
    if (u.notify_email && u.email) {
      const m = renderEmail({ title: n.title, body: n.body, link: n.link });
      await c.query(
        `INSERT INTO deliveries (tenant_id, user_id, notification_id, channel, category, to_addr, subject, body, html)
         VALUES ($1,$2,$3,'email',$4,$5,$6,$7,$8)`,
        [tenantId, u.id, nid, n.category, u.email, n.title, m.text, m.html],
      );
    }
    const phone = toE164(u.phone);
    if (SMS_CATEGORIES.has(n.category) && u.notify_sms && u.sms_consent_at && phone) {
      const text = `LaborOps: ${n.sms ?? n.title}${n.link ? ' ' + absUrl(n.link) : ''} Reply STOP to opt out.`;
      await c.query(
        `INSERT INTO deliveries (tenant_id, user_id, notification_id, channel, category, to_addr, body)
         VALUES ($1,$2,$3,'sms',$4,$5,$6)`,
        [tenantId, u.id, nid, n.category, phone, text.slice(0, 480)],
      );
    }
  }
}

/** Notify every active admin / labor coordinator in the tenant. */
export async function notifyStaff(c: PoolClient, tenantId: string, n: Omit<NotifyInput, 'userId'>, exceptUserId?: string) {
  const { rows } = await c.query("SELECT id FROM users WHERE role IN ('admin','manager') AND active AND id <> COALESCE($1::uuid, '00000000-0000-0000-0000-000000000000')", [exceptUserId ?? null]);
  await notify(c, tenantId, rows.map((r) => ({ ...n, userId: r.id })));
}

/** Account emails (password reset, invitations) go out regardless of notification settings. */
export async function enqueueAccountEmail(
  c: PoolClient,
  tenantId: string,
  o: { userId: string; to: string; subject: string; body: string; link: string; linkLabel: string },
) {
  const m = renderEmail({
    title: o.subject, body: o.body, link: o.link, linkLabel: o.linkLabel,
    footer: 'This message was sent because of an action on your LaborOps account. If this was not you, you can ignore it.',
  });
  await c.query(
    `INSERT INTO deliveries (tenant_id, user_id, channel, category, to_addr, subject, body, html)
     VALUES ($1,$2,'email','account',$3,$4,$5,$6)`,
    [tenantId, o.userId, o.to, o.subject, m.text, m.html],
  );
}

export type ShiftDesc = { role: string; event: string; venue: string | null; when: string; line: string };

/** Human description of a shift, formatted in the tenant's time zone. */
export async function describeShift(c: PoolClient, tenantId: string, shiftId: string): Promise<ShiftDesc | null> {
  const { rows } = await c.query(
    `SELECT s.role_name, s.starts_at, s.ends_at, e.name AS event_name, e.venue, t.timezone
       FROM shifts s JOIN events e ON e.id = s.event_id JOIN tenants t ON t.id = s.tenant_id WHERE s.id = $1`,
    [shiftId],
  );
  const r = rows[0];
  if (!r) return null;
  const { fmtWhen, fmtTimeOnly } = await import('./templates');
  const when = `${fmtWhen(r.starts_at, r.timezone)} – ${fmtTimeOnly(r.ends_at, r.timezone)}`;
  return {
    role: r.role_name,
    event: r.event_name,
    venue: r.venue,
    when,
    line: `${r.event_name}\n${r.role_name} · ${when}${r.venue ? '\n' + r.venue : ''}`,
  };
}
