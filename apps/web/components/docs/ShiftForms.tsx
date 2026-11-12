'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import PdfViewer from './PdfViewer';

type F = { id: string; name: string; done: boolean; submissionId: string | null; settings: { required: boolean; when: 'clock_in' | 'clock_out' | 'any'; blockClockIn: boolean } };

/** The forms a crew member has to fill in for one of their shifts. Shows nothing when there are none. */
export default function ShiftForms({ shiftId }: { shiftId: string }) {
  const [forms, setForms] = useState<F[]>([]);
  const [view, setView] = useState<F | null>(null);
  useEffect(() => { api<{ forms: F[] }>(`/api/my/shifts/${shiftId}/forms`).then((r) => setForms(r.forms)).catch(() => {}); }, [shiftId]);
  if (!forms.length) return null;
  return (
    <section className="card">
      <h2>Forms for this shift</h2>
      <ul className="doc-list">
        {forms.map((f) => (
          <li key={f.id}>
            <span className={f.done ? 'doc-n done' : 'doc-n'} aria-hidden="true">{f.done ? '✓' : f.settings.required ? '!' : '+'}</span>
            <div className="doc-main">
              <b>{f.name}</b>
              <span className="muted small">{!f.settings.required ? (f.done ? 'Filed. Use it again if something else happens.' : 'Only if you need it') : f.done ? 'Done' : f.settings.blockClockIn ? 'Needed before you can clock in' : f.settings.when === 'clock_in' ? 'Fill in when you arrive' : f.settings.when === 'clock_out' ? 'Fill in before you leave' : 'Fill in during the shift'}</span>
            </div>
            {f.done && <button type="button" className="btn ghost small" onClick={() => setView(f)}>Open</button>}
            {(!f.done || !f.settings.required) && <Link className={f.settings.required ? 'btn primary small' : 'btn small'} href={`/my-documents/${f.id}?shift=${shiftId}`}>{!f.settings.required ? (f.done ? 'File another' : 'Fill in') : 'Fill in'}</Link>}
          </li>
        ))}
      </ul>
      {view?.submissionId && <PdfViewer title={view.name} url={`/api/docs/submissions/${view.submissionId}/pdf`} onClose={() => setView(null)} />}
    </section>
  );
}
