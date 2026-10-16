'use client';
import { useEffect, useState } from 'react';

type Status = { phase: string; resetsAt: string | null };
const isDemoHost = () => typeof location !== 'undefined' && location.hostname.startsWith('demoapp.');

/**
 * Only on the public demo (demoapp.laborops.app): a strip at the top with the time left before the demo is wiped and
 * restarted. Its checks also tell the demo someone is using it, so it is not shut down under them.
 */
export default function DemoBanner() {
  const [s, setS] = useState<Status | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isDemoHost()) return;
    const poll = () =>
      document.visibilityState === 'visible' &&
      fetch('/__demo/status', { cache: 'no-store', headers: { 'x-demo-active': '1' } }).then((r) => r.json()).then(setS).catch(() => undefined);
    poll();
    const a = setInterval(poll, 60_000);
    const b = setInterval(() => setNow(Date.now()), 1000);
    document.addEventListener('visibilitychange', poll);
    return () => { clearInterval(a); clearInterval(b); document.removeEventListener('visibilitychange', poll); };
  }, []);
  if (!s?.resetsAt) return null;
  const left = Math.max(0, +new Date(s.resetsAt) - now);
  const h = Math.floor(left / 3600_000), m = Math.floor((left % 3600_000) / 60_000), sec = Math.floor((left % 60_000) / 1000);
  const soon = left < 10 * 60_000;
  return (
    <div className={`demo-banner${soon ? ' soon' : ''}`} role="status">
      <b>Live demo</b>
      <span>
        Resets in <span className="demo-clock">{h > 0 ? `${h}:${String(m).padStart(2, '0')}` : m}:{String(sec).padStart(2, '0')}</span>
        <span className="demo-more">{soon ? ': anything you change will be wiped soon.' : '. Everything you change is wiped then.'}</span>
      </span>
      <a className="demo-more" href="https://laborops.app">laborops.app</a>
    </div>
  );
}
