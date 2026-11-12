'use client';
import { useEffect, useRef, useState } from 'react';

/** Small line icons for action buttons (24×24, current colour). */
const P: Record<string, string> = {
  quiet: 'M4 20h4L19 9l-4-4L4 16v4ZM13 7l4 4',
  publish: 'M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z',
  autofill: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6',
  rentman: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01M12 10v4',
  update: 'M3 11v2a1 1 0 0 0 1 1h2l5 4V6L6 10H4a1 1 0 0 0-1 1ZM16 8a5 5 0 0 1 0 8M19 5a9 9 0 0 1 0 14',
  invoice: 'M6 2h12v20l-3-2-3 2-3-2-3 2V2ZM9 7h6M9 11h6M9 15h4',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  free: 'M8 2v4M16 2v4M3 9h18M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM9 15l2 2 4-4',
  rate: 'M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9L12 3Z',
  pay: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  quote: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5M9 13h6M9 17h4',
  chat: 'M4 5h16v11H9l-5 4V5Z',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z',
  archive: 'M3 4h18v4H3zM5 8v12h14V8M10 12h4',
  restore: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5',
  trash: 'M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 11v6M14 11v6',
  person: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM4 21a8 8 0 0 1 16 0',
  cert: 'M12 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM8.5 13.5 7 22l5-3 5 3-1.5-8.5',
  phone: 'M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2Z',
  text: 'M4 5h16v11H9l-5 4V5ZM8 9h8M8 12h5',
  off: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  check: 'M4 12l5 5L20 6',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z',
  nudge: 'M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8ZM10 20a2 2 0 0 0 4 0',
  swap: 'M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7',
};
export function ActIcon({ n, size = 16 }: { n: keyof typeof P | string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="act-ico">
      <path d={P[n] ?? P.more} />
    </svg>
  );
}

export type MenuItem = { label: string; icon: string; onClick: () => void; danger?: boolean; badge?: string | number | null; hint?: string } | 'divider';

/** "⋯ More" button with a dropdown of icon + label actions. Closes on outside click, Escape or after an action. */
export default function ActionMenu({ items, label = 'More', badge, compact }: { items: MenuItem[]; label?: string; badge?: boolean; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', off); document.removeEventListener('keydown', esc); };
  }, [open]);
  const list = items.filter((x, i, a) => !(x === 'divider' && (i === 0 || a[i - 1] === 'divider' || i === a.length - 1)));
  return (
    <div className="act-menu" ref={box}>
      <button type="button" className={compact ? 'act-dots' : 'btn act-btn'} aria-label={compact ? label : undefined} title={compact ? 'More' : undefined} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ActIcon n="more" size={compact ? 18 : 16} /> {compact ? null : label}{badge && <i className="act-dot" aria-label="needs attention" />}
      </button>
      {open && (
        <div className="act-pop" role="menu">
          {list.map((x, i) =>
            x === 'divider' ? <hr key={`d${i}`} /> : (
              <button key={x.label} type="button" role="menuitem" className={x.danger ? 'danger' : ''} title={x.hint} onClick={() => { setOpen(false); x.onClick(); }}>
                <ActIcon n={x.icon} /> <span>{x.label}</span>{x.badge ? <em>{x.badge}</em> : null}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
