'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { usePathname } from 'next/navigation';

/**
 * In-app tabs. Every page you open gets a tab (one per path); opening it again switches to it.
 * Kept in this browser per signed-in person, so tabs survive a reload. The page itself is not kept alive:
 * switching tabs reopens the page at the address it was last on.
 */
export type AppTab = { key: string; href: string; title: string; used: number };

const MAX = 15;
let uid: string | null = null;
let tabs: AppTab[] = [];
const listeners = new Set<() => void>();
// Titles a page reported before its tab existed (the page can render before the tab bar is ready).
const pending = new Map<string, string>();
const storeKey = () => `lo_tabs:${uid}`;

function save() {
  try {
    if (uid) localStorage.setItem(storeKey(), JSON.stringify(tabs));
  } catch {
    /* storage blocked: tabs still work until reload */
  }
}
function emit() {
  tabs = [...tabs];
  save();
  listeners.forEach((l) => l());
}

export function initTabs(userId: string) {
  if (uid === userId) return;
  uid = userId;
  try {
    const raw = JSON.parse(localStorage.getItem(storeKey()) ?? '[]');
    tabs = Array.isArray(raw) ? raw.filter((t) => t && typeof t.key === 'string' && typeof t.href === 'string').slice(0, MAX) : [];
  } catch {
    tabs = [];
  }
  listeners.forEach((l) => l());
}

/** The page at `key` is open: add its tab, or bring it up to date. */
export function openTab(key: string, href: string, fallback: string) {
  const title = pending.get(key) ?? fallback;
  const t = tabs.find((x) => x.key === key);
  if (t) {
    t.href = href;
    t.used = Date.now();
    if (pending.has(key) || !t.title) t.title = title;
  } else {
    tabs.push({ key, href, title, used: Date.now() });
    // Too many: drop the one used longest ago (never the one just opened).
    while (tabs.length > MAX) {
      const old = tabs.filter((x) => x.key !== key).sort((a, b) => a.used - b.used)[0];
      tabs = tabs.filter((x) => x !== old);
    }
  }
  emit();
}

export function setTabTitle(key: string, title: string) {
  if (title) pending.set(key, title);
  const t = tabs.find((x) => x.key === key);
  if (!t || !title || t.title === title) return;
  t.title = title;
  emit();
}

/** Close a tab. Returns where to go if it was the open one (the tab to its right, else its left). */
export function closeTab(key: string, current: string): string | null {
  const i = tabs.findIndex((x) => x.key === key);
  if (i < 0) return null;
  tabs.splice(i, 1);
  emit();
  if (key !== current) return null;
  return (tabs[i] ?? tabs[i - 1])?.href ?? '/dashboard';
}

export function closeOtherTabs(keep: string) {
  tabs = tabs.filter((x) => x.key === keep);
  emit();
}

export function moveTab(key: string, to: number) {
  const i = tabs.findIndex((x) => x.key === key);
  if (i < 0) return;
  const [t] = tabs.splice(i, 1);
  tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, t);
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const EMPTY: AppTab[] = [];
export const useTabs = () => useSyncExternalStore(subscribe, () => tabs, () => EMPTY);

/** Detail pages call this with what they show (an event's name, a customer's name…) to label their tab. */
export function useTabTitle(title: string | null | undefined) {
  const path = usePathname();
  useEffect(() => {
    if (title) setTabTitle(path, title);
  }, [path, title]);
}
