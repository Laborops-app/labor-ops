'use client';
import { useState } from 'react';
import { Banner } from '@/components/ui';
import { Head, papi, usePlatformUser } from '@/components/platform/Console';

export default function Account() {
  const me = usePlatformUser();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  return (
    <>
      <Head title="Your account" sub={`${me.name} · ${me.email}`} />
      <section className="card cs-card" style={{ maxWidth: 520 }}>
        <h2>Change password</h2>
        {msg && <Banner kind={msg.kind} onClose={() => setMsg(null)}>{msg.text}</Banner>}
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            if (next !== again) return setMsg({ kind: 'error', text: 'The new passwords do not match.' });
            try {
              await papi('/api/platform/auth/password', { body: { current: cur, next } });
              setMsg({ kind: 'ok', text: 'Password changed.' });
              setCur('');
              setNext('');
              setAgain('');
            } catch (x: any) {
              setMsg({ kind: 'error', text: x.message });
            }
          }}
        >
          <label>Current password<input type="password" value={cur} onChange={(e) => setCur(e.target.value)} required autoComplete="current-password" /></label>
          <label><span>New password <span className="muted small">(10+ characters)</span></span><input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} autoComplete="new-password" /></label>
          <label>New password again<input type="password" value={again} onChange={(e) => setAgain(e.target.value)} required minLength={10} autoComplete="new-password" /></label>
          <button className="btn primary">Change password</button>
        </form>
      </section>
    </>
  );
}
