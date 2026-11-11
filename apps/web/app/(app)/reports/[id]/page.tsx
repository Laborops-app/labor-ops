'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, money } from '@/lib/api';
import { HBars, Meter, PairBars, StepLine } from '@/components/ReportCharts';

type Report = {
  event: { id: string; name: string; customer: string | null; venue: string | null; start: string; end: string; status: string; rentman: number | null };
  money: {
    laborCost: number; billed: number; quoted: number | null; quoteNumber: number | null; quoteSource: string | null; invoiced: number; invoices: number;
    revenue: number | null; margin: number | null; marginPct: number | null; budget: number | null; budgetLeft: number | null; costPerHour: number | null;
    costByRole: { role: string; group: string | null; cost: number; hours: number; ot: number; billed: number }[];
  };
  hours: {
    scheduled: number; worked: number; approved: number; unapproved: number; regular: number; overtime: number; double: number;
    byDay: { date: string; scheduled: number; worked: number; overtime: number; cost: number }[];
    byRole: { role: string; scheduled: number; worked: number }[];
    lunches: number; lunchMinutes: number; breaks: number; breakMinutes: number; autoClockOuts: number;
  };
  staffing: {
    slots: number; filled: number; fillRate: number | null; offers: number; accepted: number; declined: number; waiting: number; removed: number;
    medianResponseHours: number | null; noShows: number; late: number; latePunches: number; leads: number; fillTimeline: { date: string; confirmed: number }[];
  };
  crew: { userId: string; name: string; roles: string[]; lead: boolean; scheduled: number; worked: number; ot: number; pay: number; late: number; lateMinutes: number; noShows: number; stars: number | null }[];
};

const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`);
const h1 = (n: number) => `${Math.round(n * 10) / 10} h`;
const int = (n: number) => String(Math.round(n));
const usd0 = (n: number) => n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
const dayFull = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
const dates = (s: string, e: string) => (s === e ? dayFull(s) : `${dayLabel(s)} – ${dayLabel(e)}, ${e.slice(0, 4)}`);
const waitText = (h: number | null) => (h === null ? '—' : h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : h < 48 ? `${Math.round(h * 10) / 10} h` : `${Math.round(h / 24)} days`);

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
  const { id } = useParams<{ id: string }>();
  const [r, setR] = useState<Report | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api<Report>(`/api/reports/events/${id}`).then(setR).catch((e) => setErr(e.message)); }, [id]);
  if (err) return <Banner>{err}</Banner>;
  if (!r) return <div className="muted">Loading…</div>;
  const { money: m, hours: h, staffing: s } = r;
  const ot = h.overtime + h.double;
  const revRows = [
    ...(m.quoted !== null ? [{ label: m.quoteSource === 'rentman' ? 'Quoted (Rentman)' : 'Quoted', value: m.quoted, note: m.quoteNumber ? `quote #${m.quoteNumber}` : undefined }] : []),
    { label: 'Billable at rates', value: m.billed, note: 'hours worked × billing rates' },
    ...(m.invoices ? [{ label: 'Invoiced', value: m.invoiced, note: `${m.invoices} invoice${m.invoices === 1 ? '' : 's'}` }] : []),
    ...(m.budget !== null ? [{ label: 'Labor budget', value: m.budget }] : []),
    { label: 'Labor cost', value: m.laborCost, note: 'approved time, as paid' },
  ];
  const offerRows = [
    { label: 'Accepted', value: s.accepted },
    { label: 'Declined', value: s.declined },
    { label: 'Waiting for an answer', value: s.waiting },
    { label: 'Taken off / replaced', value: s.removed },
  ];
  const timeline = s.fillTimeline.map((p) => ({ date: p.date, label: dayLabel(p.date), value: p.confirmed }));

  return (
    <div className="event-report">
      <div className="row space no-print" style={{ marginBottom: 8 }}>
        <Link href="/reports" className="btn ghost small">← All reports</Link>
        <div className="row" style={{ gap: 8 }}>
          <Link href={`/events/${r.event.id}`} className="btn small">Open event</Link>
          <button type="button" className="btn small primary" onClick={() => window.print()}>Print / Save as PDF</button>
        </div>
      </div>
      <header className="er-head">
        <h1 style={{ marginBottom: 4 }}>{r.event.name}</h1>
        <p className="muted" style={{ margin: 0 }}>
          {dates(r.event.start, r.event.end)}{r.event.customer ? ` · ${r.event.customer}` : ''}{r.event.venue ? ` · ${r.event.venue}` : ''} · <span className="chip">{r.event.status.replace('_', ' ')}</span>
        </p>
      </header>
      {h.unapproved > 0 && <Banner kind="info">{h.unapproved} time entr{h.unapproved === 1 ? 'y is' : 'ies are'} not approved yet: labor cost and margin only count approved time.</Banner>}

      <div className="kpis" style={{ marginTop: 16 }}>
        <Kpi label="Labor cost" value={money(m.laborCost)} sub={m.costPerHour !== null ? `${money(m.costPerHour)} per paid hour` : 'Approved time'} tone={m.budget !== null && m.laborCost > m.budget ? 'bad' : undefined} />
        <Kpi label="Margin" value={m.margin === null ? '—' : money(m.margin)} sub={m.marginPct === null ? 'Nothing billed yet' : `${pct(m.marginPct)} of ${m.quoted !== null ? 'the quote' : 'billable'}`} tone={m.margin === null ? undefined : m.margin >= 0 ? 'good' : 'bad'} />
        <Kpi label="Fill rate" value={pct(s.fillRate)} sub={`${s.filled} of ${s.slots} spots`} tone={s.fillRate !== null && s.fillRate < 1 ? 'bad' : undefined} />
        <Kpi label="Hours worked" value={h1(h.worked)} sub={`${h1(h.scheduled)} scheduled`} />
        <Kpi label="Overtime" value={h1(ot)} sub={h.double ? `${h1(h.double)} double time` : `${pct(h.worked ? ot / h.worked : 0)} of hours`} tone={ot > 0 ? 'bad' : undefined} />
        <Kpi label="No-shows · late" value={`${s.noShows} · ${s.late}`} sub={`Median answer ${waitText(s.medianResponseHours)}`} tone={s.noShows ? 'bad' : undefined} />
      </div>

      <section className="card er-section">
        <h2>Money</h2>
        <div className="er-grid">
          <div>
            <h3>Revenue and cost</h3>
            <HBars rows={revRows} format={usd0} />
            {m.budget !== null && <Meter value={m.laborCost} max={m.budget} label={`Labor cost of budget · ${m.budgetLeft! >= 0 ? `${money(m.budgetLeft!)} left` : `${money(-m.budgetLeft!)} over`}`} format={money} />}
          </div>
          <div>
            <h3>Labor cost by role</h3>
            <HBars rows={m.costByRole.map((x) => ({ label: x.role, value: x.cost, note: `${h1(x.hours)}${x.ot ? `, ${h1(x.ot)} OT` : ''}` }))} format={usd0} sub={(row) => row.note ?? ''} />
          </div>
        </div>
      </section>

      <section className="card er-section">
        <h2>Hours and overtime</h2>
        <h3>Scheduled vs worked, by day</h3>
        <PairBars
          data={h.byDay.map((d) => ({ label: dayLabel(d.date), full: dayFull(d.date), a: d.scheduled, b: d.worked, extra: `${d.overtime ? `${h1(d.overtime)} overtime · ` : ''}${money(d.cost)} labor` }))}
          a="Scheduled" b="Worked" format={int}
        />
        <div className="er-grid" style={{ marginTop: 16 }}>
          <div>
            <h3>Worked hours by role</h3>
            <HBars rows={h.byRole.map((x) => ({ label: x.role, value: x.worked, note: `${h1(x.scheduled)} scheduled` }))} format={h1} sub={(row) => row.note ?? ''} />
          </div>
          <div>
            <h3>Pay mix</h3>
            <HBars rows={[{ label: 'Regular', value: h.regular }, { label: 'Overtime', value: h.overtime }, { label: 'Double time', value: h.double }]} format={h1} />
            <p className="small muted">
              {h.lunches} lunch{h.lunches === 1 ? '' : 'es'} ({h.lunchMinutes} min) · {h.breaks} break{h.breaks === 1 ? '' : 's'} ({h.breakMinutes} min){h.autoClockOuts ? ` · ${h.autoClockOuts} automatic clock-out${h.autoClockOuts === 1 ? '' : 's'}` : ''}
            </p>
          </div>
        </div>
      </section>

      <section className="card er-section">
        <h2>Staffing and reliability</h2>
        <div className="er-grid">
          <div>
            <h3>How the crew filled</h3>
            <StepLine points={timeline} target={s.slots} targetLabel={`${s.slots} needed`} format={int} />
            <Meter value={s.filled} max={s.slots} label={`${s.filled} of ${s.slots} spots confirmed`} format={int} />
          </div>
          <div>
            <h3>Offers ({s.offers})</h3>
            <HBars rows={offerRows} format={int} />
            <p className="small muted">
              Half of the answers came within {waitText(s.medianResponseHours)}. {s.noShows} no-show{s.noShows === 1 ? '' : 's'}, {s.late} late arrival{s.late === 1 ? '' : 's'} (more than 10 minutes after the start){s.leads ? `, ${s.leads} lead${s.leads === 1 ? '' : 's'}` : ''}.
            </p>
          </div>
        </div>
      </section>

      <section className="card er-section">
        <h2>Crew ({r.crew.length})</h2>
        {r.crew.length === 0 ? <p className="muted">Nobody on this event yet.</p> : (
          <div className="table-wrap">
            <table className="report-table">
              <thead>
                <tr><th>Name</th><th>Role</th><th className="num">Scheduled</th><th className="num">Worked</th><th className="num">OT</th><th className="num">Pay</th><th className="num">Late</th><th className="num">No-show</th><th className="num">Rating</th></tr>
              </thead>
              <tbody>
                {r.crew.map((p) => (
                  <tr key={p.userId}>
                    <td><b>{p.name}</b>{p.lead && <span className="chip" style={{ marginLeft: 6 }}>Lead</span>}</td>
                    <td>{p.roles.join(', ')}</td>
                    <td className="num">{p.scheduled ? h1(p.scheduled) : '—'}</td>
                    <td className="num">{p.worked ? h1(p.worked) : '—'}</td>
                    <td className="num">{p.ot ? h1(p.ot) : '—'}</td>
                    <td className="num">{p.pay ? money(p.pay) : '—'}</td>
                    <td className="num">{p.late ? `${p.late} (${p.lateMinutes} min)` : '—'}</td>
                    <td className="num">{p.noShows || '—'}</td>
                    <td className="num">{p.stars === null ? '—' : `${p.stars.toFixed(1)} ★`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="muted small">Labor cost and pay count approved time, priced like payroll (overtime, day rates, minimum calls). Worked hours count every completed clock-in.</p>
      </section>
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager', 'hr']}>{() => <Body />}</Shell>;
}
