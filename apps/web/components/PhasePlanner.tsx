'use client';
import { useEffect, useState } from 'react';
import { PRESETS } from '@/components/EventInfo';

export type PlannedPhase = { date: string; label: string; on: boolean };

const addDay = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const nice = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
/** Load in the first day, Strike the last, Show in between (one day: Show). */
const suggest = (i: number, n: number) => (n === 1 ? 'Show' : i === 0 ? 'Load in' : i === n - 1 && n > 2 ? 'Strike' : 'Show');

/**
 * New event: one phase per day of the chosen dates, ready to rename or leave out. Names you type are kept
 * when the dates change; new days get a suggestion.
 */
export default function PhasePlanner({ start, end, value, onChange }: { start: string; end: string; value: PlannedPhase[] | null; onChange: (v: PlannedPhase[] | null) => void }) {
  const [typed, setTyped] = useState<Record<string, string>>({});
  const days: string[] = [];
  if (start && end && end >= start) for (let d = start; d <= end && days.length < 62; d = addDay(d, 1)) days.push(d);
  // Keep the list in step with the dates.
  useEffect(() => {
    if (!value) return;
    const next = days.map((d, i) => {
      const had = value.find((x) => x.date === d);
      return had ?? { date: d, label: typed[d] ?? suggest(i, days.length), on: true };
    });
    if (JSON.stringify(next) !== JSON.stringify(value)) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, !!value]);
  const on = !!value;
  return (
    <div className="phase-plan">
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked ? days.map((d, i) => ({ date: d, label: typed[d] ?? suggest(i, days.length), on: true })) : null)} />
        <span>
          Set up phases <span className="muted small">(one per day: load in, show, strike…)</span>
        </span>
      </label>
      {on && value && (
        <div className="phase-plan-list">
          {value.map((p, i) => (
            <div key={p.date} className={`phase-plan-row${p.on ? '' : ' off'}`}>
              <input type="checkbox" checked={p.on} aria-label={`Include ${nice(p.date)}`} onChange={(e) => onChange(value.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
              <span className="phase-plan-day">{nice(p.date)}</span>
              <input
                list="new-phase-presets"
                value={p.label}
                disabled={!p.on}
                maxLength={80}
                aria-label={`Phase on ${nice(p.date)}`}
                onChange={(e) => {
                  setTyped({ ...typed, [p.date]: e.target.value });
                  onChange(value.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)));
                }}
              />
            </div>
          ))}
          {value.length >= 62 && <div className="muted small">Up to 62 days can be planned here; add more on the event page.</div>}
          <datalist id="new-phase-presets">{PRESETS.map((x) => <option key={x} value={x} />)}</datalist>
        </div>
      )}
    </div>
  );
}
