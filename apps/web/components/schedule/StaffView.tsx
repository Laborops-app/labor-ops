'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import Ic from './Ic';
import PhaseRow from './PhaseRow';
import { Leave, Phase, S, phaseTitle, fmtH, fmtMoney, initials, isoWeek, key, segCostOne, segments } from '@/lib/schedule';

const fmtMin = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

type Item = { id: string; day: string; event_id: string; name: string; start: number; end: number; hours: number; cost: number | null; pending: boolean; role: string };
type Person = { id: string; name: string; team: string; items: Item[]; leave: Leave[]; hours: number; cost: number };

export default function StaffView({ days, shifts, phases, timeOff, seePay, now, teamFilter }: { days: Date[]; shifts: S[]; phases: Phase[]; timeOff: Leave[]; seePay: boolean; now: Date; teamFilter: string[] }) {
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const todayKey = key(now);
  const dayKeys = days.map(key);

  const { teams, open } = useMemo(() => {
    const people = new Map<string, Person>();
    const open: Item[] = [];
    const get = (id: string, name: string) => {
      let p = people.get(id);
      if (!p) people.set(id, (p = { id, name, team: '', items: [], leave: [], hours: 0, cost: 0 }));
      return p;
    };
    for (const sg of segments(shifts)) {
      const s = sg.shift;
      const base = { day: sg.day, event_id: s.event_id, name: phaseTitle(s.phase_label, s.event_name), start: sg.startMin, end: sg.endMin, hours: sg.hours, role: s.role_name };
      for (const a of s.assignees) {
        const p = get(a.user_id, a.name);
        const c = segCostOne(sg);
        p.items.push({ ...base, id: `${s.id}:${a.user_id}:${sg.day}`, cost: c, pending: a.status !== 'accepted' });
        p.hours += sg.hours;
        p.cost += c ?? 0;
      }
      const missing = s.headcount - Math.min(s.filled, s.headcount);
      if (sg.first && missing > 0) open.push({ ...base, id: `${s.id}:open:${sg.day}`, cost: null, pending: true, role: `${s.role_name} ×${missing}` });
    }
    if (!teamFilter.length)
      for (const l of timeOff) {
        const p = get(l.user_id, l.name);
        p.leave.push(l);
      }
    for (const p of people.values()) {
      const count = new Map<string, number>();
      for (const it of p.items) count.set(it.role, (count.get(it.role) ?? 0) + it.hours);
      p.team = [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'On leave';
    }
    const teams = new Map<string, Person[]>();
    for (const p of [...people.values()].sort((a, b) => a.name.localeCompare(b.name))) teams.set(p.team, [...(teams.get(p.team) ?? []), p]);
    return { teams: [...teams.entries()].sort((a, b) => a[0].localeCompare(b[0])), open };
  }, [shifts, timeOff, teamFilter]);

  const leaveOn = (p: Person, dk: string) => p.leave.find((l) => l.starts_on.slice(0, 10) <= dk && l.ends_on.slice(0, 10) >= dk);
  const total = teams.reduce((n, [, ps]) => n + ps.length, 0);

  const chip = (it: Item, kind = '') => (
    <Link key={it.id} href={`/events/${it.event_id}`} className={`sx-chip ${it.pending ? 'pend' : ''} ${kind}`}>
      <span className="head">
        <span>{fmtMin(it.start)}</span>
        <span>–</span>
        <span>{fmtMin(it.end)}</span>
      </span>
      <span className="row">
        <span className="f">{it.name}</span>
      </span>
      <span className="row">
        <Ic n="clock-sm" />
        <span className="f">{fmtH(it.hours)}</span>
        <span className="r">{kind === 'open' ? it.role : seePay && it.cost != null ? fmtMoney(it.cost) : it.role}</span>
      </span>
    </Link>
  );

  const groupHead = (name: string, n: number) => (
    <div className={`sx-grouph ${closed[name] ? 'closed' : ''}`}>
      <button className="t" onClick={() => setClosed((c) => ({ ...c, [name]: !c[name] }))} aria-expanded={!closed[name]}>
        <Ic n="caret-down" className="caret" />
        {name} ({n})
      </button>
    </div>
  );

  return (
    <>
      <div className="sx-fixed">
        <div className="sx-row">
          <div className="sx-weekh">
            <div className="w">Week</div>
            <div className="big">{isoWeek(days[0]!)}</div>
            <div className="cap">{total} staff</div>
          </div>
          {days.map((d) => (
            <div key={key(d)} className={`sx-dayh ${key(d) === todayKey ? 'today' : ''}`}>
              <div className="dow">{d.toLocaleDateString([], { weekday: 'short' })}</div>
              <div className="num">{d.getDate()}</div>
            </div>
          ))}
        </div>
        <PhaseRow days={days} phases={phases} now={now} />
      </div>

      {open.length > 0 && (
        <>
          {groupHead('Open shifts', open.length)}
          {!closed['Open shifts'] && (
            <div className="sx-row sx-person">
              <div className="sx-user">
                <div className="sx-cardu">
                  <div className="name">
                    <p>Needs staff</p>
                  </div>
                  <div className="info">Unfilled positions</div>
                </div>
              </div>
              {dayKeys.map((dk) => (
                <div key={dk} className={`sx-cell ${dk === todayKey ? 'today' : ''}`}>
                  {open.filter((o) => o.day === dk).map((o) => chip(o, 'open'))}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {teams.map(([team, people]) => (
        <div key={team}>
          {groupHead(team, people.length)}
          {!closed[team] &&
            people.map((p) => (
              <div key={p.id} className="sx-row sx-person">
                <div className="sx-user">
                  <div className="sx-cardu">
                    <div className="name">
                      <span className="ava">{initials(p.name)}</span>
                      <p>{p.name}</p>
                    </div>
                    <div className="info">
                      <span>
                        {p.team} · {fmtH(p.hours)}
                      </span>
                      {seePay && <b>{fmtMoney(p.cost)}</b>}
                    </div>
                  </div>
                </div>
                {dayKeys.map((dk) => {
                  const lv = leaveOn(p, dk);
                  return (
                    <div key={dk} className={`sx-cell ${dk === todayKey ? 'today' : ''}`}>
                      {lv && (
                        <div className="sx-chip leave" title={lv.note ?? undefined}>
                          <span className="leave-t">Approved leave</span>
                          <span className="row">
                            <Ic n="clock-sm" />
                            <span className="f">All day</span>
                          </span>
                        </div>
                      )}
                      {p.items.filter((it) => it.day === dk).map((it) => chip(it))}
                    </div>
                  );
                })}
              </div>
            ))}
        </div>
      ))}
      {teams.length === 0 && open.length === 0 && <div className="sx-empty">No shifts in this period.</div>}
    </>
  );
}
