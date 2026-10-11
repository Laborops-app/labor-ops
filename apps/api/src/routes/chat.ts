import type { FastifyInstance } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { withTenant, audit } from '../db';
import { authenticate, guard } from '../auth';
import { notify } from '../notify';

const uuid = z.string().uuid();
const staff = guard('admin', 'manager');
const isStaff = (role: string) => role === 'admin' || role === 'manager';

/** Add people to a channel. New members start with everything read (they can still scroll back through history). */
async function addMembers(c: PoolClient, tenantId: string, channelId: string, userIds: string[]) {
  if (!userIds.length) return;
  await c.query(
    `INSERT INTO chat_members (channel_id, user_id, tenant_id, last_read_seq)
     SELECT $1, u.id, $2, COALESCE((SELECT max(seq) FROM chat_messages WHERE channel_id = $1), 0)
       FROM users u WHERE u.id = ANY($3::uuid[]) AND u.active
     ON CONFLICT DO NOTHING`,
    [channelId, tenantId, userIds],
  );
}

/** Called when someone is assigned to / removed from a shift, so event channels stay in step with the crew list. */
export async function syncEventChannel(c: PoolClient, tenantId: string, eventId: string, userId: string, present: boolean) {
  const ch = (await c.query("SELECT id FROM chat_channels WHERE kind = 'event' AND event_id = $1", [eventId])).rows[0];
  if (!ch) return;
  if (present) return addMembers(c, tenantId, ch.id, [userId]);
  const still = await c.query(
    `SELECT 1 FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id
      WHERE s.event_id = $1 AND a.user_id = $2 AND a.status <> 'declined' LIMIT 1`,
    [eventId, userId],
  );
  const creator = (await c.query('SELECT created_by FROM chat_channels WHERE id = $1', [ch.id])).rows[0]?.created_by;
  if (!still.rowCount && creator !== userId) await c.query("DELETE FROM chat_members WHERE channel_id = $1 AND user_id = $2 AND user_id IN (SELECT id FROM users WHERE role = 'crew')", [ch.id, userId]);
}

async function myChannel(c: PoolClient, channelId: string, userId: string) {
  return (
    await c.query(
      `SELECT ch.id, ch.kind, ch.name, ch.event_id, ch.created_by, m.muted FROM chat_channels ch
         JOIN chat_members m ON m.channel_id = ch.id AND m.user_id = $2 WHERE ch.id = $1`,
      [channelId, userId],
    )
  ).rows[0] as { id: string; kind: string; name: string | null; event_id: string | null; created_by: string | null; muted: boolean } | undefined;
}

/** Post a message into the direct conversation between two people (creating it if needed), without a bell notification. */
export async function sendDirectMessage(c: PoolClient, tenantId: string, fromId: string, toId: string, body: string) {
  const key = [fromId, toId].sort().join(':');
  let ch = (await c.query("SELECT id FROM chat_channels WHERE kind = 'dm' AND dm_key = $1", [key])).rows[0];
  if (!ch) {
    ch = (await c.query("INSERT INTO chat_channels (tenant_id, kind, dm_key, created_by) VALUES ($1,'dm',$2,$3) RETURNING id", [tenantId, key, fromId])).rows[0];
    await addMembers(c, tenantId, ch.id, [fromId, toId]);
  }
  const msg = (await c.query('INSERT INTO chat_messages (tenant_id, channel_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING seq', [tenantId, ch.id, fromId, body.slice(0, 4000)])).rows[0];
  await c.query('UPDATE chat_channels SET last_message_at = now() WHERE id = $1', [ch.id]);
  await c.query('UPDATE chat_members SET last_read_seq = $3 WHERE channel_id = $1 AND user_id = $2', [ch.id, fromId, msg.seq]);
}

const chatLink = (id: string) => `/chat?c=${id}`;

export async function chatRoutes(app: FastifyInstance) {
  // ---------- channel list ----------
  app.get('/api/chat/channels', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      channels: (
        await c.query(
          `SELECT ch.id, ch.kind, ch.event_id, m.muted, ch.last_message_at,
                  CASE WHEN ch.kind = 'dm' THEN o.name ELSE ch.name END AS name,
                  o.role AS other_role,
                  (SELECT count(*) FROM chat_members x WHERE x.channel_id = ch.id)::int AS member_count,
                  (SELECT count(*) FROM chat_messages x WHERE x.channel_id = ch.id AND x.seq > m.last_read_seq AND x.user_id IS DISTINCT FROM $1 AND x.deleted_at IS NULL)::int AS unread,
                  lm.body AS last_body, lm.user_name AS last_user, lm.created_at AS last_at
             FROM chat_channels ch
             JOIN chat_members m ON m.channel_id = ch.id AND m.user_id = $1
             LEFT JOIN LATERAL (SELECT u.name, u.role FROM chat_members cm JOIN users u ON u.id = cm.user_id
                                 WHERE cm.channel_id = ch.id AND cm.user_id <> $1 AND ch.kind = 'dm' LIMIT 1) o ON true
             LEFT JOIN LATERAL (SELECT x.body, u.name AS user_name, x.created_at FROM chat_messages x LEFT JOIN users u ON u.id = x.user_id
                                 WHERE x.channel_id = ch.id AND x.deleted_at IS NULL ORDER BY x.seq DESC LIMIT 1) lm ON true
            ORDER BY ch.last_message_at DESC`,
          [req.user.sub],
        )
      ).rows,
    })),
  );

  app.get('/api/chat/unread', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      unread: (
        await c.query(
          `SELECT count(*)::int AS n FROM chat_members m WHERE m.user_id = $1 AND EXISTS (
             SELECT 1 FROM chat_messages x WHERE x.channel_id = m.channel_id AND x.seq > m.last_read_seq AND x.user_id IS DISTINCT FROM $1 AND x.deleted_at IS NULL)`,
          [req.user.sub],
        )
      ).rows[0].n,
    })),
  );

  // Who I can start a direct message with: crew can reach coordinators and admins; staff can reach everyone.
  app.get('/api/chat/people', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      people: (
        await c.query(
          `SELECT id, name, role FROM users WHERE active AND id <> $1 AND ($2 OR role IN ('admin','manager')) ORDER BY role, name`,
          [req.user.sub, isStaff(req.user.role)],
        )
      ).rows,
    })),
  );

  // ---------- create ----------
  app.post('/api/chat/dm', { preHandler: authenticate }, async (req, reply) => {
    const { userId } = z.object({ userId: uuid }).parse(req.body);
    if (userId === req.user.sub) return reply.code(400).send({ error: 'You cannot message yourself' });
    const out = await withTenant(req.user.tid, async (c) => {
      const other = (await c.query('SELECT id, role FROM users WHERE id = $1 AND active', [userId])).rows[0];
      if (!other || (!isStaff(req.user.role) && !isStaff(other.role))) return { code: 404, error: 'Person not found' };
      const key = [req.user.sub, userId].sort().join(':');
      let ch = (await c.query("SELECT id FROM chat_channels WHERE kind = 'dm' AND dm_key = $1", [key])).rows[0];
      if (!ch) {
        ch = (await c.query("INSERT INTO chat_channels (tenant_id, kind, dm_key, created_by) VALUES ($1,'dm',$2,$3) RETURNING id", [req.user.tid, key, req.user.sub])).rows[0];
        await addMembers(c, req.user.tid, ch.id, [req.user.sub, userId]);
      }
      return { code: 200, id: ch.id as string };
    });
    const { code, ...body } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(body);
  });

  app.post('/api/chat/channels', { preHandler: staff }, async (req, reply) => {
    const b = z.object({
      name: z.string().trim().min(1).max(80).optional(),
      memberIds: z.array(uuid).max(200).default([]),
      eventId: uuid.optional(),
    }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      if (b.eventId) {
        const ev = (await c.query('SELECT id, name FROM events WHERE id = $1', [b.eventId])).rows[0];
        if (!ev) return { code: 404, error: 'Event not found' };
        const existing = (await c.query("SELECT id FROM chat_channels WHERE kind = 'event' AND event_id = $1", [b.eventId])).rows[0];
        if (existing) {
          await addMembers(c, req.user.tid, existing.id, [req.user.sub]);
          return { code: 200, id: existing.id as string };
        }
        const ch = (
          await c.query("INSERT INTO chat_channels (tenant_id, kind, name, event_id, created_by) VALUES ($1,'event',$2,$3,$4) RETURNING id", [req.user.tid, b.name ?? ev.name, b.eventId, req.user.sub])
        ).rows[0];
        const crew = (
          await c.query(
            `SELECT DISTINCT a.user_id FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = $1 AND a.status <> 'declined'`,
            [b.eventId],
          )
        ).rows.map((r) => r.user_id as string);
        await addMembers(c, req.user.tid, ch.id, [req.user.sub, ...crew]);
        await audit(c, req.user.tid, req.user.sub, 'chat.event_channel', 'event', b.eventId);
        return { code: 201, id: ch.id as string };
      }
      if (!b.name) return { code: 400, error: 'Give the channel a name' };
      const ch = (await c.query("INSERT INTO chat_channels (tenant_id, kind, name, created_by) VALUES ($1,'group',$2,$3) RETURNING id", [req.user.tid, b.name, req.user.sub])).rows[0];
      await addMembers(c, req.user.tid, ch.id, [req.user.sub, ...b.memberIds]);
      return { code: 201, id: ch.id as string };
    });
    const { code, ...body } = out as { code: number; [k: string]: unknown };
    return reply.code(code).send(body);
  });

  // ---------- one channel: details and members ----------
  app.get('/api/chat/channels/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const ch = await myChannel(c, id, req.user.sub);
      if (!ch) return null;
      const members = (await c.query('SELECT u.id, u.name, u.role FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1 ORDER BY u.role, u.name', [id])).rows;
      const title = ch.kind === 'dm' ? members.find((m) => m.id !== req.user.sub)?.name ?? 'Direct message' : ch.name;
      return { channel: { id: ch.id, kind: ch.kind, name: title, eventId: ch.event_id, muted: ch.muted, canManage: isStaff(req.user.role) && ch.kind !== 'dm' }, members };
    });
    return out ?? reply.code(404).send({ error: 'Conversation not found' });
  });

  app.post('/api/chat/channels/:id/members', { preHandler: staff }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { userIds } = z.object({ userIds: z.array(uuid).min(1).max(200) }).parse(req.body);
    const ok = await withTenant(req.user.tid, async (c) => {
      const ch = await myChannel(c, id, req.user.sub);
      if (!ch || ch.kind === 'dm') return false;
      await addMembers(c, req.user.tid, id, userIds);
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Conversation not found' });
  });

  app.delete('/api/chat/channels/:id/members/:userId', { preHandler: authenticate }, async (req, reply) => {
    const { id, userId } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    const ok = await withTenant(req.user.tid, async (c) => {
      const ch = await myChannel(c, id, req.user.sub);
      if (!ch || ch.kind === 'dm') return false;
      if (userId !== req.user.sub && !isStaff(req.user.role)) return false;
      await c.query('DELETE FROM chat_members WHERE channel_id = $1 AND user_id = $2', [id, userId]);
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Not found' });
  });

  app.patch('/api/chat/channels/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ muted: z.boolean() }).parse(req.body);
    const n = await withTenant(req.user.tid, async (c) => (await c.query('UPDATE chat_members SET muted = $3 WHERE channel_id = $1 AND user_id = $2', [id, req.user.sub, b.muted])).rowCount);
    return n ? { ok: true } : reply.code(404).send({ error: 'Conversation not found' });
  });

  // ---------- messages ----------
  // `before=<seq>` pages back through history; `after=<seq>` fetches what is new since the last poll.
  app.get('/api/chat/channels/:id/messages', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ before: z.coerce.number().int().optional(), after: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const out = await withTenant(req.user.tid, async (c) => {
      if (!(await myChannel(c, id, req.user.sub))) return null;
      const rows = (
        await c.query(
          `SELECT x.id, x.seq::int AS seq, x.user_id, u.name AS user_name, u.role AS user_role, x.created_at, x.deleted_at IS NOT NULL AS deleted,
                  CASE WHEN x.deleted_at IS NULL THEN x.body ELSE '' END AS body
             FROM chat_messages x LEFT JOIN users u ON u.id = x.user_id
            WHERE x.channel_id = $1 AND ($2::bigint IS NULL OR x.seq < $2) AND ($3::bigint IS NULL OR x.seq > $3)
            ORDER BY x.seq ${q.after != null ? 'ASC' : 'DESC'} LIMIT $4`,
          [id, q.before ?? null, q.after ?? null, q.limit],
        )
      ).rows;
      if (q.after == null) rows.reverse();
      return { messages: rows, hasMore: q.after == null && rows.length === q.limit };
    });
    return out ?? reply.code(404).send({ error: 'Conversation not found' });
  });

  app.post('/api/chat/channels/:id/messages', { preHandler: authenticate, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const ch = await myChannel(c, id, req.user.sub);
      if (!ch) return null;
      const msg = (
        await c.query('INSERT INTO chat_messages (tenant_id, channel_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING id, seq::int AS seq, created_at', [req.user.tid, id, req.user.sub, body])
      ).rows[0];
      await c.query('UPDATE chat_channels SET last_message_at = now() WHERE id = $1', [id]);
      await c.query('UPDATE chat_members SET last_read_seq = $3 WHERE channel_id = $1 AND user_id = $2', [id, req.user.sub, msg.seq]);

      // Bell + browser push, quietly: the first unread message in a conversation notifies; further ones just refresh the entry.
      const others = (
        await c.query('SELECT m.user_id FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1 AND m.user_id <> $2 AND NOT m.muted AND u.active', [id, req.user.sub])
      ).rows.map((r) => r.user_id as string);
      const title = ch.kind === 'dm' ? req.user.name : `${req.user.name} in ${ch.name}`;
      const preview = body.length > 160 ? body.slice(0, 157) + '…' : body;
      const fresh: string[] = [];
      for (const uid of others) {
        const upd = await c.query(
          "UPDATE notifications SET title = $3, body = $4, created_at = now() WHERE user_id = $1 AND category = 'chat' AND link = $2 AND read_at IS NULL",
          [uid, chatLink(id), title, preview],
        );
        if (!upd.rowCount) fresh.push(uid);
      }
      await notify(c, req.user.tid, fresh.map((uid) => ({ userId: uid, category: 'chat' as const, title, body: preview, link: chatLink(id), quiet: true })));
      return { message: { id: msg.id, seq: msg.seq, user_id: req.user.sub, user_name: req.user.name, user_role: req.user.role, created_at: msg.created_at, deleted: false, body } };
    });
    return out ?? reply.code(404).send({ error: 'Conversation not found' });
  });

  app.post('/api/chat/channels/:id/read', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ok = await withTenant(req.user.tid, async (c) => {
      if (!(await myChannel(c, id, req.user.sub))) return false;
      await c.query(
        'UPDATE chat_members SET last_read_seq = COALESCE((SELECT max(seq) FROM chat_messages WHERE channel_id = $1), 0) WHERE channel_id = $1 AND user_id = $2',
        [id, req.user.sub],
      );
      await c.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND category = 'chat' AND link = $2 AND read_at IS NULL", [req.user.sub, chatLink(id)]);
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Conversation not found' });
  });

  // Authors can delete their own messages; coordinators and admins can delete anyone's in conversations they are in.
  app.delete('/api/chat/messages/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ok = await withTenant(req.user.tid, async (c) => {
      const m = (await c.query('SELECT channel_id, user_id FROM chat_messages WHERE id = $1 AND deleted_at IS NULL', [id])).rows[0];
      if (!m || !(await myChannel(c, m.channel_id, req.user.sub))) return false;
      if (m.user_id !== req.user.sub && !isStaff(req.user.role)) return false;
      await c.query('UPDATE chat_messages SET deleted_at = now() WHERE id = $1', [id]);
      await audit(c, req.user.tid, req.user.sub, 'chat.delete', 'chat_message', id);
      return true;
    });
    return ok ? { ok: true } : reply.code(404).send({ error: 'Message not found' });
  });
}
