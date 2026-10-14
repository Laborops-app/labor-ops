import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTenant } from '../db';
import { loadRates, rateFor, loadRules, estimateShift } from '../pay';
import { readRespondToken, readClaimToken, respondToAssignment } from '../notify/respond';
import { claimShift } from './scheduling';

/** Public endpoints behind the Accept / Decline links in shift emails and chat. The signed token is the credential. */
export async function respondRoutes(app: FastifyInstance) {
  const limit = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  app.get('/api/respond/preview', { config: limit }, async (req, reply) => {
    const { t } = z.object({ t: z.string().max(600) }).parse(req.query);
    const claim = readClaimToken(t);
    if (claim) {
      const out = await withTenant(claim.tid, async (c) => {
        const r = await c.query(
          `SELECT s.id AS shift_id, u.name AS person, s.role_name, s.starts_at, s.ends_at, e.name AS event_name, e.venue, tn.timezone,
                  (s.ends_at <= now()) AS ended,
                  (s.is_open AND s.ends_at > now() AND (s.offer_group_id IS NULL OR EXISTS (SELECT 1 FROM crew_group_members gm WHERE gm.group_id = s.offer_group_id AND gm.user_id = u.id))
                   AND (SELECT count(*) FROM shift_assignments x WHERE x.shift_id = s.id AND x.status <> 'declined') < s.headcount) AS open,
                  (SELECT x.status FROM shift_assignments x WHERE x.shift_id = s.id AND x.user_id = u.id) AS mine
             FROM shifts s JOIN users u ON u.id = $2 AND u.active JOIN events e ON e.id = s.event_id JOIN tenants tn ON tn.id = s.tenant_id WHERE s.id = $1`,
          [claim.sid, claim.uid],
        );
        const row = r.rows[0];
        if (!row) return row;
        const pay = await estimateShift(c, await loadRules(c), await loadRates(c), row.role_name, row.starts_at, row.ends_at, claim.uid, row.shift_id);
        return { ...row, kind: 'claim', status: row.mine ?? 'open', hours: pay.hours, hourly_rate: pay.rate, estimated_pay: pay.estimate, pay_notes: pay.notes, pay_type: pay.payType };
      });
      if (!out) return reply.code(404).send({ error: 'This shift is no longer available.' });
      const reason = out.ended ? 'This shift has already ended.' : out.mine ? `You already asked for this shift (${out.mine}).` : !out.open ? 'This shift has been filled or is no longer open.' : null;
      return { shift: { ...out, canRespond: out.open && !out.mine, reason } };
    }
    const tok = readRespondToken(t);
    if (!tok) return reply.code(400).send({ error: 'This link is invalid or has expired. Open LaborOps to answer the shift.' });
    const out = await withTenant(tok.tid, async (c) => {
      const r = await c.query(
        `SELECT a.id AS assignment_id, a.status, s.id AS shift_id, u.name AS person, s.role_name, s.starts_at, s.ends_at, e.name AS event_name, e.venue, tn.timezone,
                (s.ends_at > now()) AS open, EXISTS (SELECT 1 FROM time_entries x WHERE x.assignment_id = a.id) AS worked
           FROM shift_assignments a JOIN users u ON u.id = a.user_id JOIN shifts s ON s.id = a.shift_id
           JOIN events e ON e.id = s.event_id JOIN tenants tn ON tn.id = s.tenant_id
          WHERE a.id = $1 AND a.user_id = $2`,
        [tok.aid, tok.uid],
      );
      const row = r.rows[0];
      if (!row) return row;
      const pay = await estimateShift(c, await loadRules(c), await loadRates(c), row.role_name, row.starts_at, row.ends_at, tok.uid, row.shift_id);
      return { ...row, hours: pay.hours, hourly_rate: pay.rate, estimated_pay: pay.estimate, pay_notes: pay.notes, pay_type: pay.payType };
    });
    if (!out) return reply.code(404).send({ error: 'This shift is no longer available.' });
    return { shift: { ...out, canRespond: out.open && !out.worked, reason: !out.open ? 'This shift has already ended.' : out.worked ? 'You have already clocked in for this shift.' : null } };
  });

  app.post('/api/respond', { config: limit }, async (req, reply) => {
    const b = z.object({ t: z.string().max(600), response: z.enum(['accepted', 'declined']) }).parse(req.body);
    const claim = readClaimToken(b.t);
    if (claim) {
      if (b.response === 'declined') return { status: 'passed' };
      const r = await withTenant(claim.tid, async (c) => {
        const u = (await c.query('SELECT id, name FROM users WHERE id = $1 AND active', [claim.uid])).rows[0];
        if (!u) return { code: 409, error: 'This shift can no longer be claimed.' } as { code: number; [k: string]: unknown };
        return claimShift(c, claim.tid, u, claim.sid);
      });
      if (r.code >= 400) return reply.code(r.code === 404 ? 409 : r.code).send({ error: r.error });
      return { status: 'accepted' };
    }
    const tok = readRespondToken(b.t);
    if (!tok) return reply.code(400).send({ error: 'This link is invalid or has expired. Open LaborOps to answer the shift.' });
    const out = await withTenant(tok.tid, async (c) => {
      const u = (await c.query('SELECT id, name FROM users WHERE id = $1 AND active', [tok.uid])).rows[0];
      if (!u) return null;
      return respondToAssignment(c, tok.tid, u, tok.aid, b.response, { notStarted: true });
    });
    if (!out) return reply.code(409).send({ error: 'This shift can no longer be changed. Contact your coordinator.' });
    return { status: out.status };
  });
}
