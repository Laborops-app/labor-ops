'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { closeOtherTabs, closeTab, moveTab, openTab, useTabs } from '@/lib/tabs';

/** The row of in-app tabs under the top bar. Middle-click or × closes a tab; drag to reorder. */
export default function AppTabs({ path, iconFor }: { path: string; iconFor: (href: string) => React.ReactNode }) {
  const router = useRouter();
  const tabs = useTabs();
  const bar = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<string | null>(null);

  if (!tabs.length) return null;
  const close = (key: string) => {
    const next = closeTab(key, path);
    if (next) router.push(next);
  };
  // Remember where the open tab was (filters, sub-tabs in the address) before leaving it.
  const leave = () => openTab(path, location.pathname + location.search, '');

  return (
    <div className="at-bar" role="tablist" aria-label="Open pages" ref={bar}>
      {tabs.map((t, i) => {
        const on = t.key === path;
        return (
          <div
            key={t.key}
            className={`at-tab${on ? ' on' : ''}${drag === t.key ? ' dragging' : ''}`}
            role="presentation"
            draggable
            onDragStart={(e) => { setDrag(t.key); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.key); }}
            onDragOver={(e) => { if (drag) e.preventDefault(); }}
            onDrop={(e) => { e.preventDefault(); if (drag && drag !== t.key) moveTab(drag, i); setDrag(null); }}
            onDragEnd={() => setDrag(null)}
            onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); close(t.key); } }}
          >
            <Link href={t.href} role="tab" aria-selected={on} className="at-link" title={t.title} onClick={() => { if (!on) leave(); }}>
              <span className="at-icon">{iconFor(t.key)}</span>
              <span className="at-title">{t.title || '…'}</span>
            </Link>
            <button className="at-x" aria-label={`Close ${t.title}`} title="Close tab" onClick={() => close(t.key)}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
            </button>
          </div>
        );
      })}
      {tabs.length > 2 && (
        <button className="at-others" onClick={() => closeOtherTabs(path)} title="Close every tab except this one">Close others</button>
      )}
    </div>
  );
}
