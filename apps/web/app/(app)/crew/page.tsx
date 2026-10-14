'use client';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Stars, roleKey } from '@/components/Stars';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, Me, roleLabel } from '@/lib/api';
import SkillPicker, { useSkillNames, useSkillSections } from '@/components/SkillPicker';
import Modal from '@/components/Modal';
import TopbarAction, { PlusIcon, EditIcon, SearchIcon, avClass, initialsOf } from '@/components/TopbarAction';

type Cert = { id: string; name: string; expires_on: string | null; verified: boolean; has_file: boolean };
type Member = { id: string; name: string; email: string; role: string; phone: string | null; skills: string[]; active: boolean; certs: Cert[]; has_availability: boolean; can_adjust_rates?: boolean; ratings?: Record<string, number> };

const certState = (c: Cert) => {
  if (!c.expires_on) return '';
  const days = (new Date(c.expires_on + 'T23:59:59').getTime() - Date.now()) / 86400000;
  return days < 0 ? 'bad' : days < 30 ? 'warn' : '';
};
const certLabel = (c: Cert) => (c.expires_on ? `${c.name} · ${certState(c) === 'bad' ? 'expired' : 'exp'} ${c.expires_on}` : c.name) + (c.verified ? '' : ' · needs review');
const chipCls = (c: Cert) => (c.verified ? certState(c) : 'warn');

function Body({ me }: { me: Me }) {
  const router = useRouter();
  const [list, setList] = useState<Member[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [f, setF] = useState({ name: '', email: '', phone: '', skills: [] as string[], role: 'crew' });
  const skillNames = useSkillNames();
  const skillSections = useSkillSections();
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
          skills: f.skills,
        },
      });
      setNotice(`Added ${r.member.name}. Temporary password: ${r.tempPassword} — share it with them now, it is not shown again.`);
      setF({ name: '', email: '', phone: '', skills: [], role: 'crew' });
      load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
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

  const [adding, setAdding] = useState(false);
  const [view, setView] = useState<'all' | 'crew' | 'manager' | 'inactive'>('all');
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const rows = (list ?? []).filter((m) =>
    (view === 'all' ? m.active || m.role !== 'crew' : view === 'inactive' ? !m.active : m.role === view && m.active) &&
    (!needle || `${m.name} ${m.email} ${m.phone ?? ''} ${m.skills.join(' ')}`.toLowerCase().includes(needle)),
  );
  const count = (v: typeof view) => (list ?? []).filter((m) => (v === 'all' ? m.active || m.role !== 'crew' : v === 'inactive' ? !m.active : m.role === v && m.active)).length;
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return (
    <>
      <h1>Crew</h1>
      <TopbarAction>
        <button className="btn primary" onClick={() => setAdding(true)}>
          Add Crew Member
          <PlusIcon />
        </button>
      </TopbarAction>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {notice && (
        <Banner kind="ok" onClose={() => setNotice('')}>
          {notice}
        </Banner>
      )}

      <div className="list-head">
        <div className="row" style={{ gap: 16 }}>
          <div className="total">Total: {list ? rows.length : '…'} {rows.length === 1 ? 'person' : 'people'}</div>
          <div className="phase-tabs" role="tablist" aria-label="Who to show" style={{ margin: 0 }}>
            {([['all', 'Everyone'], ['crew', 'Crew'], ['manager', 'Coordinators'], ['inactive', 'Inactive']] as const).map(([v, label]) => (
              <button key={v} type="button" role="tab" aria-selected={view === v} className={view === v ? 'tab on' : 'tab'} onClick={() => setView(v)}>
                {label} ({count(v)})
              </button>
            ))}
          </div>
        </div>
        <div className="controls">
          <span className="pill-input">
            <SearchIcon />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, skill, phone" aria-label="Search crew" />
          </span>
        </div>
      </div>

      {!list ? (
        <div className="muted">Loading…</div>
      ) : rows.length === 0 ? (
        <Empty>{list.length ? 'Nobody matches.' : 'No crew yet. Add your first crew member.'}</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dlist">
            <thead>
              <tr>
                <th className="av-col" aria-label="Avatar" />
                <th>Name</th>
                <th>Role</th>
                <th>Skills</th>
                <th>Certificates</th>
                <th className="hide-sm">Phone</th>
                <th className="hide-sm" />
                <th className="edit-col">Edit</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <Fragment key={m.id}>
                  <tr className={m.active ? '' : 'inactive'} onClick={() => router.push(`/crew/${m.id}`)}>
                    <td className="av-col"><span className={avClass(m.name)} aria-hidden="true">{initialsOf(m.name)}</span></td>
                    <td>
                      <Link href={`/crew/${m.id}`} className="rowlink" onClick={stop}>{m.name}</Link>
                      <span className="sub">{m.email}{!m.active ? ' · inactive' : ''}</span>
                    </td>
                    <td><span className={m.role === 'crew' ? 'pill past' : 'pill'}>{roleLabel(m.role)}</span></td>
                    <td className="wrap" onClick={stop} style={{ cursor: 'default' }}>
                      {m.skills.length === 0 && <span className="muted">—</span>}
                      {m.skills.map((s) => (
                        <span key={s} className="chip">
                          {s}
                          {m.role === 'crew' && (
                            <Stars
                              label={`${m.name} as ${s}`}
                              value={m.ratings?.[roleKey(s)]}
                              onChange={(n) =>
                                api<{ ratings: Record<string, number> }>(`/api/crew/${m.id}/ratings`, { method: 'PUT', body: { role: s, stars: n } })
                                  .then((r) => setList((l) => l && l.map((x) => (x.id === m.id ? { ...x, ratings: r.ratings } : x))))
                                  .catch((e) => setError(e.message))
                              }
                            />
                          )}
                        </span>
                      ))}
                    </td>
                    <td className="wrap" onClick={stop} style={{ cursor: 'default' }}>
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
                    <td className="hide-sm">{m.phone ?? <span className="muted">—</span>}</td>
                    <td className="hide-sm" onClick={stop} style={{ cursor: 'default' }}>
                      {m.role === 'manager' && me.role === 'admin' && (
                        <label className="check small" title="Lets this coordinator change pay and bill rates, including on quotes" style={{ fontWeight: 500 }}>
                          <input type="checkbox" checked={!!m.can_adjust_rates} onChange={(e) => api(`/api/crew/${m.id}/rate-permission`, { method: 'PUT', body: { allowed: e.target.checked } }).then(() => setList((l) => l && l.map((x) => (x.id === m.id ? { ...x, can_adjust_rates: e.target.checked } : x)))).catch((x) => setError(x.message))} />
                          {' '}Can adjust rates
                        </label>
                      )}
                      {m.role === 'crew' && (
                        <button className="btn ghost small" onClick={() => toggle(m)}>
                          {m.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      )}
                    </td>
                    <td className="edit-col">
                      <Link href={`/crew/${m.id}`} className="btn-round sm" aria-label={`Edit ${m.name}`} onClick={stop} style={{ border: 0, background: 'transparent' }}>
                        <EditIcon />
                      </Link>
                    </td>
                  </tr>
                  {open === m.id && (
                    <tr onClick={stop} style={{ cursor: 'default' }}>
                      <td colSpan={8} className="cert-edit wrap" style={{ height: 'auto', padding: '16px 12px', maxWidth: 'none' }}>
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

      {adding && (
        <Modal title="Add Crew Member" onClose={() => setAdding(false)}>
          <form onSubmit={(e) => add(e).then((ok) => ok && setAdding(false))}>
            <div className="two">
              <label>
                Name
                <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required autoFocus />
              </label>
              <label>
                Phone
                <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
              </label>
            </div>
            <label>
              Email
              <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
            </label>
            <div className="field" role="group" aria-label="Skills">
              <span className="field-label" style={{ fontWeight: 700, fontSize: 14 }}>Skills</span>
              <SkillPicker value={f.skills} onChange={(skills) => setF({ ...f, skills })} options={skillNames} sections={skillSections} />
            </div>
            {me.role === 'admin' && (
              <label>
                Role
                <select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
                  <option value="crew">Crew</option>
                  <option value="manager">Labor Coordinator</option>
                </select>
              </label>
            )}
            <div className="acts">
              <button type="button" className="btn" onClick={() => setAdding(false)}>Cancel</button>
              <button className="btn primary">Add {f.role === 'manager' ? 'Coordinator' : 'Crew Member'}</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{(me) => <Body me={me} />}</Shell>;
}
