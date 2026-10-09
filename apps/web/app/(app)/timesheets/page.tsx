'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, fmtDateTime } from '@/lib/api';

type Entry = {
  id: string;
  status: string;
  clock_in: string;
  clock_out: string | null;
  hours: number;
  user_name: string;
  role_name: string;
  event_name: string;
  approved_by_name: string | null;
};
const TABS = [
  { key: 'submitted', label: 'Needs approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'open', label: 'On the clock' },
] as const;

function Body() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('submitted');
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');

  const load = (t = tab) => {
    setRows(null);
    api<{ entries: Entry[] }>(`/api/timesheets?status=${t}`)
      .then((r) => setRows(r.entries))
      .catch((e) => setError(e.message));
  };
  useEffect(() => {
    load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const approve = async (id: string) => {
    setError('');
    try {
      await api(`/api/timesheets/${id}/approve`, { method: 'POST', body: {} });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <>
      <div className="row space">
        <h1>Timesheets</h1>
        <a className="btn" href="/api/timesheets/export.csv">
          Export approved (CSV)
        </a>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      <section className="card">
        {!rows ? (
          <div className="muted">Loading…</div>
        ) : rows.length === 0 ? (
          <Empty>Nothing here.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Crew</th>
                  <th>Shift</th>
                  <th>In</th>
                  <th>Out</th>
                  <th>Hours</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <b>{r.user_name}</b>
                    </td>
                    <td className="small">
                      {r.role_name}
                      <div className="muted">{r.event_name}</div>
                    </td>
                    <td className="small">{fmtDateTime(r.clock_in)}</td>
                    <td className="small">{r.clock_out ? fmtDateTime(r.clock_out) : <Pill status="open" />}</td>
                    <td>{r.hours.toFixed(2)}</td>
                    <td>
                      {r.status === 'submitted' ? (
                        <button className="btn small primary" onClick={() => approve(r.id)}>
                          Approve
                        </button>
                      ) : r.status === 'approved' ? (
                        <span className="muted small">by {r.approved_by_name}</span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
