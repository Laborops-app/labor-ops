'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, fmtTime } from '@/lib/api';

type S = { assignment_id: string; status: string; role_name: string; starts_at: string; ends_at: string; event_name: string; venue: string | null };

const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const weekStart = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
};

const Chevron = ({ dir }: { dir: 'l' | 'r' }) => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={dir === 'l' ? 'm15 18-6-6 6-6' : 'm9 18 6-6-6-6'} />
  </svg>
);

function Body() {
  const [view, setView] = useState<'month' | 'week'>('month');
  const [anchor, setAnchor] = useState(() => new Date());
  const [shifts, setShifts] = useState<S[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const { start, days, title } = useMemo(() => {
    if (view === 'week') {
      const s = weekStart(anchor);
      const e = addDays(s, 6);
      const t =
        s.getMonth() === e.getMonth()
          ? `${s.toLocaleDateString([], { month: 'long' })} ${s.getDate()} – ${e.getDate()}, ${e.getFullYear()}`
          : `${s.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${e.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}`;
      return { start: s, days: 7, title: t };
    }
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const s = weekStart(first);
    const n = Math.ceil((((last.getTime() - s.getTime()) / 86400000) + 1) / 7) * 7;
    return { start: s, days: n, title: anchor.toLocaleDateString([], { month: 'long', year: 'numeric' }) };
  }, [view, anchor]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    const from = new Date(start);
    const to = addDays(start, days);
    api<{ shifts: S[] }>(`/api/my/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .then((r) => live && (setShifts(r.shifts), setError('')))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [start, days]);

  const byDay = useMemo(() => {
    const m = new Map<string, S[]>();
    for (const s of shifts) {
      const k = key(new Date(s.starts_at));
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return m;
  }, [shifts]);

  const todayKey = key(new Date());
  const step = (dir: number) => {
    const a = new Date(anchor);
    if (view === 'week') a.setDate(a.getDate() + 7 * dir);
    else a.setMonth(a.getMonth() + dir, 1);
    setAnchor(a);
  };
  const cells = Array.from({ length: days }, (_, i) => addDays(start, i));

  return (
    <>
      <div className="cal-bar">
        <h1>{title}</h1>
        <div className="seg" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'week'} className={view === 'week' ? 'active' : ''} onClick={() => setView('week')}>
            7-Day
          </button>
          <button role="tab" aria-selected={view === 'month'} className={view === 'month' ? 'active' : ''} onClick={() => setView('month')}>
            Monthly
          </button>
        </div>
        <div className="seg">
          <button onClick={() => step(-1)} aria-label="Previous">
            <Chevron dir="l" />
          </button>
          <button onClick={() => setAnchor(new Date())}>Go to Today</button>
          <button onClick={() => step(1)} aria-label="Next">
            <Chevron dir="r" />
          </button>
        </div>
        <span className="legend">
          <i className="d good" /> Confirmed <i className="d warn" /> Needs your reply / pending
        </span>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      <div className="cal-head" aria-hidden="true">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className={`cal-grid ${view} ${loading ? 'loading' : ''}`}>
        {cells.map((d) => {
          const k = key(d);
          const list = byDay.get(k) ?? [];
          const out = view === 'month' && d.getMonth() !== anchor.getMonth();
          return (
            <div key={k} className={`cal-cell ${k === todayKey ? 'today' : ''} ${out ? 'out' : ''} ${list.length === 0 ? 'no-ev' : ''}`}>
              <div className="cal-cell-h">
                <b>
                  {d.toLocaleDateString([], { weekday: 'short' }).toUpperCase()} {d.toLocaleDateString([], { month: 'short' })} {String(d.getDate()).padStart(2, '0')}
                </b>
                <small>{list.length ? `${list.length} shift${list.length === 1 ? '' : 's'}` : ''}</small>
              </div>
              {list.map((g) => (
                <Link key={g.assignment_id} href={`/my-shifts/${g.assignment_id}`} className={`ev-card ${g.status === 'accepted' ? 'good' : 'warn'}`}>
                  <b>{g.role_name}</b>
                  <span>{g.event_name}</span>
                  <span>
                    {fmtTime(g.starts_at)} – {fmtTime(g.ends_at)}
                  </span>
                  {g.venue && <span className="v">{g.venue}</span>}
                  {g.status !== 'accepted' && <span className="v">{g.status === 'pending' ? 'Waiting for approval' : 'Reply needed'}</span>}
                </Link>
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew', 'manager', 'admin']}>{() => <Body />}</Shell>;
}
