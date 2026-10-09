'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, fmtTime } from '@/lib/api';

type S = { id: string; role_name: string; starts_at: string; ends_at: string; headcount: number; event_id: string; event_name: string; venue: string | null; filled: number };
type Group = { event_id: string; name: string; venue: string | null; start: string; end: string; filled: number; total: number; shifts: number };

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
    api<{ shifts: S[] }>(`/api/calendar?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`)
      .then((r) => live && (setShifts(r.shifts), setError('')))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [start, days]);

  const byDay = useMemo(() => {
    const m = new Map<string, Map<string, Group>>();
    for (const s of shifts) {
      const k = key(new Date(s.starts_at));
      const day = m.get(k) ?? new Map<string, Group>();
      const g = day.get(s.event_id) ?? { event_id: s.event_id, name: s.event_name, venue: s.venue, start: s.starts_at, end: s.ends_at, filled: 0, total: 0, shifts: 0 };
      if (s.starts_at < g.start) g.start = s.starts_at;
      if (s.ends_at > g.end) g.end = s.ends_at;
      g.filled += Math.min(s.filled, s.headcount);
      g.total += s.headcount;
      g.shifts += 1;
      day.set(s.event_id, g);
      m.set(k, day);
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
          <i className="d good" /> Full <i className="d warn" /> Partly staffed <i className="d bad" /> Unstaffed
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
          const groups = [...(byDay.get(k)?.values() ?? [])];
          const total = groups.reduce((n, g) => n + g.total, 0);
          const filled = groups.reduce((n, g) => n + g.filled, 0);
          const out = view === 'month' && d.getMonth() !== anchor.getMonth();
          return (
            <div key={k} className={`cal-cell ${k === todayKey ? 'today' : ''} ${out ? 'out' : ''} ${groups.length === 0 ? 'no-ev' : ''}`}>
              <div className="cal-cell-h">
                <b>
                  {d.toLocaleDateString([], { weekday: 'short' }).toUpperCase()} {d.toLocaleDateString([], { month: 'short' })} {String(d.getDate()).padStart(2, '0')}
                </b>
                <small>
                  {groups.length} event{groups.length === 1 ? '' : 's'} | {filled}/{total} filled
                </small>
              </div>
              {groups.map((g) => {
                const tone = g.filled >= g.total ? 'good' : g.filled === 0 ? 'bad' : 'warn';
                return (
                  <Link key={g.event_id} href={`/events/${g.event_id}`} className={`ev-card ${tone}`}>
                    <b>{g.name}</b>
                    <span>
                      {fmtTime(g.start)} – {fmtTime(g.end)}
                    </span>
                    {g.venue && <span className="v">{g.venue}</span>}
                    <span className="dots" aria-label={`${g.filled} of ${g.total} filled`}>
                      {Array.from({ length: Math.min(g.total, 16) }, (_, i) => (
                        <i key={i} className={i < g.filled ? 'on' : ''} />
                      ))}
                    </span>
                  </Link>
                );
              })}
            </div>
          );
        })}
      </div>
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
