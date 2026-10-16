'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate, money } from '@/lib/api';

type Line = { id: string; date: string; event: string; role: string; hours: number; pay: number | null; status?: string };
type Data = {
  period: { from: string; to: string; offset: number; kind: 'weekly' | 'biweekly'; current: boolean; past: boolean };
  payroll: { hours: number; overtime: number; double: number; gross: number; missingRate: boolean; entries: (Line & { ot: number; dt: number; minCall: number })[] };
  pending: { hours: number; pay: number; entries: Line[] };
  scheduled: { hours: number; pay: number; shifts: Line[] };
  estimated: { hours: number; pay: number };
  unpriced: boolean;
};
const h = (n: number) => `${Math.round(n * 10) / 10} h`;
const range = (a: string, b: string) => `${fmtDate(a)} – ${fmtDate(b)}`;

/** My earnings for a pay period: what payroll will pay (approved), what's waiting for approval, and shifts still to come. */
export default function MyEarnings() {
  const [offset, setOffset] = useState(0);
  const [d, setD] = useState<Data | null>(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    setErr('');
    api<Data>(`/api/my/earnings?offset=${offset}`).then(setD).catch((e) => setErr(e.message));
  }, [offset]);
  if (err && !d) return null; // offline or no access: My shifts still works
  const p = d?.period;
  const lines = d ? [
    ...d.payroll.entries.map((e) => ({ ...e, kind: 'Approved' })),
    ...d.pending.entries.map((e) => ({ ...e, kind: e.status === 'clocked in' ? 'Clocked in' : 'Waiting for approval' })),
    ...d.scheduled.shifts.map((e) => ({ ...e, kind: 'Scheduled' })),
  ].sort((a, b) => a.date.localeCompare(b.date)) : [];
  return (
    <section className="card earnings">
      <div className="row space earnings-head">
        <div>
          <h2 style={{ margin: 0 }}>Earnings</h2>
          <div className="muted small">
            {p ? <>{p.current ? 'This pay period' : p.past ? 'Past pay period' : 'Next pay period'} · {range(p.from, p.to)}</> : 'Loading…'}
          </div>
        </div>
        <div className="row" style={{ gap: '.25rem' }}>
          <button className="icon-btn" aria-label="Previous pay period" onClick={() => setOffset(offset - 1)} disabled={offset <= -26}>‹</button>
          {offset !== 0 && <button className="btn ghost small" onClick={() => setOffset(0)}>Now</button>}
          <button className="icon-btn" aria-label="Next pay period" onClick={() => setOffset(offset + 1)} disabled={offset >= 1}>›</button>
        </div>
      </div>
      {d && (
        <>
          <div className="earn-grid">
            <div className="earn-tile main">
              <div className="earn-label">{p!.past ? 'Total' : 'Estimated'}</div>
              <div className="earn-value">{money(d.estimated.pay)}</div>
              <div className="muted small">{h(d.estimated.hours)}</div>
            </div>
            <div className="earn-tile">
              <div className="earn-label">Payroll (approved)</div>
              <div className="earn-value">{money(d.payroll.gross)}</div>
              <div className="muted small">{h(d.payroll.hours)}{d.payroll.overtime + d.payroll.double > 0 ? ` · ${h(d.payroll.overtime + d.payroll.double)} OT` : ''}</div>
            </div>
            <div className="earn-tile">
              <div className="earn-label">Waiting for approval</div>
              <div className="earn-value">{money(d.pending.pay)}</div>
              <div className="muted small">{h(d.pending.hours)}</div>
            </div>
            {!p!.past && (
              <div className="earn-tile">
                <div className="earn-label">Still scheduled</div>
                <div className="earn-value">{money(d.scheduled.pay)}</div>
                <div className="muted small">{h(d.scheduled.hours)}</div>
              </div>
            )}
          </div>
          <p className="muted small" style={{ margin: '.5rem 0 0' }}>
            Before taxes and deductions. Payroll counts approved time with overtime and minimum calls; the rest is an estimate.
            {d.unpriced ? ' Some shifts have no pay rate yet, so they show $0.' : ''}
          </p>
          {lines.length > 0 && (
            <>
              <button className="rt-link" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide shifts' : `Show ${lines.length} shift${lines.length === 1 ? '' : 's'}`}</button>
              {open && (
                <div className="table-wrap">
                  <table className="earn-table">
                    <tbody>
                      {lines.map((l) => (
                        <tr key={l.kind + l.id}>
                          <td className="small">{fmtDate(l.date)}</td>
                          <td className="small">{l.role}<div className="muted">{l.event}</div></td>
                          <td className="small">{h(l.hours)}<div className="muted">{l.kind}</div></td>
                          <td className="num">{l.pay === null ? '—' : money(l.pay)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
