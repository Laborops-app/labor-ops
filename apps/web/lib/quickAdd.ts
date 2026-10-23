/**
 * Quick-add: "10 stagehands 8a-4p, 4 riggers 7:30a-3:30p" → positions. One position per comma, semicolon or line.
 * The role is matched to the company's roles (plural or singular, any case); times are 12- or 24-hour.
 */
export type QuickRow = { role: string; count: number; start: string; end: string; known: boolean; raw: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const singular = (s: string) => s.replace(/ies$/, 'y').replace(/(ch|sh|x|s)es$/, '$1').replace(/s$/, '');

export function matchRole(text: string, roles: string[]): { role: string; known: boolean } {
  const t = norm(text);
  if (!t) return { role: '', known: false };
  const want = t.split(' ').map(singular).join(' ');
  for (const r of roles) {
    const n = norm(r);
    if (n === t || n.split(' ').map(singular).join(' ') === want) return { role: r, known: true };
  }
  // "hands" → "Stage Hand" is too loose; but "a1" → "Audio A1" (the role ends with the words typed) is fine.
  const ends = roles.filter((r) => norm(r).split(' ').map(singular).join(' ').endsWith(` ${want}`));
  if (ends.length === 1) return { role: ends[0], known: true };
  return { role: text.trim().replace(/\s+/g, ' ').replace(/^./, (c) => c.toUpperCase()), known: false };
}

const pad = (n: number) => String(n).padStart(2, '0');
type T = { h: number; m: number; ap: 'a' | 'p' | null };
const to24 = (t: T, ap: 'a' | 'p' | null) => {
  let h = t.h % 12;
  if (ap === 'p') h += 12;
  if (!ap) h = t.h % 24;
  return h * 60 + t.m;
};

/** "8a-4p", "7:30am - 3:30pm", "8-6", "22:00-06:00" → ["08:00", "16:00"]. Null if there is no time range. */
export function parseRange(s: string): { start: string; end: string; rest: string } | null {
  const re = /(\d{1,2})(?::?(\d{2}))?\s*(a|am|p|pm)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::?(\d{2}))?\s*(a|am|p|pm)?\s*$/i;
  const m = s.match(re);
  if (!m) return null;
  const a: T = { h: +m[1], m: +(m[2] ?? 0), ap: m[3] ? (m[3][0].toLowerCase() as 'a' | 'p') : null };
  const b: T = { h: +m[4], m: +(m[5] ?? 0), ap: m[6] ? (m[6][0].toLowerCase() as 'a' | 'p') : null };
  if (a.h > 24 || b.h > 24 || a.m > 59 || b.m > 59) return null;
  let s1: number, e1: number;
  if (a.ap || b.ap) {
    // "8-4p": the start takes the end's am/pm unless that puts it after the end (then it's morning).
    const apA = a.ap ?? (b.ap && to24(a, b.ap) < to24(b, b.ap) ? b.ap : 'a');
    const apB = b.ap ?? apA;
    s1 = to24(a, apA);
    e1 = to24(b, apB);
  } else {
    s1 = to24(a, null);
    e1 = to24(b, null);
    // "8-6" means 8 am to 6 pm.
    if (e1 <= s1 && b.h <= 12 && b.h + 12 < 24 && (b.h + 12) * 60 + b.m > s1) e1 += 12 * 60;
  }
  const f = (x: number) => `${pad(Math.floor(x / 60) % 24)}:${pad(x % 60)}`;
  return { start: f(s1), end: f(e1), rest: s.slice(0, m.index).trim() };
}

export function parseQuickAdd(text: string, roles: string[], fallback: (role: string) => { start: string; end: string }): QuickRow[] {
  return text
    .split(/[,;\n]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((raw) => {
      let rest = raw;
      let start = '', end = '';
      const r = parseRange(rest);
      if (r) ({ start, end, rest } = r);
      let count = 1;
      const lead = rest.match(/^(\d{1,3})\s*(?:x\s+)?/i);
      const tail = rest.match(/\s*(?:x|×)\s*(\d{1,3})$/i);
      if (lead) {
        count = +lead[1];
        rest = rest.slice(lead[0].length);
      } else if (tail) {
        count = +tail[1];
        rest = rest.slice(0, tail.index);
      }
      rest = rest.replace(/\s+(?:from|at|@)$/i, '').trim();
      const m = matchRole(rest, roles);
      if (!start) ({ start, end } = fallback(m.role));
      return { role: m.role, count: Math.max(1, Math.min(500, count)), start, end, known: m.known, raw };
    })
    .filter((x) => x.role);
}
