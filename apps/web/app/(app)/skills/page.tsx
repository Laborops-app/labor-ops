'use client';
import { Fragment, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api } from '@/lib/api';

type Skill = { id: string; name: string; payRate: number; active: boolean; groupId: string | null };
type Group = { id: string; name: string };
type Edit = { name: string; payRate: string };

const money = (n: number) => n.toLocaleString([], { style: 'currency', currency: 'USD' });

function Body() {
  const [list, setList] = useState<Skill[] | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [f, setF] = useState({ name: '', payRate: '', groupId: '' });
  const [newGroup, setNewGroup] = useState('');
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');

  const load = () =>
    api<{ skills: Skill[]; groups: Group[] }>('/api/skills')
      .then((r) => {
        setList(r.skills);
        setGroups(r.groups);
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
    if (await act('add', `Added ${f.name}.`, () => api('/api/skills', { body: { name: f.name, payRate: n, groupId: f.groupId || null } }))) setF({ name: '', payRate: '', groupId: f.groupId });
  };
  const save = (s: Skill) => {
    const e = edits[s.id];
    if (!e) return;
    const n = rateNum(e.payRate);
    if (!Number.isFinite(n) || n < 0) return setError('Enter a pay rate of 0 or more.');
    act(s.id, `Saved ${e.name}.`, () => api(`/api/skills/${s.id}`, { method: 'PATCH', body: { name: e.name, payRate: n } }));
  };
  const set = (s: Skill, patch: Partial<Edit>) => setEdits({ ...edits, [s.id]: { name: edits[s.id]?.name ?? s.name, payRate: edits[s.id]?.payRate ?? String(s.payRate), ...patch } });

  const addGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await act('group', `Added the ${newGroup} group.`, () => api('/api/skill-groups', { body: { name: newGroup } }))) setNewGroup('');
  };
  const sections = list
    ? [...groups.map((g) => ({ g: g as Group | null, rows: list.filter((s) => s.groupId === g.id) })), { g: null as Group | null, rows: list.filter((s) => !s.groupId || !groups.some((g) => g.id === s.groupId)) }].filter((x) => x.g || x.rows.length)
    : [];

  const active = list?.filter((s) => s.active).length ?? 0;
  const avg = list && active ? list.filter((s) => s.active).reduce((n, s) => n + s.payRate, 0) / active : 0;

  return (
    <>
      <h1>Roles &amp; pay rates</h1>
      <p className="muted">
        These skills and roles fill the drop-downs for crew skills and shift roles. Pay rates are hourly and only admins can see them. Timesheet exports use them to work out pay when a shift’s role matches a name below.
      </p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {list && list.length === 0 && (
        <section className="card">
          <h2>Start with the standard production roles</h2>
          <p className="muted small">Adds the groups Audio, Lighting, Stage Hand, Spot Op and Equipment Ops with their roles (loaders, pushers, fork lift, boom, lull, scissor lift and high lift operators), plus ready-made shift templates for load-in, load-out and each department. Rates start at $0 for you to fill in. You can rename or delete any of it.</p>
          <button className="btn primary" disabled={busy === 'starter'} onClick={() => act('starter', 'Standard roles, groups and shift templates added.', () => api('/api/skills/starter', { body: {} }))}>
            Add standard roles &amp; templates
          </button>
        </section>
      )}
      {ok && (
        <Banner kind="ok" onClose={() => setOk('')}>
          {ok}
        </Banner>
      )}

      <section className="card">
        <div className="row space">
          <h2>Groups</h2>
          {list && list.length > 0 && (
            <button className="btn ghost small" disabled={busy === 'starter'} onClick={() => act('starter', 'Added any missing standard roles, groups and templates.', () => api('/api/skills/starter', { body: {} }))}>
              Add standard roles &amp; templates
            </button>
          )}
        </div>
        <p className="muted small">Groups organise the role lists, for example Audio, Lighting or Equipment Ops. Deleting a group keeps its roles.</p>
        <div className="skill-chips" style={{ marginBottom: 10 }}>
          {groups.map((g) => (
            <span key={g.id} className="chip">
              {renaming[g.id] !== undefined ? (
                <input
                  autoFocus
                  value={renaming[g.id]}
                  maxLength={60}
                  style={{ width: '9rem', padding: '2px 6px' }}
                  onChange={(e) => setRenaming({ ...renaming, [g.id]: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setRenaming(Object.fromEntries(Object.entries(renaming).filter(([k]) => k !== g.id)));
                    if (e.key === 'Enter') act(g.id, 'Group renamed.', () => api(`/api/skill-groups/${g.id}`, { method: 'PATCH', body: { name: renaming[g.id] } })).then(() => setRenaming({}));
                  }}
                />
              ) : (
                <button type="button" className="chip-x" style={{ fontWeight: 600 }} onClick={() => setRenaming({ ...renaming, [g.id]: g.name })} title="Click to rename">
                  {g.name}
                </button>
              )}
              <button type="button" className="chip-x" aria-label={`Delete ${g.name}`} onClick={() => confirm(`Delete the ${g.name} group? Its roles are kept.`) && act(g.id, `Deleted ${g.name}.`, () => api(`/api/skill-groups/${g.id}`, { method: 'DELETE' }))}>
                ✕
              </button>
            </span>
          ))}
          {groups.length === 0 && <span className="muted small">No groups yet.</span>}
        </div>
        <form className="row" style={{ gap: 8 }} onSubmit={addGroup}>
          <input value={newGroup} onChange={(e) => setNewGroup(e.target.value)} placeholder="New group, e.g. Rigging" maxLength={60} required aria-label="New group name" style={{ maxWidth: '18rem' }} />
          <button className="btn small primary" disabled={busy === 'group'}>
            Add group
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Add a skill or role</h2>
        <form className="grid-form" onSubmit={add}>
          <label>
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Audio Tech" required maxLength={60} />
          </label>
          <label>
            Group
            <select value={f.groupId} onChange={(e) => setF({ ...f, groupId: e.target.value })}>
              <option value="">No group</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
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
                  <th>Group</th>
                  <th>Hourly rate</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sections.map(({ g, rows }) => (
                  <Fragment key={g?.id ?? 'none'}>
                    <tr className="group-row">
                      <td colSpan={5}>
                        <b>{g ? g.name : groups.length ? 'No group' : 'Roles'}</b> <span className="muted small">{rows.length} role{rows.length === 1 ? '' : 's'}</span>
                      </td>
                    </tr>
                    {rows.length === 0 && (
                      <tr>
                        <td colSpan={5} className="muted small">
                          No roles in this group yet. Choose it in the Group column of a role, or when adding one.
                        </td>
                      </tr>
                    )}
                {rows.map((s) => {
                  const e = edits[s.id];
                  return (
                    <tr key={s.id} className={s.active ? '' : 'inactive'}>
                      <td>
                        <input value={e?.name ?? s.name} onChange={(ev) => set(s, { name: ev.target.value })} aria-label={`Name of ${s.name}`} maxLength={60} />
                      </td>
                      <td>
                        <select value={s.groupId ?? ''} aria-label={`Group for ${s.name}`} disabled={!!busy} onChange={(ev) => act(s.id, `Moved ${s.name}.`, () => api(`/api/skills/${s.id}`, { method: 'PATCH', body: { groupId: ev.target.value || null } }))}>
                          <option value="">No group</option>
                          {groups.map((x) => (
                            <option key={x.id} value={x.id}>
                              {x.name}
                            </option>
                          ))}
                        </select>
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
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
