'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, Me, Role, roleLabel } from '@/lib/api';
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
    href: '/schedule',
    label: 'Schedule',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <rect x="3" y="4" width="18" height="18" rx="2.5" />
        <path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
      </>,
    ),
  },
  {
    href: '/events',
    label: 'Events',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <rect x="3" y="7" width="18" height="13" rx="2.5" />
        <path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 13h18" />
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
    href: '/requests',
    label: 'Requests',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <path d="M22 12h-6l-2 3h-4l-2-3H2" />
        <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
      </>,
    ),
  },
  {
    href: '/skills',
    label: 'Roles & rates',
    roles: ['admin'],
    icon: icon(
      <>
        <path d="M12 2v20M17 6.5C17 4.6 14.8 3.5 12 3.5S7 4.6 7 6.5 9.2 9.5 12 10s5 1.6 5 3.5-2.2 3-5 3-5-1.1-5-3" />
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
  {
    href: '/my-calendar',
    label: 'Calendar',
    roles: ['crew'],
    icon: icon(
      <>
        <rect x="3" y="4" width="18" height="18" rx="2.5" />
        <path d="M16 2v4M8 2v4M3 10h18M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01" />
      </>,
    ),
  },
  {
    href: '/open-shifts',
    label: 'Open shifts',
    roles: ['crew'],
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9.5" />
        <path d="M12 8v8M8 12h8" />
      </>,
    ),
  },
  {
    href: '/availability',
    label: 'Availability',
    roles: ['crew'],
    icon: icon(<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />),
  },
  {
    href: '/profile',
    label: 'Profile',
    roles: ['crew'],
    icon: icon(
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1" />
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

  const current = items.find((n) => path.startsWith(n.href));

  return (
    <div className="app">
      <aside className="rail" aria-label="Main">
        <Link href="/" className="logo" aria-label="LaborOps home">
          <Image src="/brand/icon.png" alt="" width={38} height={38} priority />
        </Link>
        <nav>
          {items.map((n) => (
            <Link key={n.href} href={n.href} aria-label={n.label} className={path.startsWith(n.href) ? 'active' : ''} aria-current={path.startsWith(n.href) ? 'page' : undefined}>
              {n.icon}
              <span className="tip">{n.label}</span>
            </Link>
          ))}
        </nav>
        <div className="rail-foot">
          <ThemeToggle />
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <Link href="/" className="brand">
            <Image src="/brand/icon.png" alt="" width={28} height={28} priority />
            <span>
              Labor<b>Ops</b>
            </span>
          </Link>
          <span className="page-title">{current?.label ?? ''}</span>
          <span className="spacer" />
          <Link href="/profile" className="who" aria-label="My profile">
            <span className="avatar solid" aria-hidden="true">
              {initials(me.name)}
            </span>
            <span className="txt">
              <span className="name">{me.name}</span>
              <span className="role">
                {me.company ? `${me.company} · ` : ''}
                {roleLabel(me.role)}
              </span>
            </span>
          </Link>
          <span className="mobile-only-toggle">
            <ThemeToggle />
          </span>
          <button className="btn ghost small" onClick={signOut}>
            Sign out
          </button>
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
