import type { Category } from './index';

/**
 * What each person chooses about their notifications. Kinds of alert are grouped the way people think about them;
 * for each group they pick app (push), email and text. The in-app list always gets everything.
 */
export const GROUPS = {
  offers: { label: 'Shift offers and open shifts', cats: ['assignment', 'open_shift'], sms: true },
  changes: { label: 'Changes to my shifts and event updates', cats: ['shift_change', 'event_update'], sms: true },
  reminders: { label: 'Reminders and attendance', cats: ['reminder', 'attendance'], sms: true },
  requests: { label: 'Requests and approvals', cats: ['approval_request', 'approval_result'], sms: true },
  chat: { label: 'Chat messages', cats: ['chat'], sms: false },
  other: { label: 'Certificates, trainings and account', cats: ['cert', 'training', 'account', 'billing', 'digest'], sms: false },
} as const satisfies Record<string, { label: string; cats: readonly Category[]; sms: boolean }>;
export type Group = keyof typeof GROUPS;
export type Channel = 'push' | 'email' | 'sms';
export type Prefs = Partial<Record<Group, Partial<Record<Channel, boolean>>>>;

export const groupOf = (cat: Category): Group => (Object.entries(GROUPS).find(([, g]) => (g.cats as readonly string[]).includes(cat))?.[0] as Group) ?? 'other';

/** Off only when the person switched it off; everything starts on. */
export const wants = (p: Prefs | null | undefined, cat: Category, ch: Channel) => p?.[groupOf(cat)]?.[ch] !== false;

/** Never held back by quiet hours: they're about a shift happening now or soon. */
const URGENT = new Set<Category>(['assignment', 'shift_change', 'reminder', 'attendance']);

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const validTime = (t: unknown): t is string => typeof t === 'string' && HHMM.test(t);

/** Minutes past local midnight in a time zone. */
function localMinutes(d: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  return Number(p.find((x) => x.type === 'hour')?.value ?? 0) * 60 + Number(p.find((x) => x.type === 'minute')?.value ?? 0);
}

/**
 * During someone's quiet hours, push and texts that can wait are held until the quiet time ends. Returns the minutes to
 * wait (0 = send now). Email is never held: it doesn't buzz.
 */
export function quietDelayMin(cat: Category, start: string | null | undefined, end: string | null | undefined, tz: string, now = new Date()): number {
  if (URGENT.has(cat) || !validTime(start) || !validTime(end) || start === end) return 0;
  const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  const s = toMin(start), e = toMin(end), n = localMinutes(now, tz);
  const inside = s < e ? n >= s && n < e : n >= s || n < e; // overnight windows wrap past midnight
  if (!inside) return 0;
  return (e - n + 1440) % 1440 || 1440;
}

/** Bursts about the same thing (same kind, same page) within a few minutes become one email or text. */
export const MERGE = new Set<Category>(['shift_change', 'event_update', 'approval_request', 'open_shift']);
export const MERGE_HOLD_MIN = Number(process.env.NOTIFY_MERGE_MIN ?? 2);
