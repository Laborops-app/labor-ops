'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

type State = 'loading' | 'unsupported' | 'blocked' | 'off' | 'on';

/** Browser notification toggle: asks permission, registers the service worker, and saves this device's subscription. */
export default function BrowserPush() {
  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [ios, setIos] = useState(false);

  const refresh = async () => {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return setState('unsupported');
    if (Notification.permission === 'denied') return setState('blocked');
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      setState(sub && Notification.permission === 'granted' ? 'on' : 'off');
    } catch {
      setState('off');
    }
  };
  useEffect(() => {
    setIos(/iPhone|iPad|iPod/.test(navigator.userAgent));
    refresh();
  }, []);

  const enable = async () => {
    setBusy(true);
    setError('');
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return setState(perm === 'denied' ? 'blocked' : 'off');
      const reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      const { publicKey } = await api<{ publicKey: string }>('/api/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
      await api('/api/push/subscribe', { body: sub.toJSON() });
      setState('on');
    } catch (e) {
      setError((e as Error).message || 'Could not turn on notifications');
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    setBusy(true);
    setError('');
    try {
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await api('/api/push/unsubscribe', { body: { endpoint: sub.endpoint } });
        await sub.unsubscribe();
      }
      setState('off');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
