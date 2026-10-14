'use client';
import Link from 'next/link';
import { useMemo } from 'react';
import Ic from './Ic';
import { Group, HOUR_PX, fmtH, fmtMoney, groupByEventDay, hhmm, initials, isoWeek, key, lanes, minutesOfDay, S, segments } from '@/lib/schedule';

const fmtMin = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function Card({ g, seePay, style }: { g: Group; seePay: boolean; style: React.CSSProperties }) {
  const h = ((g.endMin - g.startMin) / 60) * HOUR_PX;
  const tone = g.total === 0 ? 'good' : g.filled >= g.total ? 'good' : g.filled === 0 ? 'bad' : 'warn';
  const size = h < 64 ? 'tiny' : h < 128 ? 'short' : '';
  const shown = g.people.slice(0, 3);
  const extra = g.people.length - shown.length;
  return (
    <Link href={`/events/${g.event_id}`} className={`sx-sg ${tone} ${size}`} style={{ ...style, height: Math.max(h - 2, 36) }} title={`${g.name}${g.venue ? ' · ' + g.venue : ''}`}>
      <span className="nm">{g.name}</span>
      <span className="head">
        <span>{fmtMin(g.startMin)}</span>
        <span>–</span>
        <span>{fmtMin(g.endMin === 1440 ? 1440 : g.endMin)}</span>
      </span>
      <span className="fields">
        <span className="field">
          <Ic n="clock-sm" size={16} />
          {fmtH(g.hours)}
        </span>
        {seePay && g.cost != null && (
          <span className="field hide-tiny">
            <Ic n="currency-dollar" />
            {fmtMoney(g.cost)}
          </span>
        )}
        <span className="field hide-tiny">
          <Ic n="user-check" />
          {g.continued ? (
            <small>continued</small>
          ) : (
            <>
              <span>
                {g.confirmed}
                <span className="of">/{g.total}</span>
              </span>
              <small>confirmed</small>
            </>
          )}
        </span>
      </span>
      {!g.continued && g.filled === 0 && g.total > 0 ? (
        <span className="sx-assign">+ Assign</span>
      ) : (
        shown.length > 0 && (
          <span className="avatars">
            {shown.map((p) => (
              <span key={p.id} className="av" title={p.name}>
                {initials(p.name)}
              </span>
            ))}
            {extra > 0 && <span className="av more">+{extra}</span>}
          </span>
        )
      )}
    </Link>
  );
}

export default function ShiftView({ days, shifts, seePay, now }: { days: Date[]; shifts: S[]; seePay: boolean; now: Date }) {
  const groups = useMemo(() => groupByEventDay(segments(shifts)), [shifts]);
  const byDay = useMemo(() => {
    const m = new Map<string, Group[]>();
    for (const g of groups) m.set(g.day, [...(m.get(g.day) ?? []), g]);
    return m;
  }, [groups]);
  const todayKey = key(now);
  const wk = isoWeek(days[0]!);
  const totH = days.reduce((n, d) => n + (byDay.get(key(d)) ?? []).reduce((a, g) => a + g.hours, 0), 0);
  const totC = days.reduce((n, d) => n + (byDay.get(key(d)) ?? []).reduce((a, g) => a + (g.cost ?? 0), 0), 0);

  return (
    <>
      <div className="sx-fixed sx-row">
        <div className="sx-weekh">
          <div className="w">Week</div>
          <div className="big">{wk}</div>
          <div className="cap">
            {fmtH(totH)}
            {seePay ? ` · ${fmtMoney(totC)}` : ''}
          </div>
        </div>
        {days.map((d) => {
          const gs = byDay.get(key(d)) ?? [];
          const hrs = gs.reduce((a, g) => a + g.hours, 0);
          const cost = gs.reduce((a, g) => a + (g.cost ?? 0), 0);
          return (
            <div key={key(d)} className={`sx-dayh ${key(d) === todayKey ? 'today' : ''}`}>
              <div className="dow">{d.toLocaleDateString([], { weekday: 'short' })}</div>
              <div className="num">{d.getDate()}</div>
              <div className="meta">
                <b>{fmtH(hrs)}</b>
                {seePay && (
                  <>
                    <span>·</span>
                    <b>{fmtMoney(cost)}</b>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="sx-body">
        <div className="sx-times">
          {Array.from({ length: 24 }, (_, h) => (
            <span key={h} className={h === 0 ? 'first' : ''} style={{ top: h * HOUR_PX }}>
              {String(h).padStart(2, '0')}:00
            </span>
          ))}
        </div>
        {days.map((d) => {
          const k = key(d);
          const laid = lanes(byDay.get(k) ?? []);
          return (
            <div key={k} className={`sx-col ${k === todayKey ? 'today' : ''}`}>
              {laid.map(({ item, lane, lanes: n }) => (
                <Card
                  key={item.id}
                  g={item}
                  seePay={seePay}
                  style={{ top: (item.startMin / 60) * HOUR_PX + 1, left: `calc(${(lane / n) * 100}% + 3px)`, width: `calc(${100 / n}% - 6px)` }}
                />
              ))}
              {k === todayKey && <div className="sx-now" style={{ top: (minutesOfDay(now) / 60) * HOUR_PX }} title={hhmm(now)} />}
            </div>
          );
        })}
      </div>
    </>
  );
}
