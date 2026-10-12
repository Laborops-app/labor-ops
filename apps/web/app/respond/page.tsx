'use client';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import Logo from '@/components/Logo';
import ThemeToggle from '@/components/ThemeToggle';
import { Banner } from '@/components/ui';
import { api, money } from '@/lib/api';

type Shift = { kind?: 'claim'; assignment_id?: string; hours: number; hourly_rate: number | null; estimated_pay: number | null; status: string; person: string; role_name: string; starts_at: string; ends_at: string; event_name: string; venue: string | null; timezone: string; canRespond: boolean; reason?: string | null };

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
        <h1>{shift?.kind === 'claim' ? 'Open shift' : 'Shift offer'}</h1>
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
            {shift.hourly_rate != null && shift.estimated_pay != null && (
              <div className="pay-box">
                <div>
                  <span className="muted small">Hourly rate</span>
                  <b>{money(shift.hourly_rate)}/hr</b>
                </div>
                <div>
                  <span className="muted small">Estimated earnings</span>
                  <b>{money(shift.estimated_pay)}</b>
                </div>
                <div className="muted small" style={{ gridColumn: '1 / -1' }}>
                  {shift.hours} scheduled hours, before taxes. Final pay follows approved time.
                </div>
              </div>
            )}
            {done ? (
              <Banner kind="ok">
                {done === 'pending'
                  ? 'Request sent. Your coordinator will confirm the shift and you will be notified.'
                  : done === 'passed'
                    ? 'No problem. Thanks for letting us know.'
                    : done === 'accepted'
                      ? 'You accepted this shift. See you there!'
                      : 'You declined this shift. Your coordinator has been told.'}
              </Banner>
            ) : shift.canRespond ? (
              <>
                <p className="muted small">
                  Hi {shift.person.split(' ')[0]},{' '}
                  {shift.kind === 'claim'
                    ? 'this shift is open to you, first come, first served. Want it?'
                    : shift.status === 'offered'
                      ? 'can you work this shift?'
                      : `you currently have this shift marked as ${shift.status}. You can change your answer.`}
                </p>
                <div className="row" style={{ gap: '0.6rem' }}>
                  <button className={`btn big ${pre === 'decline' ? '' : 'primary'}`} style={{ flex: 1 }} disabled={busy} onClick={() => send('accepted')}>
                    {shift.kind === 'claim' ? 'Claim this shift' : 'Accept'}
                  </button>
                  <button className={`btn big ${pre === 'decline' ? 'primary' : ''}`} style={{ flex: 1 }} disabled={busy} onClick={() => send('declined')}>
                    {shift.kind === 'claim' ? 'No thanks' : 'Decline'}
                  </button>
                </div>
              </>
            ) : (
              <Banner kind="info">
                {shift.reason ?? 'This shift can no longer be changed here. Contact your coordinator.'}
              </Banner>
            )}
          </>
        )}
        <p className="muted small center-text">
          <Link href={shift?.kind === 'claim' ? '/open-shifts' : shift?.assignment_id ? `/my-shifts/${shift.assignment_id}` : '/my-shifts'}>{done === 'accepted' ? 'View this shift in LaborOps' : 'Open LaborOps'}</Link>
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
