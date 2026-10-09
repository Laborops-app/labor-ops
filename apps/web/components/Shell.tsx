'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, Me, Role } from '@/lib/api';

const NAV: { href: string; label: string; roles: Role[] }[] = [
  { href: '/dashboard', label: 'Dashboard', roles: ['admin', 'manager'] },
  { href: '/events', label: 'Events', roles: ['admin', 'manager'] },
  { href: '/crew', label: 'Crew', roles: ['admin', 'manager'] },
  { href: '/timesheets', label: 'Timesheets', roles: ['admin', 'manager'] },
  { href: '/my-shifts', label: 'My shifts', roles: ['crew'] },
];

export default function Shell({ roles, children }: { roles: Role[]; children: (me: Me) => React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api<{ user: Me }>('/api/auth/me')
      .then(({ user }) => {
        if (!roles.includes(user.role)) router.replace(user.role === 'crew' ? '/my-shifts' : '/dashboard');
        else setMe(user);
      })
      .catch(() => router.replace('/login'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!me) return <div className="center muted">Loading…</div>;

  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    router.replace('/login');
  };

  return (
    <div className="shell">
      <header className="topbar">
        <Link href="/" className="brand">
          <Image src="/brand/icon.png" alt="" width={32} height={32} priority />
          <span>
            Labor<b>Ops</b>
          </span>
        </Link>
        <nav>
          {NAV.filter((n) => n.roles.includes(me.role)).map((n) => (
            <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? 'active' : ''}>
              {n.label}
            </Link>
          ))}
        </nav>
        <div className="who">
          <span className="muted small">
            {me.company ? `${me.company} · ` : ''}
            {me.name} ({me.role})
          </span>
          <button className="btn ghost small" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="page">{children(me)}</main>
    </div>
  );
}
