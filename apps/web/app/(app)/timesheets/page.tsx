'use client';
import { Fragment, useEffect, useState } from 'react';
import TimeEdit from '@/components/TimeEdit';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, ApiError, fmtDateTime, fmtTime, type Me } from '@/lib/api';

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
  auto_approved?: boolean;
  offline_in?: boolean;
  offline_out?: boolean;
  auto_clocked_out?: boolean;
  edited_at?: string | null;
  edited_by_name?: string | null;
  original_clock_in?: string | null;
  original_clock_out?: string | null;
  shift_starts_at?: string;
  shift_ends_at?: string;
};
const TABS = [
  { key: 'submitted', label: 'Needs approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'open', label: 'On the clock' },
] as const;

function Body({ me }: { me: Me }) {
  // HR sees and exports timesheets; approving and fixing time stays with coordinators.
  const readOnly = me.role === 'hr';
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('submitted');
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const saveTime = async (id: string, t: { clockIn: string; clockOut: string | null }, force = false): Promise<void> => {
    try {
      const r = await api<{ entry: { status: string; auto_approved: boolean } }>(`/api/time-entries/${id}`, { method: 'PUT', body: { ...t, force: force || undefined } });
      setEditing(null);
      setNote(r.entry.auto_approved ? 'Time saved and approved (within the scheduled shift).' : r.entry.status === 'submitted' ? 'Time saved. It is outside the scheduled shift, so it needs approval.' : 'Time saved.');
      load();
    } catch (e) {
      if (e instanceof ApiError && e.reason === 'exported' && !force) {
        if (confirm(e.message)) return saveTime(id, t, true);
        return;
      }
      throw e;
    }
  };

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
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                  <tr>
                    <td>
                      <b>{r.user_name}</b>
                    </td>
                    <td className="small">
                      {r.role_name}
                      <div className="muted">{r.event_name}</div>
                    </td>
                    <td className="small">
                      {fmtDateTime(r.clock_in)}
                      {r.edited_at && (
                        <div>
                          <span className="chip small-chip" style={{ marginLeft: 0 }} title={`Changed by ${r.edited_by_name ?? 'someone'} on ${fmtDateTime(r.edited_at)}. Recorded: ${r.original_clock_in ? fmtDateTime(r.original_clock_in) : 'no clock-in'} – ${r.original_clock_out ? fmtDateTime(r.original_clock_out) : 'no clock-out'}`}>
                            Edited
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="small">
                      {r.clock_out ? fmtDateTime(r.clock_out) : <Pill status="open" />}
                      {(r.auto_clocked_out || r.offline_in || r.offline_out) && (
                        <div>
                          {r.auto_clocked_out && !r.edited_at && <span className="chip warn small-chip" style={{ marginLeft: 0 }} title="Nobody clocked out, so it was closed at the scheduled end. Check the real time before approving.">Auto clock-out</span>}
                          {(r.offline_in || r.offline_out) && <span className="chip small-chip" style={{ marginLeft: 0 }} title="Punched with no signal and sent later; the time is when it was tapped on the phone.">Offline</span>}
                        </div>
                      )}
                    </td>
                    <td>{r.hours.toFixed(2)}</td>
                    <td>
                      {r.status === 'submitted' ? (
                        <span className="row" style={{ gap: 6 }}>
                          {readOnly ? <span className="pill">Waiting for approval</span> : (
                            <button className="btn small primary" onClick={() => approve(r.id)}>
                              Approve
                            </button>
                          )}
                          {r.shift_starts_at && r.shift_ends_at && (
                            <span className="muted small" title="Time outside the scheduled shift waits for a coordinator">
                              scheduled {fmtTime(r.shift_starts_at)}–{fmtTime(r.shift_ends_at)}
                            </span>
                          )}
                        </span>
                      ) : r.status === 'approved' ? (
                        r.auto_approved ? <span className="chip open" title="Within the scheduled shift, so approved automatically">Auto-approved</span> : <span className="muted small">by {r.approved_by_name ?? 'a coordinator'}</span>
                      ) : null}
                    </td>
                    <td>
                      {!readOnly && <button className="btn ghost small" onClick={() => setEditing(editing === r.id ? null : r.id)} title="Correct the clock-in or clock-out">✎ Edit</button>}
                    </td>
                  </tr>
                  {editing === r.id && (
                    <tr>
                      <td colSpan={7}>
                        <TimeEdit title={`Correct ${r.user_name}'s time`} clockIn={r.clock_in} clockOut={r.clock_out} onSave={(t) => saveTime(r.id, t)} onCancel={() => setEditing(null)} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
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
  return <Shell roles={['admin', 'manager', 'hr']}>{(me) => <Body me={me} />}</Shell>;
}
