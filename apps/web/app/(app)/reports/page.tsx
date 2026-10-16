'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, money } from '@/lib/api';

type Ev = {
  id: string; name: string; customer: string | null; start: string; end: string; slots: number; filled: number; fillRate: number | null;
  scheduledHours: number; actualHours: number; approvedHours: number; unapproved: number; regular: number; overtime: number; double: number;
  laborCost: number; billed: number; quoted: number | null; margin: number | null; marginPct: number | null; budget: number | null; budgetLeft: number | null;
  noShows: number; late: number; autoClockOuts: number; offlinePunches: number;
};
type Totals = {
  events: number; slots: number; filled: number; fillRate: number | null; scheduledHours: number; actualHours: number; overtime: number; double: number;
  laborCost: number; revenue: number; margin: number | null; marginPct: number | null; unbilledEvents: number; unbilledCost: number; budget: number | null; budgetCost: number; noShows: number; late: number; unapproved: number;
};
type Data = { from: string; to: string; events: Ev[]; totals: Totals };

const ymd = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
const PRESETS: { key: string; label: string; range: () => { from: string; to: string } }[] = [
  { key: 'month', label: 'This month', range: () => { const d = new Date(); return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)) }; } },
  { key: 'last', label: 'Last month', range: () => { const d = new Date(); return { from: ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: ymd(new Date(d.getFullYear(), d.getMonth(), 0)) }; } },
  { key: '30', label: 'Last 30 days', range: () => { const d = new Date(); return { from: ymd(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 29)), to: ymd(d) }; } },
  { key: 'quarter', label: 'This quarter', range: () => { const d = new Date(); const q = Math.floor(d.getMonth() / 3) * 3; return { from: ymd(new Date(d.getFullYear(), q, 1)), to: ymd(new Date(d.getFullYear(), q + 3, 0)) }; } },
  { key: 'year', label: 'This year', range: () => { const d = new Date(); return { from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear()}-12-31` }; } },
];
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const hrs = (n: number) => (n ? `${Math.round(n * 10) / 10} h` : '—');
type SortKey = 'start' | 'name' | 'margin' | 'laborCost' | 'fillRate' | 'overtime' | 'noShows';

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub muted small">{sub}</div>}
    </div>
  );
}

function Body() {
  const [preset, setPreset] = useState('month');
  const [range, setRange] = useState(PRESETS[0].range);
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [sort, setSort] = useState<{ k: SortKey; desc: boolean }>({ k: 'start', desc: false });

  useEffect(() => {
    setError('');
    setD(null);
    api<Data>(`/api/reports?from=${range.from}&to=${range.to}`).then(setD).catch((e) => setError(e.message));
  }, [range]);

  const rows = useMemo(() => {
    if (!d) return [];
    const v = (e: Ev) => (sort.k === 'name' ? e.name.toLowerCase() : sort.k === 'start' ? e.start : (e[sort.k] ?? -Infinity));
    return [...d.events].sort((a, b) => (v(a) < v(b) ? -1 : v(a) > v(b) ? 1 : 0) * (sort.desc ? -1 : 1));
  }, [d, sort]);
  const th = (k: SortKey, label: string, num = false) => (
    <th className={num ? 'num' : ''}>
      <button className="th-sort" onClick={() => setSort((s) => ({ k, desc: s.k === k ? !s.desc : k !== 'start' && k !== 'name' }))} aria-sort={sort.k === k ? (sort.desc ? 'descending' : 'ascending') : undefined}>
        {label}{sort.k === k ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );
  const t = d?.totals;

  return (
    <>
      <div className="row space">
        <h1>Reports</h1>
        {d && d.events.length > 0 && <a className="btn small" href={`/api/reports/events.csv?from=${range.from}&to=${range.to}`}>Download CSV</a>}
      </div>
      <div className="row report-range">
        <div className="seg" role="group" aria-label="Period">
          {PRESETS.map((p) => (
            <button key={p.key} className={preset === p.key ? 'active' : ''} onClick={() => { setPreset(p.key); setRange(p.range()); }}>{p.label}</button>
          ))}
        </div>
        <label className="inline">From <input type="date" value={range.from} onChange={(e) => { setPreset(''); setRange({ ...range, from: e.target.value }); }} /></label>
        <label className="inline">To <input type="date" value={range.to} onChange={(e) => { setPreset(''); setRange({ ...range, to: e.target.value }); }} /></label>
      </div>
      {error && <Banner>{error}</Banner>}
      {!d && !error && <div className="muted">Loading…</div>}
      {d && t && (
        <>
          <div className="kpis">
            <Kpi
              label="Margin"
              value={t.margin === null ? '—' : money(t.margin)}
              sub={t.margin === null ? 'Add billing rates to roles, or accept a quote' : `${pct(t.marginPct)} of ${money(t.revenue)} billed${t.unbilledEvents ? ` · ${t.unbilledEvents} event${t.unbilledEvents === 1 ? '' : 's'} not billed` : ''}`}
              tone={t.margin === null ? undefined : t.margin < 0 ? 'bad' : 'good'}
            />
            <Kpi label="Labor cost" value={money(t.laborCost)} sub={t.budget !== null ? `Budget ${money(t.budget)} (${money(t.budget - t.budgetCost)} left)` : 'Approved time, as paid'} tone={t.budget !== null && t.budgetCost > t.budget ? 'bad' : undefined} />
            <Kpi label="Fill rate" value={pct(t.fillRate)} sub={`${t.filled} of ${t.slots} slots`} />
            <Kpi label="Hours" value={hrs(t.actualHours)} sub={`${hrs(t.scheduledHours)} scheduled`} />
            <Kpi label="Overtime" value={hrs(t.overtime + t.double)} sub={t.double ? `${hrs(t.double)} double time` : 'OT + DT'} tone={t.overtime + t.double > 0 ? 'bad' : undefined} />
            <Kpi label="No-shows" value={String(t.noShows)} sub={`${t.late} late arrival${t.late === 1 ? '' : 's'}`} tone={t.noShows ? 'bad' : undefined} />
          </div>
          {t.unapproved > 0 && (
            <Banner kind="info">{t.unapproved} timesheet{t.unapproved === 1 ? ' is' : 's are'} not approved yet: labor cost and margin only count approved time. <Link href="/timesheets">Review timesheets</Link></Banner>
          )}
          {d.events.length === 0 ? (
            <Empty>No events in this period.</Empty>
          ) : (
            <section className="card">
              <div className="table-wrap">
                <table className="report-table">
                  <thead>
                    <tr>
                      {th('name', 'Event')}
                      {th('start', 'Dates')}
                      {th('fillRate', 'Filled', true)}
                      <th className="num">Hours</th>
                      {th('overtime', 'OT / DT', true)}
                      {th('laborCost', 'Labor cost', true)}
                      <th className="num">Billed</th>
                      {th('margin', 'Margin', true)}
                      <th className="num">Budget</th>
                      {th('noShows', 'No-shows', true)}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((e) => (
                      <tr key={e.id}>
                        <td>
                          <Link href={`/events/${e.id}`}><b>{e.name}</b></Link>
                          {e.customer && <div className="muted small">{e.customer}</div>}
                          <div className="report-flags">
                            {e.unapproved > 0 && <span className="chip warn">{e.unapproved} unapproved</span>}
                            {e.autoClockOuts > 0 && <span className="chip warn" title="Nobody clocked out, closed at the shift end">{e.autoClockOuts} auto clock-out</span>}
                            {e.offlinePunches > 0 && <span className="chip" title="Clocked with no signal, sent later with the phone's time">{e.offlinePunches} offline</span>}
                          </div>
                        </td>
                        <td className="small nowrap">{e.start === e.end ? e.start : `${e.start} → ${e.end}`}</td>
                        <td className="num">{e.filled}/{e.slots}<div className="muted small">{pct(e.fillRate)}</div></td>
                        <td className="num">{hrs(e.actualHours)}<div className="muted small">{hrs(e.scheduledHours)} sched.</div></td>
                        <td className="num">{e.overtime || e.double ? `${hrs(e.overtime)}${e.double ? ` / ${hrs(e.double)}` : ''}` : '—'}</td>
                        <td className="num">{money(e.laborCost)}</td>
                        <td className="num">{e.margin === null ? <span className="muted" title="No accepted quote, and its roles have no billing rate">—</span> : money(e.quoted ?? e.billed)}{e.quoted !== null && <div className="muted small">quote</div>}</td>
                        <td className={`num ${e.margin !== null && e.margin < 0 ? 'neg' : ''}`}>
                          {e.margin === null ? <span className="muted">—</span> : <><b>{money(e.margin)}</b><div className="small">{pct(e.marginPct)}</div></>}
                        </td>
                        <td className={`num ${e.budgetLeft !== null && e.budgetLeft < 0 ? 'neg' : ''}`}>
                          {e.budget === null ? <span className="muted">—</span> : <>{money(e.budget)}<div className="small">{e.budgetLeft! < 0 ? `${money(-e.budgetLeft!)} over` : `${money(e.budgetLeft!)} left`}</div></>}
                        </td>
                        <td className="num">{e.noShows || '—'}{e.late > 0 && <div className="muted small">{e.late} late</div>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small">
                Labor cost counts approved time, priced like payroll (overtime, day rates, minimum calls). Billed uses an accepted quote when the event has one, otherwise
                the hours worked at each role's billing rate. Set an event's labor budget on its page.
              </p>
            </section>
          )}
        </>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
