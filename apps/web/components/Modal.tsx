'use client';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';

/** Centered dialog in the CRM style (white 12px card, title + round close button). Escape or a click outside closes it. */
export default function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [onClose]);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="modal-back crm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={wide ? 'modal crm wide' : 'modal crm'} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="btn-round sm" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
}
