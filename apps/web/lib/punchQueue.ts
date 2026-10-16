'use client';
import { ApiError } from '@/lib/api';

/**
 * Clock-ins and clock-outs made without signal are kept on the phone (IndexedDB, shared with the service worker) and sent
 * as soon as there is a connection: when the app opens, comes back online or to the front, and through Background Sync
 * on Android even with the app closed. Each punch carries the phone's own time and a random id, so the server records
 * the real time and never counts it twice.
 */
export type Punch = { clientId: string; kind: 'in' | 'out'; body: Record<string, unknown>; savedAt: number; label?: string; error?: string };

const DB = 'laborops';
const STORE = 'punches';
const EVT = 'lo-punches-changed';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'clientId' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req ? req.result : undefined);
    t.onerror = () => reject(t.error);
  });
}
const changed = () => window.dispatchEvent(new Event(EVT));

export const newClientId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });

export async function pendingPunches(): Promise<Punch[]> {
  try {
    return ((await run<Punch[]>('readonly', (s) => s.getAll())) ?? []).sort((a, b) => a.savedAt - b.savedAt);
  } catch {
    return [];
  }
}

export async function queuePunch(p: Omit<Punch, 'savedAt'>) {
  await run('readwrite', (s) => s.put({ ...p, savedAt: Date.now() }));
  changed();
  // Android/Chrome: let the service worker send it even if the app is closed.
  try {
    const reg = await navigator.serviceWorker?.ready;
    await (reg as any)?.sync?.register('lo-punches');
  } catch {
    /* not supported (iOS): sent when the app is next open */
  }
}

export async function dropPunch(clientId: string) {
  await run('readwrite', (s) => s.delete(clientId));
  changed();
}

const isOffline = (e: unknown) => !(e instanceof ApiError) || [0, 502, 503, 504].includes((e as ApiError).status);

let flushing: Promise<number> | null = null;
/** Send everything waiting, oldest first. Stops at the first network failure. Returns how many were sent. */
export function flushPunches(): Promise<number> {
  return (flushing ??= (async () => {
    let sent = 0;
    try {
      for (const p of await pendingPunches()) {
        if (p.error) continue; // refused by the server: shown to the person until they dismiss it
        const res = await fetch(p.kind === 'in' ? '/api/time/clock-in' : '/api/time/clock-out', {
          method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p.body),
        }).catch(() => null);
        if (!res || res.status === 401 || res.status >= 502) break;
        if (res.ok) {
          await run('readwrite', (s) => s.delete(p.clientId));
          sent++;
        } else {
          const j = await res.json().catch(() => ({}));
          await run('readwrite', (s) => s.put({ ...p, error: j.error ?? `Error ${res.status}` }));
        }
      }
    } finally {
      flushing = null;
      changed();
    }
    return sent;
  })());
}

/**
 * Clock in or out: straight to the server when there is signal, otherwise saved on the phone.
 * Returns 'sent' or 'queued'; a refusal from the server (geofence, too early…) is thrown as usual.
 */
export async function punch(kind: 'in' | 'out', body: Record<string, unknown>, label: string): Promise<'sent' | 'queued'> {
  const clientId = newClientId();
  const full = { ...body, clientId, at: new Date().toISOString() };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    await queuePunch({ clientId, kind, body: full, label });
    return 'queued';
  }
  try {
    const res = await fetch(kind === 'in' ? '/api/time/clock-in' : '/api/time/clock-out', {
      method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(full),
      signal: AbortSignal.timeout?.(12_000),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(j.error ?? `Request failed (${res.status})`, res.status, j.reason);
    return 'sent';
  } catch (e) {
    if (!isOffline(e)) throw e;
    // No answer (no signal, or it timed out): keep it and send it later with the same id and time.
    await queuePunch({ clientId, kind, body: full, label });
    return 'queued';
  }
}

export const onPunchesChanged = (fn: () => void) => {
  window.addEventListener(EVT, fn);
  return () => window.removeEventListener(EVT, fn);
};
