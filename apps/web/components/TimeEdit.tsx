'use client';
import { useState } from 'react';

const p2 = (n: number) => String(n).padStart(2, '0');
/** ISO → value for <input type="datetime-local"> (local time). */
export const toLocalInput = (iso: string | Date) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

/**
 * Inline form to correct (or add) a clock-in / clock-out. Leaving "Out" empty keeps the person on the clock.
 * onSave gets ISO times; it throws to show an error, or returns a message for a confirmation question.
 */
export default function TimeEdit({ clockIn, clockOut, onSave, onCancel, title = 'Correct time', allowOpen = true }: {
  clockIn?: string | null; clockOut?: string | null; title?: string; allowOpen?: boolean;
  onSave: (t: { clockIn: string; clockOut: string | null }) => Promise<void>; onCancel: () => void;
}) {
  const [inV, setIn] = useState(clockIn ? toLocalInput(clockIn) : '');
  const [outV, setOut] = useState(clockOut ? toLocalInput(clockOut) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const hours = inV && outV ? (new Date(outV).getTime() - new Date(inV).getTime()) / 3600_000 : null;
  return (
    <form
      className="time-edit time-entry-edit"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!inV) return setErr('Enter the clock-in time');
        if (!outV && !allowOpen) return setErr('Enter the clock-out time');
        if (hours !== null && hours <= 0) return setErr('Clock-out must be after clock-in');
        setBusy(true);
        setErr('');
        try {
          await onSave({ clockIn: new Date(inV).toISOString(), clockOut: outV ? new Date(outV).toISOString() : null });
        } catch (x) {
          setErr((x as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <b className="small" style={{ flexBasis: '100%' }}>{title}</b>
      <label>
        In
        <input type="datetime-local" value={inV} onChange={(e) => setIn(e.target.value)} required />
      </label>
      <label>
        Out {allowOpen && <span className="muted small">(empty = still on the clock)</span>}
        <input type="datetime-local" value={outV} min={inV} onChange={(e) => setOut(e.target.value)} required={!allowOpen} />
      </label>
      {hours !== null && hours > 0 && <span className="muted small" style={{ alignSelf: 'center' }}>{hours.toFixed(2)} h</span>}
      <div className="row" style={{ gap: 6 }}>
        <button className="btn small primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
        <button type="button" className="btn ghost small" onClick={onCancel}>Cancel</button>
      </div>
      {err && <div className="small" style={{ color: 'var(--bad)', flexBasis: '100%' }}>{err}</div>}
    </form>
  );
}
