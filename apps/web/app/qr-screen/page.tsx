'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';

type Screen = { event: { name: string; venue: string | null; company: string }; svg: string; secondsLeft: number; counts: { in: number; onSite: number; expected: number } };

/** The venue screen: a clock-in code that changes every 30 seconds, for a laptop, tablet or TV at the door. No sign-in. */
function QrScreen() {
  const t = useSearchParams().get('t') ?? '';
  const [d, setD] = useState<Screen | null>(null);
  const [err, setErr] = useState('');
  const [left, setLeft] = useState(0);
  const until = useRef(0);
  useEffect(() => {
    let stop = false;
    const load = () =>
      api<Screen>(`/api/qr-screen?t=${encodeURIComponent(t)}`)
        .then((x) => { if (stop) return; setD(x); setErr(''); until.current = Date.now() + x.secondsLeft * 1000; setLeft(x.secondsLeft); })
        .catch((e) => !stop && setErr(e.message));
    load();
    // Fetch a new code the moment the old one runs out, and refresh the head count every few seconds.
    const tick = setInterval(() => {
      const s = Math.max(0, Math.ceil((until.current - Date.now()) / 1000));
      setLeft(s);
      if (s === 0 || Date.now() % 5000 < 1000) load();
    }, 1000);
    return () => { stop = true; clearInterval(tick); };
  }, [t]);
  // Keep the screen awake where the browser allows it.
  useEffect(() => {
    let lock: { release?: () => Promise<void> } | null = null;
    const on = () => (navigator as any).wakeLock?.request('screen').then((l: any) => { lock = l; }).catch(() => {});
    on();
    document.addEventListener('visibilitychange', on);
    return () => { document.removeEventListener('visibilitychange', on); lock?.release?.().catch(() => {}); };
  }, []);
  if (err && !d) return <main className="qrs"><div className="qrs-msg"><h1>Clock-in screen</h1><p role="alert">{err}</p></div></main>;
  if (!d) return <main className="qrs"><div className="qrs-msg"><p>Loading…</p></div></main>;
  return (
    <main className="qrs">
      <div className="qrs-code" dangerouslySetInnerHTML={{ __html: d.svg }} />
      <div className="qrs-side">
        <div className="qrs-kicker">Clock in here</div>
        <h1>{d.event.name}</h1>
        {d.event.venue && <div className="qrs-venue">{d.event.venue}</div>}
        <p className="qrs-how">Open your phone camera, point it at the code, and tap the link. Scan again when you leave to clock out.</p>
        <div className="qrs-counts">
          <div><b className="ok">{d.counts.in}</b><span>clocked in</span></div>
          <div><b>{Math.max(0, d.counts.expected - d.counts.in)}</b><span>still to arrive</span></div>
        </div>
        <div className="qrs-foot" aria-live="off">New code in 0:{String(left).padStart(2, '0')} · a photo of an old code won’t work{err ? ' · reconnecting…' : ''}</div>
        <div className="qrs-foot">{d.event.company} · LaborOps</div>
      </div>
    </main>
  );
}
export default function Page() {
  return <Suspense fallback={null}><QrScreen /></Suspense>;
}
