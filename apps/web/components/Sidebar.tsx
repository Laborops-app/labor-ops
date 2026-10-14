'use client';
import Link from 'next/link';
import { Fragment, useEffect, useState } from 'react';
import type { Me } from '@/lib/api';
import { roleLabel } from '@/lib/api';

export type NavItem = { href: string; label: string; icon: React.ReactNode };

/** How the menu is grouped. Items not listed fall into "More"; children sit under their parent with a tree line. */
const SECTIONS: { title: string; items: string[] }[] = [
  { title: 'Main', items: ['/dashboard', '/schedule', '/events', '/requests', '/timesheets', '/chat'] },
  { title: 'My work', items: ['/my-shifts', '/my-calendar', '/open-shifts', '/availability'] },
  { title: 'Sales', items: ['/customers', '/quotes'] },
  { title: 'People', items: ['/crew', '/skills', '/trainings'] },
  { title: 'Admin', items: ['/payroll', '/rules', '/integrations', '/messaging'] },
  { title: 'Account', items: ['/profile'] },
];
const CHILDREN: Record<string, string[]> = { '/quotes': ['/quote-layouts'], '/crew': ['/groups'] };
const KEY = 'lo_sb_collapsed';

/** Glass sidebar (expanded 256px / collapsed 104px) with grouped sections, sub-menus and a quick action. */
export default function Sidebar({ items, me, path, chatUnread }: { items: NavItem[]; me: Me; path: string; chatUnread: number }) {
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [fly, setFly] = useState<{ href: string; top: number; left: number } | null>(null);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(KEY) === '1');
    } catch {
      /* storage blocked */
    }
  }, []);
  const toggle = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(KEY, c ? '0' : '1');
      } catch {
        /* storage blocked */
      }
      return !c;
    });
    setFly(null);
  };

  // The floating panel is fixed-positioned so the scrolling menu cannot clip it.
  const showFly = (href: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setFly({ href, top: Math.max(8, Math.min(r.top - 3, window.innerHeight - 220)), left: r.left + 53 });
  };
  const by = new Map(items.map((i) => [i.href, i]));
  const isOn = (href: string) => path === href || path.startsWith(href + '/');
  const childHrefs = new Set(Object.values(CHILDREN).flat());
  const placed = new Set(SECTIONS.flatMap((s) => s.items).concat([...childHrefs]));
  const sections = [...SECTIONS, { title: 'More', items: items.map((i) => i.href).filter((h) => !placed.has(h)) }]
    .map((s) => ({ title: s.title, items: s.items.map((h) => by.get(h)).filter(Boolean) as NavItem[] }))
    .filter((s) => s.items.length);
  const kids = (href: string) => (CHILDREN[href] ?? []).map((h) => by.get(h)).filter(Boolean) as NavItem[];
  // A child whose parent is hidden for this role is shown on its own.
  for (const [parent, list] of Object.entries(CHILDREN))
    if (!by.has(parent)) for (const h of list) if (by.has(h) && !sections.some((s) => s.items.some((i) => i.href === h))) sections[sections.length - 1]?.items.push(by.get(h)!);

  const manager = me.role !== 'crew';
  const cta = manager ? { title: 'Plan a show', text: 'Set up a new event and its shifts in a few steps.', label: 'New event', href: '/events' } : { title: 'Pick up work', text: 'See shifts that are open for you to claim.', label: 'Open shifts', href: '/open-shifts' };
  const badge = (href: string) => (href === '/chat' && chatUnread > 0 ? <span className="sb-badge" aria-label={`${chatUnread} unread conversations`}>{chatUnread > 9 ? '9+' : chatUnread}</span> : null);
  const initials = me.name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

  return (
    <aside className={collapsed ? 'sb collapsed' : 'sb'} aria-label="Main">
      <div className="sb-dots" aria-hidden="true" />
      <div className="sb-head">
        <Link href="/profile" className="sb-who" aria-label="My profile">
          <span className="sb-avatar" aria-hidden="true">{initials}</span>
          <span className="sb-who-txt">
            <span className="sb-role">{roleLabel(me.role)}</span>
            <span className="sb-name">{me.name}</span>
          </span>
        </Link>
        <button type="button" className="sb-toggle" onClick={toggle} aria-label={collapsed ? 'Expand the menu' : 'Collapse the menu'} aria-expanded={!collapsed} />
      </div>
      <div className="sb-line" />
      <nav className="sb-nav" onScroll={() => fly && setFly(null)}>
        {sections.map((s, si) => (
          <Fragment key={s.title}>
            {si > 0 && <div className="sb-line" />}
            <div className="sb-section">
              <div className="sb-title">{s.title}</div>
              {s.items.map((n) => {
                const children = kids(n.href);
                const active = isOn(n.href);
                const childActive = children.some((c) => isOn(c.href));
                const expanded = children.length > 0 && (open[n.href] ?? (active || childActive));
                return (
                  <div key={n.href} className="sb-group" onMouseEnter={(e) => collapsed && showFly(n.href, e.currentTarget)} onMouseLeave={() => collapsed && setFly((f) => (f?.href === n.href ? null : f))}>
                    <div className={active || childActive ? 'sb-item on' : 'sb-item'}>
                      <Link href={n.href} className="sb-link" aria-current={active ? 'page' : undefined} aria-label={collapsed ? n.label : undefined} onFocus={(e) => collapsed && showFly(n.href, e.currentTarget.closest('.sb-group') as HTMLElement)}>
                        <span className="sb-icon">{n.icon}{badge(n.href)}</span>
                        <span className="sb-label">{n.label}</span>
                      </Link>
                      {children.length > 0 && !collapsed && (
                        <button type="button" className={expanded ? 'sb-chev open' : 'sb-chev'} aria-label={`${expanded ? 'Hide' : 'Show'} ${n.label} pages`} aria-expanded={expanded} onClick={() => setOpen({ ...open, [n.href]: !expanded })} />
                      )}
                      {(active || childActive) && <span className="sb-glow" aria-hidden="true" />}
                    </div>
                    {expanded && !collapsed && (
                      <div className="sb-tree">
                        {children.map((c) => (
                          <Link key={c.href} href={c.href} className={isOn(c.href) ? 'sb-sub on' : 'sb-sub'} aria-current={isOn(c.href) ? 'page' : undefined}>
                            {c.label}
                          </Link>
                        ))}
                      </div>
                    )}
                    {collapsed && fly?.href === n.href && (
                      <div className="sb-fly" role="menu" style={{ top: fly.top, left: fly.left }}>
                        {[n, ...children].map((c) => (
                          <Link key={c.href} href={c.href} role="menuitem" className={isOn(c.href) ? 'sb-sub on' : 'sb-sub'} onClick={() => setFly(null)}>
                            {c.label}
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Fragment>
        ))}
      </nav>
      <div className="sb-foot">
        <div className="sb-promo">
          <p className="sb-promo-title">{cta.title}</p>
          <p className="sb-promo-text">{cta.text}</p>
          <Link href={cta.href} className="sb-cta">
            <span className="sb-plus" aria-hidden="true" />
            <span>{cta.label}</span>
          </Link>
        </div>
        <Link href={cta.href} className="sb-cta sq" aria-label={cta.label} title={cta.label}>
          <span className="sb-plus" aria-hidden="true" />
        </Link>
      </div>
    </aside>
  );
}
