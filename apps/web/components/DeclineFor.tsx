'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '@/lib/api';

/**
 * Decline a shift for a crew member who called, texted or told someone they can't make it. They're marked declined,
 * left off this shift's crew picker, the spot opens again, and they get a short note. The reason goes in the log.
 */
const REASONS = ['Called in', 'Texted', 'Sick', 'No longer available', 'Family emergency', 'Other'];

export default function DeclineFor({ assignmentId, name, role, when, onClose, onDone }: {
  assignmentId: string; name: string; role: string; when: string; onClose: () => void; onDone: (msg: string) => void;
}) {
  const [reason, setReason] = useState(REASONS[0]!);
  const [note, setNote] = useState('');
  const [tell, setTell] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [onClose]);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      await api(`/api/assignments/${assignmentId}/decline-for`, { body: { reason, note: note.trim() || null, notify: tell } });
      onDone(`Declined ${role} for ${name}. The spot is open again.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  if (typeof document === 'undefined') return null;
  return createPortal(
    <div className="ask-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ask decline-for" role="dialog" aria-modal="true" aria-labelledby="df-h">
        <h3 id="df-h">Decline for {name}</h3>
        <p className="muted small">{role} · {when}. They won’t show in this shift’s crew list again, and the spot opens up.</p>
        <fieldset>
          <legend className="small">Why</legend>
          <div className="df-reasons">
            {REASONS.map((r, i) => (
              <label key={r} className={`df-reason${reason === r ? ' on' : ''}`}>
                <input ref={i === 0 ? first : undefined} type="radio" name="df-reason" checked={reason === r} onChange={() => setReason(r)} /> {r}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="small df-note">Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 150))} placeholder="e.g. Car broke down, back next week" />
        </label>
        <label className="check small"><input type="checkbox" checked={tell} onChange={(e) => setTell(e.target.checked)} /> Send {name.split(' ')[0]} a note that this is done</label>
        {err && <p className="cr-err" role="alert">{err}</p>}
        <div className="ask-acts">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn danger-solid" disabled={busy} onClick={save}>{busy ? 'Declining…' : 'Decline for them'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
