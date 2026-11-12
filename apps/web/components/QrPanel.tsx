'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import Skeleton from '@/components/Skeleton';

type Info = { on: boolean; hasVenueLocation: boolean; screenLink: string | null };

/** QR clock-in for one event: switch it on, open the venue screen, print a poster, or copy the screen link for the site lead. */
export default function QrPanel({ eventId, onClockSettings }: { eventId: string; onClockSettings: () => void }) {
  const [d, setD] = useState<Info | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(() => api<Info>(`/api/events/${eventId}/qr`).then(setD).catch((e) => setErr(e.message)), [eventId]);
  useEffect(() => { load(); }, [load]);
  if (!d) return err ? <p className="error" role="alert">{err}</p> : <Skeleton />;
  const toggle = async (on: boolean) => {
    setErr(''); setMsg('');
    setD({ ...d, on }); // flip straight away; put it back if the server says no
    try { await api(`/api/events/${eventId}/qr`, { method: 'PUT', body: { on } }); await load(); setMsg(on ? 'QR clock-in is on for this event.' : 'QR clock-in is off. Old codes no longer work.'); } catch (e) { setErr((e as Error).message); setD({ ...d, on: !on }); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(d.screenLink!); setMsg('Screen link copied. Send it to whoever runs the screen at the venue.'); } catch { setMsg(d.screenLink!); }
  };
  return (
    <div className="qrp">
      <p className="muted" style={{ marginTop: 0 }}>
        Put a code on a laptop, tablet or TV at the door. Crew scan it with their own phone camera and are clocked in, with no typing. Scanning again clocks them out.
      </p>
      <label className="qrp-toggle">
        <input type="checkbox" checked={d.on} onChange={(e) => toggle(e.target.checked)} />
        <span><b>Use a QR code at this event</b><span className="muted small">The code changes every 30 seconds, so a photo of it can’t be shared. Clocking in from the app still works.</span></span>
      </label>
      {err && <p className="error small" role="alert">{err}</p>}
      {msg && <p className="small" style={{ color: 'var(--good)', overflowWrap: 'anywhere' }} role="status">{msg}</p>}
      {d.on && d.screenLink && (
        <div className="qrp-acts">
          <a className="btn primary" href={d.screenLink} target="_blank" rel="noreferrer">Open the venue screen</a>
          <button type="button" className="btn" onClick={copy}>Copy the screen link for the site lead</button>
          {d.hasVenueLocation
            ? <a className="btn" href={`/api/events/${eventId}/qr-poster.pdf`} target="_blank" rel="noreferrer">Print a poster (PDF)</a>
            : <button type="button" className="btn" onClick={onClockSettings}>Set the venue location to print a poster</button>}
        </div>
      )}
      {d.on && (
        <p className="muted small">
          The screen link needs no sign-in and shows only the code and a head count; it works for 14 days. A printed poster uses a code that doesn’t change, so it also checks the phone is at the venue.
        </p>
      )}
    </div>
  );
}
