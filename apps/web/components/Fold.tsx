'use client';
import { useEffect, useState } from 'react';

/**
 * A collapsible card: a title row (with an optional status on the right) that opens to show its content.
 * Open/closed is remembered on this device under `id`.
 */
export default function Fold({ id, title, sub, status, defaultOpen = false, children }: {
  id: string; title: React.ReactNode; sub?: React.ReactNode; status?: React.ReactNode; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const key = `lo_fold:${id}`;
  const [open, setOpen] = useState(defaultOpen);
  useEffect(() => {
    try {
      const v = localStorage.getItem(key);
      if (v !== null) setOpen(v === '1');
    } catch { /* storage blocked */ }
  }, [key]);
  return (
    <details className="card profile-fold fold-card" open={open} onToggle={(e) => {
      const o = (e.currentTarget as HTMLDetailsElement).open;
      setOpen(o);
      try { localStorage.setItem(key, o ? '1' : '0'); } catch { /* ignore */ }
    }}>
      <summary>
        <span><b>{title}</b>{sub && <span className="muted small">{sub}</span>}</span>
        <span className="fold-right">
          {status && <span className="small">{status}</span>}
          <svg className="fold-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
        </span>
      </summary>
      {open && <div className="profile-fold-body">{children}</div>}
    </details>
  );
}
