'use client';
import Link from 'next/link';
import Image from 'next/image';
import { createContext, useContext, useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { api, ApiError } from '@/lib/api';
import ThemeToggle from '@/components/ThemeToggle';
import { avClass, initialsOf } from '@/components/TopbarAction';

/* The platform console: a separate app for the people who run LaborOps. It has its own sign-in and never shows company screens. */

export type PlatformUser = { id: string; name: string; email: string };
const Ctx = createContext<PlatformUser | null>(null);
export const usePlatformUser = () => useContext(Ctx)!;

/** API call that sends the person back to the console sign-in when their session ends. */
export async function papi<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  try {
    return await api<T>(path, init);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && typeof location !== 'undefined' && !location.pathname.startsWith('/platform/login')) {
      location.replace(`/platform/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    }
    throw e;
  }
}

export const ago = (iso: string | null | undefined) => {
  if (!iso) return 'Never';
  const m = (Date.now() - new Date(iso).getTime()) / 60000;
  if (m < 1) return 'Just now';
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  if (m < 60 * 24 * 60) return `${Math.round(m / 1440)} d ago`;
  return new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
};
export const num = (n: number | null | undefined) => (n ?? 0).toLocaleString();
export const PLAN_LABEL: Record<string, string> = { trial: 'Trial', starter: 'Starter', pro: 'Pro', enterprise: 'Enterprise', internal: 'Internal' };
export const planLabel = (p: string) => PLAN_LABEL[p] ?? p;

export function CoAvatar({ name, size = 34 }: { name: string; size?: number }) {
  return <span className={avClass(name)} aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size / 2.8), flex: 'none' }}>{initialsOf(name)}</span>;
}

const icon = (d: React.ReactNode) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const NAV = [
  { href: '/platform', label: 'Dashboard', icon: icon(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>) },
  { href: '/platform/companies', label: 'Companies', icon: icon(<><path d="M3 21h18M5 21V7l7-4 7 4v14" /><path d="M9 21v-5h6v5M9 10h.01M15 10h.01" /></>) },
  { href: '/platform/storage', label: 'Storage', icon: icon(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>) },
  { href: '/platform/backups', label: 'Backups', icon: icon(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>) },
  { href: '/platform/admins', label: 'Admins', icon: icon(<><path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6l8-3z" /><path d="M9 12l2 2 4-4" /></>) },
  { href: '/platform/activity', label: 'Activity', icon: icon(<><path d="M3 12h4l3-8 4 16 3-8h4" /></>) },
];

export default function ConsoleShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const [me, setMe] = useState<PlatformUser | null>(null);
  useEffect(() => {
    papi<{ user: PlatformUser }>('/api/platform/auth/me').then((r) => setMe(r.user)).catch(() => undefined);
  }, []);
  if (!me) return <div className="center muted">Loading…</div>;
  const on = (href: string) => (href === '/platform' ? path === href : path === href || path.startsWith(href + '/'));
  const signOut = async () => {
    await api('/api/platform/auth/logout', { method: 'POST', body: {} }).catch(() => undefined);
    router.replace('/platform/login');
  };
  return (
    <Ctx.Provider value={me}>
      <div className="cs">
        <aside className="cs-side">
          <Link href="/platform" className="cs-brand">
            <Image src="/brand/icon.png" alt="" width={30} height={30} priority />
            <span>
              Labor<b>Ops</b>
              <small>Platform console</small>
            </span>
          </Link>
          <nav className="cs-nav" aria-label="Platform console">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className={on(n.href) ? 'on' : ''} aria-current={on(n.href) ? 'page' : undefined}>
                {n.icon}
                <span>{n.label}</span>
              </Link>
            ))}
          </nav>
          <div className="cs-me">
            <CoAvatar name={me.name || me.email} size={36} />
            <span className="cs-me-main">
              <b>{me.name || 'Platform admin'}</b>
              <span className="muted small">{me.email}</span>
            </span>
          </div>
          <div className="cs-me-actions">
            <Link href="/platform/account" className={`btn ghost small${on('/platform/account') ? ' on' : ''}`}>Account</Link>
            <button className="btn ghost small" onClick={signOut}>Sign out</button>
          </div>
        </aside>
        <div className="cs-main">
          <header className="cs-top">
            <span className="cs-env">
              <span className="cs-dot" aria-hidden="true" /> Operator access · every company
            </span>
            <span className="spacer" />
            <ThemeToggle />
          </header>
          <main className="cs-page">{children}</main>
        </div>
      </div>
    </Ctx.Provider>
  );
}

/** Page heading with an optional action area on the right. */
export function Head({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="cs-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {children && <div className="cs-head-actions">{children}</div>}
    </div>
  );
}
