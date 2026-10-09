'use client';
import { useEffect, useRef, useState } from 'react';
import Shell, { initials } from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, ApiError, roleLabel } from '@/lib/api';
import SkillPicker, { useSkillNames } from '@/components/SkillPicker';

type User = {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string | null;
  address: string | null;
  emergency_name: string | null;
  emergency_phone: string | null;
  bio: string | null;
  skills: string[];
};
type Cert = { id: string; name: string; expires_on: string | null; verified: boolean; file_name: string | null; file_size: number | null; file_type: string | null };

const MAX = 5 * 1024 * 1024;
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const days = (d: string) => (new Date(d + 'T23:59:59').getTime() - Date.now()) / 86400000;

async function upload(certId: string, file: File) {
  if (file.size > MAX) throw new Error('That file is over 5 MB');
  const res = await fetch(`/api/my/certs/${certId}/file?filename=${encodeURIComponent(file.name)}`, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream' },
    body: file,
    credentials: 'same-origin',
  });
  if (!res.ok) {
    let msg = `Upload failed (${res.status})`;
    try {
      msg = (await res.json()).error ?? msg;
    } catch {}
    throw new ApiError(msg, res.status);
  }
}

function Body({ role }: { role: string }) {
  const [u, setU] = useState<User | null>(null);
  const [certs, setCerts] = useState<Cert[]>([]);
  const [f, setF] = useState({ name: '', phone: '', address: '', emergencyName: '', emergencyPhone: '', bio: '', skills: [] as string[] });
  const skillNames = useSkillNames();
  const [pw, setPw] = useState({ current: '', next: '', again: '' });
  const [cf, setCf] = useState<{ name: string; expiresOn: string; file: File | null }>({ name: '', expiresOn: '', file: null });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replaceFor, setReplaceFor] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api<{ user: User; certs: Cert[] }>('/api/my/profile');
      setU(r.user);
      setCerts(r.certs);
      setF({
        name: r.user.name,
        phone: r.user.phone ?? '',
        address: r.user.address ?? '',
        emergencyName: r.user.emergency_name ?? '',
        emergencyPhone: r.user.emergency_phone ?? '',
        bio: r.user.bio ?? '',
        skills: r.user.skills,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
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

  const saveProfile = (e: React.FormEvent) => {
    e.preventDefault();
    act('profile', 'Profile saved.', () =>
      api('/api/my/profile', {
        method: 'PATCH',
        body: {
          name: f.name,
          phone: f.phone,
          address: f.address,
          emergencyName: f.emergencyName,
          emergencyPhone: f.emergencyPhone,
          bio: f.bio,
          skills: f.skills,
        },
      }),
    );
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.next !== pw.again) return setError('The new passwords do not match.');
    if (await act('pw', 'Password changed.', () => api('/api/my/password', { body: { current: pw.current, next: pw.next } }))) setPw({ current: '', next: '', again: '' });
  };

  const addCert = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = cf.file;
    if (await act('cert', file ? 'Certificate added with its file. A labor coordinator will review it.' : 'Certificate added. A labor coordinator will review it.', async () => {
      const r = await api<{ cert: { id: string } }>('/api/my/certs', { body: { name: cf.name, expiresOn: cf.expiresOn || null } });
      if (file) await upload(r.cert.id, file);
    })) {
      setCf({ name: '', expiresOn: '', file: null });
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const status = (c: Cert) => {
    if (c.expires_on && days(c.expires_on) < 0) return { cls: 'bad', label: 'Expired' };
    if (!c.verified) return { cls: 'warn', label: 'Waiting for review' };
    if (c.expires_on && days(c.expires_on) < 30) return { cls: 'warn', label: 'Expires soon' };
    return { cls: 'open', label: 'Verified' };
  };

  if (!u) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const isCrew = role === 'crew';

  return (
    <>
      <div className="profile-head">
        <span className="avatar solid big" aria-hidden="true">
          {initials(u.name)}
        </span>
        <div>
          <h1>{u.name}</h1>
          <div className="muted">
            {u.email} · {roleLabel(u.role)}
          </div>
        </div>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && (
        <Banner kind="ok" onClose={() => setOk('')}>
          {ok}
        </Banner>
      )}

      <form className="card" onSubmit={saveProfile}>
        <h2>About you</h2>
        <div className="grid-form">
          <label>
            Full name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={100} />
          </label>
          <label>
            Phone
            <input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="555-555-5555" maxLength={40} />
          </label>
          <label>
            Home address
            <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} placeholder="Street, city, state" maxLength={300} autoComplete="street-address" />
          </label>
          <label>
            Email
            <input value={u.email} disabled />
          </label>
          {isCrew && (
            <label style={{ gridColumn: '1 / -1' }}>
              Skills
              <SkillPicker value={f.skills} onChange={(skills) => setF({ ...f, skills })} options={skillNames} />
            </label>
          )}
          <label style={{ gridColumn: '1 / -1' }}>
            About me <span className="muted small">(optional — experience, anything your labor coordinator should know)</span>
            <textarea rows={3} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={1000} />
          </label>
        </div>
        <h2 style={{ marginTop: 20 }}>Emergency contact</h2>
        <div className="grid-form">
          <label>
            Name
            <input value={f.emergencyName} onChange={(e) => setF({ ...f, emergencyName: e.target.value })} maxLength={100} />
          </label>
          <label>
            Phone
            <input type="tel" value={f.emergencyPhone} onChange={(e) => setF({ ...f, emergencyPhone: e.target.value })} maxLength={40} />
          </label>
          <div className="form-actions">
            <button className="btn primary" disabled={busy === 'profile'}>
              Save profile
            </button>
          </div>
        </div>
      </form>

      {isCrew && (
        <section className="card">
          <h2>My certificates</h2>
          <p className="muted small">
            Add each certificate with its expiry date and a photo or PDF of it (up to 5 MB). A labor coordinator reviews it before it counts for shifts that require it.
          </p>
          {certs.length === 0 ? (
            <p className="muted">No certificates yet.</p>
          ) : (
            <ul className="plain certs">
              {certs.map((c) => {
                const st = status(c);
                return (
                  <li key={c.id} className="cert-row">
                    <div className="grow">
                      <b>{c.name}</b> <span className={`chip ${st.cls}`}>{st.label}</span>
                      <div className="muted small">
                        {c.expires_on ? `Expires ${c.expires_on}` : 'No expiry date'}
                        {c.file_name && (
                          <>
                            {' · '}
                            <a href={`/api/certs/${c.id}/file`} target="_blank" rel="noopener noreferrer">
                              {c.file_name}
                            </a>{' '}
                            ({kb(c.file_size ?? 0)})
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      className="btn ghost small"
                      disabled={!!busy}
                      onClick={() => {
                        setReplaceFor(c.id);
                        replaceRef.current?.click();
                      }}
                    >
                      {c.file_name ? 'Replace file' : 'Upload file'}
                    </button>
                    <button
                      className="btn ghost small danger"
                      disabled={!!busy}
                      onClick={() => confirm(`Remove ${c.name}?`) && act('del', 'Certificate removed.', () => api(`/api/my/certs/${c.id}`, { method: 'DELETE' }))}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <input
            ref={replaceRef}
            type="file"
            accept="application/pdf,image/png,image/jpeg"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              const id = replaceFor;
              e.target.value = '';
              if (file && id) act('up', 'File uploaded. A labor coordinator will review it.', () => upload(id, file));
            }}
          />

          <form className="cert-add" onSubmit={addCert}>
            <h3>Add a certificate</h3>
            <div className="grid-form">
              <label>
                Name
                <input value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} placeholder="Forklift, First Aid, Rigging…" required maxLength={60} />
              </label>
              <label>
                Expires
                <input type="date" value={cf.expiresOn} onChange={(e) => setCf({ ...cf, expiresOn: e.target.value })} />
              </label>
              <label>
                Photo or PDF
                <input ref={fileRef} type="file" accept="application/pdf,image/png,image/jpeg" onChange={(e) => setCf({ ...cf, file: e.target.files?.[0] ?? null })} />
              </label>
              <div className="form-actions">
                <button className="btn primary" disabled={busy === 'cert'}>
                  Add certificate
                </button>
              </div>
            </div>
          </form>
        </section>
      )}

      <form className="card" onSubmit={savePassword}>
        <h2>Change password</h2>
        <div className="grid-form">
          <label>
            Current password
            <input type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" required />
          </label>
          <label>
            New password <span className="muted small">(8+ characters)</span>
            <input type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} minLength={8} autoComplete="new-password" required />
          </label>
          <label>
            New password again
            <input type="password" value={pw.again} onChange={(e) => setPw({ ...pw, again: e.target.value })} minLength={8} autoComplete="new-password" required />
          </label>
          <div className="form-actions">
            <button className="btn" disabled={busy === 'pw'}>
              Change password
            </button>
          </div>
        </div>
      </form>
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew', 'manager', 'admin']}>{(me) => <Body role={me.role} />}</Shell>;
}
