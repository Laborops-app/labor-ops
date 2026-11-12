'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/api';

type Hit = { kind: 'event' | 'person' | 'customer' | 'quote' | 'page'; id: string; title: string; sub?: string; href: string };
const LABEL: Record<Hit['kind'], string> = { page: 'Pages', event: 'Events', person: 'People', customer: 'Customers', quote: 'Quotes' };
const RECENT = 'lo-search-recent';
const readRecent = (): Hit[] => { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; } };
const saveRecent = (h: Hit) => { try { localStorage.setItem(RECENT, JSON.stringify([h, ...readRecent().filter((x) => x.href !== h.href)].slice(0, 6))); } catch { /* storage blocked */ } };

const SearchIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
);

/**
 * Search everything: the top bar button, Ctrl+K / ⌘K or "/" opens one box that finds pages, events, people, customers and
 * quotes. Arrow keys move, Enter opens. Recent picks show before typing.
 */
export default function SearchPalette({ pages, office }: { pages: { href: string; label: string }[]; office: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setOpen((o) => !o); }
      else if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); setOpen(true); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (!open) return;
    setQ(''); setHits([]); setSel(0);
    setTimeout(() => input.current?.focus(), 0);
  }, [open]);

  const pageHits = useMemo<Hit[]>(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return pages.filter((p) => p.label.toLowerCase().includes(s)).slice(0, 5).map((p) => ({ kind: 'page', id: p.href, title: p.label, href: p.href }));
  }, [q, pages]);

  useEffect(() => {
    const s = q.trim();
    if (!office || s.length < 2) { setHits([]); setBusy(false); return; }
    setBusy(true);
    const t = setTimeout(() => {
      api<{ results: Hit[] }>(`/api/search?q=${encodeURIComponent(s)}`).then((r) => setHits(r.results)).catch(() => setHits([])).finally(() => setBusy(false));
    }, 160);
    return () => clearTimeout(t);
  }, [q, office]);

  const recent = q.trim() ? [] : (typeof window !== 'undefined' && open ? readRecent() : []);
  const all = q.trim() ? [...pageHits, ...hits] : recent;
  useEffect(() => { setSel(0); }, [q, hits.length]);
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [sel]);

  const go = (h: Hit) => { saveRecent(h); setOpen(false); router.push(h.href); };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((n) => Math.min(all.length - 1, n + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((n) => Math.max(0, n - 1)); }
    else if (e.key === 'Enter' && all[sel]) { e.preventDefault(); go(all[sel]!); }
  };

  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  let lastKind = '';
  return (
    <>
      <button type="button" className="icon-btn search-btn" onClick={() => setOpen(true)} aria-label="Search" title={`Search (${mac ? '⌘' : 'Ctrl'}+K)`}>
        <SearchIcon />
        <span className="search-btn-txt">Search</span>
        <kbd className="search-kbd">{mac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {open && typeof document !== 'undefined' && createPortal(
        <div className="sp-back" onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false); }}>
          <div className="sp" role="dialog" aria-modal="true" aria-label="Search">
            <div className="sp-in">
              <SearchIcon />
              <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} role="combobox" aria-expanded={all.length > 0} aria-controls="sp-list"
                aria-activedescendant={all[sel] ? `sp-${sel}` : undefined} autoComplete="off" spellCheck={false}
                placeholder={office ? 'Search events, people, customers, quotes, pages…' : 'Search pages…'} aria-label="Search" />
              <button type="button" className="sp-esc" onClick={() => setOpen(false)}>Esc</button>
            </div>
            <ul className="sp-list" id="sp-list" role="listbox" ref={list} aria-label="Results">
              {!q.trim() && recent.length > 0 && <li className="sp-h" role="presentation">Recent</li>}
              {all.map((h, i) => {
                const head = q.trim() && h.kind !== lastKind ? LABEL[h.kind] : null;
                lastKind = h.kind;
                return [
                  head ? <li key={`h-${h.kind}`} className="sp-h" role="presentation">{head}</li> : null,
                  <li key={h.kind + h.id} id={`sp-${i}`} role="option" aria-selected={i === sel} className={`sp-item${i === sel ? ' on' : ''}`} onMouseMove={() => setSel(i)} onClick={() => go(h)}>
                    <span className={`sp-ico ${h.kind}`} aria-hidden="true">{h.kind === 'event' ? 'E' : h.kind === 'person' ? 'P' : h.kind === 'customer' ? 'C' : h.kind === 'quote' ? 'Q' : '→'}</span>
                    <span className="sp-txt"><b>{h.title}</b>{h.sub && <small>{h.sub}</small>}</span>
                  </li>,
                ];
              })}
              {q.trim().length >= 2 && !busy && all.length === 0 && <li className="sp-empty" role="presentation">Nothing found for “{q.trim()}”.</li>}
              {!q.trim() && recent.length === 0 && <li className="sp-empty" role="presentation">{office ? 'Type a name, venue, phone number or quote number.' : 'Type the name of a page.'}</li>}
            </ul>
            <div className="sp-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>Esc</kbd> close</span></div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
