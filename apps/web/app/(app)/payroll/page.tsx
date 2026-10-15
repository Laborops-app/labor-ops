'use client';
import { Fragment, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, money } from '@/lib/api';

type Provider = 'adp' | 'gusto' | 'quickbooks';
type Entry = { id: string; date: string; event: string; role: string; hours: number; reg: number; ot: number; dt: number; pay: number | null; day: boolean; exported: boolean };
type Person = { userId: string; name: string; email: string; payrollIds: Record<string, string>; regular: number; overtime: number; double: number; hours: number; days: number; dayPay: number; gross: number | null; entries: Entry[] };
type Data = {
  from: string; to: string; people: Person[]; warnings: string[]; totals: { people: number; hours: number; gross: number };
  payroll: { enabled: Provider[]; primary: Provider }; missingIds: Record<string, string[]>; quickbooksConnected: boolean;
  history: { id: string; provider: string; period_start: string; period_end: string; people: number; entries: number; gross: string | null; created_at: string; created_by: string | null }[];
};
const LABEL: Record<string, string> = { adp: 'ADP', gusto: 'Gusto', quickbooks: 'QuickBooks', csv: 'Detail CSV' };
const ID_LABEL: Record<Provider, string> = { adp: 'ADP File #', gusto: 'Gusto employee ID', quickbooks: 'QuickBooks employee ID' };

/** The last full Monday–Sunday week. */
function lastWeek() {
  const d = new Date();
  const back = ((d.getDay() + 6) % 7) + 7;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() - back);
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6);
  const f = (x: Date) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  return { from: f(mon), to: f(sun) };
}
const h = (n: number) => (n ? n.toFixed(2) : '—');

function Body() {
  const [period, setPeriod] = useState(lastWeek);
  const [d, setD] = useState<Data | null>(null);
  const [prov, setProv] = useState<Provider | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [ids, setIds] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setError('');
    return api<Data>(`/api/payroll?from=${period.from}&to=${period.to}`)
      .then((r) => {
        setD(r);
        setProv((p) => (p && r.payroll.enabled.includes(p) ? p : r.payroll.primary));
        setIds({});
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.from, period.to]);

  const saveId = async (p: Person) => {
    if (!prov || ids[p.userId] === undefined) return;
    try {
      await api(`/api/crew/${p.userId}/payroll-ids`, { method: 'PUT', body: { [prov]: ids[p.userId].trim() } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const fileUrl = (p: string, mark = true) => `/api/payroll/export?provider=${p}&from=${period.from}&to=${period.to}${mark ? '' : '&mark=0'}`;

  return (
    <>
      <h1>Payroll</h1>
      <p className="muted">Approved time for a pay period, split into regular, overtime and double-time hours using your labor rules and each job&apos;s overtime setting. Export it for your payroll provider.</p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}

      <section className="card">
        <div className="row" style={{ gap: '.75rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label>
            From
            <input type="date" value={period.from} max={period.to} onChange={(e) => e.target.value && setPeriod({ ...period, from: e.target.value })} />
          </label>
          <label>
            To
            <input type="date" value={period.to} min={period.from} onChange={(e) => e.target.value && setPeriod({ ...period, to: e.target.value })} />
          </label>
          <button type="button" className="btn ghost small" onClick={() => setPeriod(lastWeek())}>Last week</button>
        </div>
      </section>

      {!d ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          {d.warnings.map((w) => <Banner key={w} kind="info">{w}</Banner>)}
          <div className="phase-tabs" role="tablist" aria-label="Payroll provider">
            {d.payroll.enabled.map((p) => (
              <button key={p} type="button" role="tab" aria-selected={prov === p} className={prov === p ? 'tab on' : 'tab'} onClick={() => setProv(p)}>
                {LABEL[p]}
              </button>
            ))}
          </div>
          <section className="card">
            <div className="row space" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
              <div>
                <b>{d.totals.people}</b> people · <b>{d.totals.hours.toFixed(2)}</b> hours · est. gross <b>{money(d.totals.gross)}</b>
              </div>
              {prov && d.people.length > 0 && (
                <div className="row" style={{ gap: '.4rem' }}>
                  {prov === 'quickbooks' && d.quickbooksConnected && (
                    <button
                      className="btn primary small"
                      disabled={busy}
                      onClick={async () => {
                        const fresh = d.missingIds.quickbooks ?? [];
                        if (!confirm(`Send ${d.totals.hours.toFixed(2)} hours to QuickBooks as time entries?${fresh.length ? `\n\nCrew not in QuickBooks yet are matched by email or name, or added as new employees: ${fresh.join(', ')}.` : ''}`)) return;
                        setBusy(true);
                        setError('');
                        try {
                          type R = { people: number; activities: number; alreadyExported: number; skipped: string[]; created: string[]; linked: string[] };
                          let r = await api<R>('/api/payroll/quickbooks', { body: period });
                          const people = [
                            r.created.length ? ` Added as new QuickBooks employees: ${r.created.join(', ')} (finish their pay and tax setup in QuickBooks Payroll before paying them).` : '',
                            r.linked.length ? ` Matched to existing QuickBooks employees: ${r.linked.join(', ')}.` : '',
                          ].join('');
                          // Nothing new: these hours were exported before (an ADP or QuickBooks file, or an earlier send).
                          if (!r.activities && r.alreadyExported) {
                            await load();
                            if (!confirm(`No new hours to send: all ${r.alreadyExported} entries in this period were already exported to payroll before (for example in a downloaded file).\n\nSend them to QuickBooks anyway? If they were already sent to QuickBooks, they will show there twice.`)) {
                              setOk(`Nothing sent: the ${r.alreadyExported} entries in this period were already exported.${people}`);
                              return;
                            }
                            r = await api<R>('/api/payroll/quickbooks', { body: { ...period, includeExported: true } });
                          }
                          setOk(
                            `Sent ${r.activities} time entr${r.activities === 1 ? 'y' : 'ies'} for ${r.people} ${r.people === 1 ? 'person' : 'people'} to QuickBooks. Find them under Time (or Reports → Time Activities by Employee Detail).` +
                              people +
                              (r.alreadyExported && r.activities ? ` ${r.alreadyExported} entries exported before were left out.` : '') +
                              (r.skipped.length ? ` Not sent: ${r.skipped.join(', ')}.` : ''),
                          );
                          await load();
                        } catch (e) {
                          setError((e as Error).message);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      Send hours to QuickBooks
                    </button>
                  )}
                  <a className={prov === 'quickbooks' && d.quickbooksConnected ? 'btn small' : 'btn primary small'} href={fileUrl(prov)} onClick={() => setTimeout(load, 1500)}>
                    Download {LABEL[prov]} file
                  </a>
                  <a className="btn ghost small" href={fileUrl('csv', false)}>Detail CSV</a>
                </div>
              )}
            </div>
            {prov && d.missingIds[prov]?.length > 0 && (
              <p className="small" style={{ color: 'var(--warn)' }}>
                Missing {ID_LABEL[prov]} for {d.missingIds[prov].join(', ')}.{prov === 'quickbooks' ? ' When you send hours they are matched to QuickBooks employees by email or name, or added as new employees, and their IDs are saved.' : ' Add it below before importing.'}
              </p>
            )}
            {d.people.length === 0 ? (
              <Empty>No approved time in this period.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>Name</th>{prov && <th>{ID_LABEL[prov]}</th>}<th>Regular</th><th>Overtime</th><th>Double</th><th>Day rate</th><th>Est. gross</th><th></th></tr>
                  </thead>
                  <tbody>
                    {d.people.map((p) => (
                      <Fragment key={p.userId}>
                        <tr>
                          <td>{p.name}</td>
                          {prov && (
                            <td>
                              <input
                                value={ids[p.userId] ?? p.payrollIds[prov] ?? ''}
                                onChange={(e) => setIds({ ...ids, [p.userId]: e.target.value })}
                                onBlur={() => saveId(p)}
                                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                                placeholder="add"
                                aria-label={`${ID_LABEL[prov]} for ${p.name}`}
                                style={{ width: '8rem' }}
                              />
                            </td>
                          )}
                          <td>{h(p.regular)}</td>
                          <td>{h(p.overtime)}</td>
                          <td>{h(p.double)}</td>
                          <td>{p.days ? `${p.days} × · ${money(p.dayPay)}` : '—'}</td>
                          <td>{p.gross === null ? <span className="muted">rate missing</span> : money(p.gross)}</td>
                          <td><button className="btn ghost small" onClick={() => setOpen(open === p.userId ? null : p.userId)}>{open === p.userId ? 'Hide' : 'Details'}</button></td>
                        </tr>
                        {open === p.userId && (
                          <tr>
                            <td colSpan={prov ? 8 : 7}>
                              <table className="table small">
                                <tbody>
                                  {p.entries.map((e) => (
                                    <tr key={e.id}>
                                      <td>{e.date}</td>
                                      <td>{e.event}</td>
                                      <td>{e.role}</td>
                                      <td>{e.day ? 'day rate' : `${e.hours.toFixed(2)} h${e.ot ? ` · ${e.ot} OT` : ''}${e.dt ? ` · ${e.dt} DT` : ''}`}</td>
                                      <td>{e.pay === null ? '—' : money(e.pay)}</td>
                                      <td>{e.exported && <span className="chip warn">exported</span>}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted small">Downloading a provider file marks these entries as exported, so a second export warns you. Gross pay is an estimate; your payroll provider calculates taxes and the final amounts.</p>
          </section>

          {d.history.length > 0 && (
            <section className="card">
              <h2>Past exports</h2>
              <table className="table small">
                <thead><tr><th>When</th><th>Provider</th><th>Period</th><th>People</th><th>Entries</th><th>Est. gross</th><th>By</th></tr></thead>
                <tbody>
                  {d.history.map((x) => (
                    <tr key={x.id}>
                      <td>{new Date(x.created_at).toLocaleString()}</td>
                      <td>{LABEL[x.provider] ?? x.provider}</td>
                      <td>{x.period_start} – {x.period_end}</td>
                      <td>{x.people}</td>
                      <td>{x.entries}</td>
                      <td>{x.gross ? money(Number(x.gross)) : '—'}</td>
                      <td>{x.created_by ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
