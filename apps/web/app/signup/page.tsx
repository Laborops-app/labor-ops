'use client';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';

export default function Signup() {
  const router = useRouter();
  const [f, setF] = useState({ company: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/register', { body: f });
      router.replace('/dashboard');
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <Image src="/brand/logo-full.png" alt="LaborOps" width={160} height={146} priority className="auth-logo" />
        <h1>Create your company account</h1>
        {error && <Banner>{error}</Banner>}
        <form onSubmit={submit}>
          <label>
            Company name
            <input value={f.company} onChange={set('company')} required minLength={2} autoFocus />
          </label>
          <label>
            Your name
            <input value={f.name} onChange={set('name')} required />
          </label>
          <label>
            Work email
            <input type="email" value={f.email} onChange={set('email')} required autoComplete="username" />
          </label>
          <label>
            Password <span className="muted small">(8+ characters)</span>
            <input type="password" value={f.password} onChange={set('password')} required minLength={8} autoComplete="new-password" />
          </label>
          <button className="btn primary block" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>
        <p className="muted small center-text">
          Already have an account? <Link href="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
