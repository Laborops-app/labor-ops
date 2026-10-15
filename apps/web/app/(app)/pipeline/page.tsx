'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import CustomerSelect from '@/components/CustomerSelect';
import CustomerPicker, { customerBody, RentmanSend, useCustomerList, useRentmanSend, type CustomerChoice } from '@/components/CustomerPicker';
import TopbarAction, { PlusIcon, SearchIcon, avClass, initialsOf } from '@/components/TopbarAction';
import { Banner } from '@/components/ui';
import { api, Me, roleLabel } from '@/lib/api';
import { STATUS, STATUS_ORDER, PRIORITY, type PipelineStatus, type Priority } from '@/lib/pipeline';

/* Event pipeline board, from the "Project Management Dashboard" Figma design: a column per stage, a card per event. */

type Card = {
  id: string; name: string; client: string | null; venue: string | null; start_date: string; end_date: string; status: PipelineStatus; priority: Priority;
  status_changed_at: string; customer_id: string | null; customer_name: string | null; created_by: string | null;
  slots: number; filled: number; accepted: number; waiting: number; shift_count: number; on_clock: number; to_approve: number; to_rate: number; invoiced: boolean; messages: number;
  quote: { id: string; number: number; status: string } | null; crew: { id: string; name: string; status: string }[];
};
type Board = { events: Card[]; team: { id: string; name: string; role: string }[] };
type Range = 'upcoming' | '30d' | 'month' | 'all';
const RANGES: [Range, string][] = [['upcoming', 'Upcoming'], ['30d', 'Next 30 days'], ['month', 'This month'], ['all', 'All dates']];

const Svg = ({ children, size = 16 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const Ico = {
  filter: <path d="M4 5h16l-6 7.5V19l-4 1v-7.5z" />,
  cal: <><rect x="3.5" y="5" width="17" height="15.5" rx="2.5" /><path d="M8 3v4M16 3v4M3.5 10h17" /></>,
  down: <path d="m6 9 6 6 6-6" />,
  share: <><circle cx="9" cy="8" r="3" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.6M18 19a5 5 0 0 0-2.5-4.3" /></>,
  board: <><rect x="4" y="4" width="16" height="7" rx="1.5" /><rect x="4" y="13" width="16" height="7" rx="1.5" /></>,
  grid: <><circle cx="7" cy="7" r="1.6" /><circle cx="17" cy="7" r="1.6" /><circle cx="7" cy="17" r="1.6" /><circle cx="17" cy="17" r="1.6" /></>,
  plus: <><rect x="3" y="3" width="18" height="18" rx="5" /><path d="M12 8v8M8 12h8" /></>,
  chat: <path d="M8 18.5H7.5C4.5 18.5 3 17.75 3 14V8.5C3 5.5 4.5 4 7.5 4h9C19.5 4 21 5.5 21 8.5V14c0 3-1.5 4.5-4.5 4.5H16a1 1 0 0 0-.8.4l-1.4 1.8c-.6.8-1.6.8-2.2 0l-1.4-1.8a1 1 0 0 0-.8-.4Z" />,
  shifts: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M8 3v4M16 3v4M8 12h8M8 16h5" /></>,
  link: <path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
};

const dayMs = 86400000;
const toDate = (d: string) => new Date(`${d.slice(0, 10)}T12:00:00`);
const short = (d: string) => toDate(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
function when(c: Card) {
  const today = new Date(new Date().toDateString()).getTime() + dayMs / 2;
  const s = toDate(c.start_date).getTime(), e = toDate(c.end_date).getTime();
  const range = c.start_date.slice(0, 10) === c.end_date.slice(0, 10) ? short(c.start_date) : `${short(c.start_date)} – ${short(c.end_date)}`;
  const days = Math.round((s - today) / dayMs);
  const rel = today >= s && today <= e ? 'Today' : days > 0 ? (days === 1 ? 'Tomorrow' : `In ${days} days`) : `Ended ${Math.round((today - e) / dayMs)}d ago`;
  return { range, rel, live: today >= s && today <= e, past: today > e };
}
const since = (iso: string) => {
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / dayMs);
  return d < 1 ? 'today' : d === 1 ? '1 day' : `${d} days`;
};
const QUOTE_TONE: Record<string, string> = { draft: 'grey', sent: 'orange', accepted: 'green', declined: 'red' };

/* ---------- one card ---------- */
function CardMenu({ c, onMove, onPriority }: { c: Card; onMove: (s: PipelineStatus) => void; onPriority: (p: Priority) => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  return (
    <div className="pm-menu" ref={box}>
      <button type="button" className="pm-dots" aria-label={`Options for ${c.name}`} aria-expanded={open} onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>
        <span /><span /><span />
      </button>
      {open && (
        <div className="pm-menu-pop" role="menu" onClick={(e) => e.stopPropagation()}>
          <Link role="menuitem" href={`/events/${c.id}`}>Open event</Link>
          <div className="pm-menu-label">Move to</div>
          {STATUS_ORDER.filter((s) => s !== c.status).map((s) => (
            <button key={s} role="menuitem" type="button" onClick={() => { setOpen(false); onMove(s); }}>
              <i className="pm-dot" style={{ background: STATUS[s].color }} /> {STATUS[s].label}
            </button>
          ))}
          <div className="pm-menu-label">Priority</div>
          <div className="pm-menu-row">
            {(['low', 'medium', 'high'] as Priority[]).map((p) => (
              <button key={p} type="button" role="menuitemradio" aria-checked={c.priority === p} className={`pm-pill ${PRIORITY[p].tone} ${c.priority === p ? 'sel' : ''}`} onClick={() => { setOpen(false); onPriority(p); }}>
                {PRIORITY[p].label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CardView({ c, onMove, onPriority, onDragStart, onDragEnd, dragging }: { c: Card; onMove: (s: PipelineStatus) => void; onPriority: (p: Priority) => void; onDragStart: (e: React.DragEvent, c: Card) => void; onDragEnd: () => void; dragging: boolean }) {
  const router = useRouter();
  const w = when(c);
  const pct = c.slots ? Math.min(100, Math.round((c.filled / c.slots) * 100)) : 0;
  const tone = !c.slots ? 'none' : c.filled >= c.slots ? 'good' : c.filled > 0 ? 'warn' : 'bad';
  const wrap = c.status === 'completed' || (c.status === 'in_progress' && w.past);
  const shown = c.crew.slice(0, 3);
  return (
    <article
      className={`pm-card ${dragging ? 'dragging' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, c)}
      onDragEnd={onDragEnd}
      onClick={() => router.push(`/events/${c.id}`)}
      aria-label={`${c.name}, ${STATUS[c.status].label}`}
    >
      <div className="pm-card-top">
        <span className={`pm-pill ${c.status === 'completed' ? 'green' : PRIORITY[c.priority].tone}`}>{c.status === 'completed' ? 'Completed' : c.status === 'canceled' ? 'Canceled' : PRIORITY[c.priority].label}</span>
        <span className={`pm-when ${w.live ? 'live' : ''}`} title={w.range}>{w.live && <i className="pm-live" />}{w.rel}</span>
        <CardMenu c={c} onMove={onMove} onPriority={onPriority} />
      </div>
      <h3><Link href={`/events/${c.id}`} onClick={(e) => e.stopPropagation()}>{c.name}</Link></h3>
      <p className="pm-desc">{[c.customer_name ?? c.client, c.venue].filter(Boolean).join(' · ') || 'No client or venue yet'} · {w.range}</p>

      {c.status !== 'canceled' && (c.shift_count > 0 || c.status === 'confirmed' || c.status === 'in_progress') && (
        <div className={`pm-crew ${tone}`}>
          <div className="pm-crew-top">
            <b>Crew</b>
            <span>{c.slots ? `${c.filled}/${c.slots} seats` : c.shift_count ? 'No seats' : 'No shifts yet'}</span>
          </div>
          <span className="pm-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
          <div className="pm-crew-sub">
            {c.slots > 0 && <span>{c.accepted} confirmed</span>}
            {c.waiting > 0 && <span className="warn">{c.waiting} waiting</span>}
            {c.slots > c.filled && <span className="bad">{c.slots - c.filled} open</span>}
            {c.on_clock > 0 && <span className="live"><i className="pm-live" />{c.on_clock} on the clock</span>}
          </div>
        </div>
      )}

      {wrap && (
        <ul className="pm-wrap" aria-label="Wrap-up">
          <li className={c.to_approve ? 'todo' : 'done'}><Svg size={14}>{c.to_approve ? Ico.clock : Ico.check}</Svg>{c.to_approve ? `${c.to_approve} timesheet${c.to_approve === 1 ? '' : 's'} to approve` : 'Timesheets approved'}</li>
          <li className={c.to_rate ? 'todo' : 'done'}><Svg size={14}>{c.to_rate ? Ico.clock : Ico.check}</Svg>{c.to_rate ? `${c.to_rate} to rate` : 'Crew rated'}</li>
          <li className={c.invoiced ? 'done' : 'todo'}><Svg size={14}>{c.invoiced ? Ico.check : Ico.clock}</Svg>{c.invoiced ? 'Invoiced' : 'Not invoiced'}</li>
        </ul>
      )}

      {c.quote && (
        <Link href={`/quotes/${c.quote.id}`} className={`pm-quote ${QUOTE_TONE[c.quote.status] ?? 'grey'}`} onClick={(e) => e.stopPropagation()}>
          Quote #{c.quote.number} · {c.quote.status[0].toUpperCase() + c.quote.status.slice(1)}
        </Link>
      )}

      <div className="pm-foot">
        <span className="pm-avs" aria-label={`${c.crew.length} crew`}>
          {shown.map((p) => (
            <span key={p.id} className={`${avClass(p.name)} ${p.status === 'accepted' ? '' : 'pending'}`} title={`${p.name}${p.status === 'accepted' ? '' : ' (waiting for an answer)'}`}>{initialsOf(p.name)}</span>
          ))}
          {c.crew.length > 3 && <span className="av pm-av-more">+{c.crew.length - 3}</span>}
          {!c.crew.length && <span className="pm-nocrew">No crew yet</span>}
        </span>
        <span className="pm-stats">
          <span className="pm-stat" title="Messages in the event chat"><Svg>{Ico.chat}</Svg>{c.messages} {c.messages === 1 ? 'message' : 'messages'}</span>
          <span className="pm-stat" title="Shifts"><Svg>{Ico.shifts}</Svg>{c.shift_count} {c.shift_count === 1 ? 'shift' : 'shifts'}</span>
        </span>
      </div>
      <div className="pm-age" title={`Moved to ${STATUS[c.status].label} ${new Date(c.status_changed_at).toLocaleString()}`}>{STATUS[c.status].label} for {since(c.status_changed_at)}</div>
    </article>
  );
}

/* ---------- new event ---------- */
function NewEvent({ status, onClose, onCreated }: { status: PipelineStatus; onClose: () => void; onCreated: (id: string, warning?: string) => void }) {
  const [f, setF] = useState({ name: '', startDate: '', endDate: '', venue: '', status, priority: 'medium' as Priority });
  const [cust, setCust] = useState<CustomerChoice>({ mode: 'existing', customerId: null, client: '' });
  const customers = useCustomerList();
  const rmSend = useRentmanSend();
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api<{ event: { id: string }; warning?: string }>('/api/events', {
        body: { name: f.name, startDate: f.startDate, endDate: f.endDate || f.startDate, venue: f.venue || null, ...customerBody(cust), status: f.status, priority: f.priority, pushToRentman: rmSend.on || undefined },
      });
      onCreated(r.event.id, r.warning);
    } catch (x: any) {
      setErr(x.message);
      setBusy(false);
    }
  };
  return (
    <Modal title="New event" onClose={onClose}>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      <form onSubmit={save} className="pm-form">
        <label>Event name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus maxLength={150} placeholder="U of U Game Day" /></label>
        <div className="two">
          <label>Starts<input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate && f.endDate >= e.target.value ? f.endDate : e.target.value })} required /></label>
          <label>Ends<input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} /></label>
        </div>
        <CustomerPicker value={cust} onChange={setCust} list={customers} />
        <label>Venue <span className="muted small">(optional)</span><input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} maxLength={200} /></label>
        <div className="two">
          <label>Stage
            <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as PipelineStatus })}>
              {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
            </select>
          </label>
          <label>Priority
            <select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as Priority })}>
              {(['low', 'medium', 'high'] as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}
            </select>
          </label>
        </div>
        <RentmanSend state={rmSend} />
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy}>{busy ? 'Creating…' : 'Create event'}</button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------- dropdown button ---------- */
function Drop({ label, icon, children, active }: { label: string; icon: React.ReactNode; children: (close: () => void) => React.ReactNode; active?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <div className="pm-drop" ref={box}>
      <button type="button" className={`pm-btn ${active ? 'active' : ''}`} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Svg>{icon}</Svg>{label}<Svg>{Ico.down}</Svg>
      </button>
      {open && <div className="pm-drop-pop">{children(() => setOpen(false))}</div>}
    </div>
  );
}

/* ---------- page ---------- */
function Body({ me }: { me: Me }) {
  const router = useRouter();
  const [board, setBoard] = useState<Board | null>(null);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [range, setRange] = useState<Range>('upcoming');
  const [customer, setCustomer] = useState<string | null>(null);
  const [mine, setMine] = useState(false);
  const [prio, setPrio] = useState<Priority[]>([]);
  const [q, setQ] = useState('');
  const [view, setView] = useState<'board' | 'list'>('board');
  const [showCanceled, setShowCanceled] = useState(false);
  const [creating, setCreating] = useState<PipelineStatus | null>(null);
  const [drag, setDrag] = useState<{ id: string; from: PipelineStatus } | null>(null);
  const [over, setOver] = useState<{ col: PipelineStatus; index: number } | null>(null);

  useEffect(() => {
    try {
      const v = localStorage.getItem('lo_pm_view');
      if (v === 'list' || v === 'board') setView(v);
      if (localStorage.getItem('lo_pm_canceled') === '1') setShowCanceled(true);
    } catch { /* storage blocked */ }
  }, []);
  const remember = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

  const load = useCallback(() => {
    const p = new URLSearchParams({ range });
    if (customer) p.set('customerId', customer);
    if (mine) p.set('mine', '1');
    return api<Board>(`/api/pipeline?${p}`).then(setBoard).catch((e) => setErr(e.message));
  }, [range, customer, mine]);
  useEffect(() => { load(); }, [load]);

  const needle = q.trim().toLowerCase();
  const cards = useMemo(
    () => (board?.events ?? []).filter((c) => (!prio.length || prio.includes(c.priority)) && (!needle || `${c.name} ${c.client ?? ''} ${c.customer_name ?? ''} ${c.venue ?? ''}`.toLowerCase().includes(needle))),
    [board, prio, needle],
  );
  const col = (s: PipelineStatus) => cards.filter((c) => c.status === s);

  const patch = async (id: string, body: Record<string, unknown>, optimistic: (b: Board) => Board) => {
    if (!board) return;
    const before = board;
    setBoard(optimistic(board));
    try {
      await api(`/api/events/${id}/pipeline`, { method: 'PATCH', body });
    } catch (e: any) {
      setBoard(before);
      setErr(e.message);
    }
  };
  const move = (c: Card, to: PipelineStatus, index?: number) => {
    const target = (board?.events ?? []).filter((x) => x.status === to && x.id !== c.id);
    const at = index == null ? 0 : Math.min(index, target.length);
    const order = [...target.slice(0, at).map((x) => x.id), c.id, ...target.slice(at).map((x) => x.id)];
    const moved = { ...c, status: to, status_changed_at: c.status === to ? c.status_changed_at : new Date().toISOString() };
    if (c.status !== to) setNote(`Moved ${c.name} to ${STATUS[to].label}.`);
    if (to === 'canceled' && !showCanceled) setShowCanceled(true);
    patch(c.id, { status: c.status === to ? undefined : to, order }, (b) => {
      const rest = b.events.filter((x) => x.id !== c.id);
      const others = rest.filter((x) => x.status !== to);
      const ordered = order.map((id) => (id === c.id ? moved : rest.find((x) => x.id === id)!)).filter(Boolean);
      return { ...b, events: [...others, ...ordered] };
    });
  };
  const setPriority = (c: Card, p: Priority) => patch(c.id, { priority: p }, (b) => ({ ...b, events: b.events.map((x) => (x.id === c.id ? { ...x, priority: p } : x)) }));

  // Dragging: a tilted copy follows the pointer (like the design), a dashed slot shows where it will land.
  const onDragStart = (e: React.DragEvent, c: Card) => {
    setDrag({ id: c.id, from: c.status });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', c.id);
    const el = e.currentTarget as HTMLElement;
    const ghost = el.cloneNode(true) as HTMLElement;
    ghost.classList.add('pm-ghost');
    ghost.style.width = `${el.offsetWidth}px`;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    setTimeout(() => ghost.remove(), 0);
  };
  const onDragOver = (e: React.DragEvent, s: PipelineStatus) => {
    if (!drag) return;
    e.preventDefault();
    const list = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.pm-card:not(.dragging)');
    let index = list.length;
    for (let i = 0; i < list.length; i++) {
      const r = list[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }
    if (!over || over.col !== s || over.index !== index) setOver({ col: s, index });
  };
  const onDrop = (e: React.DragEvent, s: PipelineStatus) => {
    e.preventDefault();
    const c = board?.events.find((x) => x.id === drag?.id);
    if (c && over) move(c, s, over.index);
    setDrag(null);
    setOver(null);
  };

  const share = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setNote('Link to this board copied. Anyone in your company with access can open it.');
    } catch {
      setNote(window.location.href);
    }
  };

  const cols = STATUS_ORDER.filter((s) => s !== 'canceled' || showCanceled);
  const team = board?.team ?? [];
  const filters = (customer ? 1 : 0) + (mine ? 1 : 0) + prio.length;

  return (
    <div className="pm">
      <TopbarAction>
        <button className="btn primary pm-new" onClick={() => setCreating('pending')} aria-label="New event"><span className="pm-new-txt">New Event</span><PlusIcon /></button>
      </TopbarAction>

      <div className="pm-head">
        <div className="pm-title">
          <h1>Event pipeline</h1>
          <button type="button" className="pm-icon-btn" title="Copy link to this board" aria-label="Copy link to this board" onClick={share}><Svg>{Ico.link}</Svg></button>
        </div>
        <div className="pm-team">
          <Link href="/crew" className="pm-invite"><Svg size={18}>{Ico.plus}</Svg>Team</Link>
          <span className="pm-team-avs">
            {team.slice(0, 4).map((t) => <span key={t.id} className={avClass(t.name)} title={`${t.name} · ${roleLabel(t.role)}`}>{initialsOf(t.name)}</span>)}
            {team.length > 4 && <span className="av pm-av-more">+{team.length - 4}</span>}
          </span>
        </div>
      </div>

      <div className="pm-bar-row">
        <div className="pm-tools">
          <Drop label={filters ? `Filter · ${filters}` : 'Filter'} icon={Ico.filter} active={!!filters}>
            {() => (
              <div className="pm-filter">
                <CustomerSelect value={customer} onPick={(c) => setCustomer(c?.id ?? null)} label="Customer" />
                <div className="pm-filter-h">Priority</div>
                <div className="pm-menu-row">
                  {(['low', 'medium', 'high'] as Priority[]).map((p) => (
                    <button key={p} type="button" aria-pressed={prio.includes(p)} className={`pm-pill ${PRIORITY[p].tone} ${prio.includes(p) ? 'sel' : ''}`} onClick={() => setPrio(prio.includes(p) ? prio.filter((x) => x !== p) : [...prio, p])}>{PRIORITY[p].label}</button>
                  ))}
                </div>
                <label className="check"><input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> Only events I created</label>
                <label className="check"><input type="checkbox" checked={showCanceled} onChange={(e) => { setShowCanceled(e.target.checked); remember('lo_pm_canceled', e.target.checked ? '1' : '0'); }} /> Show canceled</label>
                {filters > 0 && <button type="button" className="btn ghost small" onClick={() => { setCustomer(null); setMine(false); setPrio([]); }}>Clear filters</button>}
              </div>
            )}
          </Drop>
          <Drop label={RANGES.find((r) => r[0] === range)![1]} icon={Ico.cal}>
            {(close) => (
              <div className="pm-list-pop" role="menu">
                {RANGES.map(([k, l]) => (
                  <button key={k} type="button" role="menuitemradio" aria-checked={range === k} className={range === k ? 'on' : ''} onClick={() => { setRange(k); close(); }}>{l}</button>
                ))}
              </div>
            )}
          </Drop>
          <span className="pill-input pm-search">
            <SearchIcon />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search events, clients, venues" aria-label="Search events" />
          </span>
        </div>
        <div className="pm-tools">
          <button type="button" className="pm-btn" onClick={share}><Svg>{Ico.share}</Svg>Share</button>
          <span className="pm-sep" aria-hidden="true" />
          <div className="pm-views" role="tablist" aria-label="View">
            <button type="button" role="tab" aria-selected={view === 'board'} className={view === 'board' ? 'on' : ''} title="Board" aria-label="Board view" onClick={() => { setView('board'); remember('lo_pm_view', 'board'); }}><Svg size={18}>{Ico.board}</Svg></button>
            <button type="button" role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} title="List" aria-label="List view" onClick={() => { setView('list'); remember('lo_pm_view', 'list'); }}><Svg size={18}>{Ico.grid}</Svg></button>
          </div>
        </div>
      </div>

      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}

      {!board ? (
        <div className="muted">Loading…</div>
      ) : view === 'board' ? (
        <div className="pm-board" style={{ ['--cols' as string]: cols.length }}>
          {cols.map((s) => {
            const list = col(s);
            const ghostAt = over?.col === s ? over.index : -1;
            return (
              <section key={s} className={`pm-col ${over?.col === s ? 'over' : ''}`} onDragOver={(e) => onDragOver(e, s)} onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o?.col === s ? null : o)); }} onDrop={(e) => onDrop(e, s)} aria-label={STATUS[s].label}>
                <header className="pm-col-head" style={{ ['--c' as string]: STATUS[s].color }}>
                  <i className="pm-dot" />
                  <b>{STATUS[s].label}</b>
                  <span className="pm-count">{list.length}</span>
                  {s !== 'canceled' && s !== 'completed' && (
                    <button type="button" className="pm-add" title={`New event in ${STATUS[s].label}`} aria-label={`New event in ${STATUS[s].label}`} onClick={() => setCreating(s)}><Svg size={14}><path d="M12 6v12M6 12h12" /></Svg></button>
                  )}
                </header>
                <div className="pm-col-body">
                  {list.map((c, i) => (
                    <div key={c.id} className="pm-slot">
                      {ghostAt === i && <div className="pm-drop-slot" />}
                      <CardView c={c} dragging={drag?.id === c.id} onMove={(to) => move(c, to)} onPriority={(p) => setPriority(c, p)} onDragStart={onDragStart} onDragEnd={() => { setDrag(null); setOver(null); }} />
                    </div>
                  ))}
                  {ghostAt >= list.length && <div className="pm-drop-slot" />}
                  {!list.length && ghostAt < 0 && <div className="pm-empty">{STATUS[s].empty}</div>}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <div className="table-wrap">
          <table className="dlist pm-table">
            <thead>
              <tr><th>Event</th><th>Dates</th><th>Stage</th><th>Priority</th><th>Crew</th><th className="hide-sm">Quote</th></tr>
            </thead>
            <tbody>
              {STATUS_ORDER.filter((s) => s !== 'canceled' || showCanceled).flatMap((s) => col(s)).map((c) => {
                const w = when(c);
                return (
                  <tr key={c.id} onClick={() => router.push(`/events/${c.id}`)}>
                    <td><Link href={`/events/${c.id}`} className="rowlink" onClick={(e) => e.stopPropagation()}>{c.name}</Link><span className="sub">{[c.customer_name ?? c.client, c.venue].filter(Boolean).join(' · ') || '—'}</span></td>
                    <td>{w.range}<span className="sub">{w.rel}</span></td>
                    <td onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
                      <select className="pm-stage" value={c.status} style={{ ['--c' as string]: STATUS[c.status].color }} onChange={(e) => move(c, e.target.value as PipelineStatus)} aria-label={`Stage of ${c.name}`}>
                        {STATUS_ORDER.map((x) => <option key={x} value={x}>{STATUS[x].label}</option>)}
                      </select>
                    </td>
                    <td onClick={(e) => e.stopPropagation()} style={{ cursor: 'default' }}>
                      <select className={`pm-stage prio ${PRIORITY[c.priority].tone}`} value={c.priority} onChange={(e) => setPriority(c, e.target.value as Priority)} aria-label={`Priority of ${c.name}`}>
                        {(['low', 'medium', 'high'] as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY[p].label}</option>)}
                      </select>
                    </td>
                    <td>{c.slots ? `${c.filled}/${c.slots}` : '—'}<span className={`mini-bar ${!c.slots ? '' : c.filled >= c.slots ? 'staff-good' : c.filled ? 'staff-warn' : 'staff-bad'}`} aria-hidden="true"><i style={{ width: `${c.slots ? Math.min(100, (c.filled / c.slots) * 100) : 0}%` }} /></span></td>
                    <td className="hide-sm">{c.quote ? <Link href={`/quotes/${c.quote.id}`} onClick={(e) => e.stopPropagation()} className={`pm-quote ${QUOTE_TONE[c.quote.status] ?? 'grey'}`}>#{c.quote.number} · {c.quote.status}</Link> : <span className="muted">—</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!cards.length && <div className="muted" style={{ padding: 16 }}>No events match.</div>}
        </div>
      )}
      {creating && <NewEvent status={creating} onClose={() => setCreating(null)} onCreated={(id, warning) => { setCreating(null); load(); if (warning) setErr(warning); else setNote('Event created. Open it to add shifts and crew.'); router.prefetch(`/events/${id}`); }} />}
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{(me) => <Body me={me} />}</Shell>;
}
