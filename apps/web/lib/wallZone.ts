/**
 * Show and enter times in a venue's time zone. While a zone is set (the event page sets it when the venue's zone
 * differs from this device's), every timestamp the API returns is moved so the device's own clock reads venue time,
 * and every timestamp sent back is moved the other way. All the date code on the page keeps working unchanged.
 */
let zone: string | null = null;
const local = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Minutes a zone is ahead of UTC at an instant. */
function off(tz: string, ms: number) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - Math.floor(ms / 1000) * 1000) / 60000;
}
// a real instant → a fake one whose local clock reads the venue's clock
function toWall(ms: number, tz: string) {
  const w = ms + off(tz, ms) * 60000;
  let x = w - off(local(), w) * 60000;
  x = w - off(local(), x) * 60000;
  return x;
}
// the reverse: a local-clock reading → the real instant at the venue
function fromWall(ms: number, tz: string) {
  const l = ms + off(local(), ms) * 60000;
  let t = l - off(tz, l) * 60000;
  t = l - off(tz, t) * 60000;
  return t;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
// Calendar dates (event start/end, phase days, expiry) come back as midnight timestamps and must not move.
const DATE_KEY = /(^|_)(date|day|on|until)$|Date$|^(sd|ed|starts_on|ends_on)$/;
function walk(v: unknown, f: (ms: number) => number, key = ''): unknown {
  if (typeof v === 'string') return ISO.test(v) && !DATE_KEY.test(key) ? new Date(f(Date.parse(v))).toISOString() : v;
  if (Array.isArray(v)) return v.map((x) => walk(x, f, key));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, f, k)]));
  return v;
}

export function setWallZone(tz: string | null) { zone = tz && tz !== local() ? tz : null; }
export const wallZone = () => zone;
export const deviceZone = local;
export const inbound = <T>(data: T): T => (zone ? (walk(data, (ms) => toWall(ms, zone!)) as T) : data);
export const outbound = <T>(data: T): T => (zone ? (walk(data, (ms) => fromWall(ms, zone!)) as T) : data);
export function outboundPath(path: string) {
  if (!zone || !path.includes('?')) return path;
  const [p, q] = path.split('?', 2) as [string, string];
  const sp = new URLSearchParams(q);
  for (const [k, v] of [...sp.entries()]) if (ISO.test(v)) sp.set(k, new Date(fromWall(Date.parse(v), zone)).toISOString());
  return `${p}?${sp.toString()}`;
}
/** A friendly name for a zone, e.g. "Arizona time (MST)". */
export function zoneLabel(tz: string) {
  const short = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(new Date()).find((x) => x.type === 'timeZoneName')?.value ?? '';
  const city = tz.split('/').pop()!.replace(/_/g, ' ');
  return `${city} time${short ? ` (${short})` : ''}`;
}
