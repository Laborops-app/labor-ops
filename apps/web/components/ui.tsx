'use client';
import { ReactNode } from 'react';

export function Banner({ kind = 'error', children, onClose }: { kind?: 'error' | 'ok' | 'info'; children: ReactNode; onClose?: () => void }) {
  return (
    <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <div>{children}</div>
      {onClose && (
        <button className="btn ghost small" onClick={onClose} aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}

export function Pill({ status }: { status: string }) {
  return <span className={`pill ${status}`}>{status}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
