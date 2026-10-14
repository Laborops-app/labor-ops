'use client';
import { useEffect, useMemo, useState } from 'react';
import Ic from './Ic';
import { CalResp, Filters, NO_FILTERS, STATUS_LABEL, Tone, addDays, key, startOfDay, toneOf } from '@/lib/schedule';
import { api } from '@/lib/api';

export default function FilterPanel({ filters, teams, events, selected, now, onApply, onPick, onClose }: { filters: Filters; teams: string[]; events: { id: string; name: string }[]; selected: Date; now: Date; onApply: (f: Filters) => void; onPick: (d: Date) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(filters);
  const [month, setMonth] = useState(() => new Date(selected.getFullYear(), selected.getMonth(), 1));
  const [tones, setTones] = useState<Map<string, Tone[]>>(new Map());

  const first = month;
  const gridStart = addDays(first, -first.getDay());
  const cells = useMemo(() => Array.from({ length: 42 }, (_, i) => addDays(gridStart, i)), [gridStart.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    api<CalResp>(`/api/calendar?from=${encodeURIComponent(gridStart.toISOString())}&to=${encodeURIComponent(addDays(gridStart, 42).toISOString())}`)
      .then((r) => {
        if (!live) return;
        const m = new Map<string, Tone[]>();
        for (const s of r.shifts) {
          const k = key(new Date(s.starts_at));
          const t = toneOf(s.filled, s.headcount);
          const cur = m.get(k) ?? [];
          if (!cur.includes(t)) m.set(k, [...cur, t]);
        }
        setTones(m);
      })
      .catch(() => live && setTones(new Map()));
    return () => {
      live = false;
    };
  }, [gridStart.getTime()]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleTeam = (t: string) => setDraft((d) => ({ ...d, teams: d.teams.includes(t) ? d.teams.filter((x) => x !== t) : [...d.teams, t] }));
  const sel = key(selected);
  const today = key(startOfDay(now));

  return (
    <aside className="sx-panel" aria-label="Advanced filter">
      <div className="sx-panel-h">
        <div className="t">
          <Ic n="filter" />
          Advanced Filter
        </div>
        <button className="sx-btn sq" onClick={onClose} aria-label="Close filter">
          <Ic n="close" size={18} />
        </button>
      </div>
      <div className="sx-panel-b">
        <div className="sx-mini">
          <div className="sx-mini-h">
            <button className="sx-btn sq" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} aria-label="Previous month">
              <Ic n="caret-down-sm" className="flip" />
            </button>
            <span>{month.toLocaleDateString([], { month: 'long', year: 'numeric' })}</span>
            <button className="sx-btn sq" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} aria-label="Next month">
              <Ic n="caret-down-sm" className="flip-r" />
            </button>
          </div>
          <div>
            <div className="sx-mini-days" aria-hidden="true">
              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => (
                <span key={d}>{d}</span>
              ))}
            </div>
            <div className="sx-mini-grid">
              {cells.map((d) => {
                const k = key(d);
                return (
                  <button key={k} className={`${d.getMonth() !== month.getMonth() ? 'out' : ''} ${k === today ? 'today' : ''} ${k === sel ? 'sel' : ''}`} onClick={() => onPick(d)} aria-label={d.toDateString()}>
                    <span className="n">{d.getDate()}</span>
                    <span className="dots">
                      {(tones.get(k) ?? []).slice(0, 3).map((t) => (
                        <i key={t} className={`sx-dot ${t}`} />
                      ))}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="sx-fgroup">
          <div className="sx-fpill">
            <span>By Status</span>
            <b className="grow">{STATUS_LABEL[draft.status]}</b>
            <Ic n="caret-down-sm" />
            <select className="sx-over" value={draft.status} onChange={(e) => setDraft({ ...draft, status: e.target.value as Filters['status'] })} aria-label="Filter by status">
              {(Object.keys(STATUS_LABEL) as Filters['status'][]).map((k) => (
                <option key={k} value={k}>
                  {STATUS_LABEL[k]}
                </option>
              ))}
            </select>
          </div>
          <div className="sx-fpill">
            <span>By Event</span>
            <b className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {events.find((e) => e.id === draft.eventId)?.name ?? 'All'}
            </b>
            <Ic n="caret-down-sm" />
            <select className="sx-over" value={draft.eventId} onChange={(e) => setDraft({ ...draft, eventId: e.target.value })} aria-label="Filter by event">
              <option value="">All</option>
              {events.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="sx-fgroup">
          <div className={`sx-fpill ${draft.teams.length ? 'on' : ''}`}>
            <span>By Team</span>
            <b className="grow">{draft.teams.length ? `${draft.teams.length} selected` : 'All'}</b>
          </div>
          <div className="sx-chips">
            {teams.length === 0 && <span className="sx-link" style={{ textDecoration: 'none' }}>No teams in view</span>}
            {teams.map((t) => {
              const on = draft.teams.includes(t);
              return (
                <button key={t} className={`sx-fchip ${on ? '' : 'off'}`} onClick={() => toggleTeam(t)} aria-pressed={on}>
                  {t}
                  {on && <Ic n="chip-close" />}
                </button>
              );
            })}
          </div>
        </div>
      </div>
      <div className="sx-panel-f">
        <button
          className="sx-btn"
          onClick={() => {
            setDraft(NO_FILTERS);
            onApply(NO_FILTERS);
          }}
        >
          Reset Filter
        </button>
        <button className="sx-btn main" onClick={() => onApply(draft)}>
          Apply
        </button>
      </div>
    </aside>
  );
}
