import { inbound, outbound, outboundPath, wallZone } from '@/lib/wallZone';

export class ApiError extends Error {
  constructor(message: string, public status: number, public reason?: string, public data?: Record<string, any>) {
    super(message);
  }
}

// The last answer to each GET, kept for this browser tab, so pages open straight away with what they showed last time
// while the fresh data loads (peek). Keyed by the time zone in use too, since times are converted per zone.
const recent = new Map<string, unknown>();
const keyOf = (path: string) => `${wallZone() ?? ''}|${path}`;
export const peek = <T>(path: string): T | null => (recent.get(keyOf(path)) as T | undefined) ?? null;

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(outboundPath(path), {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: init.body ? { 'content-type': 'application/json' } : undefined,
    body: init.body ? JSON.stringify(outbound(init.body)) : undefined,
    credentials: 'same-origin',
  });
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status, data?.reason, data ?? undefined);
  const out = inbound(data) as T;
  if ((init.method ?? (init.body ? 'POST' : 'GET')) === 'GET') {
    recent.set(keyOf(path), out);
    if (recent.size > 80) recent.delete(recent.keys().next().value!);
  }
  return out;
}

export type Role = 'admin' | 'manager' | 'crew' | 'hr' | 'client';
/** Where each kind of account lands after signing in. */
export const homeFor = (role: string) => (role === 'crew' ? '/my-shifts' : role === 'hr' ? '/pipeline' : role === 'client' ? '/client' : '/dashboard');
export const roleLabel = (r: string) => (r === 'manager' ? 'Labor Coordinator' : r === 'admin' ? 'Admin' : r === 'crew' ? 'Crew' : r === 'hr' ? 'HR' : r === 'client' ? 'Client' : r);
export type FieldRole = 'onsite_coordinator';
export const FIELD_ROLES: { key: FieldRole; label: string; help: string }[] = [
  { key: 'onsite_coordinator', label: 'On-site Labor Coordinator', help: 'On every event they work: sees all the crew, checks them in and out, and rates them.' },
];
export type Me = { id: string; name: string; role: Role; company?: string; canAdjustRates?: boolean; fieldRoles?: FieldRole[]; leads?: boolean; customer?: { id: string; name: string } };

export const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const fmtDate = (d: string) =>
  new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

export type Pos = { lat: number; lng: number; accuracy: number };
/** The device's current position, or an error message explaining why it could not be read. */
export const getPosition = (timeoutMs = 12000): Promise<Pos> =>
  new Promise((resolve, reject) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return reject(new Error('This device cannot share its location.'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
      (e) => reject(new Error(e.code === 1 ? 'Location is blocked. Allow location access for this site in your browser settings, then try again.' : 'Could not read your location. Try again.')),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 10000 },
    );
  });
