'use client';
import { useEffect, useState } from 'react';

const KEY = 'lo_panels_open';
const readOpen = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

/**
 * A card that collapses to a single header row. Closed by default; which panels are open is remembered on this device.
 * `forceOpen` opens it regardless (for example after returning from an OAuth sign-in).
 */
export default function Panel({ id, title, status, summary, forceOpen, children }: { id: string; title: string; status?: React.ReactNode; summary?: string; forceOpen?: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(!!forceOpen || readOpen().includes(id));
  }, [id, forceOpen]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      const list = readOpen().filter((x) => x !== id);
      localStorage.setItem(KEY, JSON.stringify(next ? [...list, id] : list));
    } catch {
      /* storage blocked */
    }
  };
  return (
    <section className={`card panel${open ? ' open' : ''}`} id={id}>
      <button type="button" className="panel-head" aria-expanded={open} aria-controls={`${id}-body`} onClick={toggle}>
        <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
        <span className="panel-title">
          <b>{title}</b>
          {summary && <span className="muted small">{summary}</span>}
        </span>
        {status && <span className="panel-status">{status}</span>}
      </button>
      {open && (
        <div className="panel-body" id={`${id}-body`}>
          {children}
        </div>
      )}
    </section>
  );
}
