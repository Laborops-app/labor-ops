'use client';
import { useEffect, useState } from 'react';
import { api, fmtTime } from '@/lib/api';

type W = { key: string; role: string; start: string; end: string; headcount: number; group: string | null };
type Conflict = {
  key: string; kind: 'changed' | 'removed'; shiftId: string; role: string; why: string;
  current: { role: string; start: string; end: string; headcount: number };
  rentman: (W & { hash: string; date: string }) | null;
};
type Build = {
  built: boolean; unmatched: string[]; unscheduled: number; unchanged: number;
  result: { added: number; updated: number; removed: number; unchanged: number; conflicts: number } | null;
  adds: W[]; updates: (W & { shiftId: string; headcountOnly: boolean })[]; removes: { shiftId: string; role: string; start: string }[]; conflicts: Conflict[];
};

const when = (s: string, e: string) => `${new Date(s).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(s)}–${fmtTime(e)}`;

/**
 * Days and shifts from the linked Rentman project's crew and transport: preview, build, then kept in step
 * (safe changes automatically; shifts with crew or edited here are listed to decide).
 */
export default function RentmanBuild({ eventId, onChanged, onError }: { eventId: string; onChanged: (msg: string) => void; onError: (m: string) => void }) {
  const [b, setB] = useState<Build | null>(null);
  const [busy, setBusy] = useState('');
  const [open, setOpen] = useState(false);
  const load = () => api<Build>(`/api/events/${eventId}/rentman/build`).then(setB).catch((e) => onError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);
  const run = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    onError('');
    try {
      const msg = await fn();
      await load();
      if (msg) onChanged(msg);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  if (!b) return <p className="muted small">Reading crew and transport from Rentman…</p>;
  const pending = b.adds.length + b.updates.length + b.removes.length;
  const build = () =>
    run('build', async () => {
      const r = await api<Build>(`/api/events/${eventId}/rentman/build`, { body: {} });
      const x = r.result!;
      return `From Rentman: ${x.added} shift${x.added === 1 ? '' : 's'} added, ${x.updated} updated, ${x.removed} removed${x.conflicts ? `; ${x.conflicts} to decide below` : ''}.`;
    });

  return (
    <div className="rm-build">
      <div className="row space" style={{ flexWrap: 'wrap', gap: 8 }}>
        <div>
          <h3 style={{ margin: 0 }}>Crew &amp; transport</h3>
          <p className="muted small" style={{ margin: '2px 0 0' }}>
            {b.built
              ? `Kept in step with Rentman every 30 minutes. ${b.unchanged} shift${b.unchanged === 1 ? '' : 's'} match Rentman.`
              : 'Build this event’s days and shifts from the project’s crew and transport functions. After that they stay in step with Rentman.'}
          </p>
        </div>
        <span className="row" style={{ gap: 6 }}>
          {(!b.built || pending > 0) && (
            <button type="button" className="btn primary small" disabled={!!busy || (b.built && !pending)} onClick={build}>
              {busy === 'build' ? 'Building…' : b.built ? `Apply ${pending} change${pending === 1 ? '' : 's'} now` : `Build ${b.adds.length} shift${b.adds.length === 1 ? '' : 's'} from Rentman`}
            </button>
          )}
          {b.built && (
            <button type="button" className="btn ghost small" disabled={!!busy} title="Shifts stay; Rentman changes stop coming in" onClick={() => confirm('Stop keeping this event’s shifts in step with Rentman? The shifts stay as they are.') && run('off', async () => { await api(`/api/events/${eventId}/rentman/build`, { method: 'DELETE' }); return 'This event no longer follows Rentman’s crew and transport.'; })}>
              Stop syncing
            </button>
          )}
        </span>
      </div>

      {b.unmatched.length > 0 && (
        <p className="small rm-unmatched">
          Not a LaborOps role yet: <b>{b.unmatched.join(', ')}</b>. Shifts keep Rentman’s name until you map {b.unmatched.length === 1 ? 'it' : 'them'} under Integrations › Rentman › Role names.
        </p>
      )}
      {b.unscheduled > 0 && <p className="muted small">{b.unscheduled} Rentman function{b.unscheduled === 1 ? ' has' : 's have'} no planning times yet and {b.unscheduled === 1 ? 'is' : 'are'} skipped.</p>}

      {pending > 0 && (
        <>
          <button type="button" className="btn ghost small" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide' : 'Show'} what {b.built ? 'changes' : 'gets built'}</button>
          {open && (
            <ul className="plain rm-plan">
              {b.adds.map((w) => <li key={`a${w.key}`}><span className="qc-chip match">Add</span> {w.headcount} × {w.role} · {when(w.start, w.end)}{w.group ? <span className="muted small"> · {w.group}</span> : null}</li>)}
              {b.updates.map((u) => <li key={`u${u.shiftId}`}><span className="qc-chip under">Update</span> {u.role} · {u.headcountOnly ? `${u.headcount} people` : `${u.headcount} × ${when(u.start, u.end)}`}</li>)}
              {b.removes.map((r) => <li key={`r${r.shiftId}`}><span className="qc-chip over">Remove</span> {r.role} · {new Date(r.start).toLocaleDateString()}</li>)}
            </ul>
          )}
        </>
      )}

      {b.conflicts.length > 0 && (
        <div className="rm-conflicts">
          <b className="small">Changed in Rentman: decide these ({b.conflicts.length})</b>
          <ul className="plain">
            {b.conflicts.map((x) => (
              <li key={x.key}>
                <div>
                  <b>{x.role}</b> <span className="muted small">· {x.why}</span>
                  <div className="small">
                    Here: {x.current.headcount} × {when(x.current.start, x.current.end)}
                    <br />
                    Rentman: {x.rentman ? `${x.rentman.headcount} × ${x.rentman.role !== x.current.role ? `${x.rentman.role} · ` : ''}${when(x.rentman.start, x.rentman.end)}` : 'removed'}
                  </div>
                </div>
                <span className="row" style={{ gap: 6 }}>
                  <button
                    type="button"
                    className="btn small"
                    disabled={!!busy}
                    title={x.rentman ? 'Change the shift to Rentman’s version (people on it are told)' : 'Delete the shift (people on it are told)'}
                    onClick={() =>
                      run(x.key, async () => {
                        if (x.rentman) {
                          await api(`/api/shifts/${x.shiftId}`, { method: 'PATCH', body: { roleName: x.rentman.role, startsAt: x.rentman.start, endsAt: x.rentman.end, ...(x.rentman.headcount !== x.current.headcount ? { headcount: x.rentman.headcount } : {}) } });
                          await api(`/api/events/${eventId}/rentman/build/keep`, { body: { key: x.key, hash: x.rentman.hash } });
                          return `${x.role} now matches Rentman.`;
                        }
                        if (!confirm(`Delete the ${x.role} shift? Everyone on it is told.`)) return;
                        await api(`/api/shifts/${x.shiftId}`, { method: 'DELETE' });
                        return `${x.role} shift deleted.`;
                      })
                    }
                  >
                    {x.rentman ? 'Use Rentman’s' : 'Delete shift'}
                  </button>
                  <button type="button" className="btn ghost small" disabled={!!busy} title="Keep the shift as it is here" onClick={() => run(x.key, async () => { await api(`/api/events/${eventId}/rentman/build/keep`, { body: { key: x.key, hash: x.rentman?.hash ?? null } }); return `Kept ${x.role} as it is here.`; })}>
                    Keep ours
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
