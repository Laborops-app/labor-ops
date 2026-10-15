'use client';
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

// Every page in the app, so the tab keeper can render the page for any open tab (one entry per app/(app) page file).
// A page missing here still works, it just is not kept alive when you switch tabs.
export type PageRoute = { pattern: string; re: RegExp; keys: string[]; Page: LazyExoticComponent<ComponentType> };
const route = (pattern: string, load: () => Promise<{ default: ComponentType }>): PageRoute => {
  const keys: string[] = [];
  const re = new RegExp('^' + pattern.replace(/\[([^\]]+)\]/g, (_m, k: string) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  return { pattern, re, keys, Page: lazy(load) };
};
export const PAGE_ROUTES: PageRoute[] = [
  route('/accounting', () => import('@/app/(app)/accounting/page')),
  route('/availability', () => import('@/app/(app)/availability/page')),
  route('/chat', () => import('@/app/(app)/chat/page')),
  route('/crew/[id]', () => import('@/app/(app)/crew/[id]/page')),
  route('/crew', () => import('@/app/(app)/crew/page')),
  route('/customers/[id]', () => import('@/app/(app)/customers/[id]/page')),
  route('/customers', () => import('@/app/(app)/customers/page')),
  route('/dashboard', () => import('@/app/(app)/dashboard/page')),
  route('/events/[id]', () => import('@/app/(app)/events/[id]/page')),
  route('/events', () => import('@/app/(app)/events/page')),
  route('/groups', () => import('@/app/(app)/groups/page')),
  route('/integrations', () => import('@/app/(app)/integrations/page')),
  route('/messaging', () => import('@/app/(app)/messaging/page')),
  route('/my-calendar', () => import('@/app/(app)/my-calendar/page')),
  route('/my-shifts/[id]', () => import('@/app/(app)/my-shifts/[id]/page')),
  route('/my-shifts', () => import('@/app/(app)/my-shifts/page')),
  route('/open-shifts', () => import('@/app/(app)/open-shifts/page')),
  route('/payroll', () => import('@/app/(app)/payroll/page')),
  route('/pipeline', () => import('@/app/(app)/pipeline/page')),
  route('/profile', () => import('@/app/(app)/profile/page')),
  route('/quote-layouts', () => import('@/app/(app)/quote-layouts/page')),
  route('/quotes/[id]', () => import('@/app/(app)/quotes/[id]/page')),
  route('/quotes', () => import('@/app/(app)/quotes/page')),
  route('/requests', () => import('@/app/(app)/requests/page')),
  route('/rules', () => import('@/app/(app)/rules/page')),
  route('/schedule', () => import('@/app/(app)/schedule/page')),
  route('/skills', () => import('@/app/(app)/skills/page')),
  route('/timesheets', () => import('@/app/(app)/timesheets/page')),
  route('/trainings', () => import('@/app/(app)/trainings/page')),
];

/** The page for a path and its [params], or null when it is not an app page. */
export function matchPage(path: string): { route: PageRoute; params: Record<string, string> } | null {
  for (const route of PAGE_ROUTES) {
    const m = route.re.exec(path);
    if (m) return { route, params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}
