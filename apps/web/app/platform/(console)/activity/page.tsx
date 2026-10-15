'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Banner } from '@/components/ui';
import { Head, papi } from '@/components/platform/Console';
import { feedText } from '@/components/platform/feed';

type Entry = { id: number; action: string; detail: any; created_at: string; tenant_id: string | null; company: string | null; actor: string | null; actor_email: string | null };

export default function Activity() {
  const [rows, setRows] = useState<Entry[] | null>(null);
  const [more, setMore] = useState(true);
  const [hideLogins, setHideLogins] = useState(true);
  const [err, setErr] = useState('');
  const load = (before?: number) =>
    papi<{ entries: Entry[] }>(`/api/platform/audit${before ? `?before=${before}` : ''}`)
      .then((r) => {
        setRows((cur) => [...(before ? cur ?? [] : []), ...r.entries]);
        setMore(r.entries.length === 100);
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, []);
  const shown = (rows ?? []).filter((r) => !hideLogins || r.action !== 'login');
  return (
    <>
      <Head title="Activity log" sub="Everything platform admins have done, newest first." />
      {err && <Banner>{err}</Banner>}
      <section className="card cs-card">
        <label className="cs-check">
          <input type="checkbox" checked={hideLogins} onChange={(e) => setHideLogins(e.target.checked)} /> Hide console sign-ins
        </label>
        {!rows ? (
          !err && <div className="muted">Loading…</div>
        ) : (
          <div className="table-wrap">
            <table className="cs-table">
              <thead><tr><th>When</th><th>What</th><th>Company</th><th>Who</th></tr></thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.id}>
                    <td className="small" style={{ whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                    <td>{feedText(r)}</td>
                    <td>{r.tenant_id && r.company ? <Link href={`/platform/companies/${r.tenant_id}`}>{r.company}</Link> : <span className="muted">—</span>}</td>
                    <td className="small">{r.actor ?? (r.detail?.from === 'server' ? 'Server command' : '—')}</td>
                  </tr>
                ))}
                {!shown.length && <tr><td colSpan={4} className="muted small">Nothing yet.</td></tr>}
              </tbody>
            </table>
            {more && <button className="btn small" style={{ margin: '10px auto', display: 'block' }} onClick={() => load(rows[rows.length - 1]?.id)}>Load older</button>}
          </div>
        )}
      </section>
    </>
  );
}
