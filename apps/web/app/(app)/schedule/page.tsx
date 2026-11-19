'use client';
import './schedule.css';
import './board.css';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import StaffView from '@/components/schedule/StaffView';
import {
  BoardFilters, DayPanel, MonthBoard, NO_BOARD_FILTERS, NeedsCrew, SHOW_DEFAULT, SettingsRail, Show, WeekBoard, buildCards, filterCards,
} from '@/components/schedule/Board';
import { api } from '@/lib/api';
import { CalResp, addDays, key, weekStart } from '@/lib/schedule';

/*
 * Schedule: events as cards in day columns (Week), a month grid with a day panel (Month), and people rows (Crew).
 * The left panel chooses what cards show and filters them; the "Needs crew" strip lists open shifts from today on.
 */
type Range = 'week' | 'month' | 'crew';
const read = <T,>(k: string, d: T): T => { try { const v = localStorage.getItem(k); return v ? { ...d, ...JSON.parse(v) } : d; } catch { return d; } };
const save = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

function Body() {
  const [range, setRange] = useState<Range>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [filters, setFilters] = useState<BoardFilters>(NO_BOARD_FILTERS);
  const [show, setShow] = useState<Show>(SHOW_DEFAULT);
  const [rail, setRail] = useState(false);
  const [q, setQ] = useState('');
  const [data, setData] = useState<CalResp>({ shifts: [], time_off: [], can_see_pay: false });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const [picked, setPicked] = useState<string | null>(null);
  const today = key(now);

  const [loaded, setLoaded] = useState(false); // don't save the defaults over what's stored before it has been read
  useEffect(() => {
    const v = read('lo-sched', { range: 'week' as Range, rail: window.matchMedia('(min-width: 1100px)').matches, show: SHOW_DEFAULT });
    setRange(v.range); setRail(v.rail); setShow({ ...SHOW_DEFAULT, ...v.show }); setLoaded(true);
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { if (loaded) save('lo-sched', { range, rail, show }); }, [loaded, range, rail, show]);

  const { start, count } = useMemo(() => {
    if (range !== 'month') return { start: weekStart(anchor), count: 7 };
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const s = weekStart(first);
    return { start: s, count: Math.ceil((Math.round((+last - +s) / 86400000) + 1) / 7) * 7 };
  }, [range, anchor]);
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(start, i)), [start]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api<CalResp>(`/api/calendar?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(addDays(start, count).toISOString())}`)
      .then((r) => live && (setData(r), setError('')))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
  }, [start, count]);

  // Position filter works on shifts (an event shows if it has that position); the rest on the event cards.
  const shifts = useMemo(() => (filters.teams.length ? data.shifts.filter((s) => filters.teams.includes(s.role_name)) : data.shifts), [data.shifts, filters.teams]);
  const cards = useMemo(() => {
    const all = filterCards(buildCards(shifts), filters);
    const s = q.trim().toLowerCase();
    if (!s) return all;
    for (const [d, list] of all) all.set(d, list.filter((c) => [c.name, c.client ?? '', c.job ?? '', c.venue ?? ''].some((x) => x.toLowerCase().includes(s))));
    return all;
  }, [shifts, filters, q]);
  const teams = useMemo(() => [...new Set([...data.shifts.map((s) => s.role_name), ...filters.teams])].sort(), [data.shifts, filters.teams]);

  // Totals for what's on screen
  const visible = useMemo(() => {
    const keys = range === 'month' ? Array.from({ length: count }, (_, i) => key(addDays(start, i))).filter((k) => new Date(`${k}T12:00:00`).getMonth() === anchor.getMonth()) : days.map(key);
    const list = keys.flatMap((k) => cards.get(k) ?? []);
    const filled = list.reduce((n, c) => n + c.filled, 0), slots = list.reduce((n, c) => n + c.slots, 0);
    return { events: new Set(list.map((c) => c.eventId)).size, filled, slots };
  }, [cards, days, range, start, count, anchor]);

  // Month: the day shown in the panel (today when it's in this month, else the 1st).
  const monthDay = picked ?? (now.getMonth() === anchor.getMonth() && now.getFullYear() === anchor.getFullYear() ? today : key(new Date(anchor.getFullYear(), anchor.getMonth(), 1)));

  const step = (dir: number) => {
    const a = new Date(anchor);
    if (range === 'month') a.setMonth(a.getMonth() + dir, 1);
    else a.setDate(a.getDate() + 7 * dir);
    setAnchor(a); setPicked(null);
  };
  const title = range === 'month'
    ? anchor.toLocaleDateString([], { month: 'long', year: 'numeric' })
    : `${days[0]!.toLocaleDateString([], { month: 'short', day: 'numeric' })} – ${days[6]!.toLocaleDateString([], { month: days[0]!.getMonth() === days[6]!.getMonth() ? undefined : 'short', day: 'numeric' })}, ${days[6]!.getFullYear()}`;
  const filterCount = filters.tones.length + filters.teams.length + (filters.declined ? 1 : 0) + (filters.client ? 1 : 0);

  return (
    <div className="bd">
      <header className="bd-top">
        <div className="bd-nav">
          <button type="button" aria-label={range === 'month' ? 'Previous month' : 'Previous week'} onClick={() => step(-1)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m15 6-6 6 6 6" /></svg>
          </button>
          <button type="button" className="bd-today" onClick={() => { setAnchor(new Date()); setPicked(null); }}>Today</button>
          <button type="button" aria-label={range === 'month' ? 'Next month' : 'Next week'} onClick={() => step(1)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
          </button>
        </div>
        <h2 className="bd-title">{title}</h2>
        <div className="bd-seg" role="tablist" aria-label="View">
          {(['week', 'month', 'crew'] as Range[]).map((r) => (
            <button key={r} type="button" role="tab" aria-selected={range === r} onClick={() => { setRange(r); setPicked(null); }}>{r === 'week' ? 'Week' : r === 'month' ? 'Month' : 'Crew'}</button>
          ))}
        </div>
        <div className="bd-stats" aria-live="polite">
          <span><b>{visible.events}</b> events</span>
          <span><b>{visible.filled}/{visible.slots}</b> shifts filled</span>
          {visible.slots > visible.filled && <span className="bad"><b>{visible.slots - visible.filled}</b> open</span>}
        </div>
        <span className="bd-grow" />
        <label className="bd-search">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find event, client or job #" aria-label="Find event, client or job number" />
        </label>
        {!rail && range !== 'crew' && <button type="button" className="btn" onClick={() => setRail(true)}>Filters{filterCount ? ` · ${filterCount}` : ''}</button>}
        <Link href="/events" className="btn bd-new">+ New event</Link>
      </header>

      {error && <div className="banner error" role="alert">{error}</div>}
      {range !== 'crew' && !loading && <NeedsCrew cards={cards} today={today} />}

      <div className="bd-body" style={{ opacity: loading ? 0.6 : 1 }}>
        {rail && range !== 'crew' && <SettingsRail show={show} setShow={setShow} filters={filters} setFilters={setFilters} teams={teams} onHide={() => setRail(false)} />}
        <main className="bd-main">
          {range === 'week' && <WeekBoard days={days} cards={cards} show={show} today={today} />}
          {range === 'month' && (
            <div className="bd-month-row">
              <MonthBoard start={start} count={count} month={anchor.getMonth()} cards={cards} selected={monthDay} onSelect={setPicked} today={today} />
              <DayPanel day={monthDay} cards={cards.get(monthDay) ?? []} show={show} today={today} onClose={() => setPicked(null)}
                onOpenWeek={() => { setAnchor(new Date(`${monthDay}T12:00:00`)); setRange('week'); setPicked(null); }} />
            </div>
          )}
          {range === 'crew' && (
            <div className="sx bd-crew">
              <div className="sx-scroll"><div className="sx-inner staff">
                <StaffView days={days} shifts={shifts} phases={data.phases ?? []} timeOff={data.time_off} seePay={data.can_see_pay} now={now} teamFilter={filters.teams} />
              </div></div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
