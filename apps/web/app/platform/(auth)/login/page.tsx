'use client';
import Image from 'next/image';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';
import ThemeToggle from '@/components/ThemeToggle';

export default function PlatformLogin() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="auth cs-auth">
      <div className="auth-theme"><ThemeToggle /></div>
      <div className="auth-card">
        <div className="cs-auth-brand">
          <Image src="/brand/icon.png" alt="" width={44} height={44} priority />
          <span>Labor<b>Ops</b><small>Platform console</small></span>
        </div>
        <h1>Operator sign-in</h1>
        <p className="muted small center-text" style={{ margin: 0 }}>For the team that runs LaborOps. Company accounts sign in on the main app.</p>
        {error && <Banner>{error}</Banner>}
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api('/api/platform/auth/login', { body: { email, password } });
              const next = new URLSearchParams(location.search).get('next');
              router.replace(next && /^\/platform(\/|\?|$)/.test(next) ? next : '/platform');
            } catch (x) {
              setError((x as Error).message);
              setBusy(false);
            }
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
          <button className="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        </form>
        <p className="muted small center-text" style={{ margin: 0 }}>Forgot your password? Another platform admin can send you a new link from Admins.</p>
      </div>
    </div>
  );
}
