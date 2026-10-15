'use client';
import Image from 'next/image';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';
import ThemeToggle from '@/components/ThemeToggle';

function Setup() {
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [info, setInfo] = useState<{ email: string; name: string; reset: boolean } | null>(null);
  const [bad, setBad] = useState('');
  const [name, setName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!token) return setBad('This link is missing its code. Open the full link you were sent.');
    api<{ email: string; name: string; reset: boolean }>(`/api/platform/auth/setup?token=${encodeURIComponent(token)}`)
      .then((r) => {
        setInfo(r);
        setName(r.name);
      })
      .catch((e) => setBad(e.message));
  }, [token]);

  if (bad) return (
    <>
      <h1>Link not valid</h1>
      <Banner>{bad}</Banner>
      <p className="muted small center-text"><Link href="/platform/login">Go to sign-in</Link></p>
    </>
  );
  if (!info) return <div className="muted center-text">Checking your link…</div>;
  return (
    <>
      <h1>{info.reset ? 'Choose a new password' : 'Set up your console account'}</h1>
      <p className="muted small center-text" style={{ margin: 0 }}>{info.email}</p>
      {error && <Banner>{error}</Banner>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw !== pw2) return setError('The two passwords do not match.');
          setBusy(true);
          setError('');
          try {
            await api('/api/platform/auth/setup', { body: { token, name, password: pw } });
            router.replace('/platform');
          } catch (x) {
            setError((x as Error).message);
            setBusy(false);
          }
        }}
      >
        <label>
          Your name
          <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="name" autoFocus={!info.name} />
        </label>
        <label>
          <span>Password <span className="muted small">(10+ characters)</span></span>
          <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} required minLength={10} autoComplete="new-password" autoFocus={!!info.name} />
        </label>
        <label>
          Password again
          <input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} required minLength={10} autoComplete="new-password" />
        </label>
        <button className="btn primary block" disabled={busy}>{busy ? 'Saving…' : info.reset ? 'Save and sign in' : 'Create account and sign in'}</button>
      </form>
    </>
  );
}

export default function Page() {
  return (
    <div className="auth cs-auth">
      <div className="auth-theme"><ThemeToggle /></div>
      <div className="auth-card">
        <div className="cs-auth-brand">
          <Image src="/brand/icon.png" alt="" width={44} height={44} priority />
          <span>Labor<b>Ops</b><small>Platform console</small></span>
        </div>
        <Suspense fallback={<div className="muted center-text">Loading…</div>}>
          <Setup />
        </Suspense>
      </div>
    </div>
  );
}
