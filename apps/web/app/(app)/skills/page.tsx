'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api } from '@/lib/api';

type Skill = { id: string; name: string; payRate: number; active: boolean };
type Edit = { name: string; payRate: string };

const money = (n: number) => n.toLocaleString([], { style: 'currency', currency: 'USD' });

function Body() {
  const [list, setList] = useState<Skill[] | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [f, setF] = useState({ name: '', payRate: '' });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');

  const load = () =>
    api<{ skills: Skill[] }>('/api/skills')
      .then((r) => {
        setList(r.skills);
        setEdits({});
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const act = async (key: string, msg: string, fn: () => Promise<unknown>) => {
    setError('');
    setOk('');
    setBusy(key);
    try {
      await fn();
      setOk(msg);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  };

  const rateNum = (s: string) => Math.round(Number(s) * 100) / 100;
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    const n = rateNum(f.payRate || '0');
    if (!Number.isFinite(n) || n < 0) return setError('Enter a pay rate of 0 or more.');
    if (await act('add', `Added ${f.name}.`, () => api('/api/skills', { body: { name: f.name, payRate: n } }))) setF({ name: '', payRate: '' });
  };
  const save = (s: Skill) => {
    const e = edits[s.id];
    if (!e) return;
    const n = rateNum(e.payRate);
    if (!Number.isFinite(n) || n < 0) return setError('Enter a pay rate of 0 or more.');
    act(s.id, `Saved ${e.name}.`, () => api(`/api/skills/${s.id}`, { method: 'PATCH', body: { name: e.name, payRate: n } }));
  };
  const set = (s: Skill, patch: Partial<Edit>) => setEdits({ ...edits, [s.id]: { name: edits[s.id]?.name ?? s.name, payRate: edits[s.id]?.payRate ?? String(s.payRate), ...patch } });

  const active = list?.filter((s) => s.active).length ?? 0;
  const avg = list && active ? list.filter((s) => s.active).reduce((n, s) => n + s.payRate, 0) / active : 0;

  return (
    <>
      <h1>Roles &amp; pay rates</h1>
      <p className="muted">
        These skills and roles fill the drop-downs for crew skills and shift roles. Pay rates are hourly and only admins can see them. Timesheet exports use them to work out pay when a shift’s role matches a name below.
      </p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && (
        <Banner kind="ok" onClose={() => setOk('')}>
          {ok}
        </Banner>
      )}

      <section className="card">
        <h2>Add a skill or role</h2>
        <form className="grid-form" onSubmit={add}>
          <label>
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Audio Tech" required maxLength={60} />
          </label>
          <label>
            Hourly pay rate (USD)
            <input type="number" min={0} max={10000} step="0.01" inputMode="decimal" value={f.payRate} onChange={(e) => setF({ ...f, payRate: e.target.value })} placeholder="25.00" required />
          </label>
          <div className="form-actions">
            <button className="btn primary" disabled={busy === 'add'}>
              Add
            </button>
          </div>
        </form>
      </section>

      <section className="card">
        <div className="row space">
          <h2>All skills &amp; roles</h2>
          {list && list.length > 0 && (
            <span className="muted small">
              {active} active · average {money(avg)}/hr
            </span>
          )}
        </div>
        {!list ? (
          <div className="muted">Loading…</div>
        ) : list.length === 0 ? (
          <Empty>Nothing here yet. Add your first role above.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="rates">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Hourly rate</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => {
                  const e = edits[s.id];
                  return (
                    <tr key={s.id} className={s.active ? '' : 'inactive'}>
                      <td>
                        <input value={e?.name ?? s.name} onChange={(ev) => set(s, { name: ev.target.value })} aria-label={`Name of ${s.name}`} maxLength={60} />
                      </td>
                      <td>
                        <span className="money-input">
                          <span aria-hidden="true">$</span>
                          <input
                            type="number"
                            min={0}
                            max={10000}
                            step="0.01"
                            inputMode="decimal"
                            value={e?.payRate ?? s.payRate.toFixed(2)}
                            onChange={(ev) => set(s, { payRate: ev.target.value })}
                            aria-label={`Hourly rate for ${s.name}`}
                          />
                          <span className="muted small">/hr</span>
                        </span>
                      </td>
                      <td>{s.active ? <span className="chip open">Active</span> : <span className="chip">Hidden</span>}</td>
                      <td>
                        <div className="row">
                          {e && (
                            <button className="btn small primary" disabled={busy === s.id} onClick={() => save(s)}>
                              Save
                            </button>
                          )}
                          <button className="btn ghost small" disabled={!!busy} onClick={() => act(s.id, s.active ? `${s.name} hidden from drop-downs.` : `${s.name} is back in the drop-downs.`, () => api(`/api/skills/${s.id}`, { method: 'PATCH', body: { active: !s.active } }))}>
                            {s.active ? 'Hide' : 'Show'}
                          </button>
                          <button
                            className="btn ghost small danger"
                            disabled={!!busy}
                            onClick={() => confirm(`Delete ${s.name}? People who already have it keep it on their profile.`) && act(s.id, `Deleted ${s.name}.`, () => api(`/api/skills/${s.id}`, { method: 'DELETE' }))}
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
