'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import PdfViewer from './PdfViewer';

type Sub = { id: string; template_name: string; user_name: string; role_name: string | null; event_name: string | null; flagged: boolean; signed_at: string };
type EventForms = { formsOn: boolean; shifts: { id: string; forms: { id: string; name: string; who: string; done: number }[] }[]; submissions: (Sub & { shift_id: string | null })[] };
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function List({ subs, showWho }: { subs: Sub[]; showWho: boolean }) {
  const [view, setView] = useState<Sub | null>(null);
  return (
    <>
      <ul className="doc-list">
        {subs.map((s) => (
          <li key={s.id}>
            <div className="doc-main">
              <b>{s.template_name}</b>
              <span className="muted small">{[showWho ? s.user_name : s.event_name, s.role_name, when(s.signed_at)].filter(Boolean).join(' · ')}</span>
            </div>
            {s.flagged && <span className="cs-st no" title="At least one question was answered No">A “No”</span>}
            <button type="button" className="btn ghost small" onClick={() => setView(s)}>Open</button>
          </li>
        ))}
      </ul>
      {view && <PdfViewer title={`${view.template_name}${showWho ? ` · ${view.user_name}` : ''}`} url={`/api/docs/submissions/${view.id}/pdf`} onClose={() => setView(null)} />}
    </>
  );
}

/** Everything one person has signed (their profile). Shows nothing when they have signed nothing. */
export function PersonDocs({ userId }: { userId: string }) {
  const [subs, setSubs] = useState<Sub[] | null>(null);
  useEffect(() => { api<{ submissions: Sub[] }>(`/api/docs/submissions?userId=${userId}`).then((r) => setSubs(r.submissions)).catch(() => setSubs([])); }, [userId]);
  if (!subs?.length) return null;
  return (
    <section className="card">
      <h2>Signed documents</h2>
      <List subs={subs} showWho={false} />
    </section>
  );
}

/** Forms on an event: what is still to do per shift, and every completed form. Hidden while forms are turned off. */
export function EventFormsCard({ eventId, shiftLabel }: { eventId: string; shiftLabel: (shiftId: string) => string }) {
  const [d, setD] = useState<EventForms | null>(null);
  useEffect(() => { api<EventForms>(`/api/events/${eventId}/forms`).then(setD).catch(() => {}); }, [eventId]);
  if (!d?.formsOn || (!d.shifts.length && !d.submissions.length)) return null;
  const todo = d.shifts.flatMap((s) => s.forms.filter((f) => !f.done).map((f) => ({ ...f, shiftId: s.id })));
  return (
    <section className="card">
      <h2>Forms</h2>
      {todo.length > 0 && (
        <>
          <p className="muted small" style={{ margin: '0 0 6px' }}>Not filled in yet</p>
          <ul className="doc-list">
            {todo.slice(0, 8).map((f) => (
              <li key={f.id + f.shiftId}>
                <div className="doc-main"><b>{f.name}</b><span className="muted small">{shiftLabel(f.shiftId)} · {f.who === 'lead' ? 'the lead' : f.who === 'everyone' ? 'everyone' : 'a coordinator'}</span></div>
                <Link className="btn ghost small" href={`/my-documents/${f.id}?shift=${f.shiftId}`}>Fill in</Link>
              </li>
            ))}
          </ul>
          {todo.length > 8 && <p className="muted small">{todo.length - 8} more</p>}
        </>
      )}
      {d.submissions.length > 0 && (
        <>
          <p className="muted small" style={{ margin: '10px 0 6px' }}>Completed</p>
          <List subs={d.submissions} showWho />
        </>
      )}
    </section>
  );
}

/** A nudge on the crew home page while onboarding steps are left. */
export function OnboardingBanner() {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    api<{ onboardingOn: boolean; steps: { required: boolean; submission_id: string | null }[] }>('/api/my/documents')
      .then((r) => setLeft(r.onboardingOn ? r.steps.filter((s) => s.required && !s.submission_id).length : 0))
      .catch(() => {});
  }, []);
  if (!left) return null;
  return (
    <div className="banner info" role="status">
      <span><b>Finish your onboarding.</b> {left} {left === 1 ? 'step' : 'steps'} left to fill in and sign.</span>
      <Link className="btn small primary" href="/my-documents">Open my documents</Link>
    </div>
  );
}
