'use client';
import { useEffect, useState } from 'react';
import RentmanPicker, { RmProject } from '@/components/RentmanPicker';
import { api, fmtDate, getPosition } from '@/lib/api';
import CustomerSelect from '@/components/CustomerSelect';
import LocationPick from '@/components/LocationPick';

export type EventFull = { id: string; customer_id?: string | null; name: string; client: string | null; venue: string | null; address: string | null; notes: string | null; start_date: string; end_date: string; clock_mode?: 'self' | 'coordinator'; geo_lat?: number | null; geo_lng?: number | null; geofence_m?: number | null; pipeline_status?: string; priority?: string };
export type Phase = { id: string; label: string; starts_on: string; ends_on: string };

const PRESETS = ['Load in', 'Setup', 'Rehearsal', 'Tech', 'Show day', 'Show days', 'Strike', 'Load out'];
const d10 = (s: string) => s.slice(0, 10);
const range = (a: string, b: string) => (d10(a) === d10(b) ? fmtDate(d10(a)) : `${fmtDate(d10(a))} – ${fmtDate(d10(b))}`);

/** Event name, client, venue and address, with an edit form. */
export function EventDetails({ ev, hasPhases, onSaved, onError }: { ev: EventFull; hasPhases: boolean; onSaved: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState<{ name: string; client: string; venue: string; address: string; notes: string; startDate: string; endDate: string; customerId: string | null }>({ name: '', client: '', venue: '', address: '', notes: '', startDate: '', endDate: '', customerId: null });
  const open = () => {
    setF({ name: ev.name, client: ev.client ?? '', venue: ev.venue ?? '', address: ev.address ?? '', notes: ev.notes ?? '', startDate: d10(ev.start_date), endDate: d10(ev.end_date), customerId: ev.customer_id ?? null });
    setEditing(true);
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/events/${ev.id}`, { method: 'PATCH', body: { ...f, ...(hasPhases ? { startDate: undefined, endDate: undefined } : {}) } });
      setEditing(false);
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    }
  };
  const maps = ev.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ev.address)}` : '';

  if (!editing)
    return (
      <section className="card event-info">
        <div className="row space">
          <h2>Event details</h2>
          <button className="btn ghost small" onClick={open}>
            Edit
          </button>
        </div>
        <dl className="info-grid">
          <div>
            <dt>Event</dt>
            <dd>{ev.name}</dd>
          </div>
          <div>
            <dt>Client</dt>
            <dd>{ev.client || <span className="muted">Not set</span>}</dd>
          </div>
          <div>
            <dt>Venue</dt>
            <dd>{ev.venue || <span className="muted">Not set</span>}</dd>
          </div>
          <div>
            <dt>Street address</dt>
            <dd>
              {ev.address ? (
                <a href={maps} target="_blank" rel="noopener noreferrer">
                  {ev.address}
                </a>
              ) : (
                <span className="muted">Not set</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Dates</dt>
            <dd>{range(ev.start_date, ev.end_date)}</dd>
          </div>
          {ev.notes && (
            <div style={{ gridColumn: '1 / -1' }}>
              <dt>Notes</dt>
              <dd style={{ whiteSpace: 'pre-wrap' }}>{ev.notes}</dd>
            </div>
          )}
        </dl>
      </section>
    );

  return (
    <form className="card" onSubmit={save}>
      <h2>Edit event details</h2>
      <div className="grid-form">
        <label>
          Event name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={150} />
        </label>
        <CustomerSelect value={f.customerId} onPick={(c) => setF({ ...f, customerId: c?.id ?? null, client: c ? c.name : f.client })} />
        <LocationPick customerId={f.customerId} onPick={(l) => setF((x) => ({ ...x, venue: l.venue, address: l.address }))} />
        {!f.customerId && (
          <label>
            Client name
            <input value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} maxLength={200} placeholder="Who is this event for?" />
          </label>
        )}
        <label>
          Venue
          <input value={f.venue} onChange={(e) => setF({ ...f, venue: e.target.value })} maxLength={200} />
        </label>
        <label>
          Street address
          <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={300} placeholder="123 Main St, Denver, CO" />
        </label>
        <label>
          Starts
          <input type="date" value={f.startDate} disabled={hasPhases} onChange={(e) => setF({ ...f, startDate: e.target.value })} required />
        </label>
        <label>
          Ends
          <input type="date" value={f.endDate} min={f.startDate} disabled={hasPhases} onChange={(e) => setF({ ...f, endDate: e.target.value })} required />
        </label>
        <label style={{ gridColumn: '1 / -1' }}>
          Notes
          <textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={3} maxLength={5000} />
        </label>
      </div>
      {hasPhases && <p className="muted small">The overall dates follow the dated phases below, so change them there.</p>}
      <div className="form-actions">
        <button className="btn primary">Save</button>
        <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Several dated stretches per event: load in, show days, strike ... */
export function Phases({ eventId, phases, onChanged, onError }: { eventId: string; phases: Phase[]; onChanged: () => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ label: '', startDate: '', endDate: '' });
  const [edit, setEdit] = useState<Record<string, { label: string; startDate: string; endDate: string }>>({});
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChanged();
      return true;
    } catch (e) {
      onError((e as Error).message);
      return false;
    }
  };
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await act(() => api(`/api/events/${eventId}/phases`, { body: f }))) setF({ label: '', startDate: '', endDate: '' });
  };
  return (
    <section className="card">
      <h2>Dates &amp; phases</h2>
      <p className="muted small">Add each stretch of the event with its own start and end: load in, rehearsal, show days, strike. The event’s overall dates follow them.</p>
      {phases.length > 0 && (
        <ul className="phase-list">
          {phases.map((p) => {
            const e = edit[p.id];
            return (
              <li key={p.id}>
                {e ? (
                  <form
                    className="row"
                    style={{ gap: 8, flexWrap: 'wrap' }}
                    onSubmit={async (ev) => {
                      ev.preventDefault();
                      if (await act(() => api(`/api/event-phases/${p.id}`, { method: 'PATCH', body: e }))) setEdit(({ [p.id]: _, ...rest }) => rest);
                    }}
                  >
                    <input list="phase-presets" value={e.label} onChange={(ev) => setEdit({ ...edit, [p.id]: { ...e, label: ev.target.value } })} required maxLength={80} aria-label="Phase name" style={{ width: '10rem' }} />
                    <input type="date" value={e.startDate} onChange={(ev) => setEdit({ ...edit, [p.id]: { ...e, startDate: ev.target.value } })} required aria-label="Phase start" />
                    <input type="date" value={e.endDate} min={e.startDate} onChange={(ev) => setEdit({ ...edit, [p.id]: { ...e, endDate: ev.target.value } })} required aria-label="Phase end" />
                    <button className="btn small primary">Save</button>
                    <button type="button" className="btn ghost small" onClick={() => setEdit(({ [p.id]: _, ...rest }) => rest)}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <div className="row space">
                    <span>
                      <b>{p.label}</b> <span className="muted">· {range(p.starts_on, p.ends_on)}</span>
                    </span>
                    <span className="row">
                      <button className="btn ghost small" onClick={() => setEdit({ ...edit, [p.id]: { label: p.label, startDate: d10(p.starts_on), endDate: d10(p.ends_on) } })}>
                        Edit
                      </button>
                      <button className="btn ghost small danger" onClick={() => confirm(`Remove “${p.label}”? Shifts already created stay.`) && act(() => api(`/api/event-phases/${p.id}`, { method: 'DELETE' }))}>
                        Remove
                      </button>
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <form className="grid-form" onSubmit={add} style={{ marginTop: 10 }}>
        <label>
          Phase
          <input list="phase-presets" value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Load in, Show days, Strike…" required maxLength={80} />
        </label>
        <label>
          Starts
          <input type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value, endDate: f.endDate && f.endDate >= e.target.value ? f.endDate : e.target.value })} required />
        </label>
        <label>
          Ends
          <input type="date" value={f.endDate} min={f.startDate} onChange={(e) => setF({ ...f, endDate: e.target.value })} required />
        </label>
        <div className="form-actions">
          <button className="btn primary">Add phase</button>
        </div>
      </form>
      <datalist id="phase-presets">
        {PRESETS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </section>
  );
}

/** Who clocks crew in at this event, and an optional geofence around the venue. */
export function Clocking({ ev, onSaved, onError }: { ev: EventFull; onSaved: () => void; onError: (m: string) => void }) {
  const [mode, setMode] = useState<'self' | 'coordinator'>(ev.clock_mode ?? 'self');
  const [lat, setLat] = useState(ev.geo_lat != null ? String(ev.geo_lat) : '');
  const [lng, setLng] = useState(ev.geo_lng != null ? String(ev.geo_lng) : '');
  const [radius, setRadius] = useState(String(ev.geofence_m ?? 300));
  const [fence, setFence] = useState(ev.geo_lat != null && ev.geofence_m != null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');

  const here = async () => {
    onError('');
    try {
      const p = await getPosition();
      setLat(p.lat.toFixed(6));
      setLng(p.lng.toFixed(6));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    onError('');
    setSaved('');
    const la = lat.trim() === '' ? null : Number(lat);
    const lo = lng.trim() === '' ? null : Number(lng);
    if (fence && (la === null || lo === null || !Number.isFinite(la) || !Number.isFinite(lo))) return onError('Enter the venue latitude and longitude, or use your current location.');
    setBusy(true);
    try {
      await api(`/api/events/${ev.id}/clocking`, {
        method: 'PUT',
        body: { clockMode: mode, lat: la, lng: lo, geofenceM: fence && la !== null ? Math.round(Number(radius)) : null },
      });
      setSaved('Saved.');
      onSaved();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>Clock-in</h2>
      <form onSubmit={save}>
        <div className="grid2">
          <label>
            Who clocks crew in
            <select value={mode} onChange={(e) => setMode(e.target.value as 'self' | 'coordinator')}>
              <option value="self">Crew clock themselves in</option>
              <option value="coordinator">Labor coordinator checks crew in on site</option>
            </select>
          </label>
          {mode === 'self' && (
            <label className="row" style={{ gap: '.5rem', alignItems: 'center' }}>
              <input type="checkbox" checked={fence} onChange={(e) => setFence(e.target.checked)} style={{ width: 'auto' }} />
              Only allow clock-in near the venue
            </label>
          )}
        </div>
        {mode === 'self' && fence && (
          <div className="grid2">
            <label>
              Venue latitude
              <input inputMode="decimal" value={lat} onChange={(e) => setLat(e.target.value)} placeholder="39.7392" />
            </label>
            <label>
              Venue longitude
              <input inputMode="decimal" value={lng} onChange={(e) => setLng(e.target.value)} placeholder="-104.9903" />
            </label>
            <label>
              Allowed distance (metres)
              <input type="number" min={25} max={20000} value={radius} onChange={(e) => setRadius(e.target.value)} />
            </label>
            <div>
              <button type="button" className="btn" onClick={here}>Use my current location</button>
              <div className="muted small">Stand at the venue and tap this to set the spot.</div>
            </div>
          </div>
        )}
        <div className="row">
          <button className="btn primary" disabled={busy}>Save clock-in settings</button>
          {saved && <span className="muted small">{saved}</span>}
        </div>
      </form>
    </section>
  );
}

export type RmView = {
  linked: boolean; connected: boolean; warning?: string;
  request?: { id: number; status: 'open' | 'accepted' | 'declined'; pushedAt: string | null } | null;
  project?: { id: number; number: number | null; name: string; customer: string | null; location: string | null; reference: string | null; project_type: string | null; tags: string | null; planperiod_start: string | null; planperiod_end: string | null; usageperiod_start: string | null; usageperiod_end: string | null; synced_at: string } | null;
  equipment?: { item_id: number; name: string; quantity: string | null; unit_price?: string | null; is_option: boolean; period_start: string | null; period_end: string | null; remark: string | null; group_id: number | null; group_name: string | null; group_sort: number | null; parent_id: number | null }[];
};
type RmItem = NonNullable<RmView['equipment']>[number];

/** The Rentman project linked to an event: project info and the equipment rental list. */
export function RentmanCard({ eventId, isAdmin, onError, onView }: { eventId: string; isAdmin: boolean; onError: (m: string) => void; onView?: (v: RmView) => void }) {
  const [v, setV] = useState<RmView | null>(null);
  const [pick, setPick] = useState<RmProject | null>(null);
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set()); // equipment groups start collapsed
  const [busy, setBusy] = useState(false);
  const load = () => api<RmView>(`/api/events/${eventId}/rentman`).then((r) => { setV(r); onView?.(r); }).catch(() => {});
  useEffect(() => {
    load();
  }, [eventId]);
  const run = async (fn: () => Promise<RmView>) => {
    onError('');
    setBusy(true);
    try {
      const r = await fn();
      setV(r);
      onView?.(r);
      if (r.warning) onError(r.warning);
      setPick(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!v || (!v.connected && !v.linked)) return null;
  const when = (a: string | null, b: string | null) => (a ? (b && b.slice(0, 10) !== a.slice(0, 10) ? `${fmtDate(a.slice(0, 10))} – ${fmtDate(b.slice(0, 10))}` : fmtDate(a.slice(0, 10))) : '—');
  const p = v.project;
  return (
    <section className="card">
      <div className="row space">
        <span className="muted small">
          {v.linked && p ? `${p.number ? `#${p.number} · ` : ''}${p.name} · ${v.equipment?.length ?? 0} equipment item${v.equipment?.length === 1 ? '' : 's'}` : v.linked ? 'Linked project' : v.request?.status === 'open' ? 'Waiting for Rentman to accept the request' : 'Not linked to a Rentman project yet'}
        </span>
        {v.linked && (
          <span className="row">
            <button className="btn small" disabled={busy} onClick={() => run(() => api<RmView>(`/api/events/${eventId}/rentman/refresh`, { body: {} }))}>Refresh equipment</button>
            <button className="btn ghost small" disabled={busy} onClick={() => confirm('Unlink this event from its Rentman project?') && run(() => api<RmView>(`/api/events/${eventId}/rentman`, { method: 'PUT', body: { projectId: null } }))}>Unlink</button>
          </span>
        )}
      </div>
      {!v.linked && v.connected && (
        <div className={`rm-send ${v.request?.status ?? ''}`}>
          {!v.request ? (
            <>
              <div>
                <b>Create this event in Rentman</b>
                <p className="muted small">Sends it as a project request with the dates, linked to the customer, its contact person and the venue as a location. Any of those not yet in Rentman are created there first. Once someone accepts the request in Rentman, the new project links back here with its equipment.</p>
              </div>
              <button className="btn primary" disabled={busy} onClick={() => run(() => api<RmView>(`/api/events/${eventId}/rentman/push`, { body: {} }))}>{busy ? 'Sending…' : 'Send to Rentman'}</button>
            </>
          ) : v.request.status === 'declined' ? (
            <div>
              <b>Rentman declined project request #{v.request.id}</b>
              <p className="muted small">Link an existing project below instead, or change the event and ask in Rentman.</p>
            </div>
          ) : (
            <>
              <div>
                <b>Sent to Rentman · request #{v.request.id}</b>
                <p className="muted small">
                  {v.request.pushedAt ? `Sent ${new Date(v.request.pushedAt).toLocaleString()}. ` : ''}Waiting for it to be accepted under Project requests in Rentman; the project links here automatically after that.
                </p>
              </div>
              <span className="row">
                <button className="btn small" disabled={busy} onClick={() => run(() => api<RmView>(`/api/events/${eventId}/rentman/check`, { body: {} }))}>Check now</button>
                <button className="btn ghost small" disabled={busy} title="Send the event's current details again" onClick={() => run(() => api<RmView>(`/api/events/${eventId}/rentman/push`, { body: {} }))}>Send updates</button>
              </span>
            </>
          )}
        </div>
      )}
      {!v.linked && (
        <>
          <RentmanPicker value={pick?.id ?? null} onPick={setPick} label="Or link an existing Rentman project" />
          <button className="btn primary" disabled={!pick || busy} onClick={() => pick && run(() => api<RmView>(`/api/events/${eventId}/rentman`, { method: 'PUT', body: { projectId: pick.id } }))}>Link project</button>
        </>
      )}
      {v.linked && p && (
        <>
          <div className="info-grid">
            <div><span className="muted small">Project</span><b>{p.number ? `#${p.number} · ` : ''}{p.name}</b></div>
            {p.customer && <div><span className="muted small">Customer</span><b>{p.customer}</b></div>}
            {p.location && <div><span className="muted small">Location</span><b>{p.location}</b></div>}
            {p.reference && <div><span className="muted small">Reference</span><b>{p.reference}</b></div>}
            {p.project_type && <div><span className="muted small">Type</span><b>{p.project_type}</b></div>}
            <div><span className="muted small">Planning period</span><b>{when(p.planperiod_start, p.planperiod_end)}</b></div>
            {p.usageperiod_start && <div><span className="muted small">Usage period</span><b>{when(p.usageperiod_start, p.usageperiod_end)}</b></div>}
          </div>
          <div className="row space">
            <h3>Equipment rentals ({v.equipment?.length ?? 0})</h3>
            {!!v.equipment?.length && (
              <span className="row">
                <button className="btn ghost small" onClick={() => setOpenGroups(new Set(equipmentGroups(v.equipment!).map((g) => g.key)))}>Expand all</button>
                <button className="btn ghost small" onClick={() => setOpenGroups(new Set())}>Collapse all</button>
              </span>
            )}
          </div>
          {!v.equipment?.length ? (
            <p className="muted small">No equipment on this project yet. Use “Refresh equipment” to pull the latest from Rentman.</p>
          ) : (
            equipmentGroups(v.equipment).map((g) => (
              <details key={g.key} open={openGroups.has(g.key)} onToggle={(e) => { const o = (e.target as HTMLDetailsElement).open; setOpenGroups((cur) => (cur.has(g.key) === o ? cur : new Set(o ? [...cur, g.key] : [...cur].filter((k) => k !== g.key)))); }} className="rm-group">
                <summary>
                  <b>{g.name}</b> <span className="muted small">{g.items.length} item{g.items.length === 1 ? '' : 's'}</span>
                </summary>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Item</th><th>Qty</th><th>Period</th>{isAdmin && <th>Unit price</th>}</tr></thead>
                    <tbody>
                      {g.items.map(({ e, child }) => (
                        <tr key={e.item_id}>
                          <td style={child ? { paddingLeft: '1.6rem' } : undefined}>{child ? '↳ ' : ''}{e.name}{e.is_option && <span className="chip warn">option</span>}{e.remark && <div className="muted small">{e.remark}</div>}</td>
                          <td>{e.quantity ?? ''}</td>
                          <td className="small">{e.period_start ? when(e.period_start, e.period_end) : ''}</td>
                          {isAdmin && <td>{e.unit_price != null ? Number(e.unit_price).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : ''}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ))
          )}
          <p className="muted small">Project details last synced {new Date(p.synced_at).toLocaleString()}.</p>
        </>
      )}
      {v.linked && !p && <p className="muted small">The linked project is not in the local cache. Sync projects on the Integrations page.</p>}
    </section>
  );
}

/** Rentman equipment arranged by its project equipment group (in Rentman's order); kit items sit under their parent item. */
function equipmentGroups(list: RmItem[]) {
  const ids = new Set(list.map((e) => e.item_id));
  const byGroup = new Map<string, { key: string; name: string; sort: number; items: RmItem[] }>();
  for (const e of list) {
    const key = e.group_id != null ? `g${e.group_id}` : 'none';
    if (!byGroup.has(key)) byGroup.set(key, { key, name: e.group_name ?? (e.group_id != null ? 'Group' : 'Other equipment'), sort: e.group_id != null ? e.group_sort ?? 9999 : 99999, items: [] });
    byGroup.get(key)!.items.push(e);
  }
  return [...byGroup.values()]
    .sort((a, b) => a.sort - b.sort)
    .map((g) => {
      const tops = g.items.filter((e) => e.parent_id == null || !ids.has(e.parent_id));
      const items: { e: RmItem; child: boolean }[] = [];
      for (const t of tops) {
        items.push({ e: t, child: false });
        for (const k of g.items.filter((x) => x.parent_id === t.item_id)) items.push({ e: k, child: true });
      }
      return { key: g.key, name: g.name, items };
    });
}
