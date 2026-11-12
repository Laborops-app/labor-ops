'use client';
import { useMemo, useState } from 'react';
import { api } from '@/lib/api';

type Phase = { id: string; label: string; starts_on: string };

/**
 * Call sheet (for the crew) and wrap report (for the customer): a live PDF preview with what to include,
 * then download, print, send to the crew on that day, or email the customer.
 */
export default function EventDocs({ eventId, phases, customerEmail, onNote }: { eventId: string; phases: Phase[]; customerEmail?: string | null; onNote: (m: string) => void }) {
  const [kind, setKind] = useState<'call' | 'wrap'>('call');
  const [phase, setPhase] = useState(phases.length === 1 ? phases[0]!.id : '');
  const [phones, setPhones] = useState(true);
  const [unconfirmed, setUnconfirmed] = useState(true);
  const [signature, setSignature] = useState(true);
  const [text, setText] = useState(false);
  const [to, setTo] = useState(customerEmail ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const src = useMemo(() => {
    const q = kind === 'call'
      ? new URLSearchParams({ ...(phase ? { phase } : {}), phones: phones ? '1' : '0', unconfirmed: unconfirmed ? '1' : '0' })
      : new URLSearchParams({ signature: signature ? '1' : '0' });
    return `/api/events/${eventId}/${kind === 'call' ? 'call-sheet' : 'wrap-report'}.pdf?${q}`;
  }, [eventId, kind, phase, phones, unconfirmed, signature]);
  const act = async (fn: () => Promise<string>) => {
    setBusy(true); setErr(''); setMsg('');
    try { const m = await fn(); setMsg(m); onNote(m); } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const print = () => {
    const w = window.open(src, '_blank');
    if (!w) return setErr('Your browser blocked the new tab. Use Download PDF and print the file.');
    w.addEventListener('load', () => setTimeout(() => { try { w.print(); } catch { /* the PDF viewer has its own print button */ } }, 400));
  };
  return (
    <div className="edoc">
      <div className="edoc-view">
        <iframe key={src} src={`${src}#toolbar=0&view=FitH`} title={kind === 'call' ? 'Call sheet preview' : 'Wrap report preview'} />
        <p className="muted small" style={{ margin: '6px 0 0' }}>
          Preview not showing? <a href={src} target="_blank" rel="noreferrer">Open the PDF in a new tab</a>.
        </p>
      </div>
      <div className="edoc-opts">
        <div className="seg" role="radiogroup" aria-label="Document">
          <button type="button" role="radio" aria-checked={kind === 'call'} className={kind === "call" ? "seg-btn on" : "seg-btn"} onClick={() => { setKind("call"); setMsg(''); setErr(''); }}>Call sheet</button>
          <button type="button" role="radio" aria-checked={kind === 'wrap'} className={kind === "wrap" ? "seg-btn on" : "seg-btn"} onClick={() => { setKind("wrap"); setMsg(''); setErr(''); }}>Wrap report</button>
        </div>
        <p className="muted small" style={{ margin: '8px 0 12px' }}>
          {kind === 'call'
            ? 'For the crew: venue, site contact, first call, your notes, and each position’s call time and people.'
            : 'For the customer: scheduled and worked hours by day and role, overtime and attendance. Pay is never shown.'}
        </p>
        {kind === 'call' ? (
          <>
            {phases.length > 0 && (
              <label>
                Day
                <select value={phase} onChange={(e) => setPhase(e.target.value)}>
                  <option value="">All days (one page each)</option>
                  {phases.map((p) => <option key={p.id} value={p.id}>{p.label} · {new Date(`${p.starts_on.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</option>)}
                </select>
              </label>
            )}
            <label className="check"><input type="checkbox" checked={phones} onChange={(e) => setPhones(e.target.checked)} /> Crew phone numbers</label>
            <label className="check"><input type="checkbox" checked={unconfirmed} onChange={(e) => setUnconfirmed(e.target.checked)} /> Show spots not confirmed yet</label>
            <label className="check"><input type="checkbox" checked={text} onChange={(e) => setText(e.target.checked)} /> Also text the crew the link</label>
          </>
        ) : (
          <>
            <label className="check"><input type="checkbox" checked={signature} onChange={(e) => setSignature(e.target.checked)} /> Customer signature line</label>
            <label>
              Customer’s email
              <input type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="name@customer.com" autoComplete="off" />
            </label>
          </>
        )}
        {err && <p className="error small" role="alert">{err}</p>}
        {msg && <p className="small" style={{ color: 'var(--good)' }} role="status">{msg}</p>}
        <div className="edoc-acts">
          <a className="btn primary" href={`${src}&download=1`}>Download PDF</a>
          <button type="button" className="btn" onClick={print}>Print</button>
          {kind === 'call' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => act(async () => {
              const r = await api<{ recipients: number }>(`/api/events/${eventId}/call-sheet/send`, { body: { phase: phase || null, phones, unconfirmed, text } });
              return `Call sheet sent to ${r.recipients} crew member${r.recipients === 1 ? '' : 's'}.`;
            })}>
              {busy ? 'Sending…' : phase ? 'Send to the crew on this day' : 'Send to the confirmed crew'}
            </button>
          ) : (
            <button type="button" className="btn" disabled={busy || !to.trim()} onClick={() => act(async () => {
              const r = await api<{ sentTo: string }>(`/api/events/${eventId}/wrap-report/send`, { body: { to: to.trim(), signature } });
              return `Wrap report emailed to ${r.sentTo}.`;
            })}>
              {busy ? 'Sending…' : 'Email to the customer'}
            </button>
          )}
        </div>
        <p className="muted small" style={{ margin: '10px 0 0' }}>
          {kind === 'call' ? 'Crew get a link in the app and by email that opens the PDF. It works for 30 days and always shows the latest crew.' : 'The customer gets a link that opens the PDF. It works for 30 days.'}
        </p>
      </div>
    </div>
  );
}
