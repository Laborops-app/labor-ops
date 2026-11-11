'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

type Invoice = { id: number; number: string | null; subject: string | null; date: string | null; due: string | null; price: number | null; priceInVat: number | null; paid: number | null; outstanding: number | null; isPaid: boolean; finalized: boolean };
type Extras = {
  project: number | null;
  options?: { invoices: boolean; files: boolean; contacts: boolean; vehicles: boolean; equipment: boolean };
  invoices?: Invoice[];
  files?: { id: number; name: string; size: number | null; folder: string | null }[];
  contacts?: { kind: 'customer' | 'location'; name: string; function: string | null; phone: string | null; email: string | null }[];
  vehicles?: { shiftId: string; role: string; vehicles: { name: string; plate: string | null; seats: number | null; start: string | null; end: string | null; remark: string | null }[] }[];
  equipment?: { name: string; qty: number | null; group: string | null; remark: string | null }[];
  warnings?: string[];
};

const money = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }));
const size = (b: number | null) => (!b ? '' : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const when = (s: string | null) => (s ? new Date(s).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** Load once per event; null while loading or when Rentman isn't connected / the event isn't linked. */
export function useRentmanExtras(eventId: string | undefined) {
  const [x, setX] = useState<Extras | null>(null);
  useEffect(() => {
    if (!eventId) return;
    api<Extras>(`/api/events/${eventId}/rentman/extras`).then(setX).catch(() => setX(null));
  }, [eventId]);
  return [x, setX] as const;
}

export function RentmanInvoices({ eventId, x, onSynced }: { eventId: string; x: Extras | null; onSynced?: (x: Extras) => void }) {
  const [busy, setBusy] = useState(false);
  if (!x?.options?.invoices) return null;
  const list = x.invoices ?? [];
  const total = list.reduce((n, i) => n + (i.price ?? 0), 0);
  return (
    <div className="card rm-extra">
      <div className="row space">
        <h3>Rentman invoices ({list.length})</h3>
        <button className="btn ghost small" disabled={busy} onClick={async () => {
          setBusy(true);
          try { await api(`/api/events/${eventId}/rentman/invoices/sync`, { body: {} }); onSynced?.(await api<Extras>(`/api/events/${eventId}/rentman/extras`)); } finally { setBusy(false); }
        }}>{busy ? 'Checking…' : 'Check Rentman'}</button>
      </div>
      {!list.length ? <p className="muted small">No invoices on the Rentman project yet.</p> : (
        <>
          <table className="table">
            <thead><tr><th>Invoice</th><th>Date</th><th>Before tax</th><th>Outstanding</th><th></th></tr></thead>
            <tbody>
              {list.map((i) => (
                <tr key={i.id}>
                  <td>{i.number ?? `#${i.id}`}{i.subject ? <span className="muted small"> · {i.subject}</span> : null}</td>
                  <td>{i.date ?? '—'}</td>
                  <td>{money(i.price)}</td>
                  <td>{money(i.outstanding)}</td>
                  <td>{i.isPaid ? <span className="chip open">Paid</span> : i.finalized ? <span className="chip">Sent</span> : <span className="chip">Draft</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="small muted">Rentman has invoiced {money(total)} before tax on this project. Check it covers or excludes labor before billing labor here, so it isn’t billed twice.</p>
        </>
      )}
    </div>
  );
}

/** Files, site contacts, vehicles and equipment, as allowed for whoever is looking. */
export default function RentmanExtras({ eventId, x }: { eventId: string; x: Extras | null }) {
  const [err, setErr] = useState('');
  if (!x?.options) return null;
  const { files, contacts, vehicles, equipment } = x;
  const any = (files?.length ?? 0) + (contacts?.length ?? 0) + (vehicles?.length ?? 0) + (equipment?.length ?? 0);
  if (!any && !x.warnings?.length) return null;
  const open = async (id: number) => {
    setErr('');
    // Open the tab first so pop-up blockers allow it, then point it at Rentman's short-lived link.
    const w = window.open('', '_blank');
    try {
      const r = await api<{ url: string }>(`/api/events/${eventId}/rentman/files/${id}`);
      if (w) w.location.href = r.url; else window.location.href = r.url;
    } catch (e) {
      w?.close();
      setErr((e as Error).message);
    }
  };
  const groups = new Map<string, NonNullable<Extras['equipment']>>();
  for (const e of equipment ?? []) { const k = e.group ?? 'Other'; groups.set(k, [...(groups.get(k) ?? []), e]); }
  return (
    <div className="rm-extras">
      {x.warnings?.map((w) => <p key={w} className="small muted">{w}</p>)}
      {err && <p className="small error">{err}</p>}
      {!!contacts?.length && (
        <div className="card rm-extra">
          <h3>Site contacts</h3>
          <ul className="plain">
            {contacts.map((c) => (
              <li key={c.kind + c.name}>
                <b>{c.name}</b>{c.function ? <span className="muted small"> · {c.function}</span> : null} <span className="muted small">({c.kind === 'customer' ? 'client' : 'venue'})</span>
                <div className="row small" style={{ gap: 12 }}>
                  {c.phone && <a href={`tel:${c.phone.replace(/[^\d+]/g, '')}`}>{c.phone}</a>}
                  {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!vehicles?.length && (
        <div className="card rm-extra">
          <h3>Vehicles</h3>
          <ul className="plain">
            {vehicles.flatMap((s) => s.vehicles.map((v, i) => (
              <li key={s.shiftId + i}>
                <b>{v.name}</b>{v.plate ? <span className="chip" style={{ marginLeft: 6 }}>{v.plate}</span> : null}
                <div className="muted small">{s.role}{v.seats ? ` · ${v.seats} seats` : ''}{v.start ? ` · ${when(v.start)}${v.end ? ` – ${when(v.end)}` : ''}` : ''}{v.remark ? ` · ${v.remark}` : ''}</div>
              </li>
            )))}
          </ul>
        </div>
      )}
      {!!files?.length && (
        <div className="card rm-extra">
          <h3>Project files</h3>
          <ul className="plain">
            {files.map((f) => (
              <li key={f.id}>
                <button type="button" className="linklike" onClick={() => open(f.id)}>{f.name}</button>
                <span className="muted small"> {size(f.size)}{f.folder ? ` · ${f.folder}` : ''}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!!equipment?.length && (
        <details className="card rm-extra">
          <summary><h3 style={{ display: 'inline' }}>Equipment to check ({equipment.length})</h3></summary>
          {[...groups].map(([g, items]) => (
            <div key={g}>
              <h4>{g}</h4>
              <ul className="plain small">
                {items.map((e, i) => <li key={i}>{e.qty ? `${e.qty} × ` : ''}{e.name}{e.remark ? <span className="muted"> · {e.remark}</span> : null}</li>)}
              </ul>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
