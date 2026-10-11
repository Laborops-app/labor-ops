'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';

type Shift = { status: string; person: string; role_name: string; starts_at: string; ends_at: string; event_name: string; venue: string | null; timezone: string; canRespond: boolean };

const when = (s: Shift) => {
  const o = { timeZone: s.timezone };
  const d = new Date(s.starts_at).toLocaleString([], { ...o, weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${d} – ${new Date(s.ends_at).toLocaleTimeString([], { ...o, hour: 'numeric', minute: '2-digit' })}`;
};

function Respond() {
  const params = useSearchParams();
  const t = params.get('t') ?? '';
  const pre = params.get('a');
  const [shift, setShift] = useState<Shift | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ shift: Shift }>(`/api/respond/preview?t=${encodeURIComponent(t)}`)
      .then((r) => setShift(r.shift))
      .catch((e) => setError(e.message));
  }, [t]);

  const send = async (response: 'accepted' | 'declined') => {
    setBusy(true);
    setError('');
    try {
      const r = await api<{ status: string }>('/api/respond', { body: { t, response } });
      setDone(r.status);
      setShift((s) => (s ? { ...s, status: r.status } : s));
    } catch (e) {
      setError((e as Error).message);
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
        <h1>Shift offer</h1>
        {error && <Banner>{error}</Banner>}
        {shift && (
          <>
            <p style={{ margin: '0 0 0.2rem' }}>
              <b>{shift.event_name}</b>
            </p>
            <p className="muted" style={{ margin: 0 }}>
              {shift.role_name}
              <br />
              {when(shift)}
              {shift.venue && (
                <>
                  <br />
                  {shift.venue}
                </>
              )}
            </p>
            {done ? (
              <Banner kind="ok">{done === 'accepted' ? 'You accepted this shift. See you there!' : 'You declined this shift. Your coordinator has been told.'}</Banner>
            ) : shift.canRespond ? (
              <>
                <p className="muted small">
                  Hi {shift.person.split(' ')[0]}, {shift.status === 'offered' ? 'can you work this shift?' : `you currently have this shift marked as ${shift.status}. You can change your answer.`}
                </p>
                <div className="row" style={{ gap: '0.6rem' }}>
                  <button className={`btn big ${pre === 'decline' ? '' : 'primary'}`} style={{ flex: 1 }} disabled={busy} onClick={() => send('accepted')}>
                    Accept
                  </button>
                  <button className={`btn big ${pre === 'decline' ? 'primary' : ''}`} style={{ flex: 1 }} disabled={busy} onClick={() => send('declined')}>
                    Decline
                  </button>
                </div>
              </>
            ) : (
              <Banner kind="info">This shift can no longer be changed here. Contact your coordinator.</Banner>
            )}
          </>
        )}
        <p className="muted small center-text">
          <Link href="/login">Open LaborOps</Link>
        </p>
      </div>
    </div>
  );
}

export default function RespondPage() {
  return (
    <Suspense fallback={<div className="center muted">Loading…</div>}>
      <Respond />
    </Suspense>
  );
}
