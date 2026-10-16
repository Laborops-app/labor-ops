'use client';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState } from 'react';
import { api, ApiError, Me, Role, roleLabel } from '@/lib/api';
import ThemeToggle from '@/components/ThemeToggle';
import InstallApp, { InstallPopup } from '@/components/InstallApp';
import PunchSync from '@/components/PunchSync';
import NotificationBell from '@/components/NotificationBell';
import Sidebar from '@/components/Sidebar';
import AppTabs from '@/components/AppTabs';
import KeepAlive, { usePageActive } from '@/components/KeepAlive';
import { closeOtherTabs, closeTab, initTabs, openTab } from '@/lib/tabs';

const icon = (d: React.ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);

const NAV: { href: string; label: string; roles: Role[]; rates?: boolean; field?: boolean; icon: React.ReactNode }[] = [
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
    href: '/pipeline',
    label: 'Pipeline',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M9 3v18M15 3v18M5.5 7h1M11.5 7h1M17.5 7h1M11.5 11h1M17.5 11h1M17.5 15h1" />
      </>,
    ),
  },
  {
    href: '/customers',
    label: 'Customers',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <path d="M4 21V7l8-4 8 4v14M9 21v-6h6v6M9 10h.01M15 10h.01" />
      </>,
    ),
  },
  {
    href: '/quotes',
    label: 'Quotes',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <path d="M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7" />
      </>,
    ),
  },
  {
    href: '/quote-layouts',
    label: 'Quote layouts',
    roles: ['admin'],
    icon: icon(
      <>
        <path d="M4 4h16v16H4zM4 9h16M9 9v11" />
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
    roles: ['admin', 'manager'],
    rates: true, // coordinators only when an admin has allowed them to adjust rates
    icon: icon(
      <>
        <path d="M12 2v20M17 6.5C17 4.6 14.8 3.5 12 3.5S7 4.6 7 6.5 9.2 9.5 12 10s5 1.6 5 3.5-2.2 3-5 3-5-1.1-5-3" />
      </>,
    ),
  },
  {
    href: '/integrations',
    label: 'Integrations',
    roles: ['admin'],
    icon: icon(
      <>
        <path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" />
      </>,
    ),
  },
  {
    href: '/payroll',
    label: 'Payroll',
    roles: ['admin'],
    icon: icon(
      <>
        <rect x="3" y="6" width="18" height="12" rx="2" />
        <circle cx="12" cy="12" r="2.5" />
        <path d="M6 9v.01M18 15v.01" />
      </>,
    ),
  },
  {
    href: '/reports',
    label: 'Reports',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
      </>,
    ),
  },
  {
    href: '/billing',
    label: 'Billing',
    roles: ['admin'],
    icon: icon(
      <>
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M2 10h20M6 15h4" />
      </>,
    ),
  },
  {
    href: '/rules',
    label: 'Labor rules',
    roles: ['admin'],
    icon: icon(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>,
    ),
  },
  {
    href: '/groups',
    label: 'Crew groups',
    roles: ['admin', 'manager'],
    icon: icon(
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M17 11a3 3 0 1 0 0-6M21 20c0-2.5-1.6-4.6-4-5.5" />
      </>,
    ),
  },
  {
    href: '/trainings',
    label: 'Trainings',
    roles: ['admin', 'manager', 'crew'],
    icon: icon(
      <>
        <path d="M2 9l10-5 10 5-10 5z" />
        <path d="M6 11v5c0 1.5 2.7 3 6 3s6-1.5 6-3v-5" />
      </>,
    ),
  },
  {
    href: '/chat',
    label: 'Chat',
    roles: ['admin', 'manager', 'crew'],
    icon: icon(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />),
  },
  {
    href: '/messaging',
    label: 'Messaging',
    roles: ['admin'],
    icon: icon(
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="m3 7 9 6 9-6" />
      </>,
    ),
  },
  {
    href: '/onsite',
    label: 'On site',
    roles: ['crew'],
    field: true, // on-site labor coordinators, and crew who are a lead on an event
    icon: icon(
      <>
        <path d="M9 11l3 3 7-7" />
        <path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9" />
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

/** What a tab is called until its page says (an event's name, a customer's name…). */
const DETAIL: Record<string, string> = { events: 'Event', customers: 'Customer', quotes: 'Quote', crew: 'Crew member', 'my-shifts': 'Shift' };
function tabTitle(path: string) {
  const [, first, id] = path.split('/');
  if (id) return DETAIL[first] ?? '…';
  return NAV.find((n) => n.href === path)?.label ?? (first ? first.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : 'Home');
}
function tabIcon(path: string) {
  const n = NAV.filter((x) => path === x.href || path.startsWith(x.href + '/')).sort((a, b) => b.href.length - a.href.length)[0];
  return n?.icon ?? null;
}

const MOBILE_ON_PROFILE = ['/trainings', '/availability'];
const MeContext = createContext<Me | null>(null);
/** The signed-in person, for pages inside the app frame. */
export const useMe = () => useContext(MeContext);

/**
 * The app frame (sidebar, top bar, tab bar), drawn once for every page in the app. Each open tab's page is kept
 * alive underneath it (see KeepAlive), so switching tabs does not lose what was on screen.
 */
export function AppFrame({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState<Me | null>(null);
  const [chatUnread, setChatUnread] = useState(0);

  useEffect(() => {
    api<{ user: Me }>('/api/auth/me')
      .then(({ user }) => {
        setMe(user);
        try { localStorage.setItem('lo_me', JSON.stringify(user)); } catch { /* storage blocked */ }
      })
      .catch((e) => {
        // No signal: open with who was signed in last time, so crew can still see shifts and clock in offline.
        if (!(e instanceof ApiError)) {
          try {
            const cached = JSON.parse(localStorage.getItem('lo_me') || 'null');
            if (cached) return setMe(cached);
          } catch { /* ignore */ }
        }
        router.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!me) return;
    const poll = () => document.visibilityState === 'visible' && api<{ unread: number }>('/api/chat/unread').then((r) => setChatUnread(r.unread)).catch(() => undefined);
    poll();
    const t = setInterval(poll, 8000);
    return () => clearInterval(t);
  }, [me, path]);

  // Every page opened gets an in-app tab.
  useEffect(() => {
    if (!me) return;
    initTabs(me.id);
    openTab(path, path + window.location.search, tabTitle(path));
    // Phones have no tab row: only the page on screen is kept.
    if (matchMedia('(max-width: 899px)').matches) closeOtherTabs(path);
  }, [me, path]);

  if (!me) return <div className="center muted">Loading…</div>;

  const signOut = async () => {
    await api('/api/auth/logout', { method: 'POST', body: {} });
    try { localStorage.removeItem('lo_me'); localStorage.removeItem('lo_my_shifts'); } catch { /* ignore */ }
    // A full reload, so nothing from this session's open tabs stays in memory.
    window.location.href = '/login';
  };
  const items = NAV.filter((n) => n.roles.includes(me.role) && (!n.rates || me.role === 'admin' || me.canAdjustRates) && (!n.field || !!me.fieldRoles?.length || !!me.leads));

  const current = items.find((n) => path.startsWith(n.href));
  // The phone's bottom bar: Trainings and Availability live on the Profile page there.
  const tabbarItems = items.filter((n) => !MOBILE_ON_PROFILE.includes(n.href));

  return (
    <MeContext.Provider value={me}>
    <div className="app">
      <Sidebar items={items} me={me} path={path} chatUnread={chatUnread} />

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
          <div id="topbar-actions" className="topbar-actions" />
          <InstallApp className="btn small install-btn" />
          <InstallPopup />
          <ThemeToggle />
          <NotificationBell />
          <Link href="/profile" className="me" aria-label={`My profile (${me.name}, ${roleLabel(me.role)})`} title={`${me.name} · ${me.company ? `${me.company} · ` : ''}${roleLabel(me.role)}`}>
            {initials(me.name)}
          </Link>
          <button className="icon-btn" onClick={signOut} aria-label="Sign out" title="Sign out">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H4" />
            </svg>
          </button>
        </header>
        <AppTabs path={path} iconFor={tabIcon} />
        <PunchSync />
        <main className="page"><KeepAlive fallback={children} /></main>
      </div>

      {tabbarItems.length > 1 && (
        <nav className="tabbar" aria-label="Main">
          {tabbarItems.map((n) => (
            <Link key={n.href} href={n.href} className={path.startsWith(n.href) ? 'active' : ''} aria-current={path.startsWith(n.href) ? 'page' : undefined}>
              {n.icon}
              {n.href === '/chat' && chatUnread > 0 && <span className="nav-badge" aria-label={`${chatUnread} unread conversations`}>{chatUnread > 9 ? '9+' : chatUnread}</span>}
              <span>{n.label}</span>
            </Link>
          ))}
        </nav>
      )}
    </div>
    </MeContext.Provider>
  );
}

/**
 * A page's content inside the app frame. Only people with one of `roles` see it; others are sent to their home page.
 * (The frame itself is drawn once by AppFrame in the (app) layout.)
 */
export default function Shell({ roles, children }: { roles: Role[]; children: (me: Me) => React.ReactNode }) {
  const me = useMe();
  const router = useRouter();
  const active = usePageActive();
  const here = usePathname();
  const allowed = !!me && roles.includes(me.role);
  useEffect(() => {
    if (!me || allowed || !active) return;
    closeTab(here, ''); // no tab for a page this person cannot open
    router.replace(me.role === 'crew' ? '/my-shifts' : '/dashboard');
  }, [me, allowed, active, router, here]);
  if (!me) return <div className="center muted">Loading…</div>;
  if (!allowed) return null;
  return <>{children(me)}</>;
}
