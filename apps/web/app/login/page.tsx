'use client';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';

type Demo = { enabled: boolean; password?: string; accounts?: { label: string; email: string }[] };

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [demo, setDemo] = useState<Demo>({ enabled: false });

  useEffect(() => {
    api<Demo>('/api/demo').then(setDemo).catch(() => undefined);
  }, []);

  const signIn = async (e: string, p: string) => {
    setBusy(true);
    setError('');
    try {
      const { user } = await api<{ user: { role: string } }>('/api/auth/login', { body: { email: e, password: p } });
      router.replace(user.role === 'crew' ? '/my-shifts' : '/dashboard');
    } catch (err) {
      setError((err as Error).message);
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
        <h1>Sign in</h1>
        {error && <Banner>{error}</Banner>}
        <form
          onSubmit={(ev) => {
            ev.preventDefault();
            signIn(email, password);
          }}
        >
          <label>
            Email
            <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label>
            Password
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </label>
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="muted small center-text">
          <Link href="/forgot">Forgot your password?</Link>
        </p>
        <p className="muted small center-text">
          New company? <Link href="/signup">Create an account</Link>
        </p>
        {demo.enabled && (
          <div className="demo-box">
            <div className="small muted">This is a demo with sample data. Jump in as:</div>
            <div className="row">
              {demo.accounts?.map((a) => (
                <button key={a.email} className="btn small" disabled={busy} onClick={() => signIn(a.email, demo.password!)}>
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
