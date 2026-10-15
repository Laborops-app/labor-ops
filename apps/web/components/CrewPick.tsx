'use client';
import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * kind: ok = can work it · busy = already on another shift that day · soft = time off / outside availability
 * (needs an override) · blocked = missing a required certificate.
 */
export type PickOption = { id: string; name: string; sub?: string; stars?: number; kind?: 'ok' | 'busy' | 'soft' | 'blocked'; note?: string; flag?: string };

// ---------- "guess what you're typing" ----------
const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
/** Edit distance with a cap (adjacent swaps count as one), for small typos like "jrodan" or "rivra". */
function near(a: string, b: string, max: number) {
  if (Math.abs(a.length - b.length) > max) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= max;
}
/** How well a name matches what was typed (0 = not at all). */
export function matchScore(name: string, sub: string | undefined, typed: string): number {
  const q = norm(typed);
  if (!q) return 1;
  const n = norm(name);
  const words = n.split(' ');
  const qs = q.split(' ');
  if (n.startsWith(q)) return 100;
  if (words.some((w) => w.startsWith(q))) return 90;
  if (qs.length > 1 && qs.every((t) => words.some((w) => w.startsWith(t)))) return 85;
  if (!q.includes(' ') && q.length >= 2 && words.map((w) => w[0]).join('').startsWith(q)) return 80; // initials: "jr" → Jordan Rivera
  if (n.includes(q)) return 70;
  const typo = (t: string) => t.length >= 3 && words.some((w) => near(t, w.slice(0, Math.max(t.length, Math.min(w.length, t.length + 1))), t.length >= 6 ? 2 : 1) || near(t, w, t.length >= 6 ? 2 : 1));
  if (qs.every(typo)) return 60;
  if (sub && norm(sub).includes(q)) return 40; // a skill ("audio")
  let i = 0;
  for (const ch of n.replace(/ /g, '')) if (ch === q.replace(/ /g, '')[i]) i++;
  if (i === q.replace(/ /g, '').length && q.length >= 3) return 20; // letters in order
  return 0;
}

const Stars = ({ v }: { v?: number }) =>
  v ? <span className="rt-inline" title={`Rated ${v.toFixed(1)} of 5 for this position`}>★ {v.toFixed(1)}</span> : <span className="pick-unrated" title="No rating for this position yet">☆ new</span>;

/** Highlights the part of the name that matches what was typed. */
function Hl({ name, q }: { name: string; q: string }) {
  const t = q.trim().toLowerCase();
  const i = t ? name.toLowerCase().indexOf(t) : -1;
  if (i < 0) return <>{name}</>;
  return <>{name.slice(0, i)}<mark>{name.slice(i, i + t.length)}</mark>{name.slice(i + t.length)}</>;
}

const LABEL: Record<NonNullable<PickOption['kind']>, string> = {
  ok: '',
  busy: 'Already on a shift that day',
  soft: 'Not available (needs override)',
  blocked: 'Missing certificate',
};

/**
 * Search-as-you-type crew list, best rated first. Typing guesses who you mean (start of a name, initials, small typos);
 * Enter adds the top match, Tab completes it, arrow keys move. People who are booked that day, not available or missing a
 * certificate are tucked away under "Show unavailable". The list stays open so several people can be added in a row.
 */
export default function CrewPick({ options, onPick, onClose, title = 'Add crew', busy, extra, loading }: { options: PickOption[]; onPick: (o: PickOption) => void; onClose: () => void; title?: string; busy?: boolean; extra?: React.ReactNode; loading?: boolean }) {
  const [q, setQ] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const out = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [onClose]);

  const ranked = useMemo(
    () =>
      options
        .map((o, i) => ({ o, i, s: matchScore(o.name, o.sub, q) }))
        .filter((x) => x.s > 0)
        // Best match first while typing; otherwise best rated first (the order given keeps flagged people last).
        .sort((a, b) => (q.trim() ? b.s - a.s : 0) || (b.o.stars ?? 0) - (a.o.stars ?? 0) || a.i - b.i)
        .map((x) => x.o),
    [options, q],
  );
  const ok = ranked.filter((o) => (o.kind ?? 'ok') === 'ok');
  const hidden = ranked.filter((o) => (o.kind ?? 'ok') !== 'ok');
  // Unavailable people show when asked for, or when what you typed only matches them.
  const showHidden = showAll || (!!q.trim() && ok.length === 0);
  const groups: [NonNullable<PickOption['kind']>, PickOption[]][] = [['ok', ok]];
  if (showHidden) for (const k of ['busy', 'soft', 'blocked'] as const) groups.push([k, hidden.filter((o) => o.kind === k)]);
  const pickable = groups.flatMap(([, l]) => l).filter((o) => o.kind !== 'blocked');
  const top = pickable[Math.min(active, pickable.length - 1)];
  // The suggested completion shown greyed after what you typed.
  const guess = q && top && top.name.toLowerCase().startsWith(q.toLowerCase()) ? top.name.slice(q.length) : '';
  useEffect(() => setActive(0), [q, showAll]);
  useEffect(() => {
    list.current?.querySelector('.crew-pick-item.on')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (o: PickOption | undefined) => {
    if (!o || busy || o.kind === 'blocked') return;
    onPick(o);
    setQ('');
  };
  const key = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') return onClose();
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, pickable.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(top); }
    else if ((e.key === 'Tab' || e.key === 'ArrowRight') && guess && e.currentTarget.selectionStart === q.length) { e.preventDefault(); setQ(q + guess); }
  };

  return (
    <div className="crew-pick" ref={box} role="dialog" aria-label={title}>
      <div className="row space" style={{ marginBottom: 6 }}>
        <b className="small">{title}</b>
        <button type="button" className="chip-x" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <div className="pick-search">
        <span className="pick-ghost" aria-hidden="true"><span>{q}</span>{guess}</span>
        <input
          autoFocus
          placeholder="Type a name…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={key}
          aria-label="Search crew"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="both"
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      {q && top && <div className="pick-hint muted small">Enter adds <b>{top.name}</b>{guess ? ' · Tab completes' : ''}</div>}
      {extra}
      <div className="crew-pick-list" ref={list} role="listbox">
        {loading && <div className="muted small" style={{ padding: 8 }}>Checking who is free…</div>}
        {!loading && ranked.length === 0 && <div className="muted small" style={{ padding: 8 }}>No one matches “{q}”.</div>}
        {!loading && !q && ok.length === 0 && hidden.length > 0 && !showAll && <div className="muted small" style={{ padding: 8 }}>Nobody is free for this shift.</div>}
        {groups.map(([k, l]) => {
          if (!l.length) return null;
          return (
            <div key={k}>
              {LABEL[k] && <div className="crew-pick-head">{LABEL[k]}</div>}
              {l.map((o) => {
                const on = o === top;
                return (
                  <button key={o.id} type="button" role="option" aria-selected={on} className={`crew-pick-item${on ? ' on' : ''}`} disabled={busy || k === 'blocked'} onClick={() => choose(o)} onMouseEnter={() => { const i = pickable.indexOf(o); if (i >= 0) setActive(i); }}>
                    <span className="pick-name">
                      <b aria-hidden="true">+</b> <Hl name={o.name} q={q} /> <Stars v={o.stars} />
                      {o.flag ? <span className="rt-flag pick" title={`Tagged in past reviews: ${o.flag}. You will be asked to confirm.`}>⚠ {o.flag}</span> : null}
                    </span>
                    <span className="muted small pick-sub">{o.note ?? o.sub}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      {!q && hidden.length > 0 && (
        <button type="button" className="rt-link pick-more" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Hide unavailable' : `Show unavailable (${hidden.length})`}
        </button>
      )}
    </div>
  );
}
