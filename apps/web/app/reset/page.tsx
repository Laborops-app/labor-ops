'use client';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';

function Form() {
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const invite = params.get('invite') === '1';
  const [pw, setPw] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw !== again) return setError('The two passwords do not match');
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/reset', { body: { token, password: pw } });
      setDone(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!token) return <Banner>This link is missing its code. Open the link from your email again, or <Link href="/forgot">request a new one</Link>.</Banner>;
  if (done)
    return (
      <>
        <Banner kind="ok">Your password is set. You can sign in now.</Banner>
        <Link className="btn primary block" href="/login">
          Go to sign in
        </Link>
      </>
    );
  return (
    <>
      {error && (
        <Banner>
          {error} {error.includes('expired') && <Link href="/forgot">Get a new link</Link>}
        </Banner>
      )}
      <form onSubmit={submit}>
        <label>
          New password <span className="muted small">(8+ characters)</span>
          <input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} minLength={8} required autoFocus />
        </label>
        <label>
          New password again
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} minLength={8} required />
        </label>
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Saving…' : invite ? 'Set password' : 'Reset password'}
        </button>
      </form>
    </>
  );
}

export default function Reset() {
  return (
    <div className="auth">
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <div className="auth-card">
        <Logo width={200} className="auth-logo" />
        <h1>Choose a password</h1>
        <Suspense fallback={<div className="muted">Loading…</div>}>
          <Form />
        </Suspense>
      </div>
    </div>
  );
}
