'use client';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/lib/api';
import Skeleton from '@/components/Skeleton';

type Answer = { user_id: string; name: string; answered_at: string | null; free_dates: string[] | null };
type Check = { id: string; dates: string[]; message: string | null; created_at: string; closed_at: string | null; created_by_name: string | null; answers: Answer[] };

const short = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * "Are you free?" before booking: ask a crew group, everyone in a role, or picked people which event days they can
 * work. Answers come back here; "Book the free people" opens auto-fill with only them, on the days they said.
 */
export default function AvailCheck({
  eventId, days, groups, roles, crew, onBook, onDone, onError,
}: {
  eventId: string;
  days: string[];
  groups: { id: string; name: string }[];
  roles: string[];
  crew: { id: string; name: string }[];
  onBook: (checkId: string) => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set(days));
  const [who, setWho] = useState<'group' | 'role' | 'people'>(groups.length ? 'group' : 'role');
  const [groupId, setGroupId] = useState('');
  const [role, setRole] = useState('');
  const [people, setPeople] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<{ checks: Check[] }>(`/api/events/${eventId}/avail-checks`).then((r) => { setChecks(r.checks); if (!r.checks.length) setAsking(true); }).catch((e) => onError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const send = async () => {
    setBusy(true);
    try {
      const r = await api<{ asked: number }>(`/api/events/${eventId}/avail-checks`, {
        body: {
          dates: [...picked].sort(), message: message.trim() || undefined,
          ...(who === 'group' ? { groupId } : who === 'role' ? { role } : { userIds: [...people] }),
        },
      });
      onDone(`Asked ${r.asked} ${r.asked === 1 ? 'person' : 'people'} which days they're free. Answers show up here.`);
      setAsking(false);
      setMessage('');
      load();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const canSend = picked.size > 0 && (who === 'group' ? !!groupId : who === 'role' ? !!role.trim() : people.size > 0);
  const needle = q.trim().toLowerCase();

  return (
    <div className="avail-check">
      {checks === null && <Skeleton />}
      {checks?.map((k) => {
        const answered = k.answers.filter((a) => a.answered_at);
        const free = answered.filter((a) => a.free_dates?.length);
        return (
          <section key={k.id} className={`card avail-card${k.closed_at ? ' closed' : ''}`}>
            <div className="row space" style={{ flexWrap: 'wrap', gap: 6 }}>
              <div>
                <b>{k.dates.map(short).join(', ')}</b>
                <div className="muted small">
                  Asked {fmtDateTime(k.created_at)}{k.created_by_name ? ` by ${k.created_by_name}` : ''} · {answered.length} of {k.answers.length} answered · <b>{free.length} free</b>
                  {k.closed_at && ' · finished'}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="btn primary small" disabled={!free.length} onClick={() => onBook(k.id)} title="Auto-fill the open seats with only the people who said they're free, on their days">
                  Book the free people
                </button>
                {!k.closed_at && (
                  <button type="button" className="btn ghost small" title="Stop taking answers" onClick={() => api(`/api/avail-checks/${k.id}/close`, { body: {} }).then(load).catch((e) => onError(e.message))}>
                    Finish
                  </button>
                )}
              </div>
            </div>
            <ul className="plain avail-list">
              {k.answers.map((a) => (
                <li key={a.user_id} className="row space">
                  <span>{a.name}</span>
                  <span className="small">
                    {!a.answered_at ? (
                      <span className="muted">No answer yet</span>
                    ) : a.free_dates?.length ? (
                      a.free_dates.length === k.dates.length ? <span className="pill accepted">Free all days</span> : a.free_dates.map((d) => <span key={d} className="chip">{short(d)}</span>)
                    ) : (
                      <span className="pill declined">Not free</span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {!asking && checks && (
        <button type="button" className="btn" onClick={() => setAsking(true)}>🙋 Ask {checks.length ? 'again / more people' : 'who is free'}</button>
      )}
      {asking && (
        <section className="card">
          <h3 style={{ marginTop: 0 }}>Ask who is free</h3>
          <p className="muted small" style={{ marginTop: 0 }}>Crew get a push and text, and answer per day on My shifts. It isn&apos;t a booking: you choose who gets offers afterwards.</p>
          <div className="small muted" style={{ marginBottom: 4 }}>Days</div>
          <div className="day-chips" role="group" aria-label="Days to ask about">
            {days.map((d) => (
              <button key={d} type="button" aria-pressed={picked.has(d)} className={`day-chip${picked.has(d) ? ' on' : ''}`} onClick={() => setPicked((p) => { const n = new Set(p); if (n.has(d)) n.delete(d); else n.add(d); return n; })}>
                {short(d)}
              </button>
            ))}
          </div>
          <div className="small muted" style={{ margin: '10px 0 4px' }}>Who to ask</div>
          <div className="phase-tabs" role="tablist" aria-label="Who to ask">
            {groups.length > 0 && <button type="button" role="tab" aria-selected={who === 'group'} className={who === 'group' ? 'tab on' : 'tab'} onClick={() => setWho('group')}>Crew group</button>}
            <button type="button" role="tab" aria-selected={who === 'role'} className={who === 'role' ? 'tab on' : 'tab'} onClick={() => setWho('role')}>Everyone in a role</button>
            <button type="button" role="tab" aria-selected={who === 'people'} className={who === 'people' ? 'tab on' : 'tab'} onClick={() => setWho('people')}>Pick people</button>
          </div>
          {who === 'group' && (
            <select value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-label="Crew group">
              <option value="">Choose a group…</option>
              {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          )}
          {who === 'role' && (
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              <option value="">Choose a role…</option>
              {roles.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          )}
          {who === 'people' && (
            <div>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search crew" aria-label="Search crew" />
              <div className="avail-people">
                {crew.filter((m) => !needle || m.name.toLowerCase().includes(needle)).slice(0, 200).map((m) => (
                  <label key={m.id} className="check">
                    <input type="checkbox" checked={people.has(m.id)} onChange={() => setPeople((p) => { const n = new Set(p); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })} />
                    {m.name}
                  </label>
                ))}
              </div>
              <div className="muted small">{people.size} picked</div>
            </div>
          )}
          <label style={{ marginTop: 10 }}>
            Note (optional)
            <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={500} placeholder="Day rate $300, parking provided" />
          </label>
          <div className="row" style={{ gap: 6, marginTop: 10 }}>
            {!!checks?.length && <button type="button" className="btn ghost" onClick={() => setAsking(false)}>Cancel</button>}
            <button type="button" className="btn primary" disabled={busy || !canSend} onClick={send}>{busy ? 'Sending…' : 'Ask them'}</button>
          </div>
        </section>
      )}
    </div>
  );
}
