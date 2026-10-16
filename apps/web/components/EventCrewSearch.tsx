'use client';
import { useMemo, useState } from 'react';
import { matchScore } from '@/components/CrewPick';
import { fmtDate, fmtTime } from '@/lib/api';

type A = { id: string; user_id: string; user_name: string; status: string; is_lead?: boolean; clocked_in_at?: string | null; last_clock_out?: string | null };
type S = { id: string; role_name: string; starts_at: string; ends_at: string; phase_id: string | null; assignments: A[] };
type P = { id: string; label: string };

const STATUS: Record<string, string> = { accepted: 'Confirmed', pending: 'Offered', declined: 'Declined' };

/** Search the crew on this event by name or role, and jump to their shift. */
export default function EventCrewSearch({ shifts, phases, onJump }: { shifts: S[]; phases: P[]; onJump: (shiftId: string, phaseKey: string, role: string) => void }) {
  const [q, setQ] = useState('');
  const people = useMemo(
    () =>
      shifts.flatMap((s) =>
        s.assignments.map((a) => ({
          a,
          s,
          phase: phases.find((p) => p.id === s.phase_id) ?? null,
        })),
      ),
    [shifts, phases],
  );
  const hits = useMemo(() => {
    if (!q.trim()) return [];
    return people
      .map((x) => ({ ...x, score: matchScore(x.a.user_name, x.s.role_name, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || +new Date(a.s.starts_at) - +new Date(b.s.starts_at))
      .slice(0, 30);
  }, [people, q]);
  const uniq = new Set(people.filter((x) => x.a.status !== 'declined').map((x) => x.a.user_id)).size;

  return (
    <section className="card crew-search">
      <input
        type="search"
        className="crew-search-input"
        placeholder={`Search ${uniq} crew on this event by name or role`}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search crew on this event"
      />
      {q.trim() && (
        hits.length === 0 ? (
          <p className="muted small" style={{ margin: '8px 2px 0' }}>No one on this event matches “{q}”.</p>
        ) : (
          <ul className="crew-hits">
            {hits.map(({ a, s, phase }) => {
              const onSite = a.clocked_in_at && !a.last_clock_out;
              return (
                <li key={a.id}>
                  <button type="button" onClick={() => onJump(s.id, phase ? phase.id : 'none', s.role_name)}>
                    <span className="crew-hit-name">
                      {a.user_name}
                      {a.is_lead && <span className="pill">Lead</span>}
                    </span>
                    <span className="muted small">
                      {s.role_name} · {phase ? `${phase.label} · ` : ''}{fmtDate(s.starts_at)} {fmtTime(s.starts_at)}–{fmtTime(s.ends_at)}
                    </span>
                    <span className={`pill ${onSite ? 'clocked' : a.status === 'pending' ? 'offered' : a.status}`}>{onSite ? 'On site' : STATUS[a.status] ?? a.status}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )
      )}
    </section>
  );
}
