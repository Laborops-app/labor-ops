'use client';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActIcon } from '@/components/ActionMenu';
import { api, money } from '@/lib/api';

export type CrewMenuItem = { label: string; icon: string; onClick: () => void; danger?: boolean; hint?: string; disabled?: boolean } | 'divider';

/**
 * Menu for one crew member on a shift, opened by right-click (long-press on a phone) or the row's ⋯ button.
 * Shows at the pointer, kept inside the window; closes on Escape, an outside click, scrolling or after an action.
 */
export default function CrewMenu({ x, y, title, sub, items, pay, onClose }: { x: number; y: number; title: string; sub?: string; items: CrewMenuItem[]; pay?: React.ReactNode; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({ left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)), top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) });
  }, [x, y]);
  useEffect(() => {
    const off = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    // Close when the page really scrolls (not on the small scroll a browser may do while the menu opens).
    const y0 = window.scrollY;
    const scroll = (e: Event) => { if (!box.current?.contains(e.target as Node) && Math.abs(window.scrollY - y0) > 40) onClose(); };
    document.addEventListener('mousedown', off);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', onClose);
    (box.current?.querySelector('button:not([disabled]), input') as HTMLElement | null)?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('mousedown', off);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', onClose);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Arrow keys move between the menu's buttons.
  const keys = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = [...(box.current?.querySelectorAll<HTMLButtonElement>('.cm-item:not([disabled])') ?? [])];
    if (!list.length) return;
    e.preventDefault();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]!.focus();
  };
  const list = items.filter((it, i, a) => !(it === 'divider' && (i === 0 || a[i - 1] === 'divider' || i === a.length - 1)));
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div ref={box} className="cm" role="menu" aria-label={`Options for ${title}`} style={{ left: pos.left, top: pos.top }} onKeyDown={keys} onContextMenu={(e) => e.preventDefault()}>
      <div className="cm-head">
        <b>{title}</b>
        {sub && <span>{sub}</span>}
      </div>
      {pay}
      {list.map((it, i) =>
        it === 'divider' ? <hr key={`d${i}`} /> : (
          <button key={it.label} type="button" role="menuitem" className={`cm-item${it.danger ? ' danger' : ''}`} title={it.hint} disabled={it.disabled} onClick={() => { onClose(); it.onClick(); }}>
            <ActIcon n={it.icon} /> <span>{it.label}</span>
            {it.hint && <small>{it.hint}</small>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

/** Pay for one person on this event, for the position they work on this shift: the default, an hourly rate or a day rate. */
export function CrewPayForm({ eventId, userId, name, role, own, shiftRate, shiftPay, onSaved, onError }: {
  eventId: string; userId: string; name: string; role: string;
  own: { pay_type: 'hourly' | 'day'; rate: number } | null;
  shiftRate: number | null; shiftPay: 'hourly' | 'day';
  onSaved: (msg: string) => void; onError: (msg: string) => void;
}) {
  const [type, setType] = useState<'default' | 'hourly' | 'day'>(own ? own.pay_type : 'default');
  const [rate, setRate] = useState(own ? String(own.rate) : '');
  const [busy, setBusy] = useState(false);
  const dflt = shiftRate != null ? `${money(shiftRate)}${shiftPay === 'day' ? '/day' : '/hr'}` : 'no rate set';
  const dirty = own ? type !== own.pay_type || Number(rate) !== own.rate : type !== 'default';
  const save = async () => {
    setBusy(true);
    try {
      if (type === 'default') {
        await api(`/api/events/${eventId}/crew-rates/${userId}?role=${encodeURIComponent(role)}`, { method: 'DELETE' });
        onSaved(`${name} is back on the shift rate (${dflt}).`);
      } else {
        const n = Math.round(Number(rate) * 100) / 100;
        if (!(n > 0)) throw new Error('Enter a rate above 0.');
        await api(`/api/events/${eventId}/crew-rates/${userId}`, { method: 'PUT', body: { payType: type, rate: n, role } });
        onSaved(`${name} as ${role}: ${money(n)}${type === 'day' ? ' per day' : '/hr'} on this event. They've been told.`);
      }
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="cm-pay" onSubmit={(e) => { e.preventDefault(); if (dirty) save(); }}>
      <div className="cm-pay-label">Pay as {role} on this event</div>
      <div className="cm-seg" role="radiogroup" aria-label="How they are paid">
        {([['default', 'Shift rate'], ['hourly', 'Hourly'], ['day', 'Day rate']] as const).map(([k, l]) => (
          <button key={k} type="button" role="radio" aria-checked={type === k} className={type === k ? 'on' : ''} onClick={() => { setType(k); if (k !== 'default' && !rate) setRate(shiftRate != null && shiftPay === k ? String(shiftRate) : ''); }}>{l}</button>
        ))}
      </div>
      {type === 'default' ? (
        <div className="cm-pay-note">{dflt}{shiftPay === 'day' ? '' : ', overtime rules apply'}</div>
      ) : (
        <div className="cm-pay-row">
          <span className="money-input">
            <span aria-hidden="true">$</span>
            <input type="number" min={0.01} max={100000} step="0.01" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} aria-label={`${type === 'day' ? 'Day rate' : 'Hourly rate'} for ${name}`} placeholder={type === 'day' ? '300.00' : '35.00'} />
            <span className="muted small">{type === 'day' ? '/day' : '/hr'}</span>
          </span>
          <button className="btn small primary" disabled={busy || !dirty || !(Number(rate) > 0)}>{busy ? 'Saving…' : 'Save'}</button>
        </div>
      )}
      {type === 'default' && dirty && <button className="btn small primary cm-pay-reset" disabled={busy}>{busy ? 'Saving…' : 'Use the shift rate'}</button>}
    </form>
  );
}
