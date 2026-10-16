'use client';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, homeFor } from '@/lib/api';
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

  const [mode, setMode] = useState<'password' | 'link'>('password');
  const [sent, setSent] = useState(false);
  const [passkeys, setPasskeys] = useState(false);
  useEffect(() => {
    setPasskeys(typeof window !== 'undefined' && 'PublicKeyCredential' in window);
  }, []);
  const go = (role: string) => {
    const next = new URLSearchParams(location.search).get('next');
    router.replace(next && /^\/(?!\/)/.test(next) ? next : homeFor(role));
  };
  const sendLink = async () => {
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/magic', { body: { email } });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const withPasskey = async () => {
    setBusy(true);
    setError('');
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const optionsJSON = await api('/api/auth/passkey/options', { body: {} });
      const response = await startAuthentication({ optionsJSON });
      const { user } = await api<{ user: { role: string } }>('/api/auth/passkey', { body: { response } });
      go(user.role);
    } catch (err) {
      const m = (err as Error).message || '';
      setError(/NotAllowed|cancel|abort/i.test((err as Error).name + m) ? '' : m);
      setBusy(false);
    }
  };

  const signIn = async (e: string, p: string) => {
    setBusy(true);
    setError('');
    try {
      const { user } = await api<{ user: { role: string } }>('/api/auth/login', { body: { email: e, password: p } });
      go(user.role);
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
        {sent ? (
          <div className="banner ok" role="status">
            <div>
              <p style={{ margin: 0 }}>If <b>{email}</b> has a LaborOps account, a sign-in link is on its way by email (and text, if you get texts from us). It works once, for 15 minutes.</p>
              <button className="btn ghost small" onClick={() => { setSent(false); setMode('password'); }}>Back</button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={(ev) => {
              ev.preventDefault();
              if (mode === 'link') sendLink();
              else signIn(email, password);
            }}
          >
            <label>
              Email
              <input type="email" autoComplete="username webauthn" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            {mode === 'password' && (
              <label>
                Password
                <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </label>
            )}
            <button className="btn primary block" disabled={busy}>
              {mode === 'link' ? (busy ? 'Sending…' : 'Email me a sign-in link') : busy ? 'Signing in…' : 'Sign in'}
            </button>
          </form>
        )}
        {!sent && (
          <div className="signin-alt">
            {passkeys && (
              <button className="btn block" disabled={busy} onClick={withPasskey}>
                Sign in with a passkey
              </button>
            )}
            <button className="btn ghost block" disabled={busy} onClick={() => setMode(mode === 'link' ? 'password' : 'link')}>
              {mode === 'link' ? 'Use my password instead' : 'Email me a sign-in link instead'}
            </button>
          </div>
        )}
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
