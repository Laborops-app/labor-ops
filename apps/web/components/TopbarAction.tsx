'use client';
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

/** Puts a page's main action (e.g. "Add New Customer") into the header bar, like the design's top-right button. */
export default function TopbarAction({ children }: { children: React.ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => setEl(document.getElementById('topbar-actions')), []);
  return el ? createPortal(children, el) : null;
}

export const PlusIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" style={{ marginLeft: 10, verticalAlign: -3 }}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const EditIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13.3 4.6 4.8 13.1c-.3.3-.6.9-.7 1.3l-.4 2.9c-.1 1.1.6 1.8 1.7 1.7l2.9-.4c.4-.1 1-.4 1.3-.7l8.5-8.5c1.5-1.5 2.2-3.2 0-5.4s-3.9-1.5-5.4 0ZM12.1 5.8a5.6 5.6 0 0 0 4 4M3 21h18" />
  </svg>
);
export const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
    <circle cx="11" cy="11" r="7.5" />
    <path d="m20 20-3.2-3.2" />
  </svg>
);
export const TrashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M21 6H3M8 6V4.5A1.5 1.5 0 0 1 9.5 3h5A1.5 1.5 0 0 1 16 4.5V6M19 6l-.8 13a2 2 0 0 1-2 2H7.8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6" />
  </svg>
);

/** Stable pastel colour for an initials avatar. */
export const avClass = (seed: string) => `av c${(Array.from(seed).reduce((a, c) => a + c.charCodeAt(0), 0) % 5) + 1}`;
export const initialsOf = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('') || '?';
