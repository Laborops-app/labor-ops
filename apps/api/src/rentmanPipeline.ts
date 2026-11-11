import type { PoolClient } from 'pg';
import { pool, withTenant, audit } from './db';
import { checkOpenRequests, customerForRentman, getAll, getToken, pullCustomers, refId, syncProjects } from './rentman';
import { setStatus, type PipelineStatus } from './pipeline';
import { notify, type NotifyInput } from './notify';
import { buildFromRentman } from './rentmanBuild';

/**
 * Rentman projects in the pipeline. Rentman keeps a project's status on its subprojects, under status names each
 * company sets up ("Option", "Confirmed", "Canceled", ...). The names are read as a pipeline stage; new projects become
 * events at that stage, and linked events move forward when Rentman does. Changes that could cost money (canceling
 * an event with confirmed crew, moving the dates of an event that already has shifts) are left to a coordinator,
 * who is told once.
 */
export type Kind = 'pending' | 'quote' | 'confirmed' | 'canceled';
const RANK: Record<string, number> = { pending: 1, quote: 2, confirmed: 3, in_progress: 4, completed: 5 };

/** What a Rentman status name means for the pipeline (null = can't tell). */
export function statusKind(name: string | null | undefined): Kind | null {
  const n = String(name ?? '').toLowerCase();
  if (!n) return null;
  if (/cancel|annul|lost|declin|rejected|void/.test(n)) return 'canceled';
  if (/confirm|prepped|prepar|packed|on location|on site|onsite|returned|ready|booked|definit|final|won/.test(n)) return 'confirmed';
  if (/option|quot|offer|pending|tentativ|on hold|hold|proposal|sent/.test(n)) return 'quote';
  if (/inquir|enquir|request|concept|draft|new|lead|prospect/.test(n)) return 'pending';
  return null;
}

/** Read every subproject's status and store each project's: all canceled → canceled; else the furthest along. */
export async function syncStatuses(c: PoolClient, token: string) {
  const [subs, statuses] = await Promise.all([getAll(token, '/subprojects').catch(() => [] as any[]), getAll(token, '/statuses').catch(() => [] as any[])]);
  if (!subs.length) return 0;
  const names = new Map<number, string>(statuses.map((s: any) => [Number(s.id), String(s.displayname || s.name || '')]));
  const byProject = new Map<number, { name: string; kind: Kind | null; order: number }[]>();
  for (const s of subs) {
    const pid = refId(s.project);
    if (pid === null) continue;
    const name = names.get(refId(s.status) ?? -1) ?? (typeof s.status === 'string' && !s.status.startsWith('/') ? s.status : '');
    const list = byProject.get(pid) ?? [];
    list.push({ name, kind: statusKind(name), order: Number.isFinite(Number(s.order)) ? Number(s.order) : list.length });
    byProject.set(pid, list);
  }
  const ids: number[] = [], snames: (string | null)[] = [], kinds: (string | null)[] = [];
  for (const [pid, list] of byProject) {
    const live = list.filter((x) => x.kind !== 'canceled');
    let pick: { name: string; kind: Kind | null } | undefined;
    if (!live.length) pick = list.sort((a, b) => a.order - b.order)[0];
    else pick = [...live].sort((a, b) => (RANK[b.kind ?? ''] ?? 0) - (RANK[a.kind ?? ''] ?? 0) || a.order - b.order)[0];
    ids.push(pid);
    snames.push(pick?.name || null);
    kinds.push(pick?.kind ?? null);
  }
  await c.query(
    `UPDATE rentman_projects p SET status_name = x.name, status_kind = x.kind
       FROM unnest($1::int[], $2::text[], $3::text[]) AS x(id, name, kind) WHERE p.id = x.id`,
    [ids, snames, kinds],
  );
  return ids.length;
}

export type PipelineSettings = { autoEvents: boolean; fromDate: string | null; skipCanceled: boolean; buildShifts: boolean; lastRunAt: string | null; lastResult: RunResult | null };
export type RunResult = { created: number; moved: number; datesUpdated: number; flagged: number; skipped: number; built?: number; shiftChanges?: number; errors?: string };

export async function loadPipelineSettings(c: PoolClient): Promise<PipelineSettings> {
  const r = (await c.query("SELECT auto_events, to_char(from_date, 'YYYY-MM-DD') AS from_date, skip_canceled, build_shifts, last_run_at, last_result FROM rentman_settings LIMIT 1")).rows[0];
  return { autoEvents: !!r?.auto_events, fromDate: r?.from_date ?? null, skipCanceled: r ? !!r.skip_canceled : true, buildShifts: r ? !!r.build_shifts : true, lastRunAt: r?.last_run_at ?? null, lastResult: r?.last_result ?? null };
}
export async function savePipelineSettings(c: PoolClient, tid: string, by: string, s: { autoEvents: boolean; fromDate: string | null; skipCanceled: boolean; buildShifts: boolean }) {
  await c.query(
    `INSERT INTO rentman_settings (tenant_id, auto_events, from_date, skip_canceled, build_shifts, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id) DO UPDATE SET auto_events = $2, from_date = $3, skip_canceled = $4, build_shifts = $5, updated_by = $6, updated_at = now()`,
    [tid, s.autoEvents, s.fromDate, s.skipCanceled, s.buildShifts, by],
  );
}

const staff = async (c: PoolClient) => (await c.query("SELECT id FROM users WHERE active AND role IN ('admin', 'manager')")).rows.map((r) => r.id as string);

/** New Rentman projects become events; linked events follow Rentman's status and dates where that is safe. */
export async function applyToPipeline(c: PoolClient, tid: string, token?: string): Promise<RunResult> {
  const s = await loadPipelineSettings(c);
  const out: RunResult = { created: 0, moved: 0, datesUpdated: 0, flagged: 0, skipped: 0 };
  const tz = (await c.query('SELECT timezone FROM tenants LIMIT 1')).rows[0]?.timezone ?? 'UTC';
  const msgs: NotifyInput[] = [];
  const people = await staff(c);
  const tell = (title: string, body: string, eventId: string) => people.forEach((userId) => msgs.push({ userId, category: 'approval_request', title, body, link: `/events/${eventId}` }));

  // ---- new projects → events ----
  if (s.autoEvents) {
    const fresh = (
      await c.query(
        `SELECT p.*, to_char((COALESCE(p.usageperiod_start, p.planperiod_start) AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS sd,
                to_char((COALESCE(p.usageperiod_end, p.planperiod_end, p.usageperiod_start, p.planperiod_start) AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS ed,
                lc.address AS loc_address
           FROM rentman_projects p LEFT JOIN rentman_contacts lc ON lc.id = p.location_id
          WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.rentman_project_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM rentman_imports i WHERE i.project_id = p.id)
            AND COALESCE(p.usageperiod_end, p.planperiod_end, p.usageperiod_start, p.planperiod_start) IS NOT NULL
            AND (COALESCE(p.usageperiod_end, p.planperiod_end, p.usageperiod_start, p.planperiod_start) AT TIME ZONE $1)::date >= COALESCE($2::date, current_date)
            AND NOT ($3 AND p.status_kind IS NOT DISTINCT FROM 'canceled')
          ORDER BY COALESCE(p.usageperiod_start, p.planperiod_start) LIMIT 200`,
        [tz, s.fromDate, s.skipCanceled],
      )
    ).rows;
    for (const p of fresh) {
      if (!p.sd) { out.skipped++; continue; }
      const cust = p.customer_id ? await customerForRentman(c, tid, Number(p.customer_id)) : null;
      const status: PipelineStatus = (p.status_kind as PipelineStatus | null) ?? 'pending';
      const ev = (
        await c.query(
          `INSERT INTO events (tenant_id, name, client, venue, address, start_date, end_date, notes, rentman_project_id, customer_id, pipeline_status, priority, board_position, rentman_seen)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'medium', (SELECT COALESCE(min(board_position), 1) - 1 FROM events WHERE pipeline_status = $11), $12) RETURNING id`,
          [tid, p.name, cust?.name ?? p.customer ?? null, p.location ?? null, p.loc_address ?? null, p.sd, p.ed < p.sd ? p.sd : p.ed,
           `From Rentman project ${p.number ?? p.id}${p.status_name ? ` (${p.status_name})` : ''}.`, p.id, cust?.id ?? null, status, `${p.sd}|${p.ed}`],
        )
      ).rows[0];
      await c.query('INSERT INTO event_status_log (tenant_id, event_id, from_status, to_status, reason) VALUES ($1,$2,NULL,$3,$4)', [tid, ev.id, status, `Pulled from Rentman${p.status_name ? `: ${p.status_name}` : ''}`]);
      await c.query('INSERT INTO rentman_imports (tenant_id, project_id, event_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [tid, p.id, ev.id]);
      // Its days and shifts from Rentman's crew and transport, kept in step from then on.
      if (s.buildShifts) await c.query('UPDATE events SET rentman_build = true WHERE id = $1', [ev.id]);
      await audit(c, tid, null, 'event.rentman_import', 'event', ev.id, { project: p.id, status });
      out.created++;
    }
  }

  // ---- linked events follow Rentman ----
  const linked = (
    await c.query(
      `SELECT e.id, e.name, e.pipeline_status, to_char(e.start_date, 'YYYY-MM-DD') AS start_date, to_char(e.end_date, 'YYYY-MM-DD') AS end_date, e.rentman_seen,
              p.status_kind, p.status_name, p.number,
              to_char((COALESCE(p.usageperiod_start, p.planperiod_start) AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS sd,
              to_char((COALESCE(p.usageperiod_end, p.planperiod_end, p.usageperiod_start, p.planperiod_start) AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS ed,
              EXISTS (SELECT 1 FROM shifts s WHERE s.event_id = e.id) AS has_shifts,
              EXISTS (SELECT 1 FROM event_phases ph WHERE ph.event_id = e.id) AS has_phases,
              EXISTS (SELECT 1 FROM shift_assignments a JOIN shifts s ON s.id = a.shift_id WHERE s.event_id = e.id AND a.status = 'accepted' AND s.ends_at > now()) AS has_crew
         FROM events e JOIN rentman_projects p ON p.id = e.rentman_project_id
        WHERE e.archived_at IS NULL AND e.pipeline_status IN ('pending', 'quote', 'confirmed', 'in_progress')`,
      [tz],
    )
  ).rows;
  for (const e of linked) {
    // What was last told or applied: "<start>|<end>" of Rentman's dates, then "#canceled" once a cancel was flagged.
    let [seenDates, seenFlag] = [(e.rentman_seen ?? '').split('#')[0], (e.rentman_seen ?? '').split('#')[1] ?? ''];
    // Status: forward only; canceled only when no confirmed crew would be cut (else ask a coordinator).
    if (e.status_kind === 'canceled' && e.pipeline_status !== 'in_progress') {
      if (!e.has_crew) {
        if (await setStatus(c, tid, e.id, 'canceled', null, `Canceled in Rentman${e.status_name ? ` (${e.status_name})` : ''}`)) out.moved++;
        continue;
      }
      if (seenFlag !== 'canceled') {
        tell(`Rentman canceled ${e.name}`, `Rentman project ${e.number ?? ''} is ${e.status_name ?? 'canceled'}, but the event has confirmed crew. Cancel it in LaborOps if it is really off (short-notice cuts are paid under the event's work rules).`, e.id);
        seenFlag = 'canceled';
        out.flagged++;
      }
    } else if (e.status_kind && e.status_kind !== 'canceled' && (RANK[e.status_kind] ?? 0) > (RANK[e.pipeline_status] ?? 0)) {
      if (await setStatus(c, tid, e.id, e.status_kind as PipelineStatus, null, `Rentman: ${e.status_name ?? e.status_kind}`)) out.moved++;
    }
    // Dates: changed in Rentman. Move them when the event has nothing scheduled yet; otherwise tell a coordinator once.
    if (e.sd && e.ed && (e.sd !== e.start_date || e.ed !== e.end_date)) {
      const sig = `${e.sd}|${e.ed}`;
      if (!e.has_shifts && !e.has_phases) {
        await c.query('UPDATE events SET start_date = $2, end_date = $3 WHERE id = $1', [e.id, e.sd, e.ed < e.sd ? e.sd : e.ed]);
        seenDates = sig;
        out.datesUpdated++;
      } else if (seenDates !== sig) {
        tell(`Rentman moved ${e.name}`, `Rentman project ${e.number ?? ''} now runs ${e.sd}${e.ed !== e.sd ? ` to ${e.ed}` : ''}; the event is ${e.start_date}${e.end_date !== e.start_date ? ` to ${e.end_date}` : ''}. Move the event's days if the shifts should follow.`, e.id);
        seenDates = sig;
        out.flagged++;
      }
    }
    const seen = seenDates + (seenFlag ? `#${seenFlag}` : '');
    if (seen !== (e.rentman_seen ?? '')) await c.query('UPDATE events SET rentman_seen = $2 WHERE id = $1', [e.id, seen]);
  }
  // ---- days and shifts follow Rentman's crew and transport (events set to build) ----
  if (token) {
    const building = (
      await c.query(
        `SELECT e.id, e.name, e.rentman_build_seen FROM events e
          WHERE e.rentman_build AND e.rentman_project_id IS NOT NULL AND e.archived_at IS NULL
            AND e.pipeline_status NOT IN ('completed', 'canceled') AND e.end_date >= current_date - 1
          ORDER BY e.start_date LIMIT 60`,
      )
    ).rows;
    out.built = 0;
    out.shiftChanges = 0;
    for (const e of building) {
      await c.query('SAVEPOINT build');
      try {
        const r = await buildFromRentman(c, tid, null, e.id, token, { apply: true });
        await c.query('RELEASE SAVEPOINT build');
        out.built++;
        out.shiftChanges += (r.result?.added ?? 0) + (r.result?.updated ?? 0) + (r.result?.removed ?? 0);
        // Changes that need a person (shift staffed or edited here): tell coordinators once per set of changes.
        const sig = r.plan.conflicts.map((x) => `${x.key}:${x.kind}:${x.rentman?.hash ?? ''}`).sort().join(',');
        if (sig !== (e.rentman_build_seen ?? '')) {
          if (r.plan.conflicts.length) {
            tell(`Rentman changed shifts on ${e.name}`, `${r.plan.conflicts.length} shift${r.plan.conflicts.length === 1 ? '' : 's'} changed or removed in Rentman ${r.plan.conflicts.length === 1 ? 'has' : 'have'} crew on ${r.plan.conflicts.length === 1 ? 'it' : 'them'} or ${r.plan.conflicts.length === 1 ? 'was' : 'were'} edited here. Review them on the event's Rentman panel.`, e.id);
            out.flagged++;
          }
          await c.query('UPDATE events SET rentman_build_seen = $2 WHERE id = $1', [e.id, sig]);
        }
      } catch {
        await c.query('ROLLBACK TO SAVEPOINT build');
      }
    }
  }
  if (msgs.length) await notify(c, tid, msgs);
  return out;
}

/** The whole pull for one company: projects, customers, statuses, accepted requests, then the pipeline. */
export async function pullRentman(c: PoolClient, tid: string, token: string) {
  const projects = await syncProjects(c, tid, token);
  const customers = await pullCustomers(c, tid, token);
  const linked = await checkOpenRequests(c, tid, token);
  const statuses = await syncStatuses(c, token);
  const pipeline = await applyToPipeline(c, tid, token);
  await c.query('UPDATE rentman_settings SET last_run_at = now(), last_result = $1', [JSON.stringify(pipeline)]);
  return { projects, customers, linked, statuses, pipeline };
}

/** Background: every company that has turned on pulling Rentman projects into the pipeline. */
export async function runRentmanPipeline() {
  const { rows } = await pool.query('SELECT id FROM notify_tenants()');
  for (const t of rows) {
    await withTenant(t.id, async (c) => {
      const s = await loadPipelineSettings(c);
      if (!s.autoEvents) return;
      const token = await getToken(c);
      if (!token) return;
      try {
        await pullRentman(c, t.id, token);
      } catch (e) {
        await c.query('UPDATE rentman_settings SET last_run_at = now(), last_result = $1', [JSON.stringify({ created: 0, moved: 0, datesUpdated: 0, flagged: 0, skipped: 0, errors: (e as Error).message })]);
      }
    }).catch((e) => console.error('rentman pipeline', t.id, e?.message ?? e));
  }
}
