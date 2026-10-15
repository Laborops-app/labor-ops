'use client';
import { useTabTitle } from '@/lib/tabs';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import Shell, { initials } from '@/components/Shell';
import { Banner, Pill } from '@/components/ui';
import { api, fmtDate, fmtDateTime, fmtTime, money } from '@/lib/api';

type Detail = {
  shift: {
    assignment_id: string;
    status: string;
    shift_id: string;
    role_name: string;
    starts_at: string;
    ends_at: string;
    required_certs: string[];
    event_name: string;
    venue: string | null;
    address: string | null;
    notes: string | null;
    start_date: string;
    end_date: string;
    hours: number;
    hourly_rate: number | null;
    pay_type?: 'hourly' | 'day';
    estimated_pay: number | null;
  };
  coworkers: { user_id: string; name: string; phone: string | null; shift_id: string; role_name: string; starts_at: string; ends_at: string; status: string }[];
};

function Body() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api<Detail>(`/api/my/assignments/${id}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, [id]);
  const respond = async (response: 'accepted' | 'declined') => {
    setBusy(true);
    setError('');
    try {
      await api(`/api/assignments/${id}/respond`, { body: { response } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  useTabTitle(d ? `${d.shift.role_name}${d.shift.event_name ? ` · ${d.shift.event_name}` : ''}` : null);
  if (!d) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  const s = d.shift;
  const place = [s.venue, s.address].filter(Boolean).join(', ');
  const q = encodeURIComponent(s.address || place);
  const same = d.coworkers.filter((c) => c.shift_id === s.shift_id);
  const others = d.coworkers.filter((c) => c.shift_id !== s.shift_id);

  const Person = ({ c, showTime }: { c: Detail['coworkers'][number]; showTime?: boolean }) => (
    <li className="person">
      <span className="avatar" aria-hidden="true">
        {initials(c.name)}
      </span>
      <span className="grow">
        <b>{c.name}</b>
        <span className="muted small">
          {c.role_name}
          {showTime ? ` · ${fmtDateTime(c.starts_at)} – ${fmtTime(c.ends_at)}` : ''}
        </span>
      </span>
      {c.status === 'offered' && <span className="muted small">not confirmed</span>}
      {c.phone && (
        <a className="btn ghost small" href={`tel:${c.phone}`} aria-label={`Call ${c.name}`}>
          {c.phone}
        </a>
      )}
    </li>
  );

  return (
    <>
      <p className="small">
        <Link href="/my-shifts">← My shifts</Link>
      </p>
      <div className="row space">
        <div>
          <h1>{s.role_name}</h1>
          <div className="muted">{s.event_name}</div>
        </div>
        <Pill status={s.status} />
      </div>

      {error && <Banner>{error}</Banner>}
      {s.status === 'offered' && (
        <section className="card">
          <h2>Can you work this shift?</h2>
          <div className="row">
            <button className="btn primary big" disabled={busy} onClick={() => respond('accepted')}>
              Confirm shift
            </button>
            <button className="btn big" disabled={busy} onClick={() => respond('declined')}>
              Decline
            </button>
          </div>
        </section>
      )}

      <div className="detail-grid">
        <section className="card">
          <h2>When</h2>
          <p>
            <b>{fmtDateTime(s.starts_at)}</b> – {fmtTime(s.ends_at)}
          </p>
          <p className="muted small">
            Event runs {fmtDate(s.start_date.slice(0, 10))}
            {s.end_date.slice(0, 10) !== s.start_date.slice(0, 10) && <> – {fmtDate(s.end_date.slice(0, 10))}</>}
          </p>
          {s.hourly_rate != null && s.estimated_pay != null && (
            <div className="pay-box">
              <div>
                <span className="muted small">Hourly rate</span>
                <b>{money(s.hourly_rate)}{s.pay_type === 'day' ? ' day rate' : '/hr'}</b>
              </div>
              <div>
                <span className="muted small">Estimated earnings</span>
                <b>{money(s.estimated_pay)}</b>
              </div>
              <div className="muted small" style={{ gridColumn: '1 / -1' }}>
                {s.hours} scheduled hours, before taxes. Final pay follows approved time.
              </div>
            </div>
          )}
          {s.required_certs?.length > 0 && (
            <div className="shift-flags">
              {s.required_certs.map((c) => (
                <span key={c} className="chip">
                  {c}
                </span>
              ))}
            </div>
          )}
          {s.notes && (
            <>
              <h2 style={{ marginTop: 16 }}>Notes</h2>
              <p style={{ whiteSpace: 'pre-wrap' }}>{s.notes}</p>
            </>
          )}
        </section>

        <section className="card">
          <h2>Where</h2>
          {place ? (
            <>
              {s.venue && (
                <p>
                  <b>{s.venue}</b>
                </p>
              )}
              {s.address && <p className="muted">{s.address}</p>}
              <div className="map-frame">
                <iframe title={`Map of ${place}`} loading="lazy" referrerPolicy="no-referrer" src={`https://maps.google.com/maps?q=${q}&z=15&output=embed`} />
              </div>
              <div className="row">
                <a className="btn small primary" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/dir/?api=1&destination=${q}`}>
                  Get directions
                </a>
                <a className="btn small" target="_blank" rel="noopener noreferrer" href={`https://www.google.com/maps/search/?api=1&query=${q}`}>
                  Open in Maps
                </a>
              </div>
            </>
          ) : (
            <p className="muted">No location has been added for this event yet.</p>
          )}
        </section>
      </div>

      <section className="card">
        <h2>Working with you ({same.length})</h2>
        {same.length === 0 ? <p className="muted small">No one else is on this shift yet.</p> : <ul className="plain people">{same.map((c) => <Person key={c.user_id} c={c} />)}</ul>}
      </section>
      {others.length > 0 && (
        <section className="card">
          <h2>Elsewhere at this event ({others.length})</h2>
          <ul className="plain people">
            {others.map((c) => (
              <Person key={c.user_id + c.shift_id} c={c} showTime />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew', 'manager', 'admin']}>{() => <Body />}</Shell>;
}
