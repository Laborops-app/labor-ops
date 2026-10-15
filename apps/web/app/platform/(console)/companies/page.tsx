'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Banner } from '@/components/ui';
import { mb } from '@/components/PlatformStorage';
import { ago, CoAvatar, Head, num, papi, planLabel } from '@/components/platform/Console';

type Company = {
  id: string; name: string; plan: string; created_at: string; suspended_at: string | null; suspended_reason: string | null;
  people: number; crew: number; admins: string | null; last_active: string | null; logins_30d: number; events: number; file_bytes: number;
};
type Sort = 'newest' | 'active' | 'people' | 'name';

const isQuiet = (c: Company) => !c.suspended_at && Date.now() - new Date(c.created_at).getTime() > 14 * 86400000 && (!c.last_active || Date.now() - new Date(c.last_active).getTime() > 14 * 86400000);

export default function Companies() {
  const [list, setList] = useState<Company[] | null>(null);
  const [plans, setPlans] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [q, setQ] = useState('');
  const [plan, setPlan] = useState('');
  const [status, setStatus] = useState('');
  const [sort, setSort] = useState<Sort>('newest');
  const [shown, setShown] = useState(100);
  useEffect(() => {
    papi<{ companies: Company[]; plans: string[] }>('/api/platform/companies').then((r) => { setList(r.companies); setPlans(r.plans); }).catch((e) => setErr(e.message));
  }, []);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const r = (list ?? []).filter((c) =>
      (!needle || `${c.name} ${c.admins ?? ''}`.toLowerCase().includes(needle)) &&
      (!plan || c.plan === plan) &&
      (!status || (status === 'suspended' ? !!c.suspended_at : status === 'quiet' ? isQuiet(c) : !c.suspended_at && !isQuiet(c))));
    const by: Record<Sort, (a: Company, b: Company) => number> = {
      newest: (a, b) => b.created_at.localeCompare(a.created_at),
      active: (a, b) => b.logins_30d - a.logins_30d || (b.last_active ?? '').localeCompare(a.last_active ?? ''),
      people: (a, b) => b.people - a.people,
      name: (a, b) => a.name.localeCompare(b.name),
    };
    return r.sort(by[sort]);
  }, [list, q, plan, status, sort]);

  const counts = useMemo(() => ({
    all: list?.length ?? 0,
    suspended: list?.filter((c) => c.suspended_at).length ?? 0,
    quiet: list?.filter(isQuiet).length ?? 0,
  }), [list]);

  return (
    <>
      <Head title="Companies" sub={list ? `${num(counts.all)} companies · ${counts.quiet} quiet · ${counts.suspended} suspended` : 'Every company on LaborOps.'} />
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      <section className="card cs-card">
        <div className="cs-filters">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or admin email" aria-label="Search companies" />
          <select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Plan">
            <option value="">All plans</option>
            {plans.map((p) => <option key={p} value={p}>{planLabel(p)}</option>)}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="quiet">Quiet (14+ days)</option>
            <option value="suspended">Suspended</option>
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
            <option value="newest">Newest first</option>
            <option value="active">Most active</option>
            <option value="people">Most people</option>
            <option value="name">Name A–Z</option>
          </select>
        </div>
        {!list ? (
          !err && <div className="muted">Loading…</div>
        ) : (
          <div className="table-wrap">
            <table className="cs-table">
              <thead><tr><th>Company</th><th>Plan</th><th>People</th><th>Sign-ins (30 d)</th><th>Events</th><th>Files</th><th>Last active</th></tr></thead>
              <tbody>
                {rows.slice(0, shown).map((c) => (
                  <tr key={c.id} className={c.suspended_at ? 'inactive' : ''}>
                    <td>
                      <Link href={`/platform/companies/${c.id}`} className="cs-co">
                        <CoAvatar name={c.name} size={32} />
                        <span>
                          <b>{c.name}</b>
                          <span className="muted small cs-ellipsis" title={c.admins ?? ''}>{c.admins ?? 'No admin'}</span>
                        </span>
                      </Link>
                    </td>
                    <td>
                      <span className={`cs-plan ${c.plan}`}>{planLabel(c.plan)}</span>
                      {c.suspended_at ? <span className="chip bad" title={c.suspended_reason ?? ''}>Suspended</span> : isQuiet(c) ? <span className="chip warn">Quiet</span> : null}
                    </td>
                    <td>{num(c.people)}<span className="muted small"> ({c.crew} crew)</span></td>
                    <td>{num(c.logins_30d)}</td>
                    <td>{num(c.events)}</td>
                    <td>{mb(c.file_bytes)}</td>
                    <td className="small">{ago(c.last_active)}<div className="muted small">Joined {new Date(c.created_at).toLocaleDateString()}</div></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={7} className="muted small">No companies match.</td></tr>}
              </tbody>
            </table>
            {rows.length > shown && <button className="btn small" style={{ margin: '10px auto', display: 'block' }} onClick={() => setShown(shown + 100)}>Show more ({rows.length - shown} left)</button>}
          </div>
        )}
      </section>
    </>
  );
}
