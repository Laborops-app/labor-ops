'use client';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';
import Link from 'next/link';
import { Suspense, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';

/** Landing page for an emailed / texted sign-in link. Signing in needs a tap, so link scanners in mail apps can't use it up. */
function Body() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setError('');
    try {
      const { user } = await api<{ user: { role: string } }>('/api/auth/magic/verify', { body: { token } });
      router.replace(user.role === 'crew' ? '/my-shifts' : '/dashboard');
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="auth-card">
      <Logo width={200} className="auth-logo" />
      <h1>Sign in</h1>
      {error && <Banner>{error}</Banner>}
      {!token ? (
        <Banner>This link is not complete. Open it again from your email or text.</Banner>
      ) : (
        <button className="btn primary block big" onClick={go} disabled={busy} autoFocus>
          {busy ? 'Signing in…' : 'Continue to LaborOps'}
        </button>
      )}
      <p className="muted small center-text">
        <Link href="/login">Back to sign in</Link>
      </p>
    </div>
  );
}

export default function Magic() {
  return (
    <div className="auth">
      <div className="auth-theme">
        <ThemeToggle />
      </div>
      <Suspense fallback={null}>
        <Body />
      </Suspense>
    </div>
  );
}
