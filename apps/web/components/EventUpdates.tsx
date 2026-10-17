'use client';
import { useEffect, useMemo, useState } from 'react';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDateTime } from '@/lib/api';

type A = { user_id: string; user_name: string; status: string };
type S = { id: string; role_name: string; phase_id: string | null; group_id?: string | null; assignments: A[] };
type P = { id: string; label: string; starts_on: string };
type G = { id: string; phase_id: string; label: string };
type Audience = { include: 'confirmed' | 'all'; upcoming: boolean; phases: string[]; groups: string[]; roles: string[]; people: string[] };
type Sent = {
  id: string; title: string; body: string; created_at: string; sent_by_name: string | null; texted: boolean; include_shifts: boolean;
  recipients: { user_id: string; name: string; opened_at: string | null }[]; opened: number;
};

// Starting points for common updates; the coordinator edits the wording.
const TEMPLATES: { label: string; title: string; body: string }[] = [
  { label: 'Time change', title: 'Time change', body: 'Heads up: the schedule has changed. Your updated shift times are below. Please check them and reply in chat if this doesn’t work for you.' },
  { label: 'Call time', title: 'Call time reminder', body: 'Reminder: please arrive 15 minutes before your call time, ready to work.' },
  { label: 'Parking / load-in', title: 'Parking and load-in', body: 'Parking: \nCrew entrance: \nCheck in with: ' },
  { label: 'Dress code', title: 'Dress code', body: 'Wear all blacks, closed-toe work boots, and bring gloves.' },
  { label: 'Weather', title: 'Weather update', body: 'Weather is expected to be bad. Bring rain gear and dress in layers.' },
  { label: 'Canceled', title: 'Canceled', body: 'Unfortunately this has been canceled. We’re sorry for the short notice.' },
];

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** Write an update, pick who on the event gets it, send it; and the history of updates already sent. */
export default function EventUpdates({ eventId, eventName, shifts, phases, groups }: { eventId: string; eventName: string; shifts: S[]; phases: P[]; groups: G[] }) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [aud, setAud] = useState<Audience>({ include: 'confirmed', upcoming: true, phases: [], groups: [], roles: [], people: [] });
  const [includeShifts, setIncludeShifts] = useState(true);
  const [text, setText] = useState(false);
  const [who, setWho] = useState<{ count: number; people: { userId: string; name: string; offered: boolean }[] } | null>(null);
  const [showWho, setShowWho] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [history, setHistory] = useState<Sent[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const roles = useMemo(() => [...new Map(shifts.map((s) => [s.role_name.trim().toLowerCase(), s.role_name])).values()].sort(), [shifts]);
  const people = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of shifts) for (const a of s.assignments) if (a.status === 'accepted' || a.status === 'offered') m.set(a.user_id, a.user_name);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [shifts]);
  const [personQ, setPersonQ] = useState('');

  const loadHistory = () => api<{ updates: Sent[] }>(`/api/events/${eventId}/updates`).then((r) => setHistory(r.updates)).catch((e) => setErr(e.message));
  useEffect(() => { loadHistory(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [eventId]);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      api<{ count: number; people: { userId: string; name: string; offered: boolean }[] }>(`/api/events/${eventId}/updates/preview`, { body: aud })
        .then((r) => live && setWho(r))
        .catch(() => live && setWho(null));
    }, 200);
    return () => { live = false; clearTimeout(t); };
  }, [eventId, aud]);

  const narrowed = aud.phases.length + aud.groups.length + aud.roles.length + aud.people.length > 0;
  const send = async () => {
    setErr(''); setOk('');
    if (!title.trim() || !body.trim()) return setErr('Add a subject and a message.');
    if (!who?.count) return setErr('No one on this event matches who you picked.');
    if (!confirm(`Send “${title.trim()}” to ${who.count} ${who.count === 1 ? 'person' : 'people'}${text ? ', also by text where they allow it' : ''}?`)) return;
    setBusy(true);
    try {
      const r = await api<{ update: { recipients: number } }>(`/api/events/${eventId}/updates`, { body: { title, body, audience: aud, includeShifts, text } });
      setOk(`Update sent to ${r.update.recipients} ${r.update.recipients === 1 ? 'person' : 'people'}.`);
      setTitle(''); setBody('');
      loadHistory();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const chips = (items: { id: string; label: string }[], picked: string[], key: keyof Audience) => (
    <div className="upd-chips">
      {items.map((x) => (
        <button key={x.id} type="button" className={picked.includes(x.id) ? 'chip on' : 'chip'} aria-pressed={picked.includes(x.id)} onClick={() => setAud({ ...aud, [key]: toggle(picked, x.id) })}>
          {x.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="upd">
      <p className="muted small" style={{ marginTop: 0 }}>
        Send a message to the crew scheduled on {eventName}. They get it in the app and by email{text ? ', and by text if they allow texts' : ''}, with their own shifts listed underneath, and you can see who has opened it.
      </p>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}

      <div className="upd-chips" aria-label="Start from">
        {TEMPLATES.map((t) => (
          <button key={t.label} type="button" className="chip" onClick={() => { setTitle(t.title); setBody(t.body); }}>{t.label}</button>
        ))}
      </div>
      <label className="upd-field">
        Subject
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Load-in moved to 8 AM" />
      </label>
      <label className="upd-field">
        Message
        <textarea value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} rows={5} placeholder="What changed, and anything they need to do." />
      </label>

      <fieldset className="upd-who">
        <legend>Who gets it</legend>
        <div className="seg" role="group" aria-label="Status">
          <button type="button" className={aud.include === 'confirmed' ? 'active' : ''} onClick={() => setAud({ ...aud, include: 'confirmed' })}>Confirmed crew</button>
          <button type="button" className={aud.include === 'all' ? 'active' : ''} onClick={() => setAud({ ...aud, include: 'all' })}>Confirmed + offered</button>
        </div>
        <label className="check"><input type="checkbox" checked={aud.upcoming} onChange={(e) => setAud({ ...aud, upcoming: e.target.checked })} /> Only shifts that haven&apos;t ended yet</label>
        <p className="muted small" style={{ margin: '8px 0 4px' }}>Everyone on the event, or narrow it down (pick any mix):</p>
        {phases.length > 0 && (<><div className="upd-sub">Phases</div>{chips(phases.map((p) => ({ id: p.id, label: p.label })), aud.phases, 'phases')}</>)}
        {groups.length > 0 && (<><div className="upd-sub">Groups</div>{chips([...groups].sort((a, b) => phases.findIndex((p) => p.id === a.phase_id) - phases.findIndex((p) => p.id === b.phase_id) || a.label.localeCompare(b.label)).map((g) => ({ id: g.id, label: `${g.label}${phases.length > 1 ? ` · ${phases.find((p) => p.id === g.phase_id)?.label ?? ''}` : ''}` })), aud.groups, 'groups')}</>)}
        {roles.length > 1 && (<><div className="upd-sub">Positions</div>{chips(roles.map((r) => ({ id: r, label: r })), aud.roles, 'roles')}</>)}
        {people.length > 0 && (
          <>
            <div className="upd-sub">People</div>
            <input type="search" className="upd-person-q" placeholder="Find someone" value={personQ} onChange={(e) => setPersonQ(e.target.value)} aria-label="Find someone to send to" />
            {chips(
              people.filter((p) => aud.people.includes(p.id) || (personQ.trim() && p.name.toLowerCase().includes(personQ.trim().toLowerCase()))).slice(0, 30).map((p) => ({ id: p.id, label: p.name })),
              aud.people, 'people',
            )}
          </>
        )}
        {narrowed && <button type="button" className="rt-link" onClick={() => setAud({ ...aud, phases: [], groups: [], roles: [], people: [] })}>Clear, send to everyone</button>}
      </fieldset>

      <label className="check"><input type="checkbox" checked={includeShifts} onChange={(e) => setIncludeShifts(e.target.checked)} /> Add each person&apos;s shifts on this event (current times)</label>
      <label className="check"><input type="checkbox" checked={text} onChange={(e) => setText(e.target.checked)} /> Also send a text message (only to people who allow texts)</label>

      <div className="upd-send">
        <button type="button" className="rt-link" onClick={() => setShowWho(!showWho)} disabled={!who?.count}>
          {who ? `${who.count} ${who.count === 1 ? 'person' : 'people'} will get it` : 'Checking who gets it…'}{who?.count ? (showWho ? ' ▴' : ' ▾') : ''}
        </button>
        <button type="button" className="btn primary" disabled={busy || !who?.count} onClick={send}>{busy ? 'Sending…' : '📣 Send update'}</button>
      </div>
      {showWho && who && who.count > 0 && (
        <p className="small upd-names">{who.people.map((p) => `${p.name}${p.offered ? ' (offered)' : ''}`).join(', ')}</p>
      )}

      <h3 className="upd-h">Sent updates</h3>
      {!history ? (
        <div className="muted small">Loading…</div>
      ) : history.length === 0 ? (
        <Empty>No updates sent for this event yet.</Empty>
      ) : (
        <ul className="upd-list">
          {history.map((h) => (
            <li key={h.id}>
              <button type="button" className="upd-item" aria-expanded={open === h.id} onClick={() => setOpen(open === h.id ? null : h.id)}>
                <span>
                  <b>{h.title}</b>
                  <span className="muted small"> · {fmtDateTime(h.created_at)}{h.sent_by_name ? ` · ${h.sent_by_name}` : ''}{h.texted ? ' · texted' : ''}</span>
                </span>
                <span className={`pill ${h.opened === h.recipients.length ? 'accepted' : 'offered'}`}>{h.opened}/{h.recipients.length} opened</span>
              </button>
              {open === h.id && (
                <div className="upd-detail">
                  <p className="upd-body">{h.body}</p>
                  <ul className="upd-rec">
                    {h.recipients.map((r) => (
                      <li key={r.user_id}>
                        {r.name}
                        <span className={r.opened_at ? 'small good-text' : 'muted small'}>{r.opened_at ? ` · opened ${fmtDateTime(r.opened_at)}` : ' · not opened'}</span>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn small" onClick={() => { setTitle(h.title); setBody(h.body); window.scrollTo?.(0, 0); document.querySelector('.drawer')?.scrollTo({ top: 0, behavior: 'smooth' }); }}>Reuse this message</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
