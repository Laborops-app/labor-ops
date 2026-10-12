'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Loc = { id: string; label: string; venue: string | null; address: string | null };

/** When a customer has saved locations, choose one to fill in the venue and street address. */
export default function LocationPick({ customerId, onPick }: { customerId: string | null; onPick: (l: { venue: string; address: string }) => void }) {
  const [locs, setLocs] = useState<Loc[]>([]);
  useEffect(() => {
    setLocs([]);
    if (customerId) api<{ locations: Loc[] }>(`/api/customers/${customerId}`).then((r) => setLocs(r.locations)).catch(() => {});
  }, [customerId]);
  if (!customerId || locs.length === 0) return null;
  return (
    <label>
      Saved customer location
      <select value="" onChange={(e) => { const l = locs.find((x) => x.id === e.target.value); if (l) onPick({ venue: l.venue || l.label, address: l.address || '' }); }}>
        <option value="">Fill venue and address from…</option>
        {locs.map((l) => <option key={l.id} value={l.id}>{l.label}{l.address ? ` — ${l.address}` : ''}</option>)}
      </select>
    </label>
  );
}
