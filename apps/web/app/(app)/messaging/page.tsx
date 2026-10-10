'use client';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { api, fmtDateTime } from '@/lib/api';

type Row = { id: string; channel: 'email' | 'sms'; category: string; to_addr: string; subject: string | null; status: string; attempts: number; last_error: string | null; created_at: string; user_name: string | null };
type Data = {
  email: { live: boolean; from: string; host: string | null };
  sms: { live: boolean; provider: 'twilio' | 'sns'; from: string | null };
  appUrl: string;
  stats: { channel: string; status: string; n: number }[];
  deliveries: Row[];
};

const mask = (r: Row) => (r.channel === 'sms' ? r.to_addr.replace(/\d(?=\d{4})/g, '•') : r.to_addr);

function Body() {
  const [d, setD] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const [to, setTo] = useState({ email: '', sms: '' });

  const load = () => api<Data>('/api/messaging').then(setD).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  const test = async (channel: 'email' | 'sms') => {
    setError('');
    setOk('');
    setBusy(channel);
    try {
      const r = await api<{ logged: boolean }>('/api/messaging/test', { body: { channel, to: to[channel] } });
      setOk(r.logged ? 'Recorded in log-only mode. Nothing was delivered because this channel is not connected yet.' : 'Test message sent.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
      load();
    }
  };

  const count = (channel: string, status: string) => d?.stats.find((s) => s.channel === channel && s.status === status)?.n ?? 0;

  const Card = ({ ch, title, live, detail }: { ch: 'email' | 'sms'; title: string; live: boolean; detail: string }) => (
    <section className="card">
      <div className="row space">
        <h2>{title}</h2>
        <span className="small">
          <span className={`status-dot ${live ? 'live' : 'log'}`} />
          {live ? 'Connected' : 'Log-only (not connected)'}
        </span>
      </div>
      <p className="muted small">{detail}</p>
      <p className="small">
        Last 30 days: {count(ch, 'sent')} sent · {count(ch, 'failed')} failed · {count(ch, 'queued') + count(ch, 'sending')} waiting
      </p>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          test(ch);
        }}
      >
        <input
          style={{ flex: 1, minWidth: 180 }}
          type={ch === 'email' ? 'email' : 'tel'}
          placeholder={ch === 'email' ? 'you@example.com' : '+1 801 555 0123'}
          value={to[ch]}
          onChange={(e) => setTo({ ...to, [ch]: e.target.value })}
          required
          aria-label={`Send a test ${ch} to`}
        />
        <button className="btn" disabled={!!busy}>
          {busy === ch ? 'Sending…' : `Send test ${ch === 'email' ? 'email' : 'text'}`}
        </button>
      </form>
    </section>
  );

  return (
    <>
      <h1>Messaging</h1>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && (
        <Banner kind="ok" onClose={() => setOk('')}>
          {ok}
        </Banner>
      )}
      {!d ? (
        <div className="muted">Loading…</div>
      ) : (
        <>
          <div className="cols-2">
            <Card ch="email" title="Email" live={d.email.live} detail={d.email.live ? `Sending from ${d.email.from} through ${d.email.host}.` : 'Add the Amazon SES SMTP settings on the server to start sending. Until then, emails are recorded here but not delivered.'} />
            <Card ch="sms" title="Text messages" live={d.sms.live} detail={d.sms.live ? `Sending through ${d.sms.provider === 'sns' ? 'Amazon SNS' : 'Twilio'} from ${d.sms.from}. People only get texts after they turn them on and agree on their profile. Replying STOP turns them off.` : 'Add the Twilio or Amazon SNS settings on the server to start sending. Until then, texts are recorded here but not delivered.'} />
          </div>
          <section className="card">
            <h2>Recent messages</h2>
            {d.deliveries.length === 0 ? (
              <Empty>Nothing has been sent yet.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>To</th>
                      <th>Message</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.deliveries.map((r) => (
                      <tr key={r.id}>
                        <td className="small">{fmtDateTime(r.created_at)}</td>
                        <td className="small">
                          {r.user_name ?? '—'}
                          <div className="muted mono">{mask(r)}</div>
                        </td>
                        <td className="small">
                          {r.channel === 'email' ? 'Email' : 'Text'} · {r.category.replace('_', ' ')}
                          {r.subject && <div className="muted">{r.subject}</div>}
                        </td>
                        <td>
                          <Pill status={r.status} />
                          {r.last_error && <div className="muted small">{r.last_error}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
