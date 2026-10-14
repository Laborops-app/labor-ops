'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { S, addDays, groupByEventDay, key, segments } from '@/lib/schedule';

const fmtMin = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export default function MonthView({ start, count, month, shifts, now, onOpenDay }: { start: Date; count: number; month: number; shifts: S[]; now: Date; onOpenDay: (d: Date) => void }) {
  const byDay = useMemo(() => {
    const m = new Map<string, ReturnType<typeof groupByEventDay>>();
    for (const g of groupByEventDay(segments(shifts))) m.set(g.day, [...(m.get(g.day) ?? []), g].sort((a, b) => a.startMin - b.startMin));
    return m;
  }, [shifts]);
  const todayKey = key(now);
  return (
    <>
      <div className="sx-mhead" aria-hidden="true">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
          <span key={d}>{d}</span>
        ))}
      </div>
      <div className="sx-mgrid">
        {Array.from({ length: count }, (_, i) => addDays(start, i)).map((d) => {
          const k = key(d);
          const gs = byDay.get(k) ?? [];
          const filled = gs.reduce((n, g) => n + g.filled, 0);
          const total = gs.reduce((n, g) => n + g.total, 0);
          return (
            <div key={k} className={`sx-mcell ${k === todayKey ? 'today' : ''} ${d.getMonth() !== month ? 'out' : ''}`}>
              <div className="d">
                {d.getDate()}
                {gs.length > 0 && (
                  <small>
                    {filled}/{total} filled
                  </small>
                )}
              </div>
              {gs.slice(0, 3).map((g) => (
                <Link key={g.id} href={`/events/${g.event_id}`} className={`sx-mev ${g.total === 0 || g.filled >= g.total ? 'good' : g.filled === 0 ? 'bad' : 'warn'}`}>
                  <b>{g.name}</b>
                  <span>
                    {fmtMin(g.startMin)} – {fmtMin(g.endMin)}
                  </span>
                </Link>
              ))}
              {gs.length > 3 && (
                <button className="sx-more" onClick={() => onOpenDay(d)}>
                  +{gs.length - 3} more
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}
