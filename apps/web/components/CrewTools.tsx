'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, fmtTime } from '@/lib/api';
import { show } from '@/components/Toasts';

/** "Running late" on a shift: pick about how long, add a note, and the lead and coordinators are told. */
export function RunningLate({ assignmentId, eta, onDone }: { assignmentId: string; eta: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [min, setMin] = useState(15);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const send = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<{ eta: string; told: number }>(`/api/my/assignments/${assignmentId}/late`, { body: { minutes: min, note: note.trim() || undefined } });
      setOpen(false); setNote('');
      show(`Thanks. ${r.told ? 'Your lead and coordinator know' : 'Your coordinator knows'} you’ll be there around ${fmtTime(r.eta)}.`);
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <>
      {eta && <span className="late-chip">Running late · around {fmtTime(eta)}</span>}
      <button type="button" className="btn ghost small" onClick={() => setOpen(true)}>{eta ? 'Change arrival time' : 'Running late'}</button>
      {open && typeof document !== 'undefined' && createPortal(
        <div className="iosg-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="iosg late-sheet" role="dialog" aria-modal="true" aria-label="Running late">
            <h2>About how late?</h2>
            <p className="muted small">Your lead and labor coordinator are told right away. Late alerts wait until then.</p>
            <div className="late-opts" role="radiogroup" aria-label="Minutes late">
              {[5, 10, 15, 30, 45, 60].map((m) => (
                <button key={m} type="button" role="radio" aria-checked={min === m} className={min === m ? 'on' : ''} onClick={() => setMin(m)}>{m < 60 ? `${m} min` : '1 hour'}</button>
              ))}
            </div>
            <label className="late-note">Note (optional)
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="Traffic on I-25, parking now…" />
            </label>
            {err && <p className="small" role="alert" style={{ color: 'var(--bad)', margin: 0 }}>{err}</p>}
            <div className="iosg-acts">
              <button type="button" className="btn ghost" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Let them know'}</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Subscribe to your confirmed shifts in Apple, Google or Outlook calendar. The link is private to you. */
export function CalendarFeed({ compact }: { compact?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<{ url: string }>('/api/my/calendar-link').then((r) => setUrl(r.url)).catch((e) => setErr(e.message)); }, []);
  if (err) return null;
  const webcal = url?.replace(/^https?:/, 'webcal:') ?? '';
  const google = url ? `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}` : '';
  const copy = async () => { if (!url) return; try { await navigator.clipboard.writeText(url); show('Calendar link copied. Paste it into your calendar app as a subscription.'); } catch { show(url, { ms: 10000 }); } };
  const reset = async () => {
    try { const r = await api<{ url: string }>('/api/my/calendar-link/reset', { body: {} }); setUrl(r.url); show('New link made. The old one stopped working; subscribe again with this one.'); }
    catch (e) { show((e as Error).message, { error: true }); }
  };
  return (
    <section className={`card cal-feed${compact ? ' compact' : ''}`}>
      <h2>Shifts in your phone’s calendar</h2>
      <p className="muted small">Your confirmed shifts appear in your calendar and stay up to date by themselves, including changes and cancellations.</p>
      <div className="row cal-feed-btns">
        <a className="btn primary small" href={webcal || undefined} aria-disabled={!url}>iPhone / Apple Calendar</a>
        <a className="btn small" href={google || undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!url}>Google Calendar</a>
        <button type="button" className="btn ghost small" disabled={!url} onClick={copy}>Copy link</button>
        {!compact && <button type="button" className="btn ghost small" disabled={!url} onClick={reset} title="Stops the current link working (if you shared it by mistake)">Make a new link</button>}
      </div>
      <p className="muted small" style={{ margin: 0 }}>Keep this link to yourself: anyone with it can see your shifts.</p>
    </section>
  );
}
