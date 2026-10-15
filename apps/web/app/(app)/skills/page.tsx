'use client';
import { Fragment, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, Me } from '@/lib/api';

type Skill = { id: string; name: string; payRate: number; dayRate?: number; billRate?: number; dayBillRate?: number; active: boolean; groupId: string | null; isLead?: boolean };
type Group = { id: string; name: string };
type Edit = { name: string; payRate: string; dayRate: string; billRate: string; dayBillRate: string };

const OPEN_KEY = 'lo_roles_open';
const money = (n: number) => n.toLocaleString([], { style: 'currency', currency: 'USD' });

/** A coordinator who may adjust rates sees both rates for every role and can change only those. */
function RatesOnly() {
  const [list, setList] = useState<Skill[] | null>(null);
  const [ed, setEd] = useState<Record<string, { pay: string; day: string; bill: string; dbill: string }>>({});
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = () => api<{ skills: Skill[] }>('/api/skills').then((r) => setList(r.skills.filter((s) => s.active))).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const save = async (s: Skill) => {
    const e = ed[s.id];
    if (!e) return;
    setError('');
    try {
      await api(`/api/skills/${s.id}`, { method: 'PATCH', body: { payRate: Math.round(Number(e.pay) * 100) / 100, dayRate: Math.round(Number(e.day) * 100) / 100, dayBillRate: Math.round(Number(e.dbill) * 100) / 100, billRate: Math.round(Number(e.bill) * 100) / 100 } });
      setNote(`Saved rates for ${s.name}.`);
      setEd(({ [s.id]: _, ...rest }) => rest);
      load();
    } catch (x) { setError((x as Error).message); }
  };
  return (
    <>
      <h1>Roles &amp; rates</h1>
      <p className="muted">Each role has two rates: the <b>pay rate</b> crew are paid, and the <b>bill rate</b> customers are quoted and invoiced. You can change either. Pay changes apply to every shift of that role from now on.</p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
      {!list ? <div className="muted">Loading…</div> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Role</th><th>Pay rate /hr</th><th>Day rate</th><th>Bill rate /hr</th><th>Day bill rate</th><th>Margin</th><th></th></tr></thead>
            <tbody>
              {list.map((s) => {
                const e = ed[s.id];
                const pay = e ? Number(e.pay) : s.payRate;
                const bill = e ? Number(e.bill) : s.billRate ?? 0;
                return (
                  <tr key={s.id}>
                    <td>{s.name}</td>
                    <td><input type="number" min={0} step="0.01" value={e?.pay ?? s.payRate.toFixed(2)} onChange={(ev) => setEd({ ...ed, [s.id]: { pay: ev.target.value, day: e?.day ?? String(s.dayRate ?? 0), bill: e?.bill ?? String(s.billRate ?? 0), dbill: e?.dbill ?? String(s.dayBillRate ?? 0) } })} aria-label={`Pay rate for ${s.name}`} style={{ width: '7rem' }} /></td>
                    <td><input type="number" min={0} step="0.01" value={e?.day ?? (s.dayRate ?? 0).toFixed(2)} onChange={(ev) => setEd({ ...ed, [s.id]: { pay: e?.pay ?? String(s.payRate), day: ev.target.value, bill: e?.bill ?? String(s.billRate ?? 0), dbill: e?.dbill ?? String(s.dayBillRate ?? 0) } })} aria-label={`Day rate for ${s.name}`} style={{ width: '7rem' }} /></td>
                    <td><input type="number" min={0} step="0.01" value={e?.bill ?? (s.billRate ?? 0).toFixed(2)} onChange={(ev) => setEd({ ...ed, [s.id]: { pay: e?.pay ?? String(s.payRate), day: e?.day ?? String(s.dayRate ?? 0), bill: ev.target.value, dbill: e?.dbill ?? String(s.dayBillRate ?? 0) } })} aria-label={`Bill rate for ${s.name}`} style={{ width: '7rem' }} /></td>
                    <td><input type="number" min={0} step="0.01" value={e?.dbill ?? (s.dayBillRate ?? 0).toFixed(2)} onChange={(ev) => setEd({ ...ed, [s.id]: { pay: e?.pay ?? String(s.payRate), day: e?.day ?? String(s.dayRate ?? 0), bill: e?.bill ?? String(s.billRate ?? 0), dbill: ev.target.value } })} aria-label={`Day bill rate for ${s.name}`} style={{ width: '7rem' }} /></td>
                    <td className="small">{bill > 0 ? `${Math.round(((bill - pay) / bill) * 100)}%` : '—'}</td>
                    <td>{e && <button className="btn small primary" onClick={() => save(s)}>Save</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Body() {
  const [list, setList] = useState<Skill[] | null>(null);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [groups, setGroups] = useState<Group[]>([]);
  const [f, setF] = useState({ name: '', payRate: '', dayRate: '', billRate: '', dayBillRate: '', groupId: '' });
  const [newGroup, setNewGroup] = useState('');
  const [renaming, setRenaming] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  // Which groups are expanded in the roles table. Collapsed by default; remembered on this device.
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]');
      if (Array.isArray(v)) setOpen(new Set(v.filter((x) => typeof x === 'string')));
    } catch {}
  }, []);
  const setOpenSaved = (next: Set<string>) => {
    setOpen(next);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify([...next])); } catch {}
  };
  const toggle = (k: string) => {
    const next = new Set(open);
    if (next.has(k)) next.delete(k); else next.add(k);
    setOpenSaved(next);
  };

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
    if (await act('add', `Added ${f.name}.`, () => api('/api/skills', { body: { name: f.name, payRate: n, dayRate: rateNum(f.dayRate || '0') || 0, billRate: rateNum(f.billRate || '0') || 0, dayBillRate: rateNum(f.dayBillRate || '0') || 0, groupId: f.groupId || null } }))) {
      if (!open.has(f.groupId || 'none')) toggle(f.groupId || 'none');
      setF({ name: '', payRate: '', dayRate: '', billRate: '', dayBillRate: '', groupId: f.groupId });
    }
  };
  const save = (s: Skill) => {
    const e = edits[s.id];
    if (!e) return;
    const n = rateNum(e.payRate);
    if (!Number.isFinite(n) || n < 0) return setError('Enter a pay rate of 0 or more.');
    act(s.id, `Saved ${e.name}.`, () => api(`/api/skills/${s.id}`, { method: 'PATCH', body: { name: e.name, payRate: n, dayRate: rateNum(e.dayRate) || 0, billRate: rateNum(e.billRate) || 0, dayBillRate: rateNum(e.dayBillRate) || 0 } }));
  };
  const set = (s: Skill, patch: Partial<Edit>) => setEdits({ ...edits, [s.id]: { name: edits[s.id]?.name ?? s.name, payRate: edits[s.id]?.payRate ?? String(s.payRate), dayRate: edits[s.id]?.dayRate ?? String(s.dayRate ?? 0), billRate: edits[s.id]?.billRate ?? String(s.billRate ?? 0), dayBillRate: edits[s.id]?.dayBillRate ?? String(s.dayBillRate ?? 0), ...patch } });

  const addGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (await act('group', `Added the ${newGroup} group.`, () => api('/api/skill-groups', { body: { name: newGroup } }))) setNewGroup('');
  };
  const sections = list
    ? [...groups.map((g) => ({ g: g as Group | null, rows: list.filter((s) => s.groupId === g.id) })), { g: null as Group | null, rows: list.filter((s) => !s.groupId || !groups.some((g) => g.id === s.groupId)) }].filter((x) => x.g || x.rows.length)
    : [];

  // A single section has nothing to collapse into, so it always shows.
  const isOpen = (k: string, rows: Skill[]) => sections.length <= 1 || open.has(k) || rows.some((r) => edits[r.id]);
  const allOpen = sections.length > 0 && sections.every((x) => isOpen(x.g?.id ?? 'none', x.rows));
  const range = (rows: Skill[]) => {
    const r = rows.filter((x) => x.active).map((x) => x.payRate);
    if (!r.length) return '';
    const lo = Math.min(...r), hi = Math.max(...r);
    return lo === hi ? `${money(lo)}/hr` : `${money(lo)}–${money(hi)}/hr`;
  };
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
          <label>
            Day rate (USD, flat per day)
            <input type="number" min={0} max={10000} step="0.01" inputMode="decimal" value={f.dayRate} onChange={(e) => setF({ ...f, dayRate: e.target.value })} placeholder="250.00" />
          </label>
          <label>
            Hourly billing rate (USD, for quotes)
            <input type="number" min={0} max={10000} step="0.01" inputMode="decimal" value={f.billRate} onChange={(e) => setF({ ...f, billRate: e.target.value })} placeholder="45.00" />
          </label>
          <label>
            Day billing rate (USD, flat per day)
            <input type="number" min={0} max={10000} step="0.01" inputMode="decimal" value={f.dayBillRate} onChange={(e) => setF({ ...f, dayBillRate: e.target.value })} placeholder="450.00" />
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
            <div className="row" style={{ gap: 10 }}>
              <span className="muted small">
                {active} active · average {money(avg)}/hr
              </span>
              {sections.length > 1 && (
                <button type="button" className="btn ghost small" onClick={() => setOpenSaved(allOpen ? new Set() : new Set(sections.map((x) => x.g?.id ?? 'none')))}>
                  {allOpen ? 'Collapse all' : 'Expand all'}
                </button>
              )}
            </div>
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
                  <th>Pay rate</th>
                  <th>Day rate</th>
                  <th>Bill rate</th>
                  <th>Day bill rate</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sections.map(({ g, rows }) => {
                  const k = g?.id ?? 'none';
                  const shown = isOpen(k, rows);
                  return (
                  <Fragment key={k}>
                    <tr className={`group-row${shown ? ' open' : ''}`}>
                      <td colSpan={8}>
                        <button type="button" className="group-toggle" aria-expanded={shown} onClick={() => toggle(k)} disabled={sections.length <= 1}>
                          {sections.length > 1 && (
                            <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                          )}
                          <b>{g ? g.name : groups.length ? 'No group' : 'Roles'}</b>
                          <span className="muted small">{rows.length} role{rows.length === 1 ? '' : 's'}</span>
                          {!shown && range(rows) && <span className="muted small grp-range">{range(rows)}</span>}
                        </button>
                      </td>
                    </tr>
                    {shown && rows.length === 0 && (
                      <tr>
                        <td colSpan={8} className="muted small">
                          No roles in this group yet. Choose it in the Group column of a role, or when adding one.
                        </td>
                      </tr>
                    )}
                {shown && rows.map((s) => {
                  const e = edits[s.id];
                  return (
                    <tr key={s.id} className={s.active ? '' : 'inactive'}>
                      <td>
                        <input value={e?.name ?? s.name} onChange={(ev) => set(s, { name: ev.target.value })} aria-label={`Name of ${s.name}`} maxLength={60} />
                        <label className="check lead-role-check" title="Whoever is put on a shift with this role leads their department on that event">
                          <input type="checkbox" checked={!!s.isLead} disabled={!!busy} onChange={(ev) => act(s.id, ev.target.checked ? `${s.name} is a lead role.` : `${s.name} is no longer a lead role.`, () => api(`/api/skills/${s.id}`, { method: 'PATCH', body: { isLead: ev.target.checked } }))} />
                          Lead role
                        </label>
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
                      <td>
                        <span className="money-input">
                          <span aria-hidden="true">$</span>
                          <input type="number" min={0} max={10000} step="0.01" inputMode="decimal" value={e?.dayRate ?? (s.dayRate ?? 0).toFixed(2)} onChange={(ev) => set(s, { dayRate: ev.target.value })} aria-label={`Day rate for ${s.name}`} />
                          <span className="muted small">/day</span>
                        </span>
                      </td>
                      <td>
                        <span className="money-input">
                          <span aria-hidden="true">$</span>
                          <input type="number" min={0} max={10000} step="0.01" inputMode="decimal" value={e?.billRate ?? (s.billRate ?? 0).toFixed(2)} onChange={(ev) => set(s, { billRate: ev.target.value })} aria-label={`Billing rate for ${s.name}`} />
                          <span className="muted small">/hr</span>
                        </span>
                      </td>
                      <td>
                        <span className="money-input">
                          <span aria-hidden="true">$</span>
                          <input type="number" min={0} max={10000} step="0.01" inputMode="decimal" value={e?.dayBillRate ?? (s.dayBillRate ?? 0).toFixed(2)} onChange={(ev) => set(s, { dayBillRate: ev.target.value })} aria-label={`Day billing rate for ${s.name}`} />
                          <span className="muted small">/day</span>
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
  return <Shell roles={['admin', 'manager']}>{(me: Me) => (me.role === 'admin' ? <Body /> : <RatesOnly />)}</Shell>;
}
