'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { enablePush, keepPushSaved, pushState, turnedOffHere } from '@/lib/push';
import { isIos, isStandalone } from '@/lib/device';
import { installGuideShowing } from '@/components/IosInstallGuide';

// Per device: when it was last asked ("web" in a browser tab, "app" once opened from the home screen, which iPhone treats
// as a separate app that must be asked again).
const KEY = 'lo-alerts-asked';
const SNOOZE = 7 * 24 * 3600_000;
const read = (): Record<string, number> => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };
const mark = (where: string) => { try { localStorage.setItem(KEY, JSON.stringify({ ...read(), [where]: Date.now() })); } catch { /* storage blocked */ } };

/**
 * After signing in (and the first time LaborOps is opened from the home screen on Android or iPhone), asks once to turn on
 * shift alerts: one tap, then the browser's Allow. Where alerts are already allowed it saves this device without asking.
 */
export default function AlertsPrompt() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const where = typeof window !== 'undefined' && isStandalone() ? 'app' : 'web';
  useEffect(() => {
    keepPushSaved();
    let live = true;
    (async () => {
      // An iPhone browser tab can't get alerts; the Home Screen guide covers that, and this asks once it's opened from there.
      if (turnedOffHere() || (isIos() && !isStandalone())) return;
      const st = await pushState();
      const last = read()[where];
      if (!(st === 'off' && Notification.permission === 'default' && !(last && Date.now() - last < SNOOZE))) return;
      // The install guide goes first on a phone browser; ask about alerts once it's closed.
      await new Promise((r) => setTimeout(r, 400));
      if (!live) return;
      if (installGuideShowing()) window.addEventListener('lo-guide-closed', () => live && setOpen(true), { once: true });
      else setOpen(true);
    })();
    return () => { live = false; };
  }, [where]);
  if (!open || typeof document === 'undefined') return null;
  const close = () => { mark(where); setOpen(false); };
  const turnOn = async () => {
    setBusy(true); setMsg('');
    try {
      const st = await enablePush();
      if (st === 'on') { mark(where); setOpen(false); return; }
      if (st === 'blocked') setMsg('Alerts are blocked for LaborOps. You can allow them later in your phone or browser settings, then turn them on under Profile.');
      else setMsg('No problem. You can turn alerts on any time under Profile.');
      mark(where);
    } catch (e) {
      setMsg((e as Error).message || 'Could not turn on alerts. Try again under Profile.');
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="iosg-back" role="presentation">
      <div className="iosg alerts-ask" role="dialog" aria-modal="true" aria-label="Turn on shift alerts">
        <div className="alerts-bell" aria-hidden="true">
          <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8ZM10 20a2 2 0 0 0 4 0" /></svg>
        </div>
        <h2>Turn on shift alerts</h2>
        <p>Get new shift offers, changes and reminders on this {where === 'app' ? 'phone' : 'device'} the moment they happen, even when LaborOps is closed.</p>
        <p className="muted small">Next, your {where === 'app' ? 'phone' : 'browser'} will ask you to allow notifications. Tap <b>Allow</b>.</p>
        {msg && <p className="small" role="status">{msg}</p>}
        <div className="iosg-acts">
          <button type="button" className="btn ghost" onClick={close}>{msg ? 'Close' : 'Not now'}</button>
          {!msg && <button type="button" className="btn primary" disabled={busy} onClick={turnOn}>{busy ? 'Turning on…' : 'Turn on alerts'}</button>}
        </div>
      </div>
    </div>,
    document.body,
  );
}
