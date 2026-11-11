'use client';
import PhasePlanner, { type PlannedPhase } from '@/components/PhasePlanner';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import TopbarAction, { PlusIcon, EditIcon, SearchIcon } from '@/components/TopbarAction';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';
import RentmanPicker from '@/components/RentmanPicker';
import CustomerPicker, { customerBody, RentmanSend, useCustomerList, useRentmanSend, type CustomerChoice } from '@/components/CustomerPicker';
import LocationPick from '@/components/LocationPick';

type Ev = {
  id: string; name: string; client: string | null; venue: string | null; start_date: string; end_date: string; shift_count: number; slots: number; accepted: number; filled?: number; to_rate?: number;
  // Seats by state: confirmed, waiting for an answer, planned (built quietly, not sent), open.
  confirmed?: number; waiting?: number; planned?: number; open?: number; staffing_draft?: boolean;
};
type EvTemplate = { id: string; name: string; customer_id: string | null; customer_name: string | null; days: number; phases: number; positions: number; people: number };
const plusDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
type View = 'upcoming' | 'past' | 'all';
const today = () => new Date().toISOString().slice(0, 10);
const PAGE = 25;

function DateBadge({ date }: { date: string }) {
  const d = new Date(`${date}T12:00:00`);
  return (
    <span className="av c1" aria-hidden="true" style={{ display: 'grid', lineHeight: 1.05, fontSize: 11, textTransform: 'uppercase' }}>
      <span>{d.toLocaleDateString('en-US', { month: 'short' })}</span>
      <b style={{ fontSize: 15 }}>{d.getDate()}</b>
    </span>
  );
}

/** Where the event stands, counting only people who said yes as staffed: green when every seat is confirmed. */
function status(ev: Ev) {
  const t = today(), s = ev.start_date.slice(0, 10), e = ev.end_date.slice(0, 10);
  if (e < t) return { label: 'Done', cls: 'done' };
  if (!ev.slots) return { label: 'No shifts', cls: 'past' };
  const live = s <= t ? 'In progress · ' : '';
  const conf = ev.confirmed ?? ev.accepted, wait = ev.waiting ?? 0, plan = ev.planned ?? 0, open = ev.open ?? Math.max(0, ev.slots - (ev.filled ?? ev.accepted));
  if (conf >= ev.slots) return { label: `${live}Fully confirmed`, cls: 'staff-good' };
  if (!open && plan) return { label: `${live}Ready to publish`, cls: 'staff-warn' };
  if (!open) return { label: `${live}Waiting on ${wait}`, cls: 'staff-warn' };
  if (conf + wait + plan > 0) return { label: `${live}${open} open`, cls: 'staff-warn' };
  return { label: `${live}No crew yet`, cls: 'staff-bad' };
}

/** Confirmed, waiting and planned seats as one bar. */
function CrewBar({ ev }: { ev: Ev }) {
  const conf = ev.confirmed ?? ev.accepted, wait = ev.waiting ?? 0, plan = ev.planned ?? 0;
  const w = (n: number) => `${ev.slots ? Math.min(100, (n / ev.slots) * 100) : 0}%`;
  return (
    <>
      <b>{conf}</b> / {ev.slots} <span className="muted small">confirmed</span>
      <span className="stack-bar" aria-hidden="true"><i className="sb-conf" style={{ width: w(conf) }} /><i className="sb-wait" style={{ width: w(wait) }} /><i className="sb-plan" style={{ width: w(plan) }} /></span>
      {(wait > 0 || plan > 0) && (
        <span className="sub">
          {wait > 0 && `${wait} waiting`}
          {wait > 0 && plan > 0 && ' · '}
          {plan > 0 && `${plan} not sent`}
        </span>
      )}
    </>
  );
}

function Body() {
  const router = useRouter();
  const [list, setList] = useState<Ev[] | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('upcoming');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ name: '', client: '', venue: '', address: '', startDate: today(), endDate: today() });
  const [rm, setRm] = useState<number | null>(null);
  const [cust, setCust] = useState<CustomerChoice>({ mode: 'existing', customerId: null, client: '' });
  const customers = useCustomerList();
  const rmSend = useRentmanSend();
  const [made, setMade] = useState<{ id: string; warning: string } | null>(null);
  const [plan, setPlan] = useState<PlannedPhase[] | null>(null);
  // Start a new event from scratch, from an event template, or as a copy of a past event.
  const [from, setFrom] = useState<'blank' | 'template' | 'past'>('blank');
  const [templates, setTemplates] = useState<EvTemplate[] | null>(null);
  const [tplId, setTplId] = useState('');
  const [pastId, setPastId] = useState('');
  const [quiet, setQuiet] = useState(true);
  // New events build quietly unless the company turned that off (Labor rules › Building the crew).
  useEffect(() => { api<{ quietByDefault: boolean }>('/api/staffing/settings').then((r) => setQuiet(r.quietByDefault)).catch(() => {}); }, []);
  const tpl = templates?.find((x) => x.id === tplId) ?? null;
  const custId = cust.mode === 'existing' ? cust.customerId : null;
  useEffect(() => {
    if (!adding) return;
    api<{ templates: EvTemplate[] }>(`/api/event-templates${custId ? `?customerId=${custId}` : ''}`).then((r) => setTemplates(r.templates)).catch(() => setTemplates([]));
  }, [adding, custId]);
  // A template sets how many days the event runs.
  useEffect(() => {
    if (from === 'template' && tpl) setF((x) => ({ ...x, endDate: plusDays(x.startDate, tpl.days - 1) }));
  }, [from, tpl, f.startDate]);

  useEffect(() => {
    api<{ events: Ev[] }>('/api/events')
      .then((r) => setList(r.events))
      .catch((e) => setError(e.message));
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      if (from === 'past') {
        if (!pastId) return setError('Choose the event to copy.');
        // A copy keeps the past event's venue, phases, groups and positions (no crew), moved to the new start date.
        const r = await api<{ event: { id: string } }>(`/api/events/${pastId}/copy`, { body: { name: f.name, startDate: f.startDate, ...(custId ? { customerId: custId } : {}) } });
        await api(`/api/events/${r.event.id}/build-quietly`, { method: 'PUT', body: { on: quiet } }).catch(() => {});
        router.push(`/events/${r.event.id}`);
        return;
      }
      if (from === 'template' && !tplId) return setError('Choose a template.');
      const r = await api<{ event: { id: string }; warning?: string }>('/api/events', {
        body: {
          ...f, ...customerBody(cust), venue: f.venue || null, address: f.address || null, rentmanProjectId: rm, pushToRentman: !rm && rmSend.on ? true : undefined,
          phases: from === 'blank' && plan ? plan.filter((p) => p.on && p.label.trim()).map((p) => ({ label: p.label.trim(), date: p.date })) : undefined,
          templateId: from === 'template' ? tplId : undefined,
          buildQuietly: quiet,
        },
      });
      // Rentman trouble does not stop the event; say so before moving on.
      if (r.warning) setMade({ id: r.event.id, warning: r.warning });
      else router.push(`/events/${r.event.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const t = today();
  const needle = q.trim().toLowerCase();
  const rows = (list ?? [])
    .filter((ev) => (view === 'all' ? true : view === 'past' ? ev.end_date.slice(0, 10) < t : ev.end_date.slice(0, 10) >= t))
    .filter((ev) => !needle || `${ev.name} ${ev.client ?? ''} ${ev.venue ?? ''}`.toLowerCase().includes(needle))
    // upcoming soonest first; past most recent first
    .sort((a, b) => (view === 'upcoming' ? a.start_date.localeCompare(b.start_date) : b.start_date.localeCompare(a.start_date)));
  const counts = { upcoming: (list ?? []).filter((e) => e.end_date.slice(0, 10) >= t).length, past: (list ?? []).filter((e) => e.end_date.slice(0, 10) < t).length, all: (list ?? []).length };

  return (
    <>
      <h1>Events</h1>
      <TopbarAction>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Add New Event
          <PlusIcon />
        </button>
      </TopbarAction>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}

      <div className="list-head">
        <div className="row" style={{ gap: 16 }}>
          <div className="total">Total: {list ? rows.length : '…'} event{rows.length === 1 ? '' : 's'}</div>
          <div className="phase-tabs" role="tablist" aria-label="Which events" style={{ margin: 0 }}>
            {(['upcoming', 'past', 'all'] as View[]).map((v) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'tab on' : 'tab'} onClick={() => { setView(v); setShown(PAGE); }}>
                {v[0].toUpperCase() + v.slice(1)} ({counts[v]})
              </button>
            ))}
          </div>
        </div>
        <div className="controls">
          <span className="pill-input">
            <SearchIcon />
            <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search event, client, venue" aria-label="Search events" />
          </span>
        </div>
      </div>

      {!list ? (
        <div className="muted">Loading…</div>
      ) : rows.length === 0 ? (
        <Empty>{list.length ? 'No events here.' : 'No events yet. Add one, then add shifts to it.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dlist">
            <thead>
              <tr>
                <th className="av-col" aria-label="Date" />
                <th>Name</th>
                <th className="hide-sm">Venue</th>
                <th>Dates</th>
                <th>Crew</th>
                <th>Status</th>
                <th className="edit-col">Edit</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((ev) => {
                const s0 = ev.start_date.slice(0, 10), e0 = ev.end_date.slice(0, 10);
                const st = status(ev);
                return (
                  <tr key={ev.id} onClick={() => router.push(`/events/${ev.id}`)}>
                    <td className="av-col"><DateBadge date={s0} /></td>
                    <td>
                      <Link href={`/events/${ev.id}`} className="rowlink" onClick={(e) => e.stopPropagation()}>{ev.name}</Link>
                      {ev.client && <span className="sub">{ev.client}</span>}
                    </td>
                    <td className="hide-sm">{ev.venue ?? <span className="muted">—</span>}</td>
                    <td>
                      {fmtDate(s0)}
                      {e0 !== s0 && <span className="sub">to {fmtDate(e0)}</span>}
                    </td>
                    <td>
                      {ev.slots ? <CrewBar ev={ev} /> : <span className="muted">—</span>}
                    </td>
                    <td>
                      <span className={`pill ${st.cls}`}>{st.label}</span>
                      {ev.staffing_draft && <span className="pill draft-pill" title="Crew picks are kept as a plan until you publish">Building quietly</span>}
                      {!!ev.to_rate && (
                        <Link href={`/events/${ev.id}?rate=1`} className="pill rt-due" onClick={(e) => e.stopPropagation()} title="People who worked this event and have not been rated yet">
                          ★ Rate crew · {ev.to_rate}
                        </Link>
                      )}
                    </td>
                    <td className="edit-col">
                      <Link href={`/events/${ev.id}`} className="btn-round sm" aria-label={`Open ${ev.name}`} onClick={(e) => e.stopPropagation()} style={{ border: 0, background: 'transparent' }}>
                        <EditIcon />
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > shown && (
            <div className="load-more">
              <button className="btn" onClick={() => setShown(shown + PAGE)}>Load More</button>
            </div>
          )}
        </div>
      )}

      {made && (
        <Modal title="Event created" onClose={() => router.push(`/events/${made.id}`)}>
          <Banner kind="info">{made.warning}</Banner>
          <p className="muted small">You can send it to Rentman again from the event page once the problem is fixed.</p>
          <div className="acts"><button className="btn primary" onClick={() => router.push(`/events/${made.id}`)}>Open the event</button></div>
        </Modal>
      )}
      {adding && !made && (
        <Modal title="Add New Event" onClose={() => setAdding(false)}>
          <form onSubmit={add}>
            <div className="phase-tabs start-from" role="tablist" aria-label="Start from">
              {([['blank', 'Blank'], ['template', 'Template'], ['past', 'Copy a past event']] as const).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={from === k} className={from === k ? 'tab on' : 'tab'} onClick={() => setFrom(k)}>
                  {label}
                </button>
              ))}
            </div>
            {from === 'template' && (
              <label>
                Event template
                <select value={tplId} onChange={(e) => setTplId(e.target.value)} required>
                  <option value="">{templates === null ? 'Loading…' : templates.length ? 'Choose a template…' : 'No templates yet: save one from an event (Settings → Templates)'}</option>
                  {(templates ?? []).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.customer_id ? `★ ${t.name}` : t.name} · {t.days} day{t.days === 1 ? '' : 's'}, {t.positions} position{t.positions === 1 ? '' : 's'}, {t.people} people
                    </option>
                  ))}
                </select>
                {tpl && <span className="muted small">Its phases, groups and positions are added from the start date{tpl.customer_name ? `. Saved for ${tpl.customer_name}` : ''}.</span>}
              </label>
            )}
            {from === 'past' && (
              <label>
                Event to copy
                <select value={pastId} onChange={(e) => { setPastId(e.target.value); const ev = list?.find((x) => x.id === e.target.value); if (ev && !f.name) setF((x) => ({ ...x, name: ev.name })); }} required>
                  <option value="">Choose an event…</option>
                  {[...(list ?? [])].sort((a, b) => b.start_date.localeCompare(a.start_date)).slice(0, 200).map((ev) => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name} · {fmtDate(ev.start_date.slice(0, 10))}{ev.client ? ` · ${ev.client}` : ''} ({ev.slots} seats)
                    </option>
                  ))}
                </select>
                <span className="muted small">Venue, phases, groups, positions and clock-in settings come along, moved to the new start date. Crew don&apos;t.</span>
              </label>
            )}
            {from !== 'past' && <RentmanPicker
              value={rm}
              onPick={(p) => {
                setRm(p ? p.id : null);
                if (p) {
                  // Picking a project fills in everything it knows: name, customer, client, venue, street address and dates.
                  setCust({ mode: 'existing', customerId: p.customer_local_id ?? null, client: p.customer ?? '' });
                  setF((x) => ({
                    ...x,
                    name: p.name || x.name,
                    venue: p.location || x.venue,
                    address: p.location_address || x.address,
                    startDate: p.planperiod_start ? p.planperiod_start.slice(0, 10) : x.startDate,
                    endDate: p.planperiod_end ? p.planperiod_end.slice(0, 10) : p.planperiod_start ? p.planperiod_start.slice(0, 10) : x.endDate,
                  }));
                }
              }}
              label="Rentman project (optional, fills in the details below)"
            />}
            <label>
              Event name
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus />
            </label>
            <CustomerPicker value={cust} onChange={setCust} list={customers} />
            {from !== 'past' && <LocationPick customerId={cust.mode === 'existing' ? cust.customerId : null} onPick={(l) => setF((x) => ({ ...x, venue: l.venue, address: l.address }))} />}
            {from === 'past' ? (
              <label>
                Starts
                <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value })} required />
              </label>
            ) : (
            <div className="two">
              <label>
                Venue
                <input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} />
              </label>
              <label>
                Street address
                <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="123 Main St, Denver, CO" />
              </label>
              <label>
                Starts
                <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: e.target.value > f.endDate ? e.target.value : f.endDate })} required />
              </label>
              <label>
                Ends
                <input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} required />
              </label>
            </div>
            )}
            {from === 'blank' && <PhasePlanner start={f.startDate} end={f.endDate} value={plan} onChange={setPlan} />}
            <label className="check">
              <input type="checkbox" checked={quiet} onChange={(e) => setQuiet(e.target.checked)} />
              <span>Build the crew quietly <span className="muted small">(picks are kept as a plan; nobody is told until you press Publish)</span></span>
            </label>
            {from !== 'past' && <RentmanSend state={rmSend} disabled={!!rm} note="This event is already linked to the Rentman project picked above." />}
            <div className="acts">
              <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn primary">Create Event</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
