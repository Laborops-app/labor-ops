'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { type S, key, addDays } from '@/lib/schedule';

/*
 * The schedule board: events as cards in day columns (week), a "Needs crew" strip, and a month grid with a day panel.
 * One card = one event on one day, built from that day's shifts: earliest start to latest end, seats filled, client,
 * job number, city and venue. Long jobs that are fully staffed fold into one "ongoing" row per day.
 */

export type Tone = 'good' | 'warn' | 'bad';
export type Card = {
  eventId: string; day: string; name: string; client: string | null; job: string | null; city: string | null; venue: string | null;
  start: Date; end: Date; slots: number; filled: number; declined: number; tone: Tone; spanDays: number; phase: string | null; roles: string[];
};
export type Show = { job: boolean; client: boolean; time: boolean; place: boolean; dots: boolean; fold: boolean };
export const SHOW_DEFAULT: Show = { job: true, client: true, time: true, place: true, dots: true, fold: true };
export const SHOW_LABEL: Record<keyof Show, string> = { job: 'Job number', client: 'Client', time: 'Start and end time', place: 'City and venue', dots: 'Shift slots', fold: 'Group ongoing jobs' };
export type BoardFilters = { tones: Tone[]; declined: boolean; client: string; teams: string[] };
export const NO_BOARD_FILTERS: BoardFilters = { tones: [], declined: false, client: '', teams: [] };
export const TONE_LABEL: Record<Tone, string> = { good: 'Fully staffed', warn: 'Partly staffed', bad: 'No crew yet' };

const toneOf = (filled: number, slots: number): Tone => (filled >= slots ? 'good' : filled === 0 ? 'bad' : 'warn');
/** "123 Main St, Salt Lake City, UT 84101" → "Salt Lake City". */
function cityOf(address: string | null | undefined) {
  const parts = (address ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 3) return parts[parts.length - 2]!;
  if (parts.length === 2) return /\d/.test(parts[0]!) ? parts[1]!.replace(/\s+[A-Z]{2}(\s+\d{5}(-\d{4})?)?$/, '') : parts[0]!;
  return null;
}
const daysBetween = (a?: string | null, b?: string | null) => (a && b ? Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400000) + 1 : 1);

/** Shifts → one card per event per day. */
export function buildCards(shifts: S[]): Map<string, Card[]> {
  const by = new Map<string, Card>();
  for (const s of shifts) {
    const day = s.day ?? key(new Date(s.starts_at));
    const k = `${day}|${s.event_id}`;
    const st = new Date(s.starts_at), en = new Date(s.ends_at);
    const filled = Math.min(s.filled, s.headcount);
    let c = by.get(k);
    if (!c) {
      by.set(k, (c = {
        eventId: s.event_id, day, name: s.event_name, client: s.client ?? null, job: s.job_number != null ? String(s.job_number) : null,
        city: cityOf(s.address), venue: s.venue, start: st, end: en, slots: 0, filled: 0, declined: 0, tone: 'good',
        spanDays: daysBetween(s.event_start, s.event_end), phase: s.phase_label ?? null, roles: [],
      }));
    }
    if (st < c.start) c.start = st;
    if (en > c.end) c.end = en;
    c.slots += s.headcount;
    c.filled += filled;
    c.declined += s.declined ?? 0;
    if (!c.roles.includes(s.role_name)) c.roles.push(s.role_name);
    if (!c.phase && s.phase_label) c.phase = s.phase_label;
  }
  const out = new Map<string, Card[]>();
  for (const c of by.values()) {
    c.tone = toneOf(c.filled, c.slots);
    const list = out.get(c.day) ?? [];
    list.push(c);
    out.set(c.day, list);
  }
  for (const list of out.values()) list.sort((a, b) => +a.start - +b.start || a.name.localeCompare(b.name));
  return out;
}

export function filterCards(cards: Map<string, Card[]>, f: BoardFilters) {
  const q = f.client.trim().toLowerCase();
  const out = new Map<string, Card[]>();
  for (const [d, list] of cards) {
    out.set(d, list.filter((c) => (!f.tones.length || f.tones.includes(c.tone)) && (!f.declined || c.declined > 0) && (!q || (c.client ?? '').toLowerCase().includes(q) || c.name.toLowerCase().includes(q))));
  }
  return out;
}

const t12 = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const short = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: d.getMinutes() ? '2-digit' : undefined }).replace(/\s?([AP])M/i, (_, x: string) => x.toLowerCase());
const DOW = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

const Check = () => (
  <svg className="bd-ok" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label="Fully staffed"><path d="m5 12 5 5 9-10" /></svg>
);
const PersonIco = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="8" r="4" /><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6" /></svg>;
const PinIco = () => <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12Z" /><circle cx="12" cy="9" r="2.5" /></svg>;

/** One event on one day. */
export function EventCard({ c, show }: { c: Card; show: Show }) {
  const place = [c.city, c.venue].filter(Boolean).join(' → ');
  const dots = Math.min(c.slots, 16);
  return (
    <Link href={`/events/${c.eventId}`} className={`bd-card ${c.tone}`} aria-label={`${c.name}, ${t12(c.start)} to ${t12(c.end)}, ${c.filled} of ${c.slots} shifts filled`}>
      <span className="bd-card-top">
        <b>{c.name}{show.job && c.job && <span className="bd-job"> ({c.job})</span>}</b>
        {c.tone === 'good' && <Check />}
      </span>
      {c.phase && <span className="bd-phase">{c.phase}</span>}
      {show.time && <span className="bd-time">{t12(c.start)} – {t12(c.end)}</span>}
      {show.client && c.client && <span className="bd-meta"><PersonIco /><span>{c.client}</span></span>}
      {show.place && place && <span className="bd-meta"><PinIco /><span>{place}</span></span>}
      {show.dots && (
        <span className="bd-dots" aria-hidden="true">
          {Array.from({ length: dots }, (_, i) => <i key={i} className={i < c.filled ? 'on' : ''} />)}
          {c.slots > 16 && <em>+{c.slots - 16}</em>}
          <b>{c.filled}/{c.slots}</b>
          {c.declined > 0 && <em className="bd-declined">{c.declined} declined</em>}
        </span>
      )}
      {!show.dots && <span className="bd-count">{c.filled}/{c.slots} filled{c.declined > 0 ? ` · ${c.declined} declined` : ''}</span>}
    </Link>
  );
}

/** Week: seven day columns of event cards. */
export function WeekBoard({ days, cards, show, today }: { days: Date[]; cards: Map<string, Card[]>; show: Show; today: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div className="bd-week-wrap">
      <div className="bd-week">
        {days.map((d) => {
          const k = key(d);
          const list = cards.get(k) ?? [];
          const folded = show.fold ? list.filter((c) => c.spanDays >= 4 && c.tone === 'good') : [];
          const rest = list.filter((c) => !folded.includes(c));
          const f = list.reduce((n, c) => n + c.filled, 0), t = list.reduce((n, c) => n + c.slots, 0);
          const isToday = k === today;
          const expanded = open.has(k);
          return (
            <section key={k} className={`bd-day${isToday ? ' today' : ''}`} aria-label={d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}>
              <header className="bd-dh">
                <div className="bd-dh-1">
                  <b>{DOW[d.getDay()]}</b>
                  <span>{d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
                  {isToday && <em>Today</em>}
                </div>
                <div className="bd-dh-2">{list.length} {list.length === 1 ? 'event' : 'events'}{t > 0 && <> · <b className={f >= t ? 'good' : 'warn'}>{f}/{t}</b> shifts</>}</div>
              </header>
              <div className="bd-list">
                {folded.length > 0 && (
                  <>
                    <button type="button" className="bd-fold" aria-expanded={expanded} onClick={() => setOpen((s) => { const n = new Set(s); if (expanded) n.delete(k); else n.add(k); return n; })}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10" /></svg>
                      <span><b>{folded.length} ongoing {folded.length === 1 ? 'job' : 'jobs'}</b><small>All staffed</small></span>
                      <i aria-hidden="true">{expanded ? '▴' : '▾'}</i>
                    </button>
                    {expanded && folded.map((c) => <EventCard key={c.eventId} c={c} show={show} />)}
                  </>
                )}
                {rest.map((c) => <EventCard key={c.eventId} c={c} show={show} />)}
                {list.length === 0 && <p className="bd-none">No events</p>}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

/** Events in view with open seats from today on, soonest first. */
export function NeedsCrew({ cards, today }: { cards: Map<string, Card[]>; today: string }) {
  const items = useMemo(() => {
    const m = new Map<string, { eventId: string; name: string; first: Card; open: number; tone: Tone }>();
    for (const [d, list] of [...cards.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (d < today) continue;
      for (const c of list) {
        const open = c.slots - c.filled;
        if (open <= 0) continue;
        const x = m.get(c.eventId);
        if (x) { x.open += open; if (c.tone === 'bad') x.tone = 'bad'; } else m.set(c.eventId, { eventId: c.eventId, name: c.name, first: c, open, tone: c.tone });
      }
    }
    return [...m.values()].sort((a, b) => +a.first.start - +b.first.start);
  }, [cards, today]);
  const total = items.reduce((n, x) => n + x.open, 0);
  if (!items.length) return <p className="bd-allgood" role="status"><Check /> Every shift in view is staffed.</p>;
  return (
    <section className="bd-needs" aria-label="Needs crew">
      <b className="bd-needs-h">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 9v4M12 17h.01" /><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
        Needs crew <span>{total} open {total === 1 ? 'shift' : 'shifts'}</span>
      </b>
      {items.slice(0, 8).map((x) => (
        <Link key={x.eventId} href={`/events/${x.eventId}`} className="bd-need">
          <b>{x.name}</b>
          <span>{x.first.start.toLocaleDateString([], { weekday: 'short' })} {short(x.first.start)}</span>
          <em className={x.tone}>{x.open} open</em>
        </Link>
      ))}
      {items.length > 8 && <span className="bd-need-more">+{items.length - 8} more</span>}
    </section>
  );
}

/** Month grid; picking a day shows it in the panel beside. */
export function MonthBoard({ start, count, month, cards, selected, onSelect, today }: {
  start: Date; count: number; month: number; cards: Map<string, Card[]>; selected: string; onSelect: (k: string) => void; today: string;
}) {
  const cells = Array.from({ length: count }, (_, i) => addDays(start, i));
  return (
    <div className="bd-month-wrap">
      <div className="bd-month">
        {DOW.map((d) => <div key={d} className="bd-mh">{d}</div>)}
        {cells.map((d) => {
          const k = key(d);
          const list = cards.get(k) ?? [];
          const open = list.reduce((n, c) => n + c.slots - c.filled, 0);
          const out = d.getMonth() !== month;
          return (
            <button key={k} type="button" className={`bd-mc${out ? ' out' : ''}${k === selected ? ' sel' : ''}${k < today ? ' past' : ''}`} aria-pressed={k === selected}
              aria-label={`${d.toLocaleDateString([], { month: 'long', day: 'numeric' })}: ${list.length} events${open ? `, ${open} open shifts` : ''}`} onClick={() => onSelect(k)}>
              <span className="bd-mc-top">
                <b className={k === today ? 'today' : ''}>{d.getDate()}</b>
                {open > 0 ? <em className="open">{open} open</em> : list.length > 0 && <em>{list.length} {list.length === 1 ? 'event' : 'events'}</em>}
              </span>
              {list.slice(0, 3).map((c) => (
                <span key={c.eventId} className="bd-chip"><i className={c.tone} /><b>{short(c.start)}</b><span>{c.name}</span></span>
              ))}
              {list.length > 3 && <span className="bd-more">+{list.length - 3} more</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function DayPanel({ day, cards, show, onClose, onOpenWeek, today }: { day: string; cards: Card[]; show: Show; onClose: () => void; onOpenWeek: () => void; today: string }) {
  const d = new Date(`${day}T12:00:00`);
  const f = cards.reduce((n, c) => n + c.filled, 0), t = cards.reduce((n, c) => n + c.slots, 0);
  return (
    <aside className="bd-panel" aria-label={d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}>
      <header>
        <div className="bd-panel-h">
          <h2>{d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</h2>
          {day === today && <em>Today</em>}
          <button type="button" className="bd-x" aria-label="Close day panel" onClick={onClose}>✕</button>
        </div>
        <p>{cards.length} {cards.length === 1 ? 'event' : 'events'}{t > 0 && <> · <b className={f >= t ? 'good' : 'warn'}>{f}/{t} shifts filled</b></>}</p>
        <div className="bd-panel-acts">
          <button type="button" className="btn" onClick={onOpenWeek}>Open that week</button>
          <Link className="btn" href="/attendance">Time &amp; attendance</Link>
        </div>
      </header>
      <div className="bd-panel-list">
        {cards.length ? cards.map((c) => <EventCard key={c.eventId} c={c} show={show} />) : <p className="bd-none">No events on this day.</p>}
      </div>
    </aside>
  );
}

/** Left panel: what cards show, and filters. */
export function SettingsRail({ show, setShow, filters, setFilters, teams, onHide }: {
  show: Show; setShow: (s: Show) => void; filters: BoardFilters; setFilters: (f: BoardFilters) => void; teams: string[]; onHide: () => void;
}) {
  const [allTeams, setAllTeams] = useState(false);
  const shownTeams = allTeams ? teams : teams.slice(0, 8);
  return (
    <aside className="bd-rail" aria-label="View settings and filters">
      <button type="button" className="bd-hide" onClick={onHide}>‹ Hide panel</button>
      <section>
        <h2>Show on cards</h2>
        {(Object.keys(SHOW_LABEL) as (keyof Show)[]).map((k) => (
          <label key={k} className="check"><input type="checkbox" checked={show[k]} onChange={(e) => setShow({ ...show, [k]: e.target.checked })} /> {SHOW_LABEL[k]}</label>
        ))}
      </section>
      <section>
        <h2>Staffing</h2>
        {(Object.keys(TONE_LABEL) as Tone[]).map((t) => (
          <label key={t} className="check">
            <input type="checkbox" checked={filters.tones.includes(t)} onChange={(e) => setFilters({ ...filters, tones: e.target.checked ? [...filters.tones, t] : filters.tones.filter((x) => x !== t) })} />
            <i className={`bd-tone ${t}`} aria-hidden="true" /> {TONE_LABEL[t]}
          </label>
        ))}
        <label className="check"><input type="checkbox" checked={filters.declined} onChange={(e) => setFilters({ ...filters, declined: e.target.checked })} /> Has declined shifts</label>
      </section>
      <section>
        <h2>Client</h2>
        <input value={filters.client} onChange={(e) => setFilters({ ...filters, client: e.target.value })} placeholder="Client or event name" aria-label="Filter by client" />
      </section>
      {teams.length > 0 && (
        <section>
          <h2>Position</h2>
          {shownTeams.map((t) => (
            <label key={t} className="check">
              <input type="checkbox" checked={filters.teams.includes(t)} onChange={(e) => setFilters({ ...filters, teams: e.target.checked ? [...filters.teams, t] : filters.teams.filter((x) => x !== t) })} /> {t}
            </label>
          ))}
          {teams.length > 8 && <button type="button" className="bd-linkbtn" onClick={() => setAllTeams(!allTeams)}>{allTeams ? 'Show fewer' : `Show all ${teams.length}`}</button>}
        </section>
      )}
      {(filters.tones.length > 0 || filters.declined || filters.client || filters.teams.length > 0) && (
        <button type="button" className="bd-linkbtn" onClick={() => setFilters({ tones: [], declined: false, client: '', teams: [] })}>Clear filters</button>
      )}
    </aside>
  );
}
