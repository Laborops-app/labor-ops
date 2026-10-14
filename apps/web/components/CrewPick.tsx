'use client';
import { useEffect, useRef, useState } from 'react';

export type PickOption = { id: string; name: string; sub?: string; stars?: number; kind?: 'ok' | 'soft' | 'blocked'; note?: string };

/** Search-as-you-type crew list. Click a name to pick it; the list stays open so several people can be added in a row. */
export default function CrewPick({ options, onPick, onClose, title = 'Add crew', busy }: { options: PickOption[]; onPick: (o: PickOption) => void; onClose: () => void; title?: string; busy?: boolean }) {
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const out = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', out);
    return () => document.removeEventListener('mousedown', out);
  }, [onClose]);
  const needle = q.trim().toLowerCase();
  const shown = options.filter((o) => !needle || o.name.toLowerCase().includes(needle) || (o.sub ?? '').toLowerCase().includes(needle));
  const groups: [PickOption['kind'], string][] = [['ok', ''], ['soft', 'Outside availability (needs override)'], ['blocked', 'Missing certificate']];
  return (
    <div className="crew-pick" ref={box} role="dialog" aria-label={title} onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <div className="row space" style={{ marginBottom: 6 }}>
        <b className="small">{title}</b>
        <button type="button" className="chip-x" aria-label="Close" onClick={onClose}>✕</button>
      </div>
      <input autoFocus placeholder="Search name or skill…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search crew" />
      <div className="crew-pick-list">
        {shown.length === 0 && <div className="muted small" style={{ padding: 8 }}>No one matches.</div>}
        {groups.map(([k, label]) => {
          const list = shown.filter((o) => (o.kind ?? 'ok') === k);
          if (!list.length) return null;
          return (
            <div key={k}>
              {label && <div className="crew-pick-head">{label}</div>}
              {list.map((o) => (
                <button key={o.id} type="button" className="crew-pick-item" disabled={busy || k === 'blocked'} onClick={() => onPick(o)}>
                  <span>
                    <b>+</b> {o.name}
                    {o.stars ? <span className="muted"> {'★'.repeat(o.stars)}</span> : null}
                  </span>
                  <span className="muted small">{o.note ?? o.sub}</span>
                </button>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
