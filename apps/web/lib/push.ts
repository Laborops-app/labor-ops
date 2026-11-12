import { api } from '@/lib/api';
import { isIos, isStandalone } from '@/lib/device';

/** Browser push for this device: what state it's in, turning it on (needs a tap for the permission prompt) and keeping it saved. */
export type PushState = 'unsupported' | 'needs-install' | 'blocked' | 'off' | 'on';

const OFF = 'lo-push-off'; // set when the person turns alerts off on this device, so they aren't switched back on by themselves
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};
export const turnedOffHere = () => !!store.get(OFF);

const toKey = (b64: string) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};
const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function currentSub() {
  const reg = await navigator.serviceWorker.getRegistration('/sw.js').catch(() => undefined);
  return (await reg?.pushManager?.getSubscription().catch(() => null)) ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const sub = await currentSub();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

async function subscribe() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey((await api<{ publicKey: string }>('/api/push/key')).publicKey) }));
  await api('/api/push/subscribe', { body: sub.toJSON() });
}

/** Ask for permission (call from a tap) and save this device. Returns the resulting state. */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return pushState();
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'blocked' : 'off';
  await subscribe();
  store.set(OFF, null);
  return 'on';
}

export async function disablePush() {
  const sub = await currentSub();
  if (sub) {
    await api('/api/push/unsubscribe', { body: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
  }
  store.set(OFF, '1');
}

/**
 * Runs on each signed-in page load: when this device already allows notifications, make sure it's subscribed and saved for
 * whoever is signed in now (no prompt). Skipped if the person turned alerts off here.
 */
let savedThisVisit = false;
export async function keepPushSaved() {
  if (savedThisVisit || !supported() || Notification.permission !== 'granted' || turnedOffHere()) return;
  savedThisVisit = true;
  try { await subscribe(); } catch { savedThisVisit = false; }
}
