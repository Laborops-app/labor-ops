'use client';
import { useState } from 'react';
import { api, fmtDate } from '@/lib/api';

const plus = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

/** Copy one day (phase) with its groups and positions to other days. Crew are not copied. */
export default function CopyPhase({
  phase, eventStart, eventEnd, onDone, onError, onClose,
}: {
  phase: { id: string; label: string; starts_on: string };
  eventStart: string;
  eventEnd: string;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
  onClose: () => void;
}) {
  const day = phase.starts_on.slice(0, 10);
  // Every day of the event, plus three days either side.
  const days: string[] = [];
  for (let d = plus(eventStart.slice(0, 10), -3); d <= plus(eventEnd.slice(0, 10), 3) && days.length < 40; d = plus(d, 1)) if (d !== day) days.push(d);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [extra, setExtra] = useState('');
  const [busy, setBusy] = useState(false);
  const all = [...new Set([...days, ...[...picked].filter((d) => !days.includes(d))])].sort();
  const toggle = (d: string) => setPicked((p) => { const n = new Set(p); if (n.has(d)) n.delete(d); else n.add(d); return n; });
  const inEvent = (d: string) => d >= eventStart.slice(0, 10) && d <= eventEnd.slice(0, 10);
  const go = async () => {
    setBusy(true);
    try {
      const r = await api<{ phases: number; shifts: number }>(`/api/event-phases/${phase.id}/copy`, { body: { dates: [...picked] } });
      onDone(`Copied ${phase.label} to ${picked.size} day${picked.size === 1 ? '' : 's'}: ${r.shifts} position${r.shifts === 1 ? '' : 's'} added${r.phases ? `, ${r.phases} new day${r.phases === 1 ? '' : 's'}` : ''}.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="copy-phase">
      <b className="small">Copy {phase.label} ({fmtDate(day)}) to:</b>
      <div className="day-chips" role="group" aria-label="Days to copy to">
        {all.map((d) => (
          <button key={d} type="button" aria-pressed={picked.has(d)} className={`day-chip${picked.has(d) ? ' on' : ''}${inEvent(d) ? '' : ' outside'}`} onClick={() => toggle(d)}>
            {new Date(`${d}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
          </button>
        ))}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
        <input type="date" value={extra} onChange={(e) => setExtra(e.target.value)} aria-label="Another date" style={{ maxWidth: '11rem' }} />
        <button type="button" className="btn ghost small" disabled={!extra || extra === day} onClick={() => { toggle(extra); setExtra(''); }}>Add date</button>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="btn ghost small" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary small" disabled={busy || !picked.size} onClick={go}>{busy ? 'Copying…' : `Copy to ${picked.size || ''} day${picked.size === 1 ? '' : 's'}`}</button>
      </div>
      <p className="muted small" style={{ margin: 0 }}>Groups and positions come along at the same times of day. Crew don&apos;t. Days outside the event stretch its dates.</p>
    </div>
  );
}
