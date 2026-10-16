'use client';
import { useEffect, useState } from 'react';
import { dropPunch, flushPunches, onPunchesChanged, pendingPunches, type Punch } from '@/lib/punchQueue';
import { fmtTime } from '@/lib/api';

/**
 * Sends clock-ins/outs saved offline whenever the app opens, gets signal back or comes to the front, and shows what is
 * still waiting (or was refused) at the top of the page.
 */
export default function PunchSync() {
  const [list, setList] = useState<Punch[]>([]);
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const refresh = () => pendingPunches().then(setList);
    const flush = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) flushPunches().then(refresh);
      else refresh();
    };
    const vis = () => document.visibilityState === 'visible' && flush();
    const fromSw = (e: MessageEvent) => e.data?.type === 'punches-flushed' && refresh();
    flush();
    const off = onPunchesChanged(refresh);
    window.addEventListener('online', flush);
    window.addEventListener('offline', flush);
    document.addEventListener('visibilitychange', vis);
    navigator.serviceWorker?.addEventListener('message', fromSw);
    const t = setInterval(() => navigator.onLine && pendingPunches().then((l) => l.some((p) => !p.error) && flush()), 30_000);
    return () => {
      off();
      window.removeEventListener('online', flush);
      window.removeEventListener('offline', flush);
      document.removeEventListener('visibilitychange', vis);
      navigator.serviceWorker?.removeEventListener('message', fromSw);
      clearInterval(t);
    };
  }, []);
  const waiting = list.filter((p) => !p.error);
  const refused = list.filter((p) => p.error);
  if (!list.length && online) return null;
  return (
    <div className="punch-sync" role="status" aria-live="polite">
      {!online && !waiting.length && <div className="punch-row offline">You're offline. You can still clock in and out: it's saved on this phone and sent when you have signal.</div>}
      {waiting.length > 0 && (
        <div className="punch-row pending">
          <span className="punch-dot" aria-hidden="true" />
          <span>
            <b>{waiting.length === 1 ? `${waiting[0].kind === 'in' ? 'Clock-in' : 'Clock-out'} at ${fmtTime(new Date(waiting[0].savedAt).toISOString())}` : `${waiting.length} punches`}</b>{' '}
            saved on this phone. {online ? 'Sending…' : 'It will send when you have signal, with the time you tapped.'}
          </span>
          {online && <button className="btn small" onClick={() => flushPunches()}>Send now</button>}
        </div>
      )}
      {refused.map((p) => (
        <div className="punch-row refused" key={p.clientId}>
          <span>
            Your {p.kind === 'in' ? 'clock-in' : 'clock-out'} at {fmtTime(new Date(p.savedAt).toISOString())}{p.label ? ` (${p.label})` : ''} was not accepted: {p.error} Tell your labor coordinator so they can add your time.
          </span>
          <button className="btn small ghost" onClick={() => dropPunch(p.clientId)}>OK</button>
        </div>
      ))}
    </div>
  );
}
