'use client';
import { useState } from 'react';
import { api, fmtDate } from '@/lib/api';

export type EventFull = { id: string; name: string; client: string | null; venue: string | null; address: string | null; notes: string | null; start_date: string; end_date: string };
export type Phase = { id: string; label: string; starts_on: string; ends_on: string };

const PRESETS = ['Load in', 'Setup', 'Rehearsal', 'Tech', 'Show day', 'Show days', 'Strike', 'Load out'];
const d10 = (s: string) => s.slice(0, 10);
const range = (a: string, b: string) => (d10(a) === d10(b) ? fmtDate(d10(a)) : `${fmtDate(d10(a))} – ${fmtDate(d10(b))}`);

/** Event name, client, venue and address, with an edit form. */
export function EventDetails({ ev, hasPhases, onSaved, onError }: { ev: EventFull; hasPhases: boolean; onSaved: () => void; onError: (m: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState({ name: '', client: '', venue: '', address: '', notes: '', startDate: '', endDate: '' });
  const open = () => {
    setF({ name: ev.name, client: ev.client ?? '', venue: ev.venue ?? '', address: ev.address ?? '', notes: ev.notes ?? '', startDate: d10(ev.start_date), endDate: d10(ev.end_date) });
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
        <label>
          Client
          <input value={f.client} onChange={(e) => setF({ ...f, client: e.target.value })} maxLength={200} placeholder="Who is this event for?" />
        </label>
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
