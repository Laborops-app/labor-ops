'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

type Item = { id: string; category: string; title: string; body: string; link: string | null; read_at: string | null; created_at: string };

const ago = (iso: string) => {
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};

export default function NotificationBell() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [items, setItems] = useState<Item[] | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const count = useCallback(() => api<{ unread: number }>('/api/notifications/count').then((r) => setUnread(r.unread)).catch(() => undefined), []);
  const load = useCallback(
    () =>
      api<{ items: Item[]; unread: number }>('/api/notifications')
        .then((r) => {
          setItems(r.items);
          setUnread(r.unread);
        })
        .catch(() => undefined),
    [],
  );

  useEffect(() => {
    count();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') count();
    }, 30000);
    return () => clearInterval(t);
  }, [count]);

  useEffect(() => {
    if (!open) return;
    load();
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open, load]);

  const markAll = async () => {
    await api('/api/notifications/read', { body: {} }).catch(() => undefined);
    load();
  };
  const go = async (n: Item) => {
    if (!n.read_at) await api('/api/notifications/read', { body: { ids: [n.id] } }).catch(() => undefined);
    setOpen(false);
    count();
    if (n.link) router.push(n.link);
  };

  return (
    <div className="bell" ref={box}>
      <button className="btn ghost small bell-btn" onClick={() => setOpen(!open)} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        {unread > 0 && <span className="bell-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <div className="bell-panel" role="dialog" aria-label="Notifications">
          <div className="bell-head">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="btn ghost small" onClick={markAll}>
                Mark all read
              </button>
            )}
          </div>
          <div className="bell-list">
            {!items ? (
              <div className="muted small bell-empty">Loading…</div>
            ) : items.length === 0 ? (
              <div className="muted small bell-empty">Nothing yet. Shift updates and approvals will show up here.</div>
            ) : (
              items.map((n) => (
                <button key={n.id} className={`bell-item ${n.read_at ? '' : 'unread'}`} onClick={() => go(n)}>
                  <span className="bell-title">{n.title}</span>
                  <span className="bell-body">{n.body.split('\n').filter(Boolean).slice(0, 2).join(' · ')}</span>
                  <span className="bell-time">{ago(n.created_at)}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
