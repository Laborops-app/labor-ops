'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export type CustomerLite = { id: string; name: string; email: string | null };

export function useCustomers() {
  const [list, setList] = useState<CustomerLite[]>([]);
  useEffect(() => {
    api<{ customers: CustomerLite[] }>('/api/customers').then((r) => setList(r.customers)).catch(() => {});
  }, []);
  return list;
}

/** Pick an existing customer, or leave empty and type a name by hand. */
export default function CustomerSelect({ value, onPick, label = 'Customer' }: { value: string | null; onPick: (c: CustomerLite | null) => void; label?: string }) {
  const list = useCustomers();
  return (
    <label>
      {label}
      <select value={value ?? ''} onChange={(e) => onPick(list.find((c) => c.id === e.target.value) ?? null)}>
        <option value="">Not in the customer list</option>
        {list.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </label>
  );
}
