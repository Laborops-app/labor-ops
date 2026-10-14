'use client';
import './schedule.css';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import Shell from '@/components/Shell';
import Ic from '@/components/schedule/Ic';
import ShiftView from '@/components/schedule/ShiftView';
import StaffView from '@/components/schedule/StaffView';
import MonthView from '@/components/schedule/MonthView';
import FilterPanel from '@/components/schedule/FilterPanel';
import { api } from '@/lib/api';
import { CalResp, Filters, NO_FILTERS, STATUS_LABEL, HOUR_PX, addDays, applyFilters, filterPhases, filtersActive, isoWeek, weekStart } from '@/lib/schedule';

function Body() {
  const [mode, setMode] = useState<'shift' | 'staff'>('shift');
  const [range, setRange] = useState<'week' | 'month'>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [panel, setPanel] = useState(false);
  const [data, setData] = useState<CalResp>({ shifts: [], time_off: [], can_see_pay: false });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [now, setNow] = useState(() => new Date());
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setPanel(window.matchMedia('(min-width: 900px)').matches);
    const t = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(t);
  }, []);

  const { start, count } = useMemo(() => {
    if (range === 'week') return { start: weekStart(anchor), count: 7 };
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const s = weekStart(first);
    return { start: s, count: Math.ceil((Math.round((+last - +s) / 86400000) + 1) / 7) * 7 };
  }, [range, anchor]);
  const days = useMemo(() => Array.from({ length: Math.min(count, 7) }, (_, i) => addDays(start, i)), [start, count]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api<CalResp>(`/api/calendar?from=${encodeURIComponent(start.toISOString())}&to=${encodeURIComponent(addDays(start, count).toISOString())}`)
      .then((r) => live && (setData(r), setError('')))
      .catch((e) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [start, count]);

  // Open the time grid around the working day (or the current hour) instead of midnight.
  useEffect(() => {
    if (range === 'week' && mode === 'shift' && scroller.current) scroller.current.scrollTop = Math.max(0, (new Date().getHours() - 1) * HOUR_PX);
  }, [range, mode, start]);

  const shifts = useMemo(() => applyFilters(data.shifts, filters), [data.shifts, filters]);
  const phases = useMemo(() => filterPhases(data.phases ?? [], filters), [data.phases, filters]);
  const teams = useMemo(() => [...new Set([...data.shifts.map((s) => s.role_name), ...filters.teams])].sort(), [data.shifts, filters.teams]);
  const events = useMemo(
    () => [...new Map([...data.shifts.map((s) => [s.event_id, s.event_name] as const), ...(data.phases ?? []).map((p) => [p.event_id, p.event_name] as const)]).entries()].map(([id, name]) => ({ id, name })),
    [data.shifts, data.phases],
  );

  const step = (dir: number) => {
    const a = new Date(anchor);
    if (range === 'week') a.setDate(a.getDate() + 7 * dir);
    else a.setMonth(a.getMonth() + dir, 1);
    setAnchor(a);
  };
  const isCurrent = range === 'week' ? +weekStart(new Date()) === +start : anchor.getMonth() === new Date().getMonth() && anchor.getFullYear() === new Date().getFullYear();
  const label =
    range === 'week'
      ? isCurrent
        ? 'Current Week'
        : `Week ${isoWeek(start)}`
      : anchor.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const jump = (v: string) => (v === 'now' ? setAnchor(new Date()) : step(v === 'prev' ? -1 : 1));
  const closePanel = () => setPanel(false);

  return (
    <div className="sx">
      <div className="sx-card">
        {panel && (
          <>
            <div className="sx-backdrop" onClick={closePanel} />
            <FilterPanel
              filters={filters}
              teams={teams}
              events={events}
              selected={anchor}
              now={now}
              onApply={(f) => {
                setFilters(f);
                if (window.matchMedia('(max-width: 899px)').matches) closePanel();
              }}
              onPick={(d) => setAnchor(d)}
              onClose={closePanel}
            />
          </>
        )}
        <div className="sx-main">
          <div className="sx-toolbar">
            <div className="sx-ctas">
              <div className="sx-seg" role="tablist" aria-label="Layout">
                <button role="tab" aria-selected={mode === 'shift'} disabled={range === 'month'} onClick={() => setMode('shift')}>
                  <Ic n="shift-view" /> Shift view
                </button>
                <button role="tab" aria-selected={mode === 'staff'} disabled={range === 'month'} onClick={() => setMode('staff')}>
                  <Ic n="staff-view" /> Staff view
                </button>
              </div>
              <div className={`sx-pill ${filters.status !== 'all' ? 'on' : ''}`}>
                <span>Status</span>
                <b>{STATUS_LABEL[filters.status]}</b>
                <Ic n="caret-down-sm" />
                <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value as Filters['status'] })} aria-label="Filter by status">
                  {(Object.keys(STATUS_LABEL) as Filters['status'][]).map((k) => (
                    <option key={k} value={k}>
                      {STATUS_LABEL[k]}
                    </option>
                  ))}
                </select>
              </div>
              <button className={`sx-pill ${filters.teams.length ? 'on' : ''}`} onClick={() => setPanel(true)} aria-label="Filter by team">
                <span>Team</span>
                <b>{filters.teams.length ? `${filters.teams.length} selected` : 'All'}</b>
                <Ic n="caret-down-sm" />
              </button>
              <span className="sx-legend" aria-label="Staffing colours">
                <span><i style={{ background: 'var(--st-good)' }} />Fully staffed</span>
                <span><i style={{ background: 'var(--st-warn)' }} />Partly</span>
                <span><i style={{ background: 'var(--st-bad)' }} />No crew</span>
              </span>
              <button className="sx-link" onClick={() => setPanel((p) => !p)}>
                + Advanced filter
                {filtersActive(filters) && ' •'}
              </button>
            </div>
            <div className="sx-ctas">
              <div className="sx-seg" role="tablist" aria-label="Range">
                <button role="tab" aria-selected={range === 'week'} onClick={() => setRange('week')}>
                  Week
                </button>
                <button role="tab" aria-selected={range === 'month'} onClick={() => setRange('month')}>
                  Month
                </button>
              </div>
              <div className="sx-nav">
                <button className="sx-btn sq" onClick={() => step(-1)} aria-label="Previous">
                  <Ic n="caret-down-sm" className="flip" />
                </button>
                <span className="sx-btn" style={{ position: 'relative' }}>
                  {label}
                  <Ic n="caret-down-sm" />
                  <select className="sx-over" value="" onChange={(e) => jump(e.target.value)} aria-label="Jump to period">
                    <option value="" disabled>
                      {label}
                    </option>
                    <option value="prev">Previous {range}</option>
                    <option value="now">Current {range}</option>
                    <option value="next">Next {range}</option>
                  </select>
                </span>
                <button className="sx-btn sq" onClick={() => step(1)} aria-label="Next">
                  <Ic n="caret-down-sm" className="flip-r" />
                </button>
              </div>
            </div>
          </div>
          {error && (
            <div className="sx-error banner error" role="alert">
              {error}
            </div>
          )}
          <div className="sx-scroll" ref={scroller} style={{ opacity: loading ? 0.6 : 1 }}>
            {range === 'month' ? (
              <MonthView
                start={start}
                count={count}
                month={anchor.getMonth()}
                shifts={shifts}
                phases={phases}
                now={now}
                onOpenDay={(d) => {
                  setAnchor(d);
                  setRange('week');
                }}
              />
            ) : (
              <div className={`sx-inner ${mode === 'staff' ? 'staff' : ''}`}>
                {mode === 'shift' ? (
                  <ShiftView days={days} shifts={shifts} phases={phases} seePay={data.can_see_pay} now={now} />
                ) : (
                  <StaffView days={days} shifts={shifts} phases={phases} timeOff={data.time_off} seePay={data.can_see_pay} now={now} teamFilter={filters.teams} />
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <Link href="/events" className="sx-fab" aria-label="New event">
        <Ic n="plus" />
      </Link>
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
