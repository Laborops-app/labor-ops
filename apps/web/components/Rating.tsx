'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, Me } from '@/lib/api';
import { avClass, initialsOf } from '@/components/TopbarAction';
import { Banner } from '@/components/ui';

/* Crew ratings: big tap-friendly stars, quick tags, private notes. Internal to admins and labor coordinators. */

export const TAGS: { key: string; label: string; bad?: boolean }[] = [
  { key: 'on_time', label: 'On time' },
  { key: 'hard_worker', label: 'Hard worker' },
  { key: 'skilled', label: 'Skilled' },
  { key: 'team_player', label: 'Team player' },
  { key: 'safe', label: 'Works safely' },
  { key: 'rehire', label: 'Would rehire' },
  { key: 'late', label: 'Late', bad: true },
  { key: 'left_early', label: 'Left early', bad: true },
  { key: 'no_show', label: 'No-show', bad: true },
  { key: 'needs_supervision', label: 'Needs supervision', bad: true },
  { key: 'safety', label: 'Safety concern', bad: true },
  { key: 'no_rehire', label: 'Do not rehire', bad: true },
];
const TAG = Object.fromEntries(TAGS.map((t) => [t.key, t]));
export const STAR_WORDS = ['', 'Poor', 'Below average', 'Good', 'Very good', 'Excellent'];
const title = (k: string) => k.replace(/\b\w/g, (m) => m.toUpperCase());
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
const shiftWhen = (s: string, e: string) => {
  const a = new Date(s), b = new Date(e);
  const t = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${a.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${t(a)} – ${t(b)}`;
};

const StarSvg = ({ size }: { size: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.8l2.83 5.74 6.33.92-4.58 4.47 1.08 6.3L12 17.25l-5.66 2.98 1.08-6.3L2.84 9.46l6.33-.92z" fill="currentColor" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

/** Five stars to pick a rating. Hover previews, arrow keys move, the word for the rating shows beside them. */
export function StarInput({ value, onChange, size = 28, label, disabled, showWord = true }: { value: number | null | undefined; onChange: (n: number) => void; size?: number; label: string; disabled?: boolean; showWord?: boolean }) {
  const [hover, setHover] = useState(0);
  const shown = hover || value || 0;
  const key = (e: React.KeyboardEvent, n: number) => {
    const next = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? Math.min(5, n + 1) : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? Math.max(1, n - 1) : 0;
    if (!next) return;
    e.preventDefault();
    onChange(next);
    (e.currentTarget.parentElement?.children[next - 1] as HTMLElement | undefined)?.focus();
  };
  return (
    <span className="rt-input">
      <span className="rt-stars" role="radiogroup" aria-label={label} onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            aria-checked={value === n}
            aria-label={`${n} star${n > 1 ? 's' : ''}, ${STAR_WORDS[n]}`}
            tabIndex={(value || 1) === n ? 0 : -1}
            disabled={disabled}
            className={`rt-star ${n <= shown ? 'on' : ''} ${hover && n <= hover ? 'preview' : ''}`}
            onMouseEnter={() => !disabled && setHover(n)}
            onClick={() => onChange(n)}
            onKeyDown={(e) => key(e, n)}
          >
            <StarSvg size={size} />
          </button>
        ))}
      </span>
      {showWord && <span className={`rt-word ${shown ? '' : 'muted'}`}>{shown ? STAR_WORDS[shown] : 'Not rated'}</span>}
    </span>
  );
}

/** Read-only stars filled to the exact average (4.3 fills 4 and a third), with the number and review count. */
export function StarMeter({ value, count, size = 16, compact }: { value: number | null | undefined; count?: number; size?: number; compact?: boolean }) {
  if (!value) return <span className="muted small">Not rated</span>;
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));
  return (
    <span className="rt-meter" title={`${value.toFixed(1)} of 5${count != null ? ` from ${count} review${count === 1 ? '' : 's'}` : ''}`}>
      {!compact && (
        <span className="rt-meter-stars" style={{ fontSize: size }} aria-hidden="true">
          <span className="rt-meter-bg">{[0, 1, 2, 3, 4].map((i) => <StarSvg key={i} size={size} />)}</span>
          <span className="rt-meter-fg" style={{ width: `${pct}%` }}>{[0, 1, 2, 3, 4].map((i) => <StarSvg key={i} size={size} />)}</span>
        </span>
      )}
      {compact && <span className="rt-meter-one" aria-hidden="true"><StarSvg size={size} /></span>}
      <b>{value.toFixed(1)}</b>
      {count != null && <span className="muted">({count})</span>}
    </span>
  );
}

/** Quick tags: good ones first, then the ones that flag a problem. */
export function TagPicker({ value, onChange, disabled }: { value: string[]; onChange: (t: string[]) => void; disabled?: boolean }) {
  return (
    <div className="rt-tags" role="group" aria-label="Quick tags">
      {TAGS.map((t) => {
        const on = value.includes(t.key);
        return (
          <button key={t.key} type="button" disabled={disabled} aria-pressed={on} className={`rt-tag ${t.bad ? 'bad' : 'good'} ${on ? 'on' : ''}`} onClick={() => onChange(on ? value.filter((x) => x !== t.key) : [...value, t.key])}>
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export const TagChips = ({ tags }: { tags: string[] }) =>
  tags.length ? (
    <span className="rt-chips">
      {tags.map((k) => (
        <span key={k} className={`rt-tag static ${TAG[k]?.bad ? 'bad' : 'good'} on`}>{TAG[k]?.label ?? k}</span>
      ))}
    </span>
  ) : null;

/* ---------- one person's ratings (crew list modal and profile page) ---------- */

type Review = { id: string; role_key: string; stars: number; tags: string[]; note: string | null; shift_id: string | null; event_id: string | null; event_name: string | null; shift_starts_at: string | null; shift_role: string | null; rated_by: string | null; rated_by_name: string | null; created_at: string; updated_at: string };
type Summary = { role_key: string; avg: number; count: number; fives: number };
type Reviews = { member: { id: string; name: string; skills: string[] }; summary: Summary[]; reviews: Review[]; overall: { avg: number | null; count: number } };

function ReviewForm({ positions, initial, onSave, onCancel, saveLabel }: { positions: string[]; initial?: { role: string; stars: number; tags: string[]; note: string }; onSave: (v: { role: string; stars: number; tags: string[]; note: string }) => Promise<void>; onCancel?: () => void; saveLabel: string }) {
  const [v, setV] = useState(initial ?? { role: positions[0] ?? '', stars: 0, tags: [] as string[], note: '' });
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState(!positions.length);
  return (
    <form
      className="rt-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!v.stars || !v.role.trim()) return;
        setBusy(true);
        try {
          await onSave(v);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="rt-form-row">
        <label className="rt-pos">
          <span className="small muted">Position</span>
          {custom ? (
            <input value={v.role} onChange={(e) => setV({ ...v, role: e.target.value })} placeholder="e.g. Stagehand" maxLength={100} required autoFocus={!positions.length} />
          ) : (
            <select value={v.role} onChange={(e) => (e.target.value === '__other' ? (setCustom(true), setV({ ...v, role: '' })) : setV({ ...v, role: e.target.value }))}>
              {positions.map((p) => <option key={p} value={p}>{p}</option>)}
              <option value="__other">Another position…</option>
            </select>
          )}
        </label>
        <div>
          <span className="small muted" style={{ display: 'block', marginBottom: 2 }}>Rating</span>
          <StarInput value={v.stars} onChange={(n) => setV({ ...v, stars: n })} label="Rating" size={30} />
        </div>
      </div>
      <TagPicker value={v.tags} onChange={(tags) => setV({ ...v, tags })} />
      <textarea value={v.note} onChange={(e) => setV({ ...v, note: e.target.value })} placeholder="Private note (optional): what went well, what to watch for" rows={2} maxLength={1000} />
      <div className="rt-form-acts">
        {onCancel && <button type="button" className="btn ghost small" onClick={onCancel}>Cancel</button>}
        <button className="btn primary small" disabled={busy || !v.stars || !v.role.trim()}>{busy ? 'Saving…' : saveLabel}</button>
        {!v.stars && <span className="muted small">Pick 1 to 5 stars</span>}
      </div>
    </form>
  );
}

/** Per-position averages, a form to add a review, and every review with who wrote it and for which event. */
export function CrewReviews({ me, memberId, onChange, startAdding }: { me: Me; memberId: string; onChange?: (ratings: Record<string, number>) => void; startAdding?: boolean }) {
  const [d, setD] = useState<Reviews | null>(null);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState(!!startAdding);
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const load = useCallback(() => api<Reviews>(`/api/crew/${memberId}/reviews`).then(setD).catch((e) => setErr(e.message)), [memberId]);
  useEffect(() => {
    load();
  }, [load]);
  const changed = (r: { ratings: Record<string, number> }) => {
    onChange?.(r.ratings);
    return load();
  };
  if (!d) return err ? <Banner>{err}</Banner> : <div className="muted small">Loading…</div>;
  const positions = [...new Set([...d.member.skills, ...d.summary.map((s) => title(s.role_key))])];
  const shown = filter ? d.reviews.filter((r) => r.role_key === filter) : d.reviews;
  const canEdit = (r: Review) => me.role === 'admin' || r.rated_by === me.id;
  return (
    <div className="rt-box">
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      <div className="rt-overview">
        <div className="rt-big">
          <span className="rt-big-n">{d.overall.avg ? d.overall.avg.toFixed(1) : '–'}</span>
          <StarMeter value={d.overall.avg} size={18} />
          <span className="muted small">{d.overall.count ? `${d.overall.count} review${d.overall.count === 1 ? '' : 's'}` : 'No reviews yet'}</span>
        </div>
        <div className="rt-pos-list">
          {d.summary.length === 0 && <span className="muted small">Ratings are kept per position, so a great stagehand can still be a new rigger.</span>}
          {d.summary.map((s) => (
            <button key={s.role_key} type="button" className={`rt-pos-row ${filter === s.role_key ? 'on' : ''}`} onClick={() => setFilter(filter === s.role_key ? null : s.role_key)} aria-pressed={filter === s.role_key} title="Show only these reviews">
              <span className="rt-pos-name">{title(s.role_key)}</span>
              <span className="rt-bar" aria-hidden="true"><i style={{ width: `${(s.avg / 5) * 100}%` }} /></span>
              <StarMeter value={s.avg} count={s.count} compact size={14} />
            </button>
          ))}
        </div>
      </div>

      {adding ? (
        <ReviewForm
          positions={positions}
          saveLabel="Save review"
          onCancel={() => setAdding(false)}
          onSave={async (v) => {
            try {
              await changed(await api(`/api/crew/${memberId}/reviews`, { body: { role: v.role, stars: v.stars, tags: v.tags, note: v.note || null } }));
              setAdding(false);
            } catch (e: any) {
              setErr(e.message);
            }
          }}
        />
      ) : (
        <button type="button" className="btn primary small rt-add" onClick={() => setAdding(true)}>★ Add a rating</button>
      )}

      <div className="rt-list-head">
        <b>{filter ? `${title(filter)} reviews` : 'All reviews'}</b>
        {filter && <button type="button" className="btn ghost small" onClick={() => setFilter(null)}>Show all</button>}
      </div>
      {shown.length === 0 && <div className="muted small">Nothing yet. Rate them after their next shift, or add a rating above.</div>}
      <ul className="rt-list">
        {shown.map((r) =>
          editing === r.id ? (
            <li key={r.id}>
              <ReviewForm
                positions={positions.includes(title(r.role_key)) ? positions : [title(r.role_key), ...positions]}
                initial={{ role: title(r.role_key), stars: r.stars, tags: r.tags, note: r.note ?? '' }}
                saveLabel="Save changes"
                onCancel={() => setEditing(null)}
                onSave={async (v) => {
                  try {
                    await changed(await api(`/api/reviews/${r.id}`, { method: 'PATCH', body: { role: v.role, stars: v.stars, tags: v.tags, note: v.note || null } }));
                    setEditing(null);
                  } catch (e: any) {
                    setErr(e.message);
                  }
                }}
              />
            </li>
          ) : (
            <li key={r.id} className="rt-item">
              <div className="rt-item-top">
                <StarMeter value={r.stars} size={15} />
                <b>{title(r.role_key)}</b>
                <span className="muted small">
                  {r.event_name ? <>· {r.event_name}{r.shift_starts_at ? `, ${shortDate(r.shift_starts_at)}` : ''}</> : '· General rating'}
                </span>
                {canEdit(r) && (
                  <span className="rt-item-acts">
                    <button type="button" className="btn ghost small" onClick={() => setEditing(r.id)}>Edit</button>
                    <button type="button" className="btn ghost small danger" onClick={async () => { if (confirm('Delete this review?')) { try { await changed(await api(`/api/reviews/${r.id}`, { method: 'DELETE' })); } catch (e: any) { setErr(e.message); } } }}>Delete</button>
                  </span>
                )}
              </div>
              <TagChips tags={r.tags} />
              {r.note && <p className="rt-note">{r.note}</p>}
              <div className="muted small">{r.rated_by_name ?? 'Former coordinator'} · {shortDate(r.updated_at)}</div>
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

/* ---------- rate everyone who worked an event ---------- */

type Worker = {
  shift_id: string; role_name: string; starts_at: string; ends_at: string; ended: boolean; user_id: string; user_name: string; worked: boolean;
  position_avg: number | null; position_reviews: number; review_id: string | null; stars: number | null; tags: string[] | null; note: string | null; rated_by: string | null; rated_by_name: string | null;
};
type EventReviews = { workers: Worker[]; rated: number; total: number; ended: number };

function WorkerRow({ me, eventId, w, onSaved }: { me: Me; eventId: string; w: Worker; onSaved: (w: Worker) => void }) {
  const [v, setV] = useState({ stars: w.stars ?? 0, tags: w.tags ?? [], note: w.note ?? '' });
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState('');
  const [noteOpen, setNoteOpen] = useState(!!w.note);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const locked = !!w.rated_by && w.rated_by !== me.id && me.role !== 'admin';
  const save = async (next: typeof v) => {
    setState('saving');
    try {
      const r = await api<{ reviewId: string | null; positionAvg: number | null; positionReviews: number }>(`/api/events/${eventId}/reviews`, {
        method: 'PUT',
        body: { shiftId: w.shift_id, userId: w.user_id, stars: next.stars || null, tags: next.tags, note: next.note || null },
      });
      setState('saved');
      onSaved({ ...w, review_id: r.reviewId, stars: next.stars || null, tags: next.tags, note: next.note || null, position_avg: r.positionAvg, position_reviews: r.positionReviews, rated_by: r.reviewId ? w.rated_by ?? me.id : null });
    } catch (e: any) {
      setState('error');
      setMsg(e.message);
    }
  };
  const change = (next: typeof v, delay = 0) => {
    setV(next);
    if (!next.stars) return;
    if (timer.current) clearTimeout(timer.current);
    if (delay) timer.current = setTimeout(() => save(next), delay);
    else save(next);
  };
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  return (
    <li className={`rt-worker ${v.stars ? 'done' : ''}`}>
      <div className="rt-worker-top">
        <span className={avClass(w.user_name)} aria-hidden="true" style={{ width: 40, height: 40, fontSize: 14 }}>{initialsOf(w.user_name)}</span>
        <span className="rt-worker-who">
          <b>{w.user_name}</b>
          <span className="muted small">
            {w.position_avg ? <>★ {w.position_avg.toFixed(1)} as {w.role_name.replace(/\s*\(.*\)\s*$/, '')} · {w.position_reviews} review{w.position_reviews === 1 ? '' : 's'}</> : `First rating as ${w.role_name.replace(/\s*\(.*\)\s*$/, '')}`}
            {!w.worked && w.ended && ' · no hours logged'}
          </span>
        </span>
        <StarInput value={v.stars} onChange={(n) => change({ ...v, stars: n })} label={`Rate ${w.user_name}`} size={30} disabled={locked} />
        <span className={`rt-status ${state}`} aria-live="polite">
          {locked ? `Rated by ${w.rated_by_name}` : state === 'saving' ? 'Saving…' : state === 'saved' ? '✓ Saved' : state === 'error' ? msg || 'Not saved' : ''}
        </span>
      </div>
      {!!v.stars && !locked && (
        <div className="rt-worker-more">
          <TagPicker value={v.tags} onChange={(tags) => change({ ...v, tags })} />
          {noteOpen ? (
            <textarea value={v.note} onChange={(e) => change({ ...v, note: e.target.value }, 900)} onBlur={() => { if (timer.current) { clearTimeout(timer.current); timer.current = null; save(v); } }} placeholder="Private note (optional)" rows={2} maxLength={1000} autoFocus={!w.note} />
          ) : (
            <span className="rt-worker-links">
              <button type="button" className="rt-link" onClick={() => setNoteOpen(true)}>+ Add a note</button>
              <button type="button" className="rt-link quiet" onClick={() => { setV({ stars: 0, tags: [], note: '' }); save({ stars: 0, tags: [], note: '' }); }}>Clear rating</button>
            </span>
          )}
        </div>
      )}
      {locked && (v.tags.length > 0 || v.note) && (
        <div className="rt-worker-more"><TagChips tags={v.tags} />{v.note && <p className="rt-note">{v.note}</p>}</div>
      )}
    </li>
  );
}

export function EventRatings({ me, eventId, onProgress }: { me: Me; eventId: string; onProgress?: (rated: number, total: number) => void }) {
  const [d, setD] = useState<EventReviews | null>(null);
  const [err, setErr] = useState('');
  const [onlyOpen, setOnlyOpen] = useState(false);
  const [frozen, setFrozen] = useState<Set<string>>(new Set());
  useEffect(() => {
    api<EventReviews>(`/api/events/${eventId}/reviews`).then((r) => {
      setD(r);
      setOnlyOpen(r.rated > 0 && r.rated < r.total);
      setFrozen(new Set(r.workers.filter((w) => !w.review_id).map((w) => w.shift_id + w.user_id)));
    }).catch((e) => setErr(e.message));
  }, [eventId]);
  if (!d) return err ? <Banner>{err}</Banner> : <div className="muted small">Loading…</div>;
  if (!d.total) return <div className="muted" style={{ padding: '12px 0' }}>Nobody has accepted a shift on this event yet. Once crew have worked it, you can rate them here.</div>;
  const rated = d.workers.filter((w) => w.review_id).length;
  // "Not rated yet" keeps a row visible after you rate it, until the drawer is reopened, so it does not jump away mid-edit.
  const shown = onlyOpen ? d.workers.filter((w) => frozen.has(w.shift_id + w.user_id)) : d.workers;
  const shifts = [...new Map(shown.map((w) => [w.shift_id, w])).values()];
  const update = (w: Worker) => {
    const workers = d.workers.map((x) => (x.shift_id === w.shift_id && x.user_id === w.user_id ? w : x));
    const n = workers.filter((x) => x.review_id).length;
    setD({ ...d, workers, rated: n });
    onProgress?.(n, d.total);
  };
  return (
    <div className="rt-event">
      <div className="rt-progress">
        <div className="rt-progress-top">
          <b>{rated} of {d.total} rated</b>
          <span className="phase-tabs" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={!onlyOpen} className={!onlyOpen ? 'tab on' : 'tab'} onClick={() => setOnlyOpen(false)}>Everyone</button>
            <button type="button" role="tab" aria-selected={onlyOpen} className={onlyOpen ? 'tab on' : 'tab'} onClick={() => setOnlyOpen(true)}>Not rated yet</button>
          </span>
        </div>
        <span className="rt-bar big" aria-hidden="true"><i style={{ width: `${(rated / d.total) * 100}%` }} /></span>
        <span className="muted small">Tap the stars to rate; it saves straight away. Ratings are private to admins and labor coordinators and help rank people when you fill shifts.</span>
      </div>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {shown.length === 0 && <div className="muted" style={{ padding: '12px 0' }}>Everyone on this event has a rating. 🎉</div>}
      {shifts.map((s) => (
        <section key={s.shift_id} className="rt-shift">
          <div className="rt-shift-head">
            <b>{s.role_name}</b>
            <span className="muted small">{shiftWhen(s.starts_at, s.ends_at)}{!s.ended && ' · not finished yet'}</span>
          </div>
          <ul className="rt-workers">
            {shown.filter((w) => w.shift_id === s.shift_id).map((w) => (
              <WorkerRow key={w.shift_id + w.user_id} me={me} eventId={eventId} w={w} onSaved={update} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
