'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Check = { id: string; event_name: string; venue: string | null; dates: string[]; message: string | null; answered_at: string | null; free_dates: string[] | null };
const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

/** Crew: "Are you free?" questions from coordinators. Tick the days you can work; not a booking. */
export default function MyAvailChecks() {
  const [checks, setChecks] = useState<Check[]>([]);
  const [edit, setEdit] = useState<Record<string, Set<string>>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<{ checks: Check[] }>('/api/my/avail-checks').then((r) => setChecks(r.checks)).catch(() => undefined);
  useEffect(() => { load(); }, []);
  if (!checks.length) return null;

  const answer = async (k: Check, days: string[]) => {
    setBusy(k.id);
    setMsg('');
    try {
      await api(`/api/avail-checks/${k.id}/answer`, { body: { freeDates: days } });
      setMsg(days.length ? `Thanks: you said you're free ${days.length === k.dates.length ? 'every day' : `on ${days.map(short).join(', ')}`} for ${k.event_name}. You'll get an offer if you're picked.` : `Thanks: you're not free for ${k.event_name}.`);
      setOpen(null);
      await load();
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="card avail-ask" aria-label="Are you free?">
      <h2 style={{ marginTop: 0 }}>🙋 Are you free?</h2>
      {msg && <p className="small" role="status">{msg}</p>}
      {checks.map((k) => {
        const sel = edit[k.id] ?? new Set(k.free_dates ?? []);
        const editing = !k.answered_at || open === k.id;
        return (
          <div key={k.id} className="avail-q">
            <div>
              <b>{k.event_name}</b>
              {k.venue && <span className="muted small"> · {k.venue}</span>}
              {k.message && <div className="small">{k.message}</div>}
            </div>
            {!editing ? (
              <div className="row space small" style={{ flexWrap: 'wrap', gap: 6 }}>
                <span>
                  You said:{' '}
                  {k.free_dates?.length ? (k.free_dates.length === k.dates.length ? <b>free every day</b> : <b>free {k.free_dates.map(short).join(', ')}</b>) : <b>not free</b>}
                </span>
                <button type="button" className="btn ghost small" onClick={() => setOpen(k.id)}>Change</button>
              </div>
            ) : (
              <>
                <div className="day-chips" role="group" aria-label={`Days for ${k.event_name}`}>
                  {k.dates.map((d) => (
                    <button key={d} type="button" aria-pressed={sel.has(d)} className={`day-chip${sel.has(d) ? ' on' : ''}`}
                      onClick={() => { const n = new Set(sel); if (n.has(d)) n.delete(d); else n.add(d); setEdit({ ...edit, [k.id]: n }); }}>
                      {short(d)}
                    </button>
                  ))}
                </div>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {k.dates.length > 1 && <button type="button" className="btn primary" disabled={!!busy} onClick={() => answer(k, k.dates)}>Free all days</button>}
                  <button type="button" className={k.dates.length > 1 ? 'btn' : 'btn primary'} disabled={!!busy || (k.dates.length > 1 && !sel.size)} onClick={() => answer(k, k.dates.length > 1 ? [...sel] : k.dates)}>
                    {k.dates.length > 1 ? `Free on ${sel.size || 'the'} day${sel.size === 1 ? '' : 's'} I picked` : "I'm free"}
                  </button>
                  <button type="button" className="btn ghost" disabled={!!busy} onClick={() => answer(k, [])}>Not free</button>
                </div>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
