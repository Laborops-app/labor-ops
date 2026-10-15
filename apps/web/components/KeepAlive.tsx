'use client';
import { Activity, createContext, Suspense, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import {
  NavigationPromisesContext, PathnameContext, PathParamsContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { matchPage } from './pageRoutes';
import { useTabs } from '@/lib/tabs';

/**
 * Keeps the page of every open tab alive. The page you are on is shown; the others stay mounted but hidden
 * (React <Activity>), so what you typed, scrolled to or opened is still there when you come back.
 * Hidden pages pause their timers and listeners, and their popups are hidden with them.
 *
 * Each page keeps seeing its own address (usePathname/useParams/useSearchParams) while hidden, so an event tab
 * never starts reading another tab's id.
 */
const ActiveContext = createContext(true);
/** False while this page sits in a tab that is not open. */
export const usePageActive = () => useContext(ActiveContext);

type Snap = { pathname: string; params: Record<string, string | string[]>; search: URLSearchParams | null };

export default function KeepAlive({ fallback }: { fallback: React.ReactNode }) {
  const path = usePathname();
  const live: Snap = {
    pathname: useContext(PathnameContext) ?? path,
    params: (useContext(PathParamsContext) as Snap['params'] | null) ?? {},
    search: useContext(SearchParamsContext) as URLSearchParams | null,
  };
  const tabs = useTabs();
  const kept = useRef(new Map<string, Snap>());
  const scroll = useRef(new Map<string, number>());
  const current = matchPage(path);

  // The page being shown always follows the live address; closed tabs are dropped.
  if (current) kept.current.set(path, live);
  const open = new Set(tabs.map((t) => t.key));
  open.add(path);
  for (const k of [...kept.current.keys()]) if (!open.has(k)) kept.current.delete(k);

  // Each tab remembers how far down it was scrolled (tracked as you scroll: by the time a tab is hidden the
  // browser has already clamped the scroll to the new, shorter page).
  const here = useRef(path);
  useEffect(() => {
    const onScroll = () => scroll.current.set(here.current, window.scrollY);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useLayoutEffect(() => {
    if (here.current === path) return;
    here.current = path;
    window.scrollTo(0, scroll.current.get(path) ?? 0);
  }, [path]);

  return (
    <>
      {[...kept.current.entries()].map(([key, snap]) => {
        const m = matchPage(key);
        if (!m) return null;
        const { Page } = m.route;
        const active = key === path;
        return (
          <Activity key={key} mode={active ? 'visible' : 'hidden'}>
            <ActiveContext.Provider value={active}>
              <PathnameContext.Provider value={snap.pathname}>
                <PathParamsContext.Provider value={snap.params}>
                  <SearchParamsContext.Provider value={snap.search}>
                    <NavigationPromisesContext.Provider value={null}>
                      <Suspense fallback={<div className="center muted">Loading…</div>}>
                        <Page />
                      </Suspense>
                    </NavigationPromisesContext.Provider>
                  </SearchParamsContext.Provider>
                </PathParamsContext.Provider>
              </PathnameContext.Provider>
            </ActiveContext.Provider>
          </Activity>
        );
      })}
      {!current && fallback}
    </>
  );
}
