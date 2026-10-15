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
      `SELECT ch.id, ch.kind, ch.name, ch.event_id, ch.created_by, m.muted, m.cleared_seq::float AS cleared_seq FROM chat_channels ch
         JOIN chat_members m ON m.channel_id = ch.id AND m.user_id = $2 WHERE ch.id = $1`,
      [channelId, userId],
    )
  ).rows[0] as { id: string; kind: string; name: string | null; event_id: string | null; created_by: string | null; muted: boolean; cleared_seq: number } | undefined;
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

const MAX_FILE = 10 * 1024 * 1024;
/** The image type from the file's first bytes (PNG, JPEG, GIF, WebP), or null for anything else. */
function sniffImage(b: Buffer): string | null {
  if (b.length > 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a' || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
  if (b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}

/**
 * Store a message, move the conversation up the list, mark it read for the sender and tell the others:
 * bell + browser push, quietly; the first unread message in a conversation notifies, further ones refresh that entry.
 */
async function postMessage(c: PoolClient, me: { tid: string; sub: string; name: string }, ch: { id: string; kind: string; name: string | null }, body: string, preview: string) {
  const msg = (
    await c.query('INSERT INTO chat_messages (tenant_id, channel_id, user_id, body) VALUES ($1,$2,$3,$4) RETURNING id, seq::int AS seq, created_at', [me.tid, ch.id, me.sub, body])
  ).rows[0];
  await c.query('UPDATE chat_channels SET last_message_at = now() WHERE id = $1', [ch.id]);
  await c.query('UPDATE chat_members SET last_read_seq = $3, typing_at = NULL WHERE channel_id = $1 AND user_id = $2', [ch.id, me.sub, msg.seq]);
  const others = (
    await c.query('SELECT m.user_id FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1 AND m.user_id <> $2 AND NOT m.muted AND u.active', [ch.id, me.sub])
  ).rows.map((r) => r.user_id as string);
  const title = ch.kind === 'dm' ? me.name : `${me.name} in ${ch.name}`;
  const text = preview.length > 160 ? preview.slice(0, 157) + '…' : preview;
  const fresh: string[] = [];
  for (const uid of others) {
    const upd = await c.query(
      "UPDATE notifications SET title = $3, body = $4, created_at = now() WHERE user_id = $1 AND category = 'chat' AND link = $2 AND read_at IS NULL",
      [uid, chatLink(ch.id), title, text],
    );
    if (!upd.rowCount) fresh.push(uid);
  }
  await notify(c, me.tid, fresh.map((uid) => ({ userId: uid, category: 'chat' as const, title, body: text, link: chatLink(ch.id), quiet: true })));
  return msg as { id: string; seq: number; created_at: string };
}

export async function chatRoutes(app: FastifyInstance) {
  // ---------- channel list ----------
  app.get('/api/chat/channels', { preHandler: authenticate }, async (req) =>
    withTenant(req.user.tid, async (c) => ({
      channels: (
        await c.query(
          `SELECT ch.id, ch.kind, ch.event_id, m.muted, ch.last_message_at, m.pinned_at IS NOT NULL AS pinned,
                  CASE WHEN ch.kind = 'dm' THEN o.name ELSE ch.name END AS name,
                  o.role AS other_role, o.id AS other_id, COALESCE(o.last_seen_at > now() - interval '2 minutes', false) AS other_online,
                  lm.user_id = $1 AS last_mine, lm.has_file AS last_file,
                  -- the other side of a direct message has read my last message
                  (ch.kind = 'dm' AND lm.user_id = $1 AND EXISTS (SELECT 1 FROM chat_members om WHERE om.channel_id = ch.id AND om.user_id <> $1 AND om.last_read_seq >= lm.seq)) AS last_read,
                  (SELECT string_agg(tu.name, ', ') FROM chat_members t JOIN users tu ON tu.id = t.user_id
                    WHERE t.channel_id = ch.id AND t.user_id <> $1 AND t.typing_at > now() - interval '6 seconds') AS typing,
                  (SELECT count(*) FROM chat_members x WHERE x.channel_id = ch.id)::int AS member_count,
                  (SELECT count(*) FROM chat_messages x WHERE x.channel_id = ch.id AND x.seq > m.last_read_seq AND x.user_id IS DISTINCT FROM $1 AND x.deleted_at IS NULL)::int AS unread,
                  lm.body AS last_body, lm.user_name AS last_user, lm.created_at AS last_at
             FROM chat_channels ch
             JOIN chat_members m ON m.channel_id = ch.id AND m.user_id = $1
                  -- a conversation I deleted stays out of my list until someone writes again
                  AND (m.cleared_seq = 0 OR EXISTS (SELECT 1 FROM chat_messages z WHERE z.channel_id = ch.id AND z.seq > m.cleared_seq AND z.deleted_at IS NULL))
             LEFT JOIN LATERAL (SELECT u.id, u.name, u.role, u.last_seen_at FROM chat_members cm JOIN users u ON u.id = cm.user_id
                                 WHERE cm.channel_id = ch.id AND cm.user_id <> $1 AND ch.kind = 'dm' LIMIT 1) o ON true
             LEFT JOIN LATERAL (SELECT x.body, u.name AS user_name, x.created_at, x.user_id, x.seq,
                                        EXISTS (SELECT 1 FROM chat_attachments f WHERE f.message_id = x.id) AS has_file
                                 FROM chat_messages x LEFT JOIN users u ON u.id = x.user_id
                                 WHERE x.channel_id = ch.id AND x.deleted_at IS NULL AND x.seq > m.cleared_seq ORDER BY x.seq DESC LIMIT 1) lm ON true
            ORDER BY m.pinned_at IS NULL, m.pinned_at DESC, ch.last_message_at DESC`,
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
      const members = (
        await c.query(
          `SELECT u.id, u.name, u.role, u.last_seen_at, COALESCE(u.last_seen_at > now() - interval '2 minutes', false) AS online,
                  CASE WHEN $2 THEN u.email END AS email, CASE WHEN $2 THEN u.phone END AS phone
             FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1 ORDER BY u.role, u.name`,
          [id, isStaff(req.user.role)],
        )
      ).rows;
      const title = ch.kind === 'dm' ? members.find((m) => m.id !== req.user.sub)?.name ?? 'Direct message' : ch.name;
      const pinned = (await c.query('SELECT pinned_at IS NOT NULL AS p FROM chat_members WHERE channel_id = $1 AND user_id = $2', [id, req.user.sub])).rows[0]?.p ?? false;
      return {
        channel: { id: ch.id, kind: ch.kind, name: title, eventId: ch.event_id, muted: ch.muted, pinned, canManage: isStaff(req.user.role) && ch.kind !== 'dm' },
        members,
        online: members.filter((m) => m.online && m.id !== req.user.sub).length,
      };
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
    const b = z.object({ muted: z.boolean().optional(), pinned: z.boolean().optional() }).parse(req.body);
    const n = await withTenant(req.user.tid, async (c) =>
      (
        await c.query(
          `UPDATE chat_members SET muted = COALESCE($3, muted),
                  pinned_at = CASE WHEN $4::boolean IS NULL THEN pinned_at WHEN $4 THEN COALESCE(pinned_at, now()) ELSE NULL END
            WHERE channel_id = $1 AND user_id = $2`,
          [id, req.user.sub, b.muted ?? null, b.pinned ?? null],
        )
      ).rowCount,
    );
    return n ? { ok: true } : reply.code(404).send({ error: 'Conversation not found' });
  });

  // ---------- messages ----------
  // `before=<seq>` pages back through history; `after=<seq>` fetches what is new since the last poll.
  app.get('/api/chat/channels/:id/messages', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const q = z.object({ before: z.coerce.number().int().optional(), after: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).parse(req.query);
    const out = await withTenant(req.user.tid, async (c) => {
      const mine = await myChannel(c, id, req.user.sub);
      if (!mine) return null;
      const rows = (
        await c.query(
          `SELECT x.id, x.seq::int AS seq, x.user_id, u.name AS user_name, u.role AS user_role, x.created_at, x.deleted_at IS NOT NULL AS deleted,
                  CASE WHEN x.deleted_at IS NULL THEN x.body ELSE '' END AS body,
                  CASE WHEN x.deleted_at IS NULL THEN COALESCE((SELECT json_agg(json_build_object('id', f.id, 'filename', f.filename, 'kind', f.kind, 'size', f.size, 'content_type', f.content_type) ORDER BY f.created_at)
                    FROM chat_attachments f WHERE f.message_id = x.id), '[]'::json) ELSE '[]'::json END AS files
             FROM chat_messages x LEFT JOIN users u ON u.id = x.user_id
            WHERE x.channel_id = $1 AND ($2::bigint IS NULL OR x.seq < $2) AND ($3::bigint IS NULL OR x.seq > $3) AND x.seq > $5
            ORDER BY x.seq ${q.after != null ? 'ASC' : 'DESC'} LIMIT $4`,
          [id, q.before ?? null, q.after ?? null, q.limit, mine.cleared_seq],
        )
      ).rows;
      if (q.after == null) rows.reverse();
      // How far the others have read (for "Seen" on my messages), and who is typing right now.
      const others = (
        await c.query(
          `SELECT COALESCE(max(m.last_read_seq), 0)::int AS read_seq,
                  string_agg(u.name, ', ') FILTER (WHERE m.typing_at > now() - interval '6 seconds') AS typing
             FROM chat_members m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1 AND m.user_id <> $2`,
          [id, req.user.sub],
        )
      ).rows[0];
      return { messages: rows, hasMore: q.after == null && rows.length === q.limit, readSeq: others.read_seq, typing: others.typing ?? null };
    });
    return out ?? reply.code(404).send({ error: 'Conversation not found' });
  });

  app.post('/api/chat/channels/:id/messages', { preHandler: authenticate, config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(4000) }).parse(req.body);
    const out = await withTenant(req.user.tid, async (c) => {
      const ch = await myChannel(c, id, req.user.sub);
      if (!ch) return null;
      const msg = await postMessage(c, req.user, ch, body, body);
      return { message: { ...msg, user_id: req.user.sub, user_name: req.user.name, user_role: req.user.role, deleted: false, body, files: [] } };
    });
    return out ?? reply.code(404).send({ error: 'Conversation not found' });
  });

  // ---------- files and images ----------
  // The body is the raw file (any type up to 10 MB). Images show inline; everything else downloads.
  app.register(async (inst) => {
    inst.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: MAX_FILE }, (_req, body, done) => done(null, body));
    inst.post('/api/chat/channels/:id/files', { preHandler: authenticate, bodyLimit: MAX_FILE, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { id } = z.object({ id: uuid }).parse(req.params);
      const q = z.object({ filename: z.string().trim().min(1).max(200), caption: z.string().trim().max(4000).default('') }).parse(req.query);
      const data = req.body;
      if (!Buffer.isBuffer(data) || !data.length) return reply.code(400).send({ error: 'Choose a file (up to 10 MB)' });
      const filename = q.filename.replace(/[\\/\r\n"<>]/g, '_');
      const img = sniffImage(data);
      const out = await withTenant(req.user.tid, async (c) => {
        const ch = await myChannel(c, id, req.user.sub);
        if (!ch) return null;
        const preview = q.caption || `📎 ${filename}`;
        const msg = await postMessage(c, req.user, ch, q.caption, preview);
        const f = (
          await c.query(
            `INSERT INTO chat_attachments (tenant_id, channel_id, message_id, user_id, filename, content_type, kind, size, data)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, filename, kind, size, content_type`,
            [req.user.tid, id, msg.id, req.user.sub, filename, img ?? 'application/octet-stream', img ? 'image' : 'file', data.length, data],
          )
        ).rows[0];
        return { message: { ...msg, user_id: req.user.sub, user_name: req.user.name, user_role: req.user.role, deleted: false, body: q.caption, files: [f] } };
      });
      return out ?? reply.code(404).send({ error: 'Conversation not found' });
    });
  });

  // Download or show one file. Only members of the conversation can open it; deleted messages take their files with them.
  app.get('/api/chat/files/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { download } = z.object({ download: z.coerce.boolean().default(false) }).parse(req.query);
    const f = await withTenant(req.user.tid, async (c) => {
      const row = (
        await c.query(
          `SELECT f.filename, f.content_type, f.kind, f.data, f.channel_id FROM chat_attachments f JOIN chat_messages x ON x.id = f.message_id
            WHERE f.id = $1 AND x.deleted_at IS NULL`,
          [id],
        )
      ).rows[0];
      if (!row || !(await myChannel(c, row.channel_id, req.user.sub))) return null;
      return row;
    });
    if (!f) return reply.code(404).send({ error: 'File not found' });
    const inline = f.kind === 'image' && !download;
    reply.header('content-type', inline ? f.content_type : 'application/octet-stream');
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(f.filename)}"; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('cache-control', 'private, max-age=86400');
    return reply.send(f.data);
  });

  // The conversation's shared files, newest first (the details panel).
  app.get('/api/chat/channels/:id/files', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const out = await withTenant(req.user.tid, async (c) => {
      const mine = await myChannel(c, id, req.user.sub);
      if (!mine) return null;
      return {
        files: (
          await c.query(
            `SELECT f.id, f.filename, f.kind, f.size, f.created_at, u.name AS user_name FROM chat_attachments f
               JOIN chat_messages x ON x.id = f.message_id LEFT JOIN users u ON u.id = f.user_id
              WHERE f.channel_id = $1 AND x.deleted_at IS NULL AND x.seq > $2 ORDER BY f.created_at DESC LIMIT 100`,
            [id, mine.cleared_seq],
          )
        ).rows,
      };
    });
    return out ?? reply.code(404).send({ error: 'Conversation not found' });
  });

  // "Typing…": the composer pings this every few seconds while someone types.
  app.post('/api/chat/channels/:id/typing', { preHandler: authenticate, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const n = await withTenant(req.user.tid, async (c) => (await c.query('UPDATE chat_members SET typing_at = now() WHERE channel_id = $1 AND user_id = $2', [id, req.user.sub])).rowCount);
    return n ? { ok: true } : reply.code(404).send({ error: 'Conversation not found' });
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

  // Delete a conversation for me only: hides its history and takes it off my list until someone writes again.
  app.delete('/api/chat/channels/:id', { preHandler: authenticate }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const ok = await withTenant(req.user.tid, async (c) => {
      if (!(await myChannel(c, id, req.user.sub))) return false;
      await c.query(
        `UPDATE chat_members SET cleared_seq = COALESCE((SELECT max(seq) FROM chat_messages WHERE channel_id = $1), 0),
                last_read_seq = COALESCE((SELECT max(seq) FROM chat_messages WHERE channel_id = $1), 0)
          WHERE channel_id = $1 AND user_id = $2`,
        [id, req.user.sub],
      );
      await c.query("DELETE FROM notifications WHERE user_id = $1 AND category = 'chat' AND link = $2", [req.user.sub, chatLink(id)]);
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
