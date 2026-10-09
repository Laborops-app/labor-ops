'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, Me } from '@/lib/api';

type Member = { id: string; name: string; email: string; role: string; phone: string | null; skills: string[]; active: boolean };

function Body({ me }: { me: Me }) {
  const [list, setList] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [f, setF] = useState({ name: '', email: '', phone: '', skills: '', role: 'crew' });

  const load = () =>
    api<{ crew: Member[] }>('/api/crew')
      .then((r) => setList(r.crew))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setNotice('');
    try {
      const r = await api<{ member: Member; tempPassword?: string }>('/api/crew', {
        body: {
          name: f.name,
          email: f.email,
          phone: f.phone || null,
          role: f.role,
          skills: f.skills.split(',').map((s) => s.trim()).filter(Boolean),
        },
      });
      setNotice(`Added ${r.member.name}. Temporary password: ${r.tempPassword} — share it with them now, it is not shown again.`);
      setF({ name: '', email: '', phone: '', skills: '', role: 'crew' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggle = async (m: Member) => {
    setError('');
    try {
      await api(`/api/crew/${m.id}`, { method: 'PATCH', body: { active: !m.active } });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <>
      <h1>Crew</h1>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {notice && (
        <Banner kind="ok" onClose={() => setNotice('')}>
          {notice}
        </Banner>
      )}
      <section className="card">
        <h2>Add someone</h2>
        <form className="grid-form" onSubmit={add}>
          <label>
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </label>
          <label>
            Email
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          </label>
          <label>
            Phone
            <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          </label>
          <label>
            Skills <span className="muted small">(comma separated)</span>
            <input value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} placeholder="Audio, Rigging" />
          </label>
          {me.role === 'admin' && (
            <label>
              Role
              <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                <option value="crew">Crew</option>
                <option value="manager">Manager</option>
              </select>
            </label>
          )}
          <div className="form-actions">
            <button className="btn primary">Add</button>
          </div>
        </form>
      </section>
      <section className="card">
        {!list ? (
          <div className="muted">Loading…</div>
        ) : list.length === 0 ? (
          <Empty>No crew yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Skills</th>
                  <th>Contact</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id} className={m.active ? '' : 'inactive'}>
                    <td>
                      <b>{m.name}</b>
                      {!m.active && <span className="muted small"> (inactive)</span>}
                    </td>
                    <td>{m.role}</td>
                    <td>
                      {m.skills.map((s) => (
                        <span key={s} className="chip">
                          {s}
                        </span>
                      ))}
                    </td>
                    <td className="small">
                      {m.email}
                      {m.phone ? <div className="muted">{m.phone}</div> : null}
                    </td>
                    <td>
                      {m.role === 'crew' && (
                        <button className="btn ghost small" onClick={() => toggle(m)}>
                          {m.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
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
  return <Shell roles={['admin', 'manager']}>{(me) => <Body me={me} />}</Shell>;
}
