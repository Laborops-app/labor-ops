'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';

type Rules = {
  minRestHours: number; maxDailyHours: number; dailyOtAfter: number; weeklyOtAfter: number; otMultiplier: number;
  nightStart: string; nightEnd: string; nightPremiumPct: number; sundayPremiumPct: number; holidayPremiumPct: number; holidays: string[]; defaultState: string | null; autoApprove?: boolean; autoApproveGraceMin?: number; lateAlertMin?: number; noShowMin?: number; autoClockoutH?: number; payPeriod?: 'weekly' | 'biweekly'; payPeriodStart?: string;
};
type StateRule = { state: string; otMult: number; dtAfter: number | null; dtMult: number; custom: boolean };

function Num({ label, hint, value, onChange, step = 0.5, suffix }: { label: string; hint?: string; value: number; onChange: (n: number) => void; step?: number; suffix?: string }) {
  return (
    <label>
      {label}
      <span className="row" style={{ gap: '.4rem' }}>
        <input type="number" min={0} step={step} value={Number.isFinite(value) ? value : ''} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} style={{ maxWidth: '8rem' }} />
        {suffix && <span className="muted">{suffix}</span>}
      </span>
      {hint && <span className="muted" style={{ fontSize: '.85rem' }}>{hint}</span>}
    </label>
  );
}

function Body() {
  const [r, setR] = useState<Rules | null>(null);
  const [hol, setHol] = useState('');
  const [states, setStates] = useState<StateRule[]>([]);
  const loadStates = () => api<{ states: StateRule[] }>('/api/state-ot-rules').then((x) => setStates(x.states)).catch(() => undefined);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  useEffect(() => {
    api<Rules>('/api/labor-rules').then(setR).catch((e) => setError(e.message));
    loadStates();
  }, []);
  if (!r) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const set = (p: Partial<Rules>) => setR({ ...r, ...p });
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setOk('');
    try {
      setR(await api<Rules>('/api/labor-rules', { method: 'PUT', body: r }));
      setOk('Labor rules saved.');
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <>
      <h1>Labor rules</h1>
      <p className="muted">These rules warn coordinators while scheduling and drive the estimated earnings crew see. Pay is an estimate; actual pay follows approved time.</p>
      {error && <Banner>{error}</Banner>}
      {ok && <Banner kind="ok">{ok}</Banner>}
      <form onSubmit={save}>
        <section className="card">
          <h2>Rest and hours</h2>
          <div className="grid2">
            <Num label="Minimum rest between shifts" suffix="hours" value={r.minRestHours} onChange={(n) => set({ minRestHours: n })} hint="Shifts less than 2 hours apart count as one continuous work period." />
            <Num label="Maximum hours in one day" suffix="hours" value={r.maxDailyHours} onChange={(n) => set({ maxDailyHours: n })} hint="0 turns the limit off." />
          </div>
          <p className="muted">Breaking either rule needs the coordinator to confirm an override. Crew cannot claim open shifts that break them.</p>
        </section>
        <section className="card">
          <h2>Timesheet approval</h2>
          <label className="check">
            <input type="checkbox" checked={r.autoApprove !== false} onChange={(e) => set({ autoApprove: e.target.checked })} />
            Approve time automatically when it stays within the scheduled shift
          </label>
          <div className="grid2" style={{ marginTop: 8 }}>
            <Num label="Grace either side" suffix="minutes" step={1} value={r.autoApproveGraceMin ?? 10} onChange={(n) => set({ autoApproveGraceMin: n })} hint="Clocking in this much before the start, or out this much after the end, still counts as on schedule. Leaving early always counts." />
          </div>
          <p className="muted">Anything outside that waits on the Timesheets page for a coordinator to approve.</p>
        </section>
        <section className="card">
          <h2>Pay periods</h2>
          <div className="grid2">
            <label>
              How often you run payroll
              <select value={r.payPeriod ?? 'biweekly'} onChange={(e) => set({ payPeriod: e.target.value as 'weekly' | 'biweekly' })}>
                <option value="biweekly">Every two weeks</option>
                <option value="weekly">Every week</option>
              </select>
            </label>
            <label>
              First day of a pay period
              <input type="date" value={r.payPeriodStart ?? '2026-01-05'} onChange={(e) => e.target.value && set({ payPeriodStart: e.target.value })} />
              <span className="muted small">Any period you have run; the rest follow from it.</span>
            </label>
          </div>
          <p className="muted">Crew see their earnings for each pay period on My shifts, and Payroll opens on the last full period.</p>
        </section>
        <section className="card">
          <h2>Late, no-shows and forgotten clock-outs</h2>
          <div className="grid2">
            <Num label="Late alert after" suffix="minutes" step={1} value={r.lateAlertMin ?? 10} onChange={(n) => set({ lateAlertMin: n })} hint="Not clocked in this long after the start: the person gets a nudge, and coordinators and the event's leads are told. 0 turns it off." />
            <Num label="No-show after" suffix="minutes" step={5} value={r.noShowMin ?? 60} onChange={(n) => set({ noShowMin: n })} hint="Still not clocked in: marked as a no-show (cleared if they are checked in later). 0 turns it off." />
            <Num label="Close a forgotten clock-out after" suffix="hours past the end" step={0.5} value={r.autoClockoutH ?? 3} onChange={(n) => set({ autoClockoutH: n })} hint="Still clocked in this long after the shift ended: closed at the scheduled end and left for you to check (never approved automatically). 0 turns it off." />
          </div>
        </section>
        <section className="card">
          <h2>Overtime</h2>
          <div className="grid2">
            <Num label="Overtime after (per week)" suffix="hours" value={r.weeklyOtAfter} onChange={(n) => set({ weeklyOtAfter: n })} hint="Weeks run Monday to Sunday. 0 turns it off." />
            <Num label="Overtime after (per day)" suffix="hours" value={r.dailyOtAfter} onChange={(n) => set({ dailyOtAfter: n })} hint="0 turns it off." />
            <Num label="Overtime multiplier" suffix="× hourly rate" step={0.05} value={r.otMultiplier} onChange={(n) => set({ otMultiplier: n })} />
          </div>
        </section>
        <section className="card">
          <h2>Premiums</h2>
          <p className="muted">Extra percentage on the hourly rate. Overtime and premiums do not stack: the higher one applies.</p>
          <div className="grid2">
            <Num label="Night premium" suffix="%" step={1} value={r.nightPremiumPct} onChange={(n) => set({ nightPremiumPct: n })} />
            <label>
              Night hours
              <span className="row" style={{ gap: '.4rem' }}>
                <input type="time" value={r.nightStart} onChange={(e) => set({ nightStart: e.target.value })} />
                <span className="muted">to</span>
                <input type="time" value={r.nightEnd} onChange={(e) => set({ nightEnd: e.target.value })} />
              </span>
            </label>
            <Num label="Sunday premium" suffix="%" step={1} value={r.sundayPremiumPct} onChange={(n) => set({ sundayPremiumPct: n })} />
            <Num label="Holiday premium" suffix="%" step={1} value={r.holidayPremiumPct} onChange={(n) => set({ holidayPremiumPct: n })} />
          </div>
          <h3>Holidays</h3>
          <div className="chips">
            {r.holidays.map((d) => (
              <span key={d} className="chip">
                {d}
                <button type="button" className="chip-x" aria-label={`Remove ${d}`} onClick={() => set({ holidays: r.holidays.filter((x) => x !== d) })}>×</button>
              </span>
            ))}
            {!r.holidays.length && <span className="muted">No holidays added.</span>}
          </div>
          <div className="row" style={{ marginTop: '.5rem' }}>
            <input type="date" value={hol} onChange={(e) => setHol(e.target.value)} aria-label="Holiday date" />
            <button type="button" className="btn" disabled={!hol} onClick={() => { set({ holidays: [...new Set([...r.holidays, hol])].sort() }); setHol(''); }}>Add holiday</button>
          </div>
        </section>
        <button className="btn primary">Save rules</button>
      </form>
      <StateOvertime states={states} defaultState={r.defaultState} onDefault={(s) => set({ defaultState: s })} onChanged={loadStates} onError={setError} onOk={setOk} />
    </>
  );
}

/** Overtime multipliers per state. Each job picks when daily overtime starts (8, 10 or 15 h); these say what it pays and where double time starts. */
function StateOvertime({ states, defaultState, onDefault, onChanged, onError, onOk }: { states: StateRule[]; defaultState: string | null; onDefault: (s: string | null) => void; onChanged: () => void; onError: (m: string) => void; onOk: (m: string) => void }) {
  const [draft, setDraft] = useState<Record<string, { ot: string; dtAfter: string; dt: string }>>({});
  const [all, setAll] = useState(false);
  const shown = all ? states : states.filter((s) => s.custom || s.state === 'CA' || s.state === defaultState);
  const act = async (fn: () => Promise<unknown>, msg: string) => {
    onError('');
    try {
      await fn();
      onOk(msg);
      onChanged();
    } catch (e) {
      onError((e as Error).message);
    }
  };
  return (
    <section className="card" style={{ marginTop: '1rem' }}>
      <h2>Overtime by state</h2>
      <p className="muted small">
        Each job picks when daily overtime starts (after 8, 10 or 15 hours) on its event page. The state the job works in decides the multiplier and where double time starts. The values start at 1.5× everywhere and double time after 12 h in California. State and local law changes, so check yours and adjust. Overtime is counted per person, per day, on the same job.
      </p>
      <label style={{ display: 'block', maxWidth: 320, marginBottom: 10 }}>
        Default state for jobs with no state in the address
        <select value={defaultState ?? ''} onChange={(e) => onDefault(e.target.value || null)}>
          <option value="">None (company multiplier)</option>
          {states.map((s) => (
            <option key={s.state} value={s.state}>{s.state}</option>
          ))}
        </select>
        <span className="muted small">Save the rules above to keep this.</span>
      </label>
      <div style={{ overflowX: 'auto' }}>
        <table className="table">
          <thead><tr><th>State</th><th>Overtime ×</th><th>Double time after (h)</th><th>Double time ×</th><th></th></tr></thead>
          <tbody>
            {shown.map((s) => {
              const d = draft[s.state] ?? { ot: String(s.otMult), dtAfter: s.dtAfter === null ? '' : String(s.dtAfter), dt: String(s.dtMult) };
              const set = (p: Partial<typeof d>) => setDraft({ ...draft, [s.state]: { ...d, ...p } });
              return (
                <tr key={s.state}>
                  <td><b>{s.state}</b> {s.custom && <span className="chip">Custom</span>}</td>
                  <td><input type="number" min={1} max={4} step={0.05} value={d.ot} onChange={(e) => set({ ot: e.target.value })} style={{ width: '5rem' }} aria-label={`Overtime multiplier for ${s.state}`} /></td>
                  <td><input type="number" min={1} max={24} step={0.5} value={d.dtAfter} placeholder="none" onChange={(e) => set({ dtAfter: e.target.value })} style={{ width: '5rem' }} aria-label={`Double time starts after, ${s.state}`} /></td>
                  <td><input type="number" min={1} max={4} step={0.05} value={d.dt} onChange={(e) => set({ dt: e.target.value })} style={{ width: '5rem' }} aria-label={`Double time multiplier for ${s.state}`} /></td>
                  <td>
                    <div className="row">
                      <button type="button" className="btn small primary" onClick={() => act(() => api(`/api/state-ot-rules/${s.state}`, { method: 'PUT', body: { otMult: Number(d.ot), dtAfter: d.dtAfter === '' ? null : Number(d.dtAfter), dtMult: Number(d.dt) } }).then(() => setDraft((x) => { const n = { ...x }; delete n[s.state]; return n; })), `${s.state} saved.`)}>Save</button>
                      {s.custom && <button type="button" className="btn small" onClick={() => act(() => api(`/api/state-ot-rules/${s.state}`, { method: 'DELETE' }), `${s.state} is back to the starting values.`)}>Reset</button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn ghost small" onClick={() => setAll(!all)}>{all ? 'Show only changed states' : 'Show all states'}</button>
    </section>
  );
}

export default function Page() {
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
