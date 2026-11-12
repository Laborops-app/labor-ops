'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { askConfirm } from '@/components/Toasts';

type Cfg = { topN: number; wait1Min: number; wave2: boolean; wait2Min: number; wave3: boolean; answerByHours: number; remindAfterMin: number; rollOnDecline: boolean };
type Offer = { user_id: string; name: string; wave: number; offered_at: string; reminded_at: string | null; note: string | null; state: 'waiting' | 'accepted' | 'declined' | 'expired' | 'removed' | 'skipped' };
type Data = {
  shift: { role_name: string; starts_at: string; ends_at: string; headcount: number; taken: number; confirmed: number; is_open: boolean; staffing_draft: boolean };
  plan: { id: string; status: 'active' | 'paused' | 'done'; wave: number; config: Cfg; next_at: string | null; answer_by: string; finished_reason: string | null } | null;
  defaults: Cfg;
  offers: Offer[];
  preview: { qualified: number; top: { name: string; stars: number; week_hours: number; overtime: boolean }[] };
};
const WAITS: [number, string][] = [[30, '30 minutes'], [60, '1 hour'], [120, '2 hours'], [240, '4 hours'], [720, '12 hours'], [1440, '1 day']];
const when = (iso: string) => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const STATE: Record<Offer['state'], [string, string]> = {
  waiting: ['Waiting', 'wait'], accepted: ['Yes', 'ok'], declined: ['No', 'no'], expired: ['No answer', 'plan'], removed: ['Removed', 'plan'], skipped: ['Skipped', 'plan'],
};

/** Offer waves for one shift: set the plan once, then watch it run. */
export default function WavePanel({ shiftId, onChanged }: { shiftId: string; onChanged: () => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [saveDefault, setSaveDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const load = useCallback(
    // Wave 1 always asks at least as many people as there are open spots.
    () => api<Data>(`/api/shifts/${shiftId}/waves`).then((x) => { setD(x); setCfg((c) => c ?? x.plan?.config ?? { ...x.defaults, topN: Math.max(x.defaults.topN, x.shift.headcount - x.shift.taken) }); }).catch((e) => setErr(e.message)),
    [shiftId],
  );
  useEffect(() => { load(); }, [load]);
  // While a plan is running, refresh so answers show up without reloading.
  useEffect(() => {
    if (d?.plan?.status !== 'active') return;
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [d?.plan?.status, load]);
  if (!d || !cfg) return err ? <p className="error" role="alert">{err}</p> : <p className="muted">Loading…</p>;
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); onChanged(); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const set = (p: Partial<Cfg>) => setCfg({ ...cfg, ...p });
  const running = d.plan && d.plan.status !== 'done';
  const open = d.shift.headcount - d.shift.taken;
  const waits = (v: number) => (WAITS.some(([m]) => m === v) ? WAITS : [...WAITS, [v, `${v} minutes`] as [number, string]]);
  const count = (s: Offer['state']) => d.offers.filter((o) => o.state === s).length;
  return (
    <div className="wave">
      <p className="muted" style={{ margin: '0 0 12px' }}>
        {d.shift.role_name} · {when(d.shift.starts_at)} to {time(d.shift.ends_at)} · {d.shift.headcount} needed, {d.shift.confirmed} confirmed{open > 0 ? `, ${open} open` : ''}.
        {' '}Offers only go out for spots that are still open.
      </p>
      {err && <p className="error" role="alert">{err}</p>}
      {d.shift.staffing_draft && !running && <p className="banner warn">This event is being built quietly. Publish the crew first, then start waves.</p>}
      <div className="wave-cols">
        <fieldset disabled={!!running || busy} className="wave-setup">
          <div className="wave-step">
            <span className="wave-n">1</span>
            <div>
              <b>Best rated</b>
              <div className="wave-fields">
                <label>Who
                  <select value={cfg.topN} onChange={(e) => set({ topN: Number(e.target.value) })}>
                    {[...new Set([open, 5, 10, 15, 20, 30, cfg.topN])].filter((n) => n >= Math.max(1, open)).sort((a, b) => a - b).map((n) => <option key={n} value={n}>Top {n} rated{n === open ? ' (one per open spot)' : ''}</option>)}
                  </select>
                </label>
                <label>Time to answer
                  <select value={cfg.wait1Min} onChange={(e) => set({ wait1Min: Number(e.target.value) })}>{waits(cfg.wait1Min).map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>
                </label>
              </div>
            </div>
          </div>
          <div className={`wave-step${cfg.wave2 ? '' : ' off'}`}>
            <span className="wave-n">2</span>
            <div>
              <label className="check"><input type="checkbox" checked={cfg.wave2} onChange={(e) => set({ wave2: e.target.checked })} /> <b>Everyone else who qualifies</b></label>
              {cfg.wave2 && (
                <div className="wave-fields">
                  <label>Time to answer
                    <select value={cfg.wait2Min} onChange={(e) => set({ wait2Min: Number(e.target.value) })}>{waits(cfg.wait2Min).map(([m, l]) => <option key={m} value={m}>{l}</option>)}</select>
                  </label>
                </div>
              )}
            </div>
          </div>
          <div className={`wave-step${cfg.wave3 ? '' : ' off'}`}>
            <span className="wave-n">3</span>
            <div>
              <label className="check"><input type="checkbox" checked={cfg.wave3} onChange={(e) => set({ wave3: e.target.checked })} /> <b>Open shift</b></label>
              <div className="muted small">Anyone qualified can claim what’s still open.</div>
            </div>
          </div>
          <div className="wave-fields" style={{ marginTop: 12 }}>
            <label>Answer by
              <select value={cfg.answerByHours} onChange={(e) => set({ answerByHours: Number(e.target.value) })}>
                {[...new Set([2, 6, 12, 24, 48, 72, cfg.answerByHours])].sort((a, b) => a - b).map((h) => <option key={h} value={h}>{h < 48 ? `${h} h before the shift` : `${h / 24} days before the shift`}</option>)}
              </select>
            </label>
            <label>Remind people who haven’t answered
              <select value={cfg.remindAfterMin} onChange={(e) => set({ remindAfterMin: Number(e.target.value) })}>
                <option value={0}>Don’t remind</option>
                {[30, 60, 120, 240].map((m) => <option key={m} value={m}>After {m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : `${m / 60} hours`}</option>)}
              </select>
            </label>
          </div>
          <label className="check" style={{ marginTop: 10 }}><input type="checkbox" checked={cfg.rollOnDecline} onChange={(e) => set({ rollOnDecline: e.target.checked })} /> When someone says no, offer the next person right away</label>
          {!running && <label className="check"><input type="checkbox" checked={saveDefault} onChange={(e) => setSaveDefault(e.target.checked)} /> Use these settings as the default for other shifts</label>}
        </fieldset>
        <div className="wave-live">
          {d.plan ? (
            <>
              <div className="evh-num"><b>{d.shift.confirmed}</b><span> / {d.shift.headcount} confirmed</span></div>
              <p className="small" style={{ margin: '6px 0 10px' }}>
                {d.plan.status === 'done'
                  ? <><b>Finished.</b> {d.plan.finished_reason}</>
                  : d.plan.status === 'paused'
                    ? <><b>Paused</b> on wave {d.plan.wave}. Nothing is sent or withdrawn until you carry on.</>
                    : <><b>Wave {d.plan.wave}</b> · {d.offers.length} offered · {count('accepted')} yes · {count('declined')} no · {count('waiting')} waiting{d.plan.next_at ? ` · this wave ends ${time(d.plan.next_at)}` : ''}</>}
              </p>
              <ul className="wave-list">
                {d.offers.map((o) => (
                  <li key={o.user_id}>
                    <div><b>{o.name}</b><span className="muted small">Wave {o.wave} · offered {time(o.offered_at)}{o.reminded_at && o.state === 'waiting' ? ` · reminded ${time(o.reminded_at)}` : ''}{o.note && o.state !== 'waiting' ? ` · ${o.note}` : ''}</span></div>
                    <span className={`cs-st ${STATE[o.state][1]}`}>{STATE[o.state][0]}</span>
                  </li>
                ))}
              </ul>
              {d.plan.status !== 'done' && <p className="muted small" style={{ margin: '10px 0 0' }}>Nothing is offered after {when(d.plan.answer_by)}.</p>}
            </>
          ) : (
            <>
              <b>Who gets asked first</b>
              <p className="muted small" style={{ margin: '4px 0 8px' }}>{d.preview.qualified} qualified and free. Ranked by stars for {d.shift.role_name}, then staying out of overtime, then fewest hours that week.</p>
              <ol className="wave-list">
                {d.preview.top.slice(0, Math.max(cfg.topN, 1)).map((p, i) => (
                  <li key={p.name + i}>
                    <div><b>{p.name}</b><span className="muted small">{p.stars ? `★ ${p.stars.toFixed(1)}` : 'not rated yet'} · {p.week_hours} h that week{p.overtime ? ' · would be overtime' : ''}</span></div>
                    {i < open && <span className="cs-st wait">First offers</span>}
                  </li>
                ))}
              </ol>
              {d.preview.qualified === 0 && <p className="small">Nobody qualified is free for this shift.</p>}
            </>
          )}
        </div>
      </div>
      <div className="wave-acts">
        {!d.plan || d.plan.status === 'done' ? (
          <button type="button" className="btn primary" disabled={busy || d.shift.staffing_draft || open <= 0 || d.preview.qualified === 0} onClick={() => run(() => api(`/api/shifts/${shiftId}/waves`, { body: { config: cfg, saveDefault } }))}>
            {busy ? 'Starting…' : d.plan ? 'Start waves again' : 'Start waves'}
          </button>
        ) : (
          <>
            {d.plan.status === 'active'
              ? <button type="button" className="btn" disabled={busy} onClick={() => run(() => api(`/api/shifts/${shiftId}/waves/pause`, { body: {} }))}>Pause</button>
              : <button type="button" className="btn primary" disabled={busy} onClick={() => run(() => api(`/api/shifts/${shiftId}/waves/resume`, { body: {} }))}>Carry on</button>}
            <button type="button" className="btn ghost danger" disabled={busy} onClick={() => askConfirm('Stop the waves? Offers already out stay as they are.').then((ok): unknown => ok && (run(() => api(`/api/shifts/${shiftId}/waves/stop`, { body: {} }))))}>Stop</button>
          </>
        )}
        {open <= 0 && !running && <span className="muted small">Every spot is taken, so there’s nothing to offer.</span>}
      </div>
    </div>
  );
}
