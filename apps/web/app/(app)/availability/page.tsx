'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';

type Win = { enabled: boolean; start: string; end: string };
type Off = { id: string; starts_on: string; ends_on: string; note: string | null };
type Cert = { id: string; name: string; expires_on: string | null };
// Monday first; the numbers are Postgres/JS weekdays (0 = Sunday)
const DAYS: [number, string][] = [[1, 'Monday'], [2, 'Tuesday'], [3, 'Wednesday'], [4, 'Thursday'], [5, 'Friday'], [6, 'Saturday'], [0, 'Sunday']];
const blank = (): Record<number, Win> => Object.fromEntries(DAYS.map(([n]) => [n, { enabled: false, start: '09:00', end: '17:00' }]));
const today = () => new Date().toISOString().slice(0, 10);

function Body() {
  const [w, setW] = useState<Record<number, Win>>(blank());
  const [off, setOff] = useState<Off[]>([]);
  const [certs, setCerts] = useState<Cert[]>([]);
  const [tz, setTz] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [f, setF] = useState({ startsOn: today(), endsOn: today(), note: '' });

  const load = () =>
    api<{ timezone: string; windows: { weekday: number; start_time: string; end_time: string }[]; timeOff: Off[]; certs: Cert[] }>('/api/my/availability')
      .then((r) => {
        const next = blank();
        for (const x of r.windows) next[x.weekday] = { enabled: true, start: x.start_time, end: x.end_time };
        setW(next);
        setOff(r.timeOff);
        setCerts(r.certs);
        setTz(r.timezone);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const save = async () => {
    setError('');
    setNotice('');
    try {
      const windows = DAYS.filter(([n]) => w[n].enabled).map(([n]) => ({ weekday: n, startTime: w[n].start, endTime: w[n].end }));
      await api('/api/my/availability', { method: 'PUT', body: { windows } });
      setNotice(windows.length ? 'Availability saved.' : 'Saved. You are treated as available any time.');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const addOff = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      await api('/api/my/time-off', { body: { startsOn: f.startsOn, endsOn: f.endsOn, note: f.note || null } });
      setF({ startsOn: today(), endsOn: today(), note: '' });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const certChip = (c: Cert) => {
    const days = c.expires_on ? (new Date(c.expires_on + 'T23:59:59').getTime() - Date.now()) / 86400000 : 999;
    return (
      <span key={c.id} className={`chip ${days < 0 ? 'bad' : days < 30 ? 'warn' : ''}`}>
        {c.name}
        {c.expires_on ? ` · ${days < 0 ? 'expired' : 'exp'} ${c.expires_on}` : ''}
      </span>
    );
  };

  return (
    <>
      <h1>Availability</h1>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {notice && (
        <Banner kind="ok" onClose={() => setNotice('')}>
          {notice}
        </Banner>
      )}
      <section className="card">
        <h2>Weekly hours</h2>
        <p className="muted small">
          Tick the days you can work and the hours. Managers see when a shift falls outside them. Leave everything unticked to be available any time.
          {tz ? ` Times are in ${tz}.` : ''}
        </p>
        <div className="avail">
          {DAYS.map(([n, label]) => (
            <div className="avail-row" key={n}>
              <label className="check">
                <input type="checkbox" checked={w[n].enabled} onChange={(e) => setW({ ...w, [n]: { ...w[n], enabled: e.target.checked } })} />
                <span>{label}</span>
              </label>
              <input type="time" value={w[n].start} disabled={!w[n].enabled} onChange={(e) => setW({ ...w, [n]: { ...w[n], start: e.target.value } })} aria-label={`${label} from`} />
              <span className="muted">to</span>
              <input type="time" value={w[n].end} disabled={!w[n].enabled} onChange={(e) => setW({ ...w, [n]: { ...w[n], end: e.target.value } })} aria-label={`${label} until`} />
            </div>
          ))}
        </div>
        <div className="row" style={{ marginTop: '0.8rem' }}>
          <button className="btn primary" onClick={save}>
            Save availability
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Time off</h2>
        <form className="grid-form" onSubmit={addOff}>
          <label>
            From
            <input type="date" value={f.startsOn} onChange={(e) => setF({ ...f, startsOn: e.target.value, endsOn: e.target.value > f.endsOn ? e.target.value : f.endsOn })} required />
          </label>
          <label>
            Until
            <input type="date" value={f.endsOn} min={f.startsOn} onChange={(e) => setF({ ...f, endsOn: e.target.value })} required />
          </label>
          <label>
            Note <span className="muted small">(optional)</span>
            <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </label>
          <div className="form-actions">
            <button className="btn primary">Add time off</button>
          </div>
        </form>
        {off.length > 0 && (
          <ul className="plain" style={{ marginTop: '0.8rem' }}>
            {off.map((o) => (
              <li className="row space" key={o.id}>
                <span>
                  {fmtDate(o.starts_on)}
                  {o.ends_on !== o.starts_on && <> – {fmtDate(o.ends_on)}</>}
                  {o.note ? <span className="muted"> · {o.note}</span> : null}
                </span>
                <button className="btn ghost small" onClick={() => api(`/api/my/time-off/${o.id}`, { method: 'DELETE' }).then(load).catch((e) => setError(e.message))}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>My certificates</h2>
        {certs.length === 0 ? <p className="muted small">None on file. Your manager adds certificates and expiry dates.</p> : <div>{certs.map(certChip)}</div>}
      </section>
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew']}>{() => <Body />}</Shell>;
}
