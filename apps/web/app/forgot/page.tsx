'use client';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';
import Link from 'next/link';
import { useState } from 'react';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';

export default function Forgot() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/forgot', { body: { email } });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <div className="auth-card">
        <Logo width={200} className="auth-logo" />
        <h1>Reset your password</h1>
        {sent ? (
          <>
            <Banner kind="ok">If an account exists for {email}, a reset link is on its way. It works for 1 hour.</Banner>
            <p className="muted small center-text">
              <Link href="/login">Back to sign in</Link>
            </p>
          </>
        ) : (
          <>
            {error && <Banner>{error}</Banner>}
            <form onSubmit={submit}>
              <label>
                Email
                <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
              </label>
              <button className="btn primary block" disabled={busy}>
                {busy ? 'Sending…' : 'Email me a reset link'}
              </button>
            </form>
            <p className="muted small center-text">
              <Link href="/login">Back to sign in</Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
