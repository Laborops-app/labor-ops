'use client';
import { useEffect, useState } from 'react';
import { Banner } from '@/components/ui';
import { ago, CoAvatar, Head, papi, usePlatformUser } from '@/components/platform/Console';

type Admin = { id: string; email: string; name: string; ready: boolean; setup_expires_at: string | null; last_login_at: string | null; created_at: string; invited_by_name: string | null };

/** A setup link to hand over: copy it, or open an email to them with it. */
function LinkBox({ email, link, onClose }: { email: string; link: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const mail = `mailto:${email}?subject=${encodeURIComponent('Your LaborOps platform console access')}&body=${encodeURIComponent(`Use this link to set your password for the LaborOps platform console. It works once, for 72 hours:\n\n${link}`)}`;
  return (
    <div className="cs-linkbox" role="status">
      <div>
        <b>Send this link to {email}</b>
        <p className="muted small">It works once, for 72 hours. Anyone with the link can set the password, so send it only to them.</p>
      </div>
      <code>{link}</code>
      <div className="row">
        <button className="btn primary small" onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true)).catch(() => undefined)}>{copied ? 'Copied' : 'Copy link'}</button>
        <a className="btn small" href={mail}>Email it</a>
        <button className="btn ghost small" onClick={onClose}>Done</button>
      </div>
    </div>
  );
}

export default function Admins() {
  const me = usePlatformUser();
  const [list, setList] = useState<Admin[] | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [link, setLink] = useState<{ email: string; link: string } | null>(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => papi<{ admins: Admin[] }>('/api/platform/admins').then((r) => setList(r.admins)).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);

  return (
    <>
      <Head title="Platform admins" sub="People who can see every company, suspend accounts and change storage and backups. They are not part of any company." />
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {msg && <Banner kind="ok" onClose={() => setMsg('')}>{msg}</Banner>}
      {link && <LinkBox {...link} onClose={() => setLink(null)} />}
      <section className="card cs-card">
        <h2>Invite a platform admin</h2>
        <form
          className="cs-invite"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr('');
            try {
              const r = await papi<{ link: string }>('/api/platform/admins', { body: { email, name } });
              setLink({ email, link: r.link });
              setEmail('');
              setName('');
              load();
            } catch (x: any) {
              setErr(x.message);
            }
          }}
        >
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name" /></label>
          <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" required /></label>
          <button className="btn primary">Create invite link</button>
        </form>
      </section>
      <section className="card cs-card">
        <h2>Admins {list && <span className="muted">({list.length})</span>}</h2>
        <ul className="cs-people">
          {list?.map((a) => (
            <li key={a.id}>
              <CoAvatar name={a.name || a.email} size={40} />
              <span className="cs-people-main">
                <b>{a.name || a.email}{a.id === me.id && <span className="muted"> (you)</span>}</b>
                <span className="muted small">
                  {a.email} · {a.ready ? `last sign-in ${ago(a.last_login_at).toLowerCase()}` : a.setup_expires_at && new Date(a.setup_expires_at) > new Date() ? 'invited, has not set up yet' : 'invite expired'}
                  {a.invited_by_name ? ` · added by ${a.invited_by_name}` : ''}
                </span>
              </span>
              {!a.ready && <span className="chip warn">Pending</span>}
              <button className="btn ghost small" title={a.ready ? 'A one-time link to choose a new password' : 'A fresh setup link'}
                onClick={() => papi<{ link: string }>(`/api/platform/admins/${a.id}/link`, { body: {} }).then((r) => setLink({ email: a.email, link: r.link })).catch((x) => setErr(x.message))}>
                {a.ready ? 'Reset password link' : 'New invite link'}
              </button>
              {a.id !== me.id && (
                <button className="btn ghost small danger"
                  onClick={() => confirm(`Remove ${a.name || a.email}? They are signed out of the console right away.`) &&
                    papi(`/api/platform/admins/${a.id}`, { method: 'DELETE' }).then(() => { setMsg(`${a.name || a.email} was removed.`); load(); }).catch((x) => setErr(x.message))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
