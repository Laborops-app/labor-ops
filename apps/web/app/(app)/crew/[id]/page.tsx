'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import Shell, { initials } from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, ApiError, roleLabel } from '@/lib/api';
import SkillPicker, { useSkillNames } from '@/components/SkillPicker';

type Member = {
  id: string;
  name: string;
  email: string;
  role: string;
  phone: string | null;
  address: string | null;
  emergency_name: string | null;
  emergency_phone: string | null;
  bio: string | null;
  coordinator_notes: string | null;
  skills: string[];
  active: boolean;
};
type Cert = { id: string; name: string; expires_on: string | null; verified: boolean; file_name: string | null; file_size: number | null };
type Detail = {
  member: Member;
  certs: Cert[];
  windows: { weekday: number; start_time: string; end_time: string }[];
  timeOff: { id: string; starts_on: string; ends_on: string; note: string | null }[];
};

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MAX = 5 * 1024 * 1024;
const kb = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const days = (d: string) => (new Date(d + 'T23:59:59').getTime() - Date.now()) / 86400000;

async function upload(certId: string, file: File) {
  if (file.size > MAX) throw new Error('That file is over 5 MB');
  const res = await fetch(`/api/certs/${certId}/file?filename=${encodeURIComponent(file.name)}`, {
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

function Body() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [f, setF] = useState({ name: '', email: '', phone: '', address: '', emergencyName: '', emergencyPhone: '', bio: '', coordinatorNotes: '', skills: [] as string[] });
  const skillNames = useSkillNames();
  const [cf, setCf] = useState<{ name: string; expiresOn: string; file: File | null }>({ name: '', expiresOn: '', file: null });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  const [replaceFor, setReplaceFor] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await api<Detail>(`/api/crew/${id}`);
      setD(r);
      const m = r.member;
      setF({
        name: m.name,
        email: m.email,
        phone: m.phone ?? '',
        address: m.address ?? '',
        emergencyName: m.emergency_name ?? '',
        emergencyPhone: m.emergency_phone ?? '',
        bio: m.bio ?? '',
        coordinatorNotes: m.coordinator_notes ?? '',
        skills: m.skills,
      });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const act = async (key: string, msg: string, fn: () => Promise<unknown>) => {
    setError('');
    setOk('');
    setBusy(key);
    try {
      await fn();
      if (msg) setOk(msg);
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy('');
    }
  };

  if (!d) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const m = d.member;

  const save = (e: React.FormEvent) => {
    e.preventDefault();
    act('save', 'Saved.', () =>
      api(`/api/crew/${id}`, {
        method: 'PATCH',
        body: f,
      }),
    );
  };
  const addCert = async (e: React.FormEvent) => {
    e.preventDefault();
    const file = cf.file;
    if (
      await act('cert', 'Certificate saved.', async () => {
        const r = await api<{ cert: { id: string } }>(`/api/crew/${id}/certs`, { body: { name: cf.name, expiresOn: cf.expiresOn || null } });
        if (file) await upload(r.cert.id, file);
      })
    ) {
      setCf({ name: '', expiresOn: '', file: null });
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const resetPw = () => {
    if (!confirm(`Set a new temporary password for ${m.name}? Their current password will stop working.`)) return;
    act('pw', '', async () => {
      const r = await api<{ tempPassword: string }>(`/api/crew/${id}/password`, { body: {} });
      setOk(`New temporary password for ${m.name}: ${r.tempPassword} — share it with them now, it is not shown again.`);
    });
  };
  const status = (c: Cert) => {
    if (c.expires_on && days(c.expires_on) < 0) return { cls: 'bad', label: 'Expired' };
    if (!c.verified) return { cls: 'warn', label: 'Needs review' };
    if (c.expires_on && days(c.expires_on) < 30) return { cls: 'warn', label: 'Expires soon' };
    return { cls: 'open', label: 'Verified' };
  };
  const isCrew = m.role === 'crew';

  return (
    <>
      <p className="small">
        <Link href="/crew">← Crew</Link>
      </p>
      <div className="profile-head">
        <span className="avatar solid big" aria-hidden="true">
          {initials(m.name)}
        </span>
        <div>
          <h1>
            {m.name} {!m.active && <span className="chip bad">Inactive</span>}
          </h1>
          <div className="muted">{roleLabel(m.role)}</div>
        </div>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && (
        <Banner kind="ok" onClose={() => setOk('')}>
          {ok}
        </Banner>
      )}

      <form className="card" onSubmit={save}>
        <h2>Profile</h2>
        <div className="grid-form">
          <label>
            Full name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={100} />
          </label>
          <label>
            Email <span className="muted small">(their login)</span>
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required maxLength={200} />
          </label>
          <label>
            Phone
            <input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={40} />
          </label>
          <label>
            Home address
            <input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} maxLength={300} />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            Skills
            <SkillPicker value={f.skills} onChange={(skills) => setF({ ...f, skills })} options={skillNames} />
          </label>
          <label style={{ gridColumn: '1 / -1' }}>
            About <span className="muted small">(what the person wrote about themselves)</span>
            <textarea rows={2} value={f.bio} onChange={(e) => setF({ ...f, bio: e.target.value })} maxLength={1000} />
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
        </div>
        <h2 style={{ marginTop: 20 }}>Coordinator notes</h2>
        <p className="muted small" style={{ margin: 0 }}>
          Private to labor coordinators and admins. The crew member can’t see these.
        </p>
        <textarea rows={3} value={f.coordinatorNotes} onChange={(e) => setF({ ...f, coordinatorNotes: e.target.value })} maxLength={2000} aria-label="Coordinator notes" />
        <div className="row">
          <button className="btn primary" disabled={busy === 'save'}>
            Save changes
          </button>
          {isCrew && (
            <>
              <button type="button" className="btn" onClick={() => act('active', m.active ? 'Deactivated.' : 'Reactivated.', () => api(`/api/crew/${id}`, { method: 'PATCH', body: { active: !m.active } }))}>
                {m.active ? 'Deactivate' : 'Reactivate'}
              </button>
              <button type="button" className="btn ghost" onClick={resetPw} disabled={busy === 'pw'}>
                Reset password
              </button>
            </>
          )}
        </div>
      </form>

      {isCrew && (
        <>
          <section className="card">
            <h2>Certificates</h2>
            {d.certs.length === 0 ? (
              <p className="muted">None on file.</p>
            ) : (
              <ul className="plain certs">
                {d.certs.map((c) => {
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
                      {!c.verified && (
                        <button className="btn small primary" disabled={!!busy} onClick={() => act('v', 'Marked as verified.', () => api(`/api/certs/${c.id}/verify`, { body: {} }))}>
                          Verify
                        </button>
                      )}
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
                      <button className="btn ghost small danger" disabled={!!busy} onClick={() => confirm(`Remove ${c.name}?`) && act('del', 'Certificate removed.', () => api(`/api/certs/${c.id}`, { method: 'DELETE' }))}>
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
                const cid = replaceFor;
                e.target.value = '';
                if (file && cid) act('up', 'File uploaded.', () => upload(cid, file));
              }}
            />
            <form className="cert-add" onSubmit={addCert}>
              <h3>Add a certificate</h3>
              <div className="grid-form">
                <label>
                  Name
                  <input value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} placeholder="Forklift, First Aid…" required maxLength={60} />
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
              <p className="muted small" style={{ marginBottom: 0 }}>
                Certificates you add count right away. Saving the same name again renews it.
              </p>
            </form>
          </section>

          <section className="card">
            <h2>Availability</h2>
            {d.windows.length === 0 ? (
              <p className="muted">No weekly limits set, so they count as available any time.</p>
            ) : (
              <ul className="plain">
                {d.windows.map((w) => (
                  <li key={w.weekday} className="row space">
                    <span>{DAYS[w.weekday]}</span>
                    <span className="muted">
                      {w.start_time} – {w.end_time}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {d.timeOff.length > 0 && (
              <>
                <h3 style={{ margin: '16px 0 8px' }}>Time off</h3>
                <ul className="plain">
                  {d.timeOff.map((t) => (
                    <li key={t.id} className="row space">
                      <span>
                        {t.starts_on}
                        {t.ends_on !== t.starts_on ? ` – ${t.ends_on}` : ''}
                      </span>
                      <span className="muted">{t.note}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <p className="muted small" style={{ marginBottom: 0 }}>
              Crew set their own availability and time off.
            </p>
          </section>
        </>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
