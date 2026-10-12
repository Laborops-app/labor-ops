'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, fmtDateTime, Me } from '@/lib/api';

type App = { id: string; user_id: string; user_name: string; status: string; ratings: string | null };
type Training = {
  id: string; title: string; description: string | null; location: string | null; starts_at: string; ends_at: string; capacity: number;
  status: 'open' | 'completed' | 'cancelled'; grants_cert: string | null; cert_valid_months: number | null;
  approved_count: number; waitlist_count: number; my_status: string | null; applications?: App[];
};

function NewTraining({ onDone, onError }: { onDone: () => void; onError: (m: string) => void }) {
  const [f, setF] = useState({ title: '', description: '', location: '', startsAt: '', endsAt: '', capacity: '10', grantsCert: '', months: '' });
  const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    onError('');
    setBusy(true);
    try {
      await api('/api/trainings', {
        body: {
          title: f.title, description: f.description || null, location: f.location || null,
          startsAt: new Date(f.startsAt).toISOString(), endsAt: new Date(f.endsAt).toISOString(), capacity: Number(f.capacity),
          grantsCert: f.grantsCert || null, certValidMonths: f.grantsCert && f.months ? Number(f.months) : null,
        },
      });
      setF({ title: '', description: '', location: '', startsAt: '', endsAt: '', capacity: '10', grantsCert: '', months: '' });
      onDone();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <h2>New training</h2>
      <p className="muted small">Crew are notified in the app, by push and by email. Anyone who already holds the certificate it grants is not.</p>
      <form onSubmit={submit}>
        <div className="grid2">
          <label>Title<input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required maxLength={150} placeholder="Forklift certification" /></label>
          <label>Location<input value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} maxLength={200} /></label>
          <label>Starts<input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} required /></label>
          <label>Ends<input type="datetime-local" value={f.endsAt} min={f.startsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} required /></label>
          <label>Seats<input type="number" min={1} max={1000} value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value })} required /></label>
          <label>Certificate it grants (optional)<input value={f.grantsCert} onChange={(e) => setF({ ...f, grantsCert: e.target.value })} maxLength={80} placeholder="Forklift" /></label>
          {f.grantsCert && <label>Certificate valid for (months, blank = no expiry)<input type="number" min={1} max={120} value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} /></label>}
        </div>
        <label>Details<textarea rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={2000} /></label>
        <button className="btn primary" disabled={busy}>Post training</button>
      </form>
    </section>
  );
}

function Body({ me }: { me: Me }) {
  const staff = me.role !== 'crew';
  const [list, setList] = useState<Training[] | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = () => api<{ trainings: Training[] }>('/api/trainings').then((r) => setList(r.trainings)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<unknown>, msg = '') => {
    setError(''); setNote('');
    try { await fn(); if (msg) setNote(msg); await load(); } catch (e) { setError((e as Error).message); }
  };
  if (!list) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  return (
    <>
      <h1>Trainings</h1>
      {error && <Banner>{error}</Banner>}
      {note && <Banner kind="ok">{note}</Banner>}
      {staff && <NewTraining onDone={() => { setNote('Training posted and crew notified.'); load(); }} onError={setError} />}
      {list.length === 0 && <Empty>No trainings right now.</Empty>}
      {list.map((t) => {
        const upcoming = t.status === 'open' && new Date(t.starts_at) > new Date();
        return (
          <section className="card" key={t.id}>
            <div className="row space">
              <div>
                <h2>{t.title}</h2>
                <div className="muted small">
                  {fmtDateTime(t.starts_at)}{t.location ? ` · ${t.location}` : ''} · {t.approved_count}/{t.capacity} seats{t.waitlist_count ? ` · ${t.waitlist_count} waitlisted` : ''}
                </div>
                {t.grants_cert && <div className="small">Earns the <b>{t.grants_cert}</b> certificate{t.cert_valid_months ? ` (valid ${t.cert_valid_months} months)` : ''}</div>}
                {t.description && <p>{t.description}</p>}
              </div>
              <Pill status={t.status === 'open' ? (t.my_status ?? 'open') : t.status} />
            </div>
            {!staff && upcoming && (
              <div className="row">
                {!t.my_status && <button className="btn primary" onClick={() => run(() => api(`/api/trainings/${t.id}/apply`, { body: {} }), 'Applied. You will hear back soon.')}>Apply</button>}
                {t.my_status && t.my_status !== 'declined' && (
                  <button className="btn ghost small" onClick={() => run(() => api(`/api/trainings/${t.id}/apply`, { method: 'DELETE' }), 'Application withdrawn.')}>Withdraw</button>
                )}
                {t.my_status === 'waitlisted' && <span className="muted small">You are on the waitlist.</span>}
              </div>
            )}
            {staff && t.applications && (
              <>
                {t.applications.length > 0 && (
                  <ul className="plain">
                    {t.applications.map((a) => (
                      <li key={a.id} className="row space">
                        <span>{a.user_name} <Pill status={a.status} />{a.ratings && <span className="muted small"> · {a.ratings}</span>}</span>
                        {t.status === 'open' && a.status !== 'completed' && (
                          <span className="row">
                            {a.status !== 'approved' && <button className="btn small" onClick={() => run(() => api(`/api/training-applications/${a.id}`, { method: 'PATCH', body: { status: 'approved' } }))}>Approve</button>}
                            {a.status !== 'declined' && <button className="btn ghost small" onClick={() => run(() => api(`/api/training-applications/${a.id}`, { method: 'PATCH', body: { status: 'declined' } }))}>Decline</button>}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {t.status === 'open' && (
                  <div className="row">
                    <button className="btn primary" disabled={t.approved_count === 0}
                      onClick={() => confirm(`Mark “${t.title}” complete for ${t.approved_count} approved attendee(s)?${t.grants_cert ? ` They will each receive the ${t.grants_cert} certificate.` : ''}`) &&
                        run(() => api(`/api/trainings/${t.id}/complete`, { body: {} }), 'Training completed.')}>
                      Mark complete{t.grants_cert ? ' & grant certificate' : ''}
                    </button>
                    <button className="btn ghost small" onClick={() => confirm('Cancel this training and tell applicants?') && run(() => api(`/api/trainings/${t.id}`, { method: 'PATCH', body: { status: 'cancelled' } }))}>Cancel training</button>
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager', 'crew']}>{(me) => <Body me={me} />}</Shell>;
}
