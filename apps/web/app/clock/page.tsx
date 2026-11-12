'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import Logo from '@/components/Logo';
import { api, ApiError, fmtTime, getPosition } from '@/lib/api';

type Result = { action: 'in' | 'out'; already?: boolean; at: string; since?: string; assignmentId?: string; event: string; shift: { role: string; starts_at: string; ends_at: string; lead?: string | null } };

/** Where the QR code at the venue lands: clocks the signed-in crew member in, or out if they are already in. */
function Clock() {
  const params = useSearchParams();
  const router = useRouter();
  const e = params.get('e') ?? '';
  const c = params.get('c') ?? '';
  const [res, setRes] = useState<Result | null>(null);
  const [err, setErr] = useState<{ message: string; reason?: string } | null>(null);
  const [busy, setBusy] = useState(true);
  const scan = useCallback(async (withLocation: boolean) => {
    setBusy(true); setErr(null);
    try {
      // Location is only needed for a printed poster; ask for it when the server says so.
      const pos = withLocation ? await getPosition(10000).catch(() => null) : null;
      setRes(await api<Result>('/api/time/qr', { body: { eventId: e, code: c, ...(pos ? { lat: pos.lat, lng: pos.lng, accuracy: pos.accuracy } : {}) } }));
    } catch (x) {
      const a = x as ApiError;
      if (a.status === 401) return router.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      if (a.reason === 'need_location' && !withLocation) return scan(true);
      setErr({ message: a.message, reason: a.reason });
    } finally { setBusy(false); }
  }, [e, c, router]);
  useEffect(() => {
    if (!e || !c) { setErr({ message: 'This link is missing its code. Scan the code at the venue again.' }); setBusy(false); return; }
    scan(false);
  }, [e, c, scan]);
  const hours = res?.since ? Math.round(((+new Date(res.at) - +new Date(res.since)) / 3600_000) * 10) / 10 : null;
  return (
    <main className="clk">
      <div className="clk-card">
        <Logo width={132} />
        {busy && !res && <p className="clk-wait" role="status">Clocking you in…</p>}
        {res && (
          <>
            <div className={`clk-badge ${res.action}`} aria-hidden="true">{res.action === 'in' ? '✓' : '→'}</div>
            <h1 role="status">{res.action === 'in' ? (res.already ? 'You’re already clocked in' : 'You’re clocked in') : 'You’re clocked out'}</h1>
            <p className="clk-sub">{fmtTime(res.at)}{hours !== null ? ` · ${hours} h on the clock` : ''}</p>
            <div className="clk-shift">
              <b>{res.shift.role}</b>
              <span>{res.event}</span>
              <span>{fmtTime(res.shift.starts_at)} to {fmtTime(res.shift.ends_at)}{res.shift.lead ? ` · Lead: ${res.shift.lead}` : ''}</span>
            </div>
            <Link className="btn primary" href={res.assignmentId ? `/my-shifts/${res.assignmentId}` : '/my-shifts'}>See my shift</Link>
            {res.action === 'in' && <p className="muted small">Scan the code again when you leave to clock out.</p>}
          </>
        )}
        {err && (
          <>
            <div className="clk-badge bad" aria-hidden="true">!</div>
            <h1>Not clocked in</h1>
            <p role="alert">{err.message}</p>
            {(err.reason === 'need_location' || err.reason === 'geofence') && <button type="button" className="btn primary" disabled={busy} onClick={() => scan(true)}>Try again with my location</button>}
            <Link className="btn" href="/my-shifts">Open my shifts</Link>
          </>
        )}
      </div>
    </main>
  );
}
export default function Page() {
  return <Suspense fallback={null}><Clock /></Suspense>;
}
