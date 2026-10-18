'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, homeFor, type Me } from '@/lib/api';

/** The client portal's frame: who you are, the company you work with, and two links. Non-client accounts are sent home. */
export default function ClientFrame({ children }: { children: (me: Me) => React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    api<{ user: Me }>('/api/auth/me')
      .then(({ user }) => (user.role === 'client' ? setMe(user) : router.replace(homeFor(user.role))))
      .catch(() => router.replace(`/login?next=${encodeURIComponent(path)}`));
  }, [router, path]);
  if (!me) return <div className="center muted">Loading…</div>;
  return (
    <div className="cp">
      <header className="cp-top">
        <div className="cp-brand">
          <b>{me.company}</b>
          <span className="muted small">Client portal · {me.customer?.name}</span>
        </div>
        <nav className="cp-nav" aria-label="Client portal">
          <Link href="/client" className={path === '/client' || path.startsWith('/client/events') ? 'on' : ''}>Events</Link>
          <Link href="/client/request" className={path === '/client/request' ? 'on' : ''}>Request crew</Link>
          <button type="button" className="btn ghost small" onClick={async () => { await api('/api/auth/logout', { method: 'POST', body: {} }).catch(() => {}); window.location.href = '/login'; }}>Sign out</button>
        </nav>
      </header>
      <main className="cp-main">{children(me)}</main>
      <footer className="cp-foot muted small">Signed in as {me.name} · Powered by LaborOps</footer>
    </div>
  );
}
