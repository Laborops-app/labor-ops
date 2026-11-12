'use client';
import { useEffect, useState } from 'react';
import { disablePush, enablePush, pushState } from '@/lib/push';

type State = 'loading' | 'unsupported' | 'blocked' | 'off' | 'on';

/** Browser notification toggle: asks permission, registers the service worker, and saves this device's subscription. */
export default function BrowserPush() {
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ios, setIos] = useState(false);

  const refresh = async () => {
    const st = await pushState();
    setState(st === 'needs-install' ? 'unsupported' : st);
  };
  useEffect(() => {
    setIos(/iPhone|iPad|iPod/.test(navigator.userAgent));
    refresh();
  }, []);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message || 'Could not change notifications');
    } finally {
      setBusy(false);
    }
  };
  const enable = () => run(enablePush);
  const disable = () => run(disablePush);

  if (state === 'loading') return null;
  return (
    <div className="grid-form" style={{ gridTemplateColumns: '1fr' }}>
      <div className="toggle-row">
        <div style={{ flex: 1 }}>
          <strong>Browser notifications on this device</strong>
          <span className="muted small" style={{ display: 'block' }}>
            {state === 'unsupported' && (ios ? 'On iPhone, add LaborOps to your Home Screen first (Share → Add to Home Screen), then open it from there.' : 'This browser does not support notifications.')}
            {state === 'blocked' && 'Notifications are blocked for this site. Allow them in your browser’s site settings, then come back.'}
            {state === 'off' && 'Get an alert for shift offers, changes and reminders, even when LaborOps is closed.'}
            {state === 'on' && 'On. You will get alerts on this device.'}
          </span>
          {error && <span className="small" style={{ display: 'block', color: 'var(--bad)' }}>{error}</span>}
        </div>
        {state === 'off' && (
          <button type="button" className="btn" onClick={enable} disabled={busy}>
            Turn on
          </button>
        )}
        {state === 'on' && (
          <button type="button" className="btn ghost" onClick={disable} disabled={busy}>
            Turn off
          </button>
        )}
      </div>
    </div>
  );
}
