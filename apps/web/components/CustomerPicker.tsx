'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Cust = { id: string; name: string; parent_id: string | null; parent_name: string | null; email: string | null; contact_name: string | null };
export type NewCustomer = { name: string; parentId?: string | null; contactName?: string; email?: string; phone?: string; address?: string };
export type CustomerChoice =
  | { mode: 'existing'; customerId: string | null; client: string }
  | { mode: 'new'; newCustomer: NewCustomer }
  | { mode: 'division'; newCustomer: NewCustomer };

/** What to send with POST /api/events for this choice. */
export const customerBody = (c: CustomerChoice) =>
  c.mode === 'existing'
    ? { customerId: c.customerId || undefined, client: c.customerId ? undefined : c.client || null }
    : { newCustomer: { ...c.newCustomer, parentId: c.mode === 'division' ? c.newCustomer.parentId : null, email: c.newCustomer.email || null } };
/** Name the event's client will show, for previews. */
export const customerLabel = (c: CustomerChoice, list: { id: string; name: string }[]) =>
  c.mode === 'existing'
    ? list.find((x) => x.id === c.customerId)?.name ?? c.client
    : c.mode === 'division'
      ? `${list.find((x) => x.id === c.newCustomer.parentId)?.name ?? '…'} – ${c.newCustomer.name || '…'}`
      : c.newCustomer.name;

export function useCustomerList() {
  const [list, setList] = useState<Cust[]>([]);
  useEffect(() => {
    api<{ customers: Cust[] }>('/api/customers').then((r) => setList(r.customers)).catch(() => {});
  }, []);
  return list;
}

const blank: NewCustomer = { name: '', contactName: '', email: '', phone: '', address: '' };

/**
 * The customer for a new event: an existing one (or a typed client name), a brand-new customer, or a new division of an
 * existing customer. New customers are created together with the event.
 */
export default function CustomerPicker({ value, onChange, list }: { value: CustomerChoice; onChange: (c: CustomerChoice) => void; list: Cust[] }) {
  const set = (mode: CustomerChoice['mode']) => {
    if (mode === value.mode) return;
    if (mode === 'existing') onChange({ mode, customerId: null, client: '' });
    else onChange({ mode, newCustomer: { ...blank, ...(value.mode !== 'existing' ? value.newCustomer : {}), parentId: mode === 'division' ? (value.mode === 'existing' ? value.customerId : null) : null } });
  };
  const nc = value.mode !== 'existing' ? value.newCustomer : blank;
  const upd = (patch: Partial<NewCustomer>) => value.mode !== 'existing' && onChange({ ...value, newCustomer: { ...value.newCustomer, ...patch } });
  const parent = value.mode === 'division' ? list.find((c) => c.id === nc.parentId) : null;
  return (
    <fieldset className="cp">
      <legend>Customer</legend>
      <div className="phase-tabs cp-tabs" role="tablist" aria-label="Customer">
        {([['existing', 'Existing customer'], ['new', '+ New customer'], ['division', '+ New division']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={value.mode === k} className={value.mode === k ? 'tab on' : 'tab'} onClick={() => set(k)} disabled={k === 'division' && !list.length} title={k === 'division' && !list.length ? 'Add a customer first' : undefined}>
            {l}
          </button>
        ))}
      </div>

      {value.mode === 'existing' && (
        <div className="two">
          <label>
            Customer
            <select value={value.customerId ?? ''} onChange={(e) => onChange({ mode: 'existing', customerId: e.target.value || null, client: list.find((c) => c.id === e.target.value)?.name ?? value.client })}>
              <option value="">Not in the customer list</option>
              {list.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          {!value.customerId && (
            <label>
              Client name <span className="muted small">(optional)</span>
              <input value={value.client} onChange={(e) => onChange({ ...value, client: e.target.value })} maxLength={200} />
            </label>
          )}
        </div>
      )}

      {value.mode === 'division' && (
        <div className="two">
          <label>
            Division of
            <select value={nc.parentId ?? ''} onChange={(e) => upd({ parentId: e.target.value || null })} required>
              <option value="" disabled>Pick the customer…</option>
              {list.filter((c) => !c.parent_id).concat(list.filter((c) => c.parent_id)).map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            Division name
            <input value={nc.name} onChange={(e) => upd({ name: e.target.value })} placeholder="e.g. Athletics" required maxLength={120} />
          </label>
        </div>
      )}
      {value.mode === 'new' && (
        <label>
          Customer name
          <input value={nc.name} onChange={(e) => upd({ name: e.target.value })} placeholder="Company or organization" required maxLength={150} />
        </label>
      )}
      {value.mode !== 'existing' && (
        <>
          <div className="two">
            <label>
              Contact person
              <input value={nc.contactName ?? ''} onChange={(e) => upd({ contactName: e.target.value })} maxLength={150} placeholder={parent?.contact_name ? `Leave blank to use ${parent.contact_name}` : 'Name'} />
            </label>
            <label>
              Email
              <input type="email" value={nc.email ?? ''} onChange={(e) => upd({ email: e.target.value })} maxLength={200} placeholder={parent?.email ?? ''} />
            </label>
            <label>
              Phone
              <input value={nc.phone ?? ''} onChange={(e) => upd({ phone: e.target.value })} maxLength={50} />
            </label>
            <label>
              Billing address
              <input value={nc.address ?? ''} onChange={(e) => upd({ address: e.target.value })} maxLength={300} placeholder={value.mode === 'division' ? "Leave blank to use the parent's" : '123 Main St, Salt Lake City, UT'} />
            </label>
          </div>
          <p className="muted small cp-note">
            {value.mode === 'division'
              ? `Saved as “${parent?.name ?? '…'} – ${nc.name || 'Division'}” under ${parent?.name ?? 'the parent customer'}. Blank contact details are copied from the parent.`
              : 'The customer is added to your customer list when the event is created.'}
          </p>
        </>
      )}
    </fieldset>
  );
}

/** "Also create it in Rentman" switch for new events; only shown when Rentman is connected. Remembers the last choice. */
export function useRentmanSend() {
  const [connected, setConnected] = useState(false);
  const [on, setOn] = useState(true);
  useEffect(() => {
    api<{ connected: boolean }>('/api/rentman/settings').then((r) => setConnected(r.connected)).catch(() => {});
    try {
      if (localStorage.getItem('lo_rm_send') === '0') setOn(false);
    } catch {
      /* storage blocked */
    }
  }, []);
  const set = (v: boolean) => {
    setOn(v);
    try {
      localStorage.setItem('lo_rm_send', v ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  };
  return { connected, on: connected && on, set };
}

export function RentmanSend({ state, disabled, note }: { state: ReturnType<typeof useRentmanSend>; disabled?: boolean; note?: string }) {
  if (!state.connected) return null;
  return (
    <label className="check cp-rm">
      <input type="checkbox" checked={state.on && !disabled} disabled={disabled} onChange={(e) => state.set(e.target.checked)} />
      <span>
        <b>Also create it in Rentman</b>
        <span className="muted small">{disabled ? note : 'Sends the event as a project request with its dates, linked to the customer, contact person and venue (as a Rentman location). Any of those missing in Rentman are created there. Accept the request in Rentman and the project links back here.'}</span>
      </span>
    </label>
  );
}
