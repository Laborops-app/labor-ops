// Shared types and helpers for the schedule page (Shift view, Staff view, Month view and the filter panel).

export type Assignee = { user_id: string; name: string; status: 'offered' | 'accepted' | 'pending' };
export type S = {
  id: string;
  role_name: string;
  starts_at: string;
  ends_at: string;
  headcount: number;
  event_id: string;
  event_name: string;
  venue: string | null;
  filled: number;
  confirmed: number;
  assignees: Assignee[];
  /** Only sent to admins and coordinators who may see pay. */
  hours?: number;
  unit_cost?: number | null;
};
export type Leave = { user_id: string; name: string; starts_on: string; ends_on: string; note: string | null };
export type CalResp = { shifts: S[]; time_off: Leave[]; can_see_pay: boolean };

export type Tone = 'good' | 'warn' | 'bad';
export const toneOf = (filled: number, total: number): Tone => (filled >= total ? 'good' : filled === 0 ? 'bad' : 'warn');

export type Filters = { status: 'all' | Tone; teams: string[]; eventId: string };
export const NO_FILTERS: Filters = { status: 'all', teams: [], eventId: '' };
export const STATUS_LABEL: Record<Filters['status'], string> = { all: 'All', good: 'Fully staffed', warn: 'Partly staffed', bad: 'Unstaffed' };

export const HOUR_PX = 48;
export const DAY_MIN = 24 * 60;

export const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
export const startOfDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};
/** Monday of the week containing d. */
export const weekStart = (d: Date) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
export const isoWeek = (d: Date) => {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((+t - +y0) / 86400000 + 1) / 7);
};

export const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
export const minutesOfDay = (d: Date) => d.getHours() * 60 + d.getMinutes();
export const fmtH = (h: number) => `${Math.round(h * 10) / 10}h`;
export const fmtMoney = (n: number) => (n >= 10000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : n >= 1000 ? `$${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `$${Math.round(n)}`);
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

/** One shift cut to a single calendar day (a shift that runs past midnight continues on the next day). */
export type Seg = { shift: S; day: string; startMin: number; endMin: number; hours: number; first: boolean };

export function segments(shifts: S[]): Seg[] {
  const out: Seg[] = [];
  for (const s of shifts) {
    const a = new Date(s.starts_at);
    const b = new Date(s.ends_at);
    let day = startOfDay(a);
    let first = true;
    // Guard against runaway ranges: shifts longer than 3 days are cut off.
    for (let i = 0; i < 4 && +day < +b; i++) {
      const next = addDays(day, 1);
      const from = Math.max(+a, +day);
      const to = Math.min(+b, +next);
      if (to > from) {
        out.push({ shift: s, day: key(day), startMin: Math.round((from - +day) / 60000), endMin: Math.round((to - +day) / 60000), hours: (to - from) / 3600000, first });
      }
      first = false;
      day = next;
    }
  }
  return out;
}

/** The slice of a shift's cost that falls on this segment, for the whole headcount. */
export function segCost(seg: Seg): number | null {
  const s = seg.shift;
  if (s.unit_cost == null || !s.hours) return null;
  return s.unit_cost * (seg.hours / s.hours) * s.headcount;
}
/** Cost for one person on this segment. */
export function segCostOne(seg: Seg): number | null {
  const s = seg.shift;
  if (s.unit_cost == null || !s.hours) return null;
  return s.unit_cost * (seg.hours / s.hours);
}

/** All of one event's shifts on one day, drawn as a single card. */
export type Group = {
  id: string;
  day: string;
  event_id: string;
  name: string;
  venue: string | null;
  startMin: number;
  endMin: number;
  filled: number;
  confirmed: number;
  total: number;
  hours: number; // person-hours (hours x headcount)
  cost: number | null;
  people: { id: string; name: string }[];
  continued: boolean; // carries on from the previous day
};

export function groupByEventDay(segs: Seg[]): Group[] {
  const m = new Map<string, Group>();
  const seen = new Map<string, Set<string>>();
  for (const sg of segs) {
    const s = sg.shift;
    const k = `${sg.day}|${s.event_id}`;
    let g = m.get(k);
    if (!g) {
      g = { id: k, day: sg.day, event_id: s.event_id, name: s.event_name, venue: s.venue, startMin: sg.startMin, endMin: sg.endMin, filled: 0, confirmed: 0, total: 0, hours: 0, cost: null, people: [], continued: !sg.first };
      m.set(k, g);
      seen.set(k, new Set());
    }
    g.startMin = Math.min(g.startMin, sg.startMin);
    g.endMin = Math.max(g.endMin, sg.endMin);
    if (sg.first) g.continued = false;
    // Counts belong to the day the shift starts on; the continuation only carries the hours and cost.
    if (sg.first) {
      g.filled += Math.min(s.filled, s.headcount);
      g.confirmed += Math.min(s.confirmed, s.headcount);
      g.total += s.headcount;
    }
    g.hours += sg.hours * s.headcount;
    const c = segCost(sg);
    if (c != null) g.cost = (g.cost ?? 0) + c;
    const set = seen.get(k)!;
    for (const a of s.assignees) {
      if (!set.has(a.user_id)) {
        set.add(a.user_id);
        g.people.push({ id: a.user_id, name: a.name });
      }
    }
  }
  return [...m.values()];
}

/** Side-by-side lanes for cards that overlap in time within one day column. */
export function lanes<T extends { startMin: number; endMin: number }>(items: T[]): { item: T; lane: number; lanes: number }[] {
  const sorted = [...items].sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const out: { item: T; lane: number; lanes: number }[] = [];
  let cluster: { item: T; lane: number; lanes: number }[] = [];
  let clusterEnd = -1;
  const flush = () => {
    const n = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) c.lanes = n;
    out.push(...cluster);
    cluster = [];
  };
  for (const it of sorted) {
    if (cluster.length && it.startMin >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => c.item.endMin > it.startMin).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ item: it, lane, lanes: 1 });
    clusterEnd = Math.max(clusterEnd, it.endMin);
  }
  if (cluster.length) flush();
  return out;
}

export function applyFilters(shifts: S[], f: Filters): S[] {
  return shifts.filter((s) => {
    if (f.eventId && s.event_id !== f.eventId) return false;
    if (f.teams.length && !f.teams.includes(s.role_name)) return false;
    if (f.status !== 'all' && toneOf(s.filled, s.headcount) !== f.status) return false;
    return true;
  });
}
export const filtersActive = (f: Filters) => f.status !== 'all' || f.teams.length > 0 || !!f.eventId;
