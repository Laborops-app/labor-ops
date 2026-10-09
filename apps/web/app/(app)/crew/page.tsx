'use client';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, Me, roleLabel } from '@/lib/api';

type Cert = { id: string; name: string; expires_on: string | null; verified: boolean; has_file: boolean };
type Member = { id: string; name: string; email: string; role: string; phone: string | null; skills: string[]; active: boolean; certs: Cert[]; has_availability: boolean };

const certState = (c: Cert) => {
  if (!c.expires_on) return '';
  const days = (new Date(c.expires_on + 'T23:59:59').getTime() - Date.now()) / 86400000;
  return days < 0 ? 'bad' : days < 30 ? 'warn' : '';
};
const certLabel = (c: Cert) => (c.expires_on ? `${c.name} · ${certState(c) === 'bad' ? 'expired' : 'exp'} ${c.expires_on}` : c.name) + (c.verified ? '' : ' · needs review');
const chipCls = (c: Cert) => (c.verified ? certState(c) : 'warn');

function Body({ me }: { me: Me }) {
  const [list, setList] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [f, setF] = useState({ name: '', email: '', phone: '', skills: '', role: 'crew' });
  const [open, setOpen] = useState<string | null>(null);
  const [cf, setCf] = useState({ name: '', expiresOn: '' });

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

  const addCert = async (m: Member, e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/crew/${m.id}/certs`, { body: { name: cf.name, expiresOn: cf.expiresOn || null } });
      setCf({ name: '', expiresOn: '' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const verifyCert = async (c: Cert) => {
    setError('');
    try {
      await api(`/api/certs/${c.id}/verify`, { body: {} });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const removeCert = async (c: Cert) => {
    setError('');
    try {
      await api(`/api/certs/${c.id}`, { method: 'DELETE' });
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
                <option value="manager">Labor Coordinator</option>
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
                  <th>Certificates</th>
                  <th>Contact</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((m) => (
                  <Fragment key={m.id}>
                    <tr className={m.active ? '' : 'inactive'}>
                      <td>
                        <Link href={`/crew/${m.id}`} className="shift-link"><b>{m.name}</b></Link>
                        {!m.active && <span className="muted small"> (inactive)</span>}
                        {m.role === 'crew' && m.has_availability && <div className="muted small">Set weekly availability</div>}
                      </td>
                      <td>{roleLabel(m.role)}</td>
                      <td>
                        {m.skills.map((s) => (
                          <span key={s} className="chip">
                            {s}
                          </span>
                        ))}
                      </td>
                      <td>
                        {m.certs.map((c) => (
                          <span key={c.id} className={`chip ${chipCls(c)}`}>
                            {certLabel(c)}
                          </span>
                        ))}
                        {m.role === 'crew' && (
                          <button className="btn ghost small" onClick={() => setOpen(open === m.id ? null : m.id)} aria-expanded={open === m.id}>
                            {open === m.id ? 'Close' : m.certs.length ? 'Edit' : '+ Add'}
                          </button>
                        )}
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
                    {open === m.id && (
                      <tr>
                        <td colSpan={6} className="cert-edit">
                          <form className="grid-form" onSubmit={(e) => addCert(m, e)}>
                            <label>
                              Certificate
                              <input value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} placeholder="Forklift" required />
                            </label>
                            <label>
                              Expires <span className="muted small">(optional)</span>
                              <input type="date" value={cf.expiresOn} onChange={(e) => setCf({ ...cf, expiresOn: e.target.value })} />
                            </label>
                            <div className="form-actions">
                              <button className="btn primary small">Save certificate</button>
                            </div>
                          </form>
                          {m.certs.length > 0 && (
                            <div className="row" style={{ marginTop: '0.6rem' }}>
                              {m.certs.map((c) => (
                                <span key={c.id} className={`chip ${chipCls(c)}`}>
                                  {certLabel(c)}{' '}
                                  {c.has_file && (
                                    <a href={`/api/certs/${c.id}/file`} target="_blank" rel="noopener noreferrer">
                                      View file
                                    </a>
                                  )}{' '}
                                  {!c.verified && (
                                    <button className="chip-x" onClick={() => verifyCert(c)} aria-label={`Verify ${c.name}`}>
                                      ✓ Verify
                                    </button>
                                  )}{' '}
                                  <button className="chip-x" onClick={() => removeCert(c)} aria-label={`Remove ${c.name}`}>
                                    ✕
                                  </button>
                                </span>
                              ))}
                            </div>
                          )}
                          <p className="muted small" style={{ margin: '0.5rem 0 0' }}>
                            Shifts that require this certificate can only be given to people who hold it, unexpired on the shift date. Saving the same name again renews it.
                          </p>
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
  return <Shell roles={['admin', 'manager']}>{(me) => <Body me={me} />}</Shell>;
}
