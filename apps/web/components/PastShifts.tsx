'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtTime } from '@/lib/api';
import { Banner, Empty, Pill } from '@/components/ui';

type Past = { assignment_id: string; role_name: string; event_name: string; venue: string | null; starts_at: string; ends_at: string; is_lead?: boolean; no_show_at: string | null; worked: number; time_status: string | null };

/** Shifts already over, newest first: hours worked and whether the time is approved. Loads 30 at a time. */
export default function PastShifts() {
  const [list, setList] = useState<Past[] | null>(null);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = async (before?: string) => {
    setBusy(true);
    try {
      const r = await api<{ shifts: Past[]; more: boolean }>(`/api/my/shifts/past${before ? `?before=${encodeURIComponent(before)}` : ''}`);
      setList((l) => (before && l ? [...l, ...r.shifts] : r.shifts));
      setMore(r.more);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    load();
  }, []);
  if (error) return <Banner>{error}</Banner>;
  if (!list) return <div className="muted">Loading…</div>;
  if (!list.length) return <Empty>No past shifts yet.</Empty>;
  return (
    <section className="card past-shifts">
      <ul className="past-list">
        {list.map((s) => (
          <li key={s.assignment_id}>
            <div className="past-main">
              <Link href={`/my-shifts/${s.assignment_id}`} className="shift-link"><b>{s.role_name}</b></Link>
              {s.is_lead && <span className="chip lead-chip">★ Lead</span>}
              <div className="small">{s.event_name}</div>
              <div className="muted small">{fmtDate(s.starts_at)} · {fmtTime(s.starts_at)} – {fmtTime(s.ends_at)}</div>
            </div>
            <div className="past-side">
              <b className="small">{s.worked ? `${s.worked.toFixed(2)} h` : '—'}</b>
              {s.time_status ? <Pill status={s.time_status} /> : s.no_show_at ? <span className="chip warn">No-show</span> : <span className="muted small">No time</span>}
            </div>
          </li>
        ))}
      </ul>
      {more && (
        <button className="btn ghost small" disabled={busy} onClick={() => load(list[list.length - 1].starts_at)}>
          {busy ? 'Loading…' : 'Show older shifts'}
        </button>
      )}
    </section>
  );
}
