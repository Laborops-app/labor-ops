'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import { Phase, STAFF_LABEL, key, phaseBars, staffTone } from '@/lib/schedule';

/** All-day row under the day headers: one bar per event phase, spanning the days it covers. */
export default function PhaseRow({ days, phases, now }: { days: Date[]; phases: Phase[]; now: Date }) {
  const bars = useMemo(() => phaseBars(days, phases), [days, phases]);
  if (!bars.length) return null;
  const rows = Math.max(...bars.map((b) => b.row)) + 1;
  const todayKey = key(now);
  const fmt = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
  return (
    <div className="sx-row sx-phases" style={{ gridTemplateRows: `repeat(${rows}, 38px)` }} aria-label="Event phases">
      <div className="sx-phl" style={{ gridRow: `1 / span ${rows}` }}>Phases</div>
      {days.map((d, i) => (
        <div key={key(d)} className={`sx-phcell ${key(d) === todayKey ? 'today' : ''}`} style={{ gridColumn: i + 2, gridRow: `1 / span ${rows}` }} />
      ))}
      {bars.map((b) => {
        const p = b.phase;
        const span = p.starts_on.slice(0, 10) === p.ends_on.slice(0, 10) ? fmt(p.starts_on) : `${fmt(p.starts_on)} – ${fmt(p.ends_on)}`;
        const tone = staffTone(p.filled ?? 0, p.slots ?? 0);
        return (
          <Link
            key={p.id}
            href={`/events/${p.event_id}`}
            className={`sx-phbar ${tone} ${b.contL ? 'cl' : ''} ${b.contR ? 'cr' : ''}`}
            style={{ gridColumn: `${b.from + 2} / ${b.to + 3}`, gridRow: b.row + 1 }}
            title={`${p.label} · ${p.event_name} (${span}) · ${STAFF_LABEL[tone]}${p.slots ? ` · ${p.filled}/${p.slots} crew` : ''}`}
          >
            <span className="top">
              <b>{p.label}</b>
              {!!p.slots && <span className="cnt">{p.filled}/{p.slots}</span>}
            </span>
            <span>{p.event_name}</span>
          </Link>
        );
      })}
    </div>
  );
}
