'use client';
import { useEffect, useState } from 'react';
import { Banner, Empty } from '@/components/ui';
import { api } from '@/lib/api';
import { askConfirm } from '@/components/Toasts';

export type WorkRules = {
  otAfter: number | null; dtAfter: number | null; otMult: number | null; dtMult: number | null;
  premiums: { nightPct: number | null; saturdayPct: number | null; sundayPct: number | null; holidayPct: number | null };
  minCallH: number | null;
  rounding: { minutes: 0 | 5 | 6 | 10 | 15 | 30; mode: 'nearest' | 'worker' };
  meal: { afterH: number; breakMin: number; stepMin: number; amounts: number[] } | null;
  turnaround: { restH: number; mult: number } | null;
  cancellation: { noticeH: number; payH: number } | null;
};
export type RuleSet = { id: string; name: string; is_default: boolean; config: WorkRules; customers: number; events: number };
type Preset = { name: string; description: string; config: WorkRules };

const EMPTY: WorkRules = {
  otAfter: null, dtAfter: null, otMult: null, dtMult: null,
  premiums: { nightPct: null, saturdayPct: null, sundayPct: null, holidayPct: null },
  minCallH: null, rounding: { minutes: 0, mode: 'nearest' }, meal: null, turnaround: null, cancellation: null,
};

/** One-line summary of a rule set, for lists and pickers. */
export function describeRules(w: WorkRules): string {
  const out: string[] = [];
  if (w.otAfter) out.push(`OT after ${w.otAfter} h${w.otMult ? ` (${w.otMult}×)` : ''}`);
  if (w.dtAfter) out.push(`DT after ${w.dtAfter} h`);
  if (w.minCallH) out.push(`${w.minCallH} h min call`);
  if (w.meal) out.push(`meal penalty after ${w.meal.afterH} h`);
  if (w.turnaround) out.push(`${w.turnaround.restH} h turnaround`);
  if (w.cancellation) out.push(`${w.cancellation.payH} h cancellation pay under ${w.cancellation.noticeH} h notice`);
  const p = w.premiums;
  const prem = [p.nightPct && `night +${p.nightPct}%`, p.saturdayPct && `Sat +${p.saturdayPct}%`, p.sundayPct && `Sun +${p.sundayPct}%`, p.holidayPct && `holiday +${p.holidayPct}%`].filter(Boolean);
  if (prem.length) out.push(prem.join(', '));
  if (w.rounding.minutes) out.push(`round ${w.rounding.minutes} min${w.rounding.mode === 'worker' ? ' (worker’s favor)' : ''}`);
  return out.join(' · ') || 'Company rules and state overtime only';
}

// Number field that holds null when empty ("use the company rule").
function Opt({ label, value, onChange, step = 0.5, suffix, hint }: { label: string; value: number | null; onChange: (v: number | null) => void; step?: number; suffix?: string; hint?: string }) {
  return (
    <label>
      {label}
      <span className="row" style={{ gap: '.4rem' }}>
        <input type="number" min={0} step={step} value={value ?? ''} placeholder="—" onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} style={{ maxWidth: '7rem' }} />
        {suffix && <span className="muted small">{suffix}</span>}
      </span>
      {hint && <span className="muted small">{hint}</span>}
    </label>
  );
}

function Editor({ initial, name: initialName, isDefault: initialDefault, onSave, onCancel }: {
  initial: WorkRules; name: string; isDefault: boolean; onSave: (b: { name: string; isDefault: boolean; config: WorkRules }) => Promise<void>; onCancel: () => void;
}) {
  const [w, setW] = useState<WorkRules>(initial);
  const [name, setName] = useState(initialName);
  const [isDefault, setDefault] = useState(initialDefault);
  const [amounts, setAmounts] = useState((initial.meal?.amounts ?? [10, 12.5, 15]).join(', '));
  const [busy, setBusy] = useState(false);
  const set = (p: Partial<WorkRules>) => setW({ ...w, ...p });
  const prem = (p: Partial<WorkRules['premiums']>) => setW({ ...w, premiums: { ...w.premiums, ...p } });
  return (
    <form
      className="wr-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        const meal = w.meal ? { ...w.meal, amounts: amounts.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n >= 0) } : null;
        setBusy(true);
        try { await onSave({ name, isDefault, config: { ...w, meal } }); } finally { setBusy(false); }
      }}
    >
      <div className="grid2">
        <label>Name<input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="IATSE Local 7" /></label>
        <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={isDefault} onChange={(e) => setDefault(e.target.checked)} /> Company default (used unless a customer or event picks another)</label>
      </div>
      <p className="muted small">Leave a box empty to use the company rule or the job’s state overtime.</p>

      <h3>Overtime</h3>
      <div className="grid4">
        <Opt label="OT after" suffix="h a day" value={w.otAfter} onChange={(v) => set({ otAfter: v })} />
        <Opt label="OT ×" step={0.25} value={w.otMult} onChange={(v) => set({ otMult: v })} />
        <Opt label="Double time after" suffix="h" value={w.dtAfter} onChange={(v) => set({ dtAfter: v })} />
        <Opt label="DT ×" step={0.25} value={w.dtMult} onChange={(v) => set({ dtMult: v })} />
      </div>

      <h3>Premiums</h3>
      <div className="grid4">
        <Opt label="Night" suffix="%" step={5} value={w.premiums.nightPct} onChange={(v) => prem({ nightPct: v })} />
        <Opt label="Saturday" suffix="%" step={5} value={w.premiums.saturdayPct} onChange={(v) => prem({ saturdayPct: v })} />
        <Opt label="Sunday" suffix="%" step={5} value={w.premiums.sundayPct} onChange={(v) => prem({ sundayPct: v })} />
        <Opt label="Holiday" suffix="%" step={5} value={w.premiums.holidayPct} onChange={(v) => prem({ holidayPct: v })} />
      </div>

      <h3>Calls and punches</h3>
      <div className="grid4">
        <Opt label="Minimum call" suffix="h" hint="When the shift sets none" value={w.minCallH} onChange={(v) => set({ minCallH: v })} />
        <label>
          Round punches
          <select value={w.rounding.minutes} onChange={(e) => set({ rounding: { ...w.rounding, minutes: Number(e.target.value) as WorkRules['rounding']['minutes'] } })}>
            {[0, 5, 6, 10, 15, 30].map((m) => <option key={m} value={m}>{m ? `${m} minutes` : 'No rounding'}</option>)}
          </select>
        </label>
        {w.rounding.minutes > 0 && (
          <label>
            Rounding
            <select value={w.rounding.mode} onChange={(e) => set({ rounding: { ...w.rounding, mode: e.target.value as 'nearest' | 'worker' } })}>
              <option value="nearest">To the nearest</option>
              <option value="worker">In the worker’s favor</option>
            </select>
          </label>
        )}
      </div>

      <h3>
        <label className="check"><input type="checkbox" checked={!!w.meal} onChange={(e) => set({ meal: e.target.checked ? { afterH: 5, breakMin: 30, stepMin: 30, amounts: [10, 12.5, 15] } : null })} /> Meal penalties</label>
      </h3>
      {w.meal && (
        <div className="grid4">
          <Opt label="Due after" suffix="h worked" value={w.meal.afterH} onChange={(v) => set({ meal: { ...w.meal!, afterH: v ?? 5 } })} />
          <Opt label="A meal break is" suffix="min or more" step={5} value={w.meal.breakMin} onChange={(v) => set({ meal: { ...w.meal!, breakMin: v ?? 30 } })} />
          <Opt label="Another penalty every" suffix="min" step={5} value={w.meal.stepMin} onChange={(v) => set({ meal: { ...w.meal!, stepMin: v ?? 30 } })} />
          <label>Amounts ($)<input value={amounts} onChange={(e) => setAmounts(e.target.value)} placeholder="10, 12.50, 15" /><span className="muted small">First, second, … (the last repeats)</span></label>
        </div>
      )}

      <h3>
        <label className="check"><input type="checkbox" checked={!!w.turnaround} onChange={(e) => set({ turnaround: e.target.checked ? { restH: 10, mult: 1.5 } : null })} /> Turnaround</label>
      </h3>
      {w.turnaround && (
        <div className="grid4">
          <Opt label="Rest between calls" suffix="h" value={w.turnaround.restH} onChange={(v) => set({ turnaround: { ...w.turnaround!, restH: v ?? 10 } })} />
          <Opt label="Hours inside the rest paid at" suffix="×" step={0.25} value={w.turnaround.mult} onChange={(v) => set({ turnaround: { ...w.turnaround!, mult: v ?? 1.5 } })} />
        </div>
      )}

      <h3>
        <label className="check"><input type="checkbox" checked={!!w.cancellation} onChange={(e) => set({ cancellation: e.target.checked ? { noticeH: 24, payH: 4 } : null })} /> Cancellation pay</label>
      </h3>
      {w.cancellation && (
        <div className="grid4">
          <Opt label="Cut with less than" suffix="h notice" step={1} value={w.cancellation.noticeH} onChange={(v) => set({ cancellation: { ...w.cancellation!, noticeH: v ?? 24 } })} />
          <Opt label="Pays" suffix="h (or a day rate)" value={w.cancellation.payH} onChange={(v) => set({ cancellation: { ...w.cancellation!, payH: v ?? 4 } })} />
        </div>
      )}

      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save rule set'}</button>
        <button type="button" className="btn ghost" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

/** Named work-rule sets (union locals, client contracts): the list, presets and the editor. Admins only. */
export default function WorkRuleSets() {
  const [sets, setSets] = useState<RuleSet[] | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [edit, setEdit] = useState<{ id: string | null; name: string; isDefault: boolean; config: WorkRules } | null>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const load = () => api<{ sets: RuleSet[]; presets: Preset[] }>('/api/work-rule-sets').then((r) => { setSets(r.sets); setPresets(r.presets); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const save = async (b: { name: string; isDefault: boolean; config: WorkRules }) => {
    setErr(''); setOk('');
    try {
      await api(edit?.id ? `/api/work-rule-sets/${edit.id}` : '/api/work-rule-sets', { method: edit?.id ? 'PUT' : 'POST', body: b });
      setOk(`“${b.name}” saved.`);
      setEdit(null);
      load();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <section className="card" style={{ marginTop: '1rem' }} id="work-rules">
      <h2>Work-rule sets</h2>
      <p className="muted small">
        Pay rules from a union local or a client contract: overtime, premiums, meal penalties, turnaround, cancellation pay, punch rounding and a minimum call.
        Mark one as the company default, and pick another on a customer or an event. Payroll, reports and cost estimates use them. The starters are examples only: check every number against your agreement.
      </p>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      {edit ? (
        <Editor initial={edit.config} name={edit.name} isDefault={edit.isDefault} onSave={save} onCancel={() => setEdit(null)} />
      ) : (
        <>
          {!sets ? <div className="muted">Loading…</div> : sets.length === 0 ? <Empty>No rule sets yet. Everything uses the company rules above and state overtime.</Empty> : (
            <ul className="wr-list">
              {sets.map((s) => (
                <li key={s.id}>
                  <div>
                    <b>{s.name}</b> {s.is_default && <span className="chip open">Default</span>}
                    <div className="muted small">{describeRules(s.config)}</div>
                    {(s.customers > 0 || s.events > 0) && <div className="muted small">Used by {s.customers} customer{s.customers === 1 ? '' : 's'} and {s.events} event{s.events === 1 ? '' : 's'}</div>}
                  </div>
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className="btn small" onClick={() => setEdit({ id: s.id, name: s.name, isDefault: s.is_default, config: s.config })}>Edit</button>
                    <button type="button" className="btn small ghost danger" onClick={async () => {
                      if (!(await askConfirm(`Delete “${s.name}”? Customers and events using it fall back to the default.`))) return;
                      try { await api(`/api/work-rule-sets/${s.id}`, { method: 'DELETE' }); load(); } catch (e) { setErr((e as Error).message); }
                    }}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" onClick={() => setEdit({ id: null, name: '', isDefault: !(sets ?? []).length, config: EMPTY })}>+ New rule set</button>
            {presets.map((p) => (
              <button key={p.name} type="button" className="btn" title={p.description} onClick={() => setEdit({ id: null, name: p.name.replace(' (starter)', ''), isDefault: !(sets ?? []).length, config: p.config })}>
                Start from “{p.name}”
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

/** Picker for a customer or an event: one of the sets, or "use the default". */
export function RuleSetPicker({ value, onChange, inheritLabel, disabled }: { value: string | null; onChange: (id: string | null) => void; inheritLabel: string; disabled?: boolean }) {
  const [sets, setSets] = useState<RuleSet[]>([]);
  useEffect(() => { api<{ sets: RuleSet[] }>('/api/work-rule-sets').then((r) => setSets(r.sets)).catch(() => {}); }, []);
  return (
    <select value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value || null)} aria-label="Work rules">
      <option value="">{inheritLabel}</option>
      {sets.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

/** The work rules an event uses, where they come from, and a picker to change them (event settings). */
export function EventRuleSet({ eventId, onSaved }: { eventId: string; onSaved?: () => void }) {
  const [d, setD] = useState<{ own: string | null; effective: { id: string; name: string; rules: WorkRules } | null; source: 'event' | 'customer' | 'default' | 'none'; customer: string | null } | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<NonNullable<typeof d>>(`/api/events/${eventId}/rule-set`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [eventId]);
  if (!d) return err ? <Banner>{err}</Banner> : null;
  const from = d.source === 'customer' ? `from ${d.customer ?? 'the customer'}` : d.source === 'default' ? 'the company default' : d.source === 'event' ? 'set on this event' : '';
  return (
    <section className="card" style={{ marginTop: 12 }}>
      <h3 style={{ marginTop: 0 }}>Work rules</h3>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      <p className="small" style={{ margin: '0 0 8px' }}>
        {d.effective ? <><b>{d.effective.name}</b> <span className="muted">({from})</span><br /><span className="muted">{describeRules(d.effective.rules)}</span></> : <span className="muted">No rule set: company rules and state overtime.</span>}
      </p>
      <RuleSetPicker
        value={d.own}
        inheritLabel={d.customer ? 'Use the customer’s / company default' : 'Use the company default'}
        onChange={async (id) => {
          try { await api(`/api/events/${eventId}/rule-set`, { method: 'PUT', body: { ruleSetId: id } }); await load(); onSaved?.(); } catch (e) { setErr((e as Error).message); }
        }}
      />
      <p className="muted small" style={{ marginBottom: 0 }}>Manage rule sets on the <a href="/rules#work-rules">Labor rules</a> page.</p>
    </section>
  );
}
