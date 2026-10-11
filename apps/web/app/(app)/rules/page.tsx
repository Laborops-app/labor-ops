'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';

type Rules = {
  minRestHours: number; maxDailyHours: number; dailyOtAfter: number; weeklyOtAfter: number; otMultiplier: number;
  nightStart: string; nightEnd: string; nightPremiumPct: number; sundayPremiumPct: number; holidayPremiumPct: number; holidays: string[];
};

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
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  useEffect(() => {
    api<Rules>('/api/labor-rules').then(setR).catch((e) => setError(e.message));
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
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
