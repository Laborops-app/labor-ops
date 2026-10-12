'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate } from '@/lib/api';

export type RmProject = { id: number; number: number | null; name: string; customer: string | null; location: string | null; location_address?: string | null; customer_local_id?: string | null; planperiod_start: string | null; planperiod_end: string | null };

/** Drop-down of synced Rentman projects with a search box. Renders nothing when Rentman is not connected. */
export default function RentmanPicker({ value, onPick, label = 'Rentman project' }: { value: number | null; onPick: (p: RmProject | null) => void; label?: string }) {
  const [connected, setConnected] = useState(false);
  const [q, setQ] = useState('');
  const [list, setList] = useState<RmProject[]>([]);
  useEffect(() => {
    api<{ connected: boolean }>('/api/rentman/settings').then((r) => setConnected(r.connected)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!connected) return;
    const t = setTimeout(() => api<{ projects: RmProject[] }>(`/api/rentman/projects${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => setList(r.projects)).catch(() => {}), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [connected, q]);
  if (!connected) return null;
  const day = (s: string | null) => (s ? fmtDate(s.slice(0, 10)) : '');
  return (
    <div className="field" role="group" aria-label={label}>
      <span className="field-label">{label}</span>
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search projects by name, customer or number" aria-label="Search Rentman projects" />
      <select value={value ?? ''} onChange={(e) => onPick(list.find((p) => String(p.id) === e.target.value) ?? null)} aria-label={label}>
        <option value="">{list.length ? 'Not linked to Rentman' : 'No synced projects (sync them on the Integrations page)'}</option>
        {list.map((p) => (
          <option key={p.id} value={p.id}>
            {p.number ? `#${p.number} · ` : ''}{p.name}{p.customer ? ` — ${p.customer}` : ''}{p.planperiod_start ? ` (${day(p.planperiod_start)})` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
