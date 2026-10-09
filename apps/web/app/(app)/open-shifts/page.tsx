'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDateTime, fmtTime } from '@/lib/api';

type Open = {
  id: string;
  role_name: string;
  starts_at: string;
  ends_at: string;
  headcount: number;
  filled: number;
  required_certs: string[];
  event_name: string;
  venue: string | null;
  can_claim: boolean;
  reason: string | null;
  outside_availability: boolean;
};
type Swap = { id: string; role_name: string; starts_at: string; ends_at: string; event_name: string; venue: string | null; offered_by_name: string; can_take: boolean; reason: string | null };

function Body() {
  const [open, setOpen] = useState<Open[] | null>(null);
  const [swaps, setSwaps] = useState<Swap[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');

  const load = () =>
    Promise.all([api<{ shifts: Open[] }>('/api/open-shifts'), api<{ swaps: Swap[] }>('/api/swaps/board')])
      .then(([o, s]) => {
        setOpen(o.shifts);
        setSwaps(s.swaps);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const act = async (key: string, url: string, msg: string) => {
    setError('');
    setNotice('');
    setBusy(key);
    try {
      await api(url, { method: 'POST', body: {} });
      setNotice(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      load();
    }
  };

  const when = (s: { starts_at: string; ends_at: string }) => `${fmtDateTime(s.starts_at)} – ${fmtTime(s.ends_at)}`;

  return (
    <>
      <h1>Open shifts</h1>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {notice && (
        <Banner kind="ok" onClose={() => setNotice('')}>
          {notice}
        </Banner>
      )}
      <div className="sec-h">
        <h2>Shifts you can pick up</h2>
      </div>
      {!open ? (
        <div className="muted">Loading…</div>
      ) : open.length === 0 ? (
        <Empty>No open shifts right now. Check back later.</Empty>
      ) : (
        <div className="cards3">
          {open.map((s) => (
            <div className="sc" key={s.id}>
              <div className="sc-top">
                <b>{s.role_name}</b>
                <span className="badge good">{s.headcount - s.filled} open</span>
              </div>
              <div className="sub">
                <span>{s.event_name}</span>
                <span>{when(s)}</span>
                {s.venue && <span>{s.venue}</span>}
              </div>
              {s.required_certs.length > 0 && (
                <div>
                  {s.required_certs.map((c) => (
                    <span className="chip" key={c}>
                      {c}
                    </span>
                  ))}
                </div>
              )}
              {s.outside_availability && s.can_claim && <div className="muted small">This is outside the availability you set — you can still ask.</div>}
              {s.reason && <div className="muted small">{s.reason}</div>}
              <button className="btn primary small" disabled={!s.can_claim || !!busy} onClick={() => act(s.id, `/api/shifts/${s.id}/claim`, `Requested ${s.role_name}. A labor coordinator will approve it.`)}>
                Request this shift
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="sec-h" style={{ marginTop: '1.4rem' }}>
        <h2>Swap board</h2>
      </div>
      {swaps.length === 0 ? (
        <Empty>Nobody is offering a shift swap right now.</Empty>
      ) : (
        <div className="cards3">
          {swaps.map((w) => (
            <div className="sc" key={w.id}>
              <div className="sc-top">
                <b>{w.role_name}</b>
                <span className="badge">Swap</span>
              </div>
              <div className="sub">
                <span>
                  {w.event_name} · from {w.offered_by_name}
                </span>
                <span>{when(w)}</span>
                {w.venue && <span>{w.venue}</span>}
              </div>
              {w.reason && <div className="muted small">{w.reason}</div>}
              <button className="btn primary small" disabled={!w.can_take || !!busy} onClick={() => act(w.id, `/api/swaps/${w.id}/take`, `You asked to take ${w.role_name}. A labor coordinator will approve the swap.`)}>
                Take this shift
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew']}>{() => <Body />}</Shell>;
}
