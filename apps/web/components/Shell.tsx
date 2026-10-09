'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, Me, Role } from '@/lib/api';
import ThemeToggle from '@/components/ThemeToggle';

const icon = (d: React.ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

const NAV: { href: string; label: string; roles: Role[]; icon: React.ReactNode }[] = [
  {
    href: '/dashboard',
    label: 'Dashboard',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <rect x="3" y="3" width="7" height="9" rx="1.5" />
        <rect x="14" y="3" width="7" height="5" rx="1.5" />
        <rect x="14" y="12" width="7" height="9" rx="1.5" />
        <rect x="3" y="16" width="7" height="5" rx="1.5" />
      </>,
    ),
  },
  {
    href: '/events',
    label: 'Events',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <rect x="3" y="4" width="18" height="18" rx="2.5" />
        <path d="M16 2v4M8 2v4M3 10h18" />
      </>,
    ),
  },
  {
    href: '/crew',
    label: 'Crew',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <path d="M17 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9.5" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </>,
    ),
  },
  {
    href: '/timesheets',
    label: 'Timesheets',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>,
    ),
  },
  {
    href: '/my-shifts',
    label: 'My shifts',
    roles: ['crew'],
    icon: icon(
      <>
        <rect x="3" y="4" width="18" height="18" rx="2.5" />
        <path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4" />
      </>,
    ),
  },
];

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');
}

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
  const items = NAV.filter((n) => n.roles.includes(me.role));

  return (
    <div className="app">
      <aside className="sidebar" aria-label="Main">
        <Link href="/" className="brand">
          <Image src="/brand/icon.png" alt="" width={34} height={34} priority />
          <span>
            Labor<b>Ops</b>
          </span>
        </Link>
        <nav>
          {items.map((n) => (
            <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? 'active' : ''} aria-current={path.startsWith(n.href) ? 'page' : undefined}>
              {n.icon}
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="side-foot">
          <div className="user">
            <div className="avatar" aria-hidden="true">
              {initials(me.name)}
            </div>
            <div className="user-text">
              <b>{me.name}</b>
              <span className="muted small">
                {me.company ? `${me.company} · ` : ''}
                {me.role}
              </span>
            </div>
          </div>
          <div className="row">
            <ThemeToggle />
            <button className="btn ghost small" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Link href="/" className="brand">
            <Image src="/brand/icon.png" alt="" width={30} height={30} priority />
            <span>
              Labor<b>Ops</b>
            </span>
          </Link>
          <div className="topbar-right">
            <ThemeToggle />
            <button className="btn ghost small" onClick={signOut}>
              Sign out
            </button>
          </div>
        </header>
        <main className="page">{children(me)}</main>
      </div>

      {items.length > 1 && (
        <nav className="tabbar" aria-label="Main">
          {items.map((n) => (
            <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? 'active' : ''} aria-current={path.startsWith(n.href) ? 'page' : undefined}>
              {n.icon}
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
      )}
    </div>
  );
}
