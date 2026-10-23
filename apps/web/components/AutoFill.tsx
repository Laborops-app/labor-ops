'use client';
import { useEffect, useState } from 'react';
import { Banner, Empty } from '@/components/ui';
import { api, fmtTime } from '@/lib/api';

type Pick = { userId: string; name: string; stars: number; weekHours: number; reasons: string[]; warnings: string[] };
type Prop = { id: string; role: string; starts_at: string; ends_at: string; phase: string | null; group: string | null; open: number; picks: Pick[]; short: number; skipped: Record<string, number> };
const day = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

/**
 * Auto-fill: the best available people for every open seat on the event, with why. Untick anyone you don't want,
 * then send the offers (or confirm them straight away). Nothing goes out until you press the button.
 */
export default function AutoFill({
  eventId, groups, onDone, freeChecks = [], initialCheck = '', held = false,
}: {
  eventId: string;
  groups: { id: string; name: string }[];
  onDone: (msg: string) => void;
  // "Are you free?" checks with answers: choose only from the people who said they're free.
  freeChecks?: { id: string; label: string }[];
  initialCheck?: string;
  // The event is built quietly: picks are kept as a plan until it is published.
  held?: boolean;
}) {
  // '' = all crew, 'g:<id>' = a crew group, 'a:<id>' = people who said they're free in that check.
  const [from, setFrom] = useState(initialCheck ? `a:${initialCheck}` : '');
  const groupId = from.startsWith('g:') ? from.slice(2) : '';
  const availCheckId = from.startsWith('a:') ? from.slice(2) : '';
  const [d, setD] = useState<Prop[] | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set()); // shiftId|userId unticked
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = () => {
    setD(null); setErr('');
    api<{ shifts: Prop[] }>(`/api/events/${eventId}/autofill/preview`, { body: { groupId: groupId || null, availCheckId: availCheckId || null } })
      .then((r) => { setD(r.shifts); setOff(new Set()); })
      .catch((e) => setErr(e.message));
  };
  useEffect(load, [eventId, from]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = (s: string, u: string) => `${s}|${u}`;
  const chosen = (d ?? []).flatMap((s) => s.picks.filter((p) => !off.has(key(s.id, p.userId))).map((p) => ({ shiftId: s.id, userId: p.userId })));
  const seats = (d ?? []).reduce((n, s) => n + s.open, 0);
  const short = (d ?? []).reduce((n, s) => n + s.short, 0);
  const sendBar = (
    <div className="af-send">
            <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> Confirm them straight away (they already said yes)</label>
            <button type="button" className="btn primary" disabled={busy || !chosen.length} onClick={async () => {
              setBusy(true); setErr('');
              try {
                const r = await api<{ sent: number; held?: boolean; failed: { error?: string }[] }>(`/api/events/${eventId}/autofill/send`, { body: { offers: chosen, confirmed } });
                const what = r.held ? `Planned ${r.sent} ${r.sent === 1 ? 'seat' : 'seats'} (not sent yet: press Publish when the crew is ready)` : `${confirmed ? 'Confirmed' : 'Offered'} ${r.sent} ${r.sent === 1 ? 'seat' : 'seats'}`;
                onDone(`${what}${r.failed.length ? `; ${r.failed.length} couldn’t be added (${[...new Set(r.failed.map((f) => f.error))].join('; ')})` : ''}.`);
              } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
            }}>{busy ? 'Sending…' : held ? `Plan ${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}` : `${confirmed ? 'Confirm' : 'Send offers to'} ${chosen.length} ${chosen.length === 1 ? 'person' : 'people'}`}</button>
          </div>
  );
  return (
    <div className="af">
      <p className="muted small" style={{ marginTop: 0 }}>
        The best people for every open seat: they list the position, aren’t booked or on time off, hold the certificates, keep the rest and daily-hours rules, and aren’t tagged Do not rehire. Ranked by position, stars, work for this customer, then fewest hours this week. Untick anyone you don’t want; nothing is sent until you press the button.
      </p>
      <div className="row" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        <label className="row" style={{ gap: 6 }}>
          From
          <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Who to choose from">
            <option value="">All active crew</option>
            {groups.length > 0 && <optgroup label="Crew group">{groups.map((g) => <option key={g.id} value={`g:${g.id}`}>{g.name}</option>)}</optgroup>}
            {freeChecks.length > 0 && <optgroup label="Said they're free">{freeChecks.map((k) => <option key={k.id} value={`a:${k.id}`}>{k.label}</option>)}</optgroup>}
          </select>
        </label>
        <button type="button" className="btn ghost small" onClick={load}>↻ Refresh</button>
      </div>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {!d ? <div className="muted">Finding people…</div> : d.length === 0 ? <Empty>Every upcoming shift on this event is full.</Empty> : (
        <>
          <p className="small"><b>{chosen.length}</b> of {seats} open seat{seats === 1 ? '' : 's'} proposed{short ? ` · ${short} with no one available` : ''}.</p>
          {sendBar}
          {d.map((s) => (
            <section key={s.id} className="af-shift">
              <div className="af-head">
                <b>{s.role}</b>
                <span className="muted small">{day(s.starts_at)} {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}{s.phase ? ` · ${s.phase}${s.group ? ` › ${s.group}` : ''}` : ''} · {s.open} open</span>
              </div>
              {s.picks.map((p) => {
                const k = key(s.id, p.userId), on = !off.has(k);
                return (
                  <label key={p.userId} className={`af-pick${on ? '' : ' off'}`}>
                    <input type="checkbox" checked={on} onChange={() => { const n = new Set(off); if (on) n.add(k); else n.delete(k); setOff(n); }} />
                    <span>
                      <b>{p.name}</b>
                      <span className="muted small"> · {p.reasons.join(' · ')}</span>
                      {p.warnings.length > 0 && <span className="af-warn small">⚠ {p.warnings.join(' · ')}</span>}
                    </span>
                  </label>
                );
              })}
              {s.short > 0 && (
                <p className="muted small af-short">
                  {s.short} seat{s.short === 1 ? '' : 's'} with no one available{Object.keys(s.skipped).length ? ` (${Object.entries(s.skipped).map(([w, n]) => `${n} ${w}`).join(', ')})` : ''}.
                </p>
              )}
            </section>
          ))}
          {sendBar}
        </>
      )}
    </div>
  );
}
