'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';
import Skeleton from '@/components/Skeleton';

type R = { id: string; name: string; headcount: number | null; start: string | null; end: string | null };

/** What a new position of each role starts with when it's added to an event: people needed, start and end time. */
export default function RoleDefaults() {
  const [rows, setRows] = useState<R[] | null>(null);
  const [ed, setEd] = useState<Record<string, R>>({});
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const load = () => api<{ roles: R[] }>('/api/role-defaults').then((r) => setRows(r.roles)).catch((e) => setErr(e.message));
  useEffect(() => { if (open && !rows) load(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (r: R) => {
    setErr(''); setMsg('');
    try {
      await api(`/api/skills/${r.id}/defaults`, { method: 'PUT', body: { headcount: r.headcount || null, start: r.start || null, end: r.end || null } });
      setMsg(`Saved defaults for ${r.name}.`);
      setEd((x) => { const n = { ...x }; delete n[r.id]; return n; });
      load();
    } catch (e) { setErr((e as Error).message); }
  };
  const needle = q.trim().toLowerCase();
  return (
    <section className="card">
      <button type="button" className="phase-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <span>
          <h2>Position defaults</h2>
          <span className="muted small">People needed and usual times a new position of each role starts with (in Add shift and Quick add).</span>
        </span>
      </button>
      {open && (
        <>
          {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
          {msg && <Banner kind="ok" onClose={() => setMsg('')}>{msg}</Banner>}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search roles" aria-label="Search roles" style={{ maxWidth: '18rem', margin: '8px 0' }} />
          {!rows ? <Skeleton /> : (
            <div className="table-wrap">
              <table className="qa-grid">
                <thead><tr><th>Role</th><th className="qa-num">People</th><th>Start</th><th>End</th><th aria-label="Save" /></tr></thead>
                <tbody>
                  {rows.filter((r) => !needle || r.name.toLowerCase().includes(needle)).map((r0) => {
                    const r = ed[r0.id] ?? r0;
                    const set = (p: Partial<R>) => setEd({ ...ed, [r0.id]: { ...r, ...p } });
                    return (
                      <tr key={r0.id}>
                        <td>{r0.name}</td>
                        <td className="qa-num"><input type="number" min={1} max={500} value={r.headcount ?? ''} placeholder="1" onChange={(e) => set({ headcount: e.target.value ? Number(e.target.value) : null })} aria-label={`People needed for ${r0.name}`} /></td>
                        <td><input type="time" value={r.start ?? ''} onChange={(e) => set({ start: e.target.value || null })} aria-label={`Start for ${r0.name}`} /></td>
                        <td><input type="time" value={r.end ?? ''} onChange={(e) => set({ end: e.target.value || null })} aria-label={`End for ${r0.name}`} /></td>
                        <td>{ed[r0.id] && <button type="button" className="btn small primary" onClick={() => save(r)}>Save</button>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}
