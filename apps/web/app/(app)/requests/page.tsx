'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDateTime, fmtTime } from '@/lib/api';

type Base = { id: string; created_at: string; role_name: string; starts_at: string; ends_at: string; event_id: string; event_name: string; venue: string | null };
type Claim = Base & { user_name: string };
type Swap = Base & { offered_by_name: string; taken_by_name: string };

function Body() {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = () =>
    api<{ claims: Claim[]; swaps: Swap[] }>('/api/requests')
      .then((r) => {
        setClaims(r.claims);
        setSwaps(r.swaps);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const act = async (key: string, url: string) => {
    setError('');
    setBusy(key);
    try {
      await api(url, { method: 'POST', body: {} });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      load();
    }
  };

  const when = (s: Base) => `${fmtDateTime(s.starts_at)} – ${fmtTime(s.ends_at)}`;
  const empty = claims && claims.length === 0 && swaps.length === 0;

  return (
    <>
      <h1>Requests</h1>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {!claims ? (
        <div className="muted">Loading…</div>
      ) : empty ? (
        <Empty>Nothing waiting. When crew claim open shifts or swap shifts, their requests show up here for approval.</Empty>
      ) : (
        <>
          {claims.length > 0 && (
            <>
              <div className="sec-h">
                <h2>Shift claims ({claims.length})</h2>
              </div>
              <div className="cards3">
                {claims.map((c) => (
                  <div className="sc" key={c.id}>
                    <div className="sc-top">
                      <b>{c.user_name}</b>
                      <span className="badge warn">Wants to work</span>
                    </div>
                    <div className="sub">
                      <span>
                        {c.role_name} · <Link href={`/events/${c.event_id}`}>{c.event_name}</Link>
                      </span>
                      <span>{when(c)}</span>
                      {c.venue && <span>{c.venue}</span>}
                    </div>
                    <div className="row">
                      <button className="btn primary small" disabled={!!busy} onClick={() => act(c.id, `/api/assignments/${c.id}/approve`)}>
                        Approve
                      </button>
                      <button className="btn small" disabled={!!busy} onClick={() => act(c.id, `/api/assignments/${c.id}/reject`)}>
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {swaps.length > 0 && (
            <>
              <div className="sec-h" style={{ marginTop: '1rem' }}>
                <h2>Shift swaps ({swaps.length})</h2>
              </div>
              <div className="cards3">
                {swaps.map((w) => (
                  <div className="sc" key={w.id}>
                    <div className="sc-top">
                      <b>
                        {w.offered_by_name} → {w.taken_by_name}
                      </b>
                      <span className="badge">Swap</span>
                    </div>
                    <div className="sub">
                      <span>
                        {w.role_name} · <Link href={`/events/${w.event_id}`}>{w.event_name}</Link>
                      </span>
                      <span>{when(w)}</span>
                      {w.venue && <span>{w.venue}</span>}
                    </div>
                    <div className="row">
                      <button className="btn primary small" disabled={!!busy} onClick={() => act(w.id, `/api/swaps/${w.id}/approve`)}>
                        Approve swap
                      </button>
                      <button className="btn small" disabled={!!busy} onClick={() => act(w.id, `/api/swaps/${w.id}/reject`)}>
                        Decline
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
