'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import Skeleton from '@/components/Skeleton';
import ActionMenu, { type MenuItem } from '@/components/ActionMenu';
import { show } from '@/components/Toasts';
import { api, type Me } from '@/lib/api';

/*
 * Time & attendance: one day (or a range) of scheduled shifts with what actually happened. Each row shows the actual
 * clock times (A), the scheduled times (S) and any break (B); hours paid after the minimum; conditions to check; and
 * Approve. Rows are grouped by event, person or position, and whole events can be approved at once.
 */

type Cond = { code: string; label: string; flag: boolean; why: string };
type Row = {
  assignmentId: string; entryId: string | null; status: 'none' | 'in' | 'out' | 'approved'; flagged: boolean; date: string; tz: string;
  user: { id: string; name: string; groups: string[] }; role: string;
  event: { id: string; name: string; number: string | null; client: string | null };
  scheduled: { start: string; end: string; hours: number };
  actual: { in: string | null; out: string | null; hours: number | null };
  paidHours: number | null; minHours: number; minSource: 'off' | 'person' | 'shift' | 'rules' | null; adjust: number;
  breaks: { kind: string; start: string; end: string | null; hours: number | null }[];
  clockIn: { by: string; self: boolean; distanceM: number | null; located: boolean } | null;
  clockOut: { by: string; self: boolean; distanceM: number | null; located: boolean } | null;
  approvedBy: string | null; editedBy: string | null; exported: boolean; moreEntries: boolean; unscheduled: boolean;
  conditions: Cond[];
};
type Resp = {
  rows: Row[]; groups: { id: string; name: string }[]; conditions: Cond[]; canApprove: boolean;
  stats: { total: number; scheduled: number; unscheduled: number; unapprovedOut: number; approved: number; flagged: number };
};
type GroupBy = 'event' | 'person' | 'role' | 'none';

const STATUS_LABEL: Record<Row['status'], string> = { none: 'Not clocked in', in: 'Clocked in', out: 'Clocked out, not approved', approved: 'Approved' };
const pad = (n: number) => String(n).padStart(2, '0');
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const shiftDay = (k: string, n: number) => { const d = new Date(`${k}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const longDay = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fullDay = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const mon = (k: string) => new Date(`${k}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
const hrs = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2));

/** "7:00am" in the event's time zone. */
function t12(iso: string, tz: string) {
  return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso)).replace(' ', '').toLowerCase();
}
/** Wall-clock parts of an instant in a zone. */
function wall(iso: string, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, h: Number(p.hour), m: Number(p.minute) };
}
/** The instant when the clock in `tz` shows this date and time. */
function fromWall(date: string, h: number, m: number, tz: string) {
  const [y, mo, d] = date.split('-').map(Number);
  let guess = Date.UTC(y!, mo! - 1, d!, h, m);
  for (let i = 0; i < 2; i++) {
    const w = wall(new Date(guess).toISOString(), tz);
    const [wy, wmo, wd] = w.date.split('-').map(Number);
    guess += Date.UTC(y!, mo! - 1, d!, h, m) - Date.UTC(wy!, wmo! - 1, wd!, w.h, w.m);
  }
  return new Date(guess).toISOString();
}
const yards = (m: number | null) => (m === null || m === undefined ? '—' : m < 1609 ? `${Math.round(m * 1.094)} yards` : `${(m / 1609).toFixed(1)} miles`);

function Avatar({ name, flag, ok }: { name: string; flag?: boolean; ok?: boolean }) {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
  let h = 0; for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="ta-av" style={{ background: `hsl(${h} 45% 42%)` }} aria-hidden="true">
      {ini}
      {flag && <i className="ta-badge bad">!</i>}
      {ok && <i className="ta-badge ok">✓</i>}
    </span>
  );
}
const Pin = ({ title }: { title: string }) => (
  <svg className="ta-pin" viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-label={title}><title>{title}</title><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7Zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5Z" /></svg>
);
const EditIco = () => (
  <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4" /><path d="M14 4h6v6" opacity=".0" /></svg>
);

/** Little link-style dropdown, like "Statuses: All Statuses". */
function Pick({ label, value, children }: { label: string; value: string; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', off); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="ta-pick" ref={box}>
      <span className="ta-pick-l">{label}:</span>
      <button type="button" className="ta-link" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>{value}</button>
      {open && <div className="ta-pop" role="menu">{children(() => setOpen(false))}</div>}
    </div>
  );
}

type Wall = { date: string; h: number; m: number };
function TimeIn({ v, set, label }: { v: Wall; set: (x: Wall) => void; label: string }) {
  const pm = v.h >= 12, h12 = v.h % 12 || 12;
  const setH = (h: number, p = pm) => set({ ...v, h: (h % 12) + (p ? 12 : 0) });
  return (
    <div className="ta-time">
      <input type="date" value={v.date} onChange={(e) => e.target.value && set({ ...v, date: e.target.value })} aria-label={`${label} date`} />
      <div className="ta-hm">
        <input inputMode="numeric" value={pad(h12)} aria-label={`${label} hour`} onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '').slice(-2)); if (n >= 1 && n <= 12) setH(n); }} />
        <span>:</span>
        <input inputMode="numeric" value={pad(v.m)} aria-label={`${label} minute`} onChange={(e) => { const n = Number(e.target.value.replace(/\D/g, '').slice(-2)); if (n >= 0 && n <= 59) set({ ...v, m: n }); }} />
        <select value={pm ? 'PM' : 'AM'} aria-label={`${label} AM or PM`} onChange={(e) => setH(h12, e.target.value === 'PM')}><option>AM</option><option>PM</option></select>
      </div>
    </div>
  );
}

/** The edit window: actual times, copy scheduled, minimum pay and where they clocked. */
function EditTime({ r, anchor, onClose, onSaved }: { r: Row; anchor: DOMRect; onClose: () => void; onSaved: () => void }) {
  const init = (iso: string | null) => (iso ? wall(iso, r.tz) : null);
  const [inV, setIn] = useState(init(r.actual.in) ?? init(r.scheduled.start)!);
  const [outV, setOut] = useState(init(r.actual.out));
  const [minOn, setMinOn] = useState(r.minSource !== 'off' && r.minHours > 0);
  const [minH, setMinH] = useState(r.minHours || 4);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    document.addEventListener('keydown', esc);
    const t = setTimeout(() => document.addEventListener('mousedown', off), 0);
    return () => { document.removeEventListener('keydown', esc); document.removeEventListener('mousedown', off); clearTimeout(t); };
  }, [onClose]);
  const iso = (v: { date: string; h: number; m: number }) => fromWall(v.date, v.h, v.m, r.tz);
  const workH = outV ? Math.max(0, (Date.parse(iso(outV)) - Date.parse(iso(inV))) / 3600_000) : null;
  const shown = workH === null ? null : Math.max(workH, minOn ? minH : 0);

  const save = async () => {
    setBusy(true); setErr('');
    try {
      const body = { clockIn: iso(inV), clockOut: outV ? iso(outV) : null };
      let id = r.entryId;
      const sameIn = r.actual.in && Math.abs(Date.parse(r.actual.in) - Date.parse(body.clockIn)) < 60_000;
      const sameOut = (r.actual.out === null && body.clockOut === null) || (r.actual.out && body.clockOut && Math.abs(Date.parse(r.actual.out) - Date.parse(body.clockOut)) < 60_000);
      if (!id) id = (await api<{ entry: { id: string } }>(`/api/assignments/${r.assignmentId}/time`, { body })).entry.id;
      else if (!sameIn || !sameOut) await api(`/api/time-entries/${id}`, { method: 'PUT', body });
      const minChanged = minOn !== (r.minSource !== 'off' && r.minHours > 0) || (minOn && minH !== r.minHours);
      if (minChanged && id) await api(`/api/time-entries/${id}/minimum`, { method: 'PUT', body: { on: minOn, hours: minOn ? minH : null } });
      show(`Saved ${r.user.name}'s time.`);
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  // Below the clicked times, kept on screen.
  const W = 300;
  const left = Math.min(Math.max(8, anchor.left), (typeof window !== 'undefined' ? window.innerWidth : 1200) - W - 8);
  const top = anchor.bottom + 8 + window.scrollY;
  return createPortal(
    <div className="ta-edit" ref={box} role="dialog" aria-label={`Actual hours for ${r.user.name}`} style={{ left, top, width: W }}>
      <h3>Actual Hours : {shown === null ? '--' : shown.toFixed(2)}{minOn && minH ? ` (${hrs(minH)} minimum)` : ''}</h3>
      <button type="button" className="btn primary small" onClick={() => { setIn(wall(r.scheduled.start, r.tz)); setOut(wall(r.scheduled.end, r.tz)); }}>Copy scheduled hours</button>
      <label className="ta-lbl">{r.clockIn ? `${r.clockIn.self ? 'Self-clock in' : 'Clock in'} by ${r.clockIn.by}` : 'Clock in'}</label>
      <TimeIn v={inV} set={setIn} label="Clock in" />
      <label className="ta-lbl">{r.clockOut ? `${r.clockOut.self ? 'Self-clock out' : 'Clock out'} by ${r.clockOut.by}` : 'Clock out'}</label>
      {outV ? (
        <>
          <TimeIn v={outV} set={(x) => setOut(x)} label="Clock out" />
          <button type="button" className="ta-link small" onClick={() => setOut(null)}>Clear End Time</button>
        </>
      ) : (
        <button type="button" className="ta-link small" onClick={() => setOut(wall(r.scheduled.end, r.tz))}>Add end time</button>
      )}
      <div className="ta-min">
        <span>Minimum Pay (hrs)</span>
        <button type="button" role="switch" aria-checked={minOn} aria-label="Minimum pay" className={`ta-switch${minOn ? ' on' : ''}`} onClick={() => setMinOn(!minOn)}><i /></button>
      </div>
      {minOn && (
        <div className="ta-minh">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          <input type="number" min={0.5} max={24} step={0.5} value={minH} onChange={(e) => setMinH(Number(e.target.value) || 0)} aria-label="Minimum paid hours" />
        </div>
      )}
      {(r.clockIn || r.clockOut) && (
        <div className="ta-dist">
          <div><small>Clock in distance:</small><span>{r.clockIn?.located ? yards(r.clockIn.distanceM) : 'No location'}</span></div>
          <div><small>Clock out distance:</small><span>{r.clockOut?.located ? yards(r.clockOut.distanceM) : r.clockOut ? 'No location' : '—'}</span></div>
        </div>
      )}
      {err && <p className="ta-err" role="alert">{err}</p>}
      <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Done'}</button>
    </div>,
    document.body,
  );
}

/** "Add New Entry": time for someone on the schedule who never clocked in. */
function AddEntry({ rows, onClose, onSaved }: { rows: Row[]; onClose: () => void; onSaved: () => void }) {
  const open = rows.filter((r) => r.status === 'none');
  const [pick, setPick] = useState(open[0]?.assignmentId ?? '');
  const r = open.find((x) => x.assignmentId === pick);
  const [inT, setInT] = useState(''); const [outT, setOutT] = useState('');
  const [err, setErr] = useState(''); const [busy, setBusy] = useState(false);
  useEffect(() => { if (r) { const a = wall(r.scheduled.start, r.tz), b = wall(r.scheduled.end, r.tz); setInT(`${pad(a.h)}:${pad(a.m)}`); setOutT(`${pad(b.h)}:${pad(b.m)}`); } }, [pick]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!r) return;
    setBusy(true); setErr('');
    try {
      const d = wall(r.scheduled.start, r.tz).date;
      const [ih, im] = inT.split(':').map(Number), [oh, om] = outT.split(':').map(Number);
      const clockIn = fromWall(d, ih!, im!, r.tz);
      let clockOut = outT ? fromWall(d, oh!, om!, r.tz) : null;
      if (clockOut && clockOut <= clockIn) clockOut = fromWall(shiftDayKey(d, 1), oh!, om!, r.tz);
      await api(`/api/assignments/${r.assignmentId}/time`, { body: { clockIn, clockOut } });
      show(`Added time for ${r.user.name}.`);
      onSaved(); onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return createPortal(
    <div className="ask-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ask ta-add" role="dialog" aria-modal="true" aria-labelledby="ta-add-h">
        <h3 id="ta-add-h">Add New Entry</h3>
        {open.length === 0 ? <p className="muted">Everyone scheduled in this view already has time.</p> : (
          <>
            <label>Person and shift
              <select value={pick} onChange={(e) => setPick(e.target.value)}>
                {open.map((x) => <option key={x.assignmentId} value={x.assignmentId}>{x.user.name} · {x.role} · {x.event.name} ({t12(x.scheduled.start, x.tz)})</option>)}
              </select>
            </label>
            <div className="row">
              <label>Clock in<input type="time" value={inT} onChange={(e) => setInT(e.target.value)} /></label>
              <label>Clock out<input type="time" value={outT} onChange={(e) => setOutT(e.target.value)} /></label>
            </div>
          </>
        )}
        {err && <p className="ta-err" role="alert">{err}</p>}
        <div className="ask-acts">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          {open.length > 0 && <button type="button" className="btn primary" disabled={busy || !inT} onClick={save}>Add entry</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
const shiftDayKey = shiftDay;

function Body({ me }: { me: Me }) {
  const [from, setFrom] = useState(todayKey());
  const [to, setTo] = useState(todayKey());
  const [client, setClient] = useState('');
  const [clientQ, setClientQ] = useState('');
  const [group, setGroup] = useState('');
  const [status, setStatus] = useState<Row['status'] | ''>('');
  const [conds, setConds] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [by, setBy] = useState<GroupBy>(() => { try { return (localStorage.getItem('lo-ta-by') as GroupBy) || 'event'; } catch { return 'event'; } });
  const [data, setData] = useState<Resp | null>(null);
  const [err, setErr] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<{ r: Row; rect: DOMRect } | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => { const t = setTimeout(() => setClientQ(client.trim()), 300); return () => clearTimeout(t); }, [client]);
  useEffect(() => { try { localStorage.setItem('lo-ta-by', by); } catch { /* storage blocked */ } }, [by]);

  const load = useCallback(async () => {
    const p = new URLSearchParams({ from, to });
    if (clientQ) p.set('client', clientQ);
    if (group) p.set('group', group);
    if (status) p.set('status', status);
    if (conds.length) p.set('cond', conds.join(','));
    try { setData(await api<Resp>(`/api/attendance?${p}`)); setErr(''); } catch (e) { setErr((e as Error).message); }
  }, [from, to, clientQ, group, status, conds]);
  useEffect(() => { load(); }, [load]);
  // Keep it live while people clock in and out.
  useEffect(() => { const t = setInterval(() => { if (!edit && document.visibilityState === 'visible') load(); }, 60_000); return () => clearInterval(t); }, [load, edit]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => !s || [r.user.name, r.role, r.event.name, r.event.number ?? ''].some((x) => x.toLowerCase().includes(s)));
  }, [data, q]);
  const groups = useMemo(() => {
    const m = new Map<string, { key: string; date: string; title: string; sub: string | null; number: string | null; href: string | null; rows: Row[] }>();
    for (const r of rows) {
      const k = by === 'event' ? `${r.date}|${r.event.id}` : by === 'person' ? `${r.date}|${r.user.id}` : by === 'role' ? `${r.date}|${r.role.toLowerCase()}` : r.date;
      let g = m.get(k);
      if (!g) m.set(k, (g = {
        key: k, date: r.date, rows: [],
        title: by === 'event' ? r.event.name : by === 'person' ? r.user.name : by === 'role' ? r.role : 'All shifts',
        sub: by === 'event' ? r.event.client : null, number: by === 'event' ? r.event.number : null,
        href: by === 'event' ? `/events/${r.event.id}` : by === 'person' ? `/crew/${r.user.id}` : null,
      }));
      g.rows.push(r);
    }
    return [...m.values()];
  }, [rows, by]);

  const canApprove = !!data?.canApprove;
  const approve = async (ids: string[], what: string) => {
    if (!ids.length) return;
    setBusy(true);
    try {
      const r = await api<{ approved: number; skipped: number }>('/api/attendance/approve', { body: { entryIds: ids } });
      show(r.approved ? `Approved ${what}.` : 'Nothing to approve: only clocked-out time can be approved.');
      setSel(new Set()); await load();
    } catch (e) { show((e as Error).message, { error: true }); } finally { setBusy(false); }
  };
  const approvable = (list: Row[]) => list.filter((r) => r.status === 'out' && r.entryId).map((r) => r.entryId!);
  const selRows = rows.filter((r) => sel.has(r.assignmentId));
  const toggle = (ids: string[], on: boolean) => setSel((s) => { const n = new Set(s); ids.forEach((i) => (on ? n.add(i) : n.delete(i))); return n; });

  const menu = (r: Row): MenuItem[] => [
    ...(r.status === 'approved' && canApprove && !r.exported && r.entryId ? [{ label: 'Unapprove', icon: 'restore', onClick: async () => { try { await api(`/api/time-entries/${r.entryId}/unapprove`, { body: {} }); show('Unapproved.'); load(); } catch (e) { show((e as Error).message, { error: true }); } } }] : []),
    ...(r.status === 'in' && canApprove && r.entryId ? [{ label: 'Clock out at scheduled end', icon: 'check', onClick: async () => { try { await api(`/api/time-entries/${r.entryId}`, { method: 'PUT', body: { clockIn: r.actual.in, clockOut: r.scheduled.end } }); show(`Clocked ${r.user.name} out.`); load(); } catch (e) { show((e as Error).message, { error: true }); } } }] : []),
    ...(r.status === 'none' && canApprove ? [{ label: 'Add scheduled hours', icon: 'free', onClick: async () => { try { await api(`/api/assignments/${r.assignmentId}/time`, { body: { clockIn: r.scheduled.start, clockOut: r.scheduled.end } }); show(`Added scheduled hours for ${r.user.name}.`); load(); } catch (e) { show((e as Error).message, { error: true }); } } }] : []),
    'divider',
    { label: 'Open event', icon: 'link', onClick: () => { window.location.href = `/events/${r.event.id}`; } },
    { label: 'View profile', icon: 'person', onClick: () => { window.location.href = `/crew/${r.user.id}`; } },
  ];

  const statusLabel = status ? STATUS_LABEL[status] : 'All Statuses';
  const groupLabel = group ? data?.groups.find((g) => g.id === group)?.name ?? 'Group' : 'All Departments';
  const condLabel = conds.length ? conds.join(', ') : 'All Condition Types';
  const filtered = !!(clientQ || group || status || conds.length || from !== todayKey() || to !== todayKey());
  const st = data?.stats;
  const oneDay = from === to;

  return (
    <div className="ta">
      <div className="ta-head">
        <div className="ta-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
          <h1>Time &amp; Attendance: <span>{oneDay ? longDay(from) : `${longDay(from)} – ${longDay(to)}`}</span></h1>
          <div className="ta-daynav">
            <button type="button" className="ta-link" onClick={() => { setFrom(shiftDay(from, -1)); setTo(shiftDay(oneDay ? from : to, -1)); }}>‹ Prev Day</button>
            <button type="button" className="ta-link" onClick={() => { setFrom(shiftDay(from, 1)); setTo(shiftDay(oneDay ? from : to, 1)); }}>Next Day ›</button>
          </div>
        </div>
        <div className="ta-filters">
          <label className="ta-f">From <input type="date" value={from} onChange={(e) => { const v = e.target.value; if (!v) return; setFrom(v); if (v > to) setTo(v); }} /></label>
          <label className="ta-f">To <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
          <label className="ta-f">Client: <input value={client} onChange={(e) => setClient(e.target.value)} placeholder="Filter by Client" /></label>
          <Pick label="Workers from" value={groupLabel}>
            {(close) => (
              <>
                <button type="button" role="menuitemradio" aria-checked={!group} onClick={() => { setGroup(''); close(); }}>All Departments</button>
                {data?.groups.map((g) => <button key={g.id} type="button" role="menuitemradio" aria-checked={group === g.id} onClick={() => { setGroup(g.id); close(); }}>{g.name}</button>)}
                {!data?.groups.length && <p className="muted small">No crew groups yet.</p>}
              </>
            )}
          </Pick>
          <Pick label="Statuses" value={statusLabel}>
            {(close) => (
              <>
                <button type="button" role="menuitemradio" aria-checked={!status} onClick={() => { setStatus(''); close(); }}>All Statuses</button>
                {(Object.keys(STATUS_LABEL) as Row['status'][]).map((k) => <button key={k} type="button" role="menuitemradio" aria-checked={status === k} onClick={() => { setStatus(k); close(); }}>{STATUS_LABEL[k]}</button>)}
              </>
            )}
          </Pick>
          <Pick label="Conditions" value={condLabel}>
            {() => (
              <>
                {data?.conditions.map((c) => (
                  <label key={c.code} className="ta-cond-opt">
                    <input type="checkbox" checked={conds.includes(c.code)} onChange={(e) => setConds((x) => (e.target.checked ? [...x, c.code] : x.filter((y) => y !== c.code)))} />
                    <span className={`ta-chip${c.flag ? ' bad' : ''}`}>{c.code}</span> {c.label}
                  </label>
                ))}
              </>
            )}
          </Pick>
          {filtered && <button type="button" className="ta-link" onClick={() => { setFrom(todayKey()); setTo(todayKey()); setClient(''); setGroup(''); setStatus(''); setConds([]); }}>Clear</button>}
        </div>
      </div>

      {err && <Banner>{err}</Banner>}
      {!data ? <Skeleton /> : (
        <>
          <div className="ta-stats">
            {[
              ['Total Shifts Found', st!.total, ''], ['Scheduled Shifts', st!.scheduled, ''], ['Unscheduled Shifts', st!.unscheduled, ''],
              ['Unapproved and Clocked Out', st!.unapprovedOut, 'out'], ['Approved Shifts', st!.approved, 'approved'], ['Flagged Shifts', st!.flagged, 'flag'],
            ].map(([label, n, k]) => (
              <button type="button" key={label as string} className={`ta-stat ${k === 'approved' ? 'ok' : k === 'flag' ? 'bad' : ''}`}
                onClick={() => { if (k === 'out' || k === 'approved') setStatus(status === k ? '' : (k as Row['status'])); else if (k === 'flag') setConds(conds.length ? [] : data.conditions.filter((c) => c.flag).map((c) => c.code)); }}
                aria-pressed={(k === 'out' || k === 'approved') ? status === k : k === 'flag' ? conds.length > 0 : undefined}>
                <b>{n as number}</b><span>{label as string}</span>
              </button>
            ))}
          </div>

          <div className="ta-bar">
            <input type="checkbox" aria-label="Select all shifts" checked={rows.length > 0 && rows.every((r) => sel.has(r.assignmentId))} onChange={(e) => toggle(rows.map((r) => r.assignmentId), e.target.checked)} />
            <b>Shifts</b>
            <select value={by} onChange={(e) => setBy(e.target.value as GroupBy)} aria-label="Group by">
              <option value="event">By Event</option><option value="person">By Person</option><option value="role">By Position</option><option value="none">No grouping</option>
            </select>
            <label className="ta-search">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search" aria-label="Search people, events and positions" />
            </label>
            {selRows.length > 0 && canApprove && (
              <button type="button" className="btn small" disabled={busy || !approvable(selRows).length} onClick={() => approve(approvable(selRows), `${approvable(selRows).length} selected`)}>
                Approve selected ({approvable(selRows).length})
              </button>
            )}
            {canApprove && <button type="button" className="btn primary ta-add-btn" onClick={() => setAdding(true)}>Add New Entry</button>}
          </div>

          {groups.length === 0 && <div className="ta-empty">No shifts {oneDay ? 'on this day' : 'in these dates'}{filtered || q ? ' match these filters' : ''}.</div>}

          {groups.map((g) => {
            const open = !shut.has(g.key);
            const total = g.rows.reduce((n, r) => n + (r.paidHours ?? 0), 0);
            const appr = g.rows.filter((r) => r.status === 'approved').length, flag = g.rows.filter((r) => r.flagged).length;
            const ids = approvable(g.rows);
            const allSel = g.rows.every((r) => sel.has(r.assignmentId));
            return (
              <section key={g.key} className="ta-group">
                <header className={`ta-gh${open ? ' open' : ''}`}>
                  <input type="checkbox" aria-label={`Select ${g.title}`} checked={allSel} onChange={(e) => toggle(g.rows.map((r) => r.assignmentId), e.target.checked)} />
                  <span className="ta-cal" aria-hidden="true"><i>{mon(g.date)}</i><b>{Number(g.date.slice(8))}</b></span>
                  <div className="ta-gt">
                    <small>{fullDay(g.date)}</small>
                    <span>
                      {g.href ? <Link href={g.href}><b>{g.title}</b></Link> : <b>{g.title}</b>}
                      {g.sub && <b> ({g.sub})</b>}
                      {g.number && <em> ({g.number})</em>}
                    </span>
                  </div>
                  <div className="ta-gtot"><small>Total:</small><span>{total.toFixed(2)} hrs</span></div>
                  <div className="ta-gcounts">
                    <span>{g.rows.length} {g.rows.length === 1 ? 'Shift' : 'Shifts'}</span>
                    <span className="ok">{appr} Approved</span>
                    <span className="bad">{flag} Flagged</span>
                  </div>
                  {canApprove && <button type="button" className="btn primary ta-appall" disabled={busy || !ids.length} onClick={() => approve(ids, `${ids.length} ${ids.length === 1 ? 'shift' : 'shifts'} on ${g.title}`)}>Approve All</button>}
                  <button type="button" className="ta-fold" aria-expanded={open} aria-label={open ? `Collapse ${g.title}` : `Expand ${g.title}`} onClick={() => setShut((s) => { const n = new Set(s); if (open) n.add(g.key); else n.delete(g.key); return n; })}>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d={open ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
                  </button>
                </header>
                {open && g.rows.map((r) => {
                  const loc = r.clockIn?.located ? `Clock in ${yards(r.clockIn.distanceM)} from the venue${r.clockOut?.located ? `, clock out ${yards(r.clockOut.distanceM)}` : ''}` : '';
                  return (
                    <div key={r.assignmentId} className={`ta-row${r.status === 'approved' ? ' approved' : ''}${sel.has(r.assignmentId) ? ' sel' : ''}`}>
                      <input type="checkbox" aria-label={`Select ${r.user.name}`} checked={sel.has(r.assignmentId)} onChange={(e) => toggle([r.assignmentId], e.target.checked)} />
                      <Avatar name={r.user.name} flag={r.flagged} ok={r.status === 'approved'} />
                      <div className="ta-who">
                        <Link href={`/crew/${r.user.id}`}><b>{r.user.name}</b></Link>
                        <small>{by === 'event' ? r.role : by === 'person' ? `${r.role} · ${r.event.name}` : `${r.event.name}${by === 'none' ? ` · ${r.role}` : ''}`}</small>
                      </div>
                      <button type="button" className="ta-times" disabled={!canApprove} onClick={(e) => setEdit({ r, rect: (e.currentTarget as HTMLElement).getBoundingClientRect() })} title={canApprove ? 'Edit actual hours' : undefined}>
                        <span><i>A:</i> {r.actual.in ? `${t12(r.actual.in, r.tz)} – ${r.actual.out ? t12(r.actual.out, r.tz) : ''}` : '—'}</span>
                        <span><i>S:</i> {t12(r.scheduled.start, r.tz)} – {t12(r.scheduled.end, r.tz)}</span>
                        {r.breaks.map((b, i) => <span key={i} className="brk"><i>B:</i> {t12(b.start, r.tz)} – {b.end ? t12(b.end, r.tz) : ''}</span>)}
                      </button>
                      <div className="ta-hrs">
                        <span>
                          <b>{r.paidHours !== null ? `${r.paidHours.toFixed(2)} hrs` : '-- hrs'}</b>
                          {r.minHours > 0 && <b> (min {hrs(r.minHours)})</b>}
                          {loc && <Pin title={loc} />}
                        </span>
                        <span>{hrs(r.scheduled.hours)} hrs</span>
                        {r.breaks.map((b, i) => <span key={i} className="brk">{b.hours !== null ? `${b.hours.toFixed(2)} hrs` : '-- hrs'}</span>)}
                      </div>
                      <div className="ta-adj">{r.adjust > 0 && <span className="ta-adjchip" title={`Worked ${r.actual.hours?.toFixed(2)} h; the ${hrs(r.minHours)}-hour minimum is paid`}>+{r.adjust.toFixed(2)} hr</span>}</div>
                      <div className="ta-conds">
                        {r.conditions.map((c) => <span key={c.code} className={`ta-chip${c.flag && r.status !== 'approved' ? ' bad' : ''}`} title={`${c.label}: ${c.why}`}>{c.code}</span>)}
                      </div>
                      <button type="button" className="ta-ico" disabled={!canApprove} aria-label={`Edit ${r.user.name}'s time`} title="Edit time" onClick={(e) => setEdit({ r, rect: (e.currentTarget.closest('.ta-row')!.querySelector('.ta-times') as HTMLElement).getBoundingClientRect() })}><EditIco /></button>
                      <div className="ta-act">
                        {r.status === 'approved'
                          ? <span className="ta-apprby">Approved{r.approvedBy ? <> by<br />{r.approvedBy}</> : ''}</span>
                          : canApprove && <button type="button" className="btn primary small" disabled={busy || r.status !== 'out'} title={r.status === 'none' ? 'Not clocked in' : r.status === 'in' ? 'Still clocked in' : undefined} onClick={() => approve([r.entryId!], `${r.user.name}'s shift`)}>Approve</button>}
                      </div>
                      <ActionMenu compact label={`More for ${r.user.name}`} items={menu(r)} />
                    </div>
                  );
                })}
              </section>
            );
          })}
        </>
      )}
      {edit && <EditTime key={edit.r.assignmentId} r={edit.r} anchor={edit.rect} onClose={() => setEdit(null)} onSaved={load} />}
      {adding && data && <AddEntry rows={rows} onClose={() => setAdding(false)} onSaved={load} />}
      {me.role === 'hr' && <p className="muted small">HR can see time and attendance; coordinators approve it.</p>}
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager', 'hr']}>{(me) => <Body me={me} />}</Shell>;
}
