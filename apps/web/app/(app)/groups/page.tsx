'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api } from '@/lib/api';

type Group = { id: string; name: string; description: string | null; members: { id: string; name: string; active: boolean }[] };
type Crew = { id: string; name: string; role: string; active: boolean };

function Body() {
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [crew, setCrew] = useState<Crew[]>([]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const load = () => api<{ groups: Group[] }>('/api/crew-groups').then((r) => setGroups(r.groups)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api<{ crew: Crew[] }>('/api/crew').then((r) => setCrew(r.crew.filter((m) => m.role === 'crew' && m.active))).catch(() => {});
  }, []);
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try { await fn(); await load(); return true; } catch (e) { setError((e as Error).message); return false; }
  };
  const edit = (g: Group) => { setOpen(open === g.id ? null : g.id); setSel(new Set(g.members.map((m) => m.id))); };
  if (!groups) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  return (
    <>
      <h1>Crew groups</h1>
      <p className="muted">Pools of people you staff from, like an A-team. On an event, pick a group to fill a shift: the best-rated available people come first, and anyone already scheduled is left out.</p>
      {error && <Banner>{error}</Banner>}
      <section className="card">
        <form className="row" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api('/api/crew-groups', { body: { name } }))) setName(''); }}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New group, e.g. Audio A-team" maxLength={80} required aria-label="New group name" style={{ maxWidth: '20rem' }} />
          <button className="btn primary">Add group</button>
        </form>
      </section>
      {groups.length === 0 && <Empty>No groups yet.</Empty>}
      {groups.map((g) => (
        <section className="card" key={g.id}>
          <div className="row space">
            <div>
              <h2>{g.name}</h2>
              <div className="muted small">{g.members.length} member{g.members.length === 1 ? '' : 's'}{g.members.length ? ': ' + g.members.map((m) => m.name).join(', ') : ''}</div>
            </div>
            <span className="row">
              <button className="btn small" onClick={() => edit(g)} aria-expanded={open === g.id}>{open === g.id ? 'Close' : 'Edit members'}</button>
              <button className="btn ghost small" onClick={() => confirm(`Delete the ${g.name} group?`) && run(() => api(`/api/crew-groups/${g.id}`, { method: 'DELETE' }))}>Delete</button>
            </span>
          </div>
          {open === g.id && (
            <>
              <div className="chips" style={{ maxHeight: '16rem', overflow: 'auto' }}>
                {crew.map((m) => (
                  <label key={m.id} className="row" style={{ gap: '.4rem', margin: '.2rem 0' }}>
                    <input type="checkbox" style={{ width: 'auto' }} checked={sel.has(m.id)} onChange={(e) => { const n = new Set(sel); e.target.checked ? n.add(m.id) : n.delete(m.id); setSel(n); }} />
                    {m.name}
                  </label>
                ))}
                {!crew.length && <span className="muted">No active crew yet.</span>}
              </div>
              <button className="btn primary" onClick={async () => { if (await run(() => api(`/api/crew-groups/${g.id}/members`, { method: 'PUT', body: { userIds: [...sel] } }))) setOpen(null); }}>Save members</button>
            </>
          )}
        </section>
      ))}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
