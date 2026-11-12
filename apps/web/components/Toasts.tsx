'use client';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';

/*
 * Undo toasts and in-app confirm windows, shared by every page (state lives here so it survives moving between pages).
 *
 * undoable(): the change is held for a few seconds with an Undo button; nothing is sent (and nobody is told) until the
 * time runs out, the person dismisses it, or the page is closed.
 * askConfirm(): replaces the browser's confirm() pop-up with a window that follows the app's look.
 */
type Toast = { id: number; text: string; undo?: () => void; commit?: () => Promise<unknown> | unknown; until: number; error?: boolean };
type Ask = { text: string; ok: string; danger: boolean; resolve: (v: boolean) => void };

let toasts: Toast[] = [];
let ask: Ask | null = null;
const subs = new Set<() => void>();
let snap: readonly [Toast[], Ask | null] = [toasts, ask];
const SERVER = [[], null] as const;
const emit = () => { snap = [toasts, ask]; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
let seq = 0;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

async function settle(id: number) {
  const t = toasts.find((x) => x.id === id);
  clearTimeout(timers.get(id)); timers.delete(id);
  toasts = toasts.filter((x) => x.id !== id); emit();
  if (!t?.commit) return;
  try { await t.commit(); } catch (e) {
    show((e as Error).message || 'That didn’t save. Try again.', { error: true });
    t.undo?.();
  }
}

/** A short message at the bottom of the screen. */
export function show(text: string, opts: { error?: boolean; ms?: number } = {}) {
  const id = ++seq;
  toasts = [...toasts.slice(-2), { id, text, until: Date.now() + (opts.ms ?? 4000), error: opts.error }]; emit();
  timers.set(id, setTimeout(() => settle(id), opts.ms ?? 4000));
}

/**
 * Hide the thing straight away (`hide`), then run `commit` after `ms` unless Undo is pressed (`restore` puts it back).
 * If `commit` fails, the thing is restored and the error shown.
 */
export function undoable(text: string, commit: () => Promise<unknown> | unknown, opts: { hide?: () => void; restore?: () => void; ms?: number } = {}) {
  const id = ++seq, ms = opts.ms ?? 5000;
  opts.hide?.();
  toasts = [...toasts.slice(-2), { id, text, commit, undo: opts.restore ?? (() => undefined), until: Date.now() + ms }]; emit();
  timers.set(id, setTimeout(() => settle(id), ms));
}

/* Rows waiting to be removed: lists skip ids in this set while their Undo toast is showing. */
let gone = new Set<string>();
let goneSnap = gone;
const goneSubs = new Set<() => void>();
const setGone = (next: Set<string>) => { gone = next; goneSnap = next; goneSubs.forEach((f) => f()); };
export function useGone() {
  return useSyncExternalStore((f) => { goneSubs.add(f); return () => { goneSubs.delete(f); }; }, () => goneSnap, () => goneSnap);
}
/** Remove a row with Undo: it disappears from lists using useGone() now; `commit` runs after 5 seconds, then `after` (a reload). */
export function undoRemove(text: string, key: string, commit: () => Promise<unknown>, after?: () => unknown) {
  undoable(text, async () => {
    try { await commit(); await after?.(); } finally { const n = new Set(gone); n.delete(key); setGone(n); }
  }, { hide: () => setGone(new Set(gone).add(key)), restore: () => { const n = new Set(gone); n.delete(key); setGone(n); } });
}

/** Send everything still waiting now (the page is closing). */
function flushAll() { for (const t of [...toasts]) if (t.commit) settle(t.id); }
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushAll);

/** In-app replacement for window.confirm(): resolves true when the person presses the OK button. */
export function askConfirm(text: string, opts: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    ask?.resolve(false);
    const verb = /^(Delete|Remove|Disconnect|Void|Cancel|Stop|Leave|Unlink|Send|Replace|Change|Create|Make|Mark|Set|Take|Download)\b/.exec(text)?.[1];
    ask = { text, ok: opts.ok ?? (verb ?? 'OK'), danger: opts.danger ?? /delete|remove|disconnect|void|cancel|stop|leave|unlink/i.test(text), resolve };
    emit();
  });
}
const answer = (v: boolean) => { const a = ask; ask = null; emit(); a?.resolve(v); };

function useStore() {
  return useSyncExternalStore(subscribe, () => snap, () => SERVER as unknown as typeof snap);
}

export default function ToastHost() {
  const [list, a] = useStore();
  const [, tick] = useState(0);
  const okBtn = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!list.length) return; const t = setInterval(() => tick((n) => n + 1), 250); return () => clearInterval(t); }, [list.length]);
  useEffect(() => {
    if (!a) return;
    okBtn.current?.focus();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') answer(false); };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [a]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <>
      <div className="toasts" role="region" aria-label="Messages" aria-live="polite">
        {list.map((t) => {
          const left = Math.max(0, Math.ceil((t.until - Date.now()) / 1000));
          return (
            <div key={t.id} className={`toast${t.error ? ' err' : ''}`} role={t.error ? 'alert' : 'status'}>
              <span className="toast-txt">{t.text}</span>
              {t.commit && (
                <button type="button" className="toast-undo" onClick={() => { clearTimeout(timers.get(t.id)); timers.delete(t.id); toasts = toasts.filter((x) => x.id !== t.id); emit(); t.undo?.(); }}>
                  Undo{left > 0 ? ` · ${left}` : ''}
                </button>
              )}
              <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => settle(t.id)}>✕</button>
            </div>
          );
        })}
      </div>
      {a && (
        <div className="ask-back" onMouseDown={(e) => { if (e.target === e.currentTarget) answer(false); }}>
          <div className="ask" role="alertdialog" aria-modal="true" aria-labelledby="ask-t">
            <p id="ask-t">{a.text.split('\n').map((l, i) => <span key={i}>{l}<br /></span>)}</p>
            <div className="ask-acts">
              <button type="button" className="btn" onClick={() => answer(false)}>Cancel</button>
              <button type="button" ref={okBtn} className={`btn ${a.danger ? 'danger-solid' : 'primary'}`} onClick={() => answer(true)}>{a.ok}</button>
            </div>
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
