'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api } from '@/lib/api';
import PdfViewer from '@/components/docs/PdfViewer';
import Skeleton from '@/components/Skeleton';

type Mine = {
  onboardingOn: boolean; formsOn: boolean;
  steps: { id: string; name: string; kind: 'pdf' | 'form'; required: boolean; submission_id: string | null }[];
  signed: { id: string; template_name: string; purpose: string; signed_at: string; event_name: string | null }[];
};
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

function Body() {
  const [d, setD] = useState<Mine | null>(null);
  const [error, setError] = useState('');
  const [view, setView] = useState<{ id: string; name: string } | null>(null);
  useEffect(() => { api<Mine>('/api/my/documents').then(setD).catch((e) => setError(e.message)); }, []);
  if (!d) return error ? <Banner>{error}</Banner> : <Skeleton />;
  const left = d.steps.filter((s) => s.required && !s.submission_id).length;
  const next = d.steps.find((s) => !s.submission_id && s.required) ?? d.steps.find((s) => !s.submission_id);
  return (
    <>
      {d.onboardingOn && d.steps.length > 0 && (
        <section className="card">
          <div className="row space" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0 }}>Onboarding</h2>
            <span className={left ? 'cs-st wait' : 'cs-st ok'}>{left ? `${left} to do` : 'All done'}</span>
          </div>
          <p className="muted small">{left ? 'Fill in and sign each one here. It takes a minute or two each, on your phone or computer.' : 'Thanks. You can open your signed copies any time.'}</p>
          <ol className="doc-list">
            {d.steps.map((s, i) => (
              <li key={s.id}>
                <span className={s.submission_id ? 'doc-n done' : 'doc-n'} aria-hidden="true">{s.submission_id ? '✓' : i + 1}</span>
                <div className="doc-main"><b>{s.name}</b><span className="muted small">{s.submission_id ? 'Done' : s.required ? 'Required' : 'Optional'} · {s.kind === 'pdf' ? 'Read and sign' : 'Short form'}</span></div>
                {s.submission_id
                  ? <button type="button" className="btn ghost small" onClick={() => setView({ id: s.submission_id!, name: s.name })}>Open my copy</button>
                  : <Link className={next?.id === s.id ? 'btn primary small' : 'btn small'} href={`/my-documents/${s.id}`}>{next?.id === s.id ? 'Start' : 'Open'}</Link>}
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="card">
        <h2>Signed documents</h2>
        {d.signed.length === 0 ? <Empty>Nothing signed yet. Documents and forms you complete show up here.</Empty> : (
          <ul className="doc-list">
            {d.signed.map((s) => (
              <li key={s.id}>
                <div className="doc-main"><b>{s.template_name}</b><span className="muted small">{s.event_name ? `${s.event_name} · ` : ''}Signed {when(s.signed_at)}</span></div>
                <button type="button" className="btn ghost small" onClick={() => setView({ id: s.id, name: s.template_name })}>Open</button>
                <a className="btn ghost small" href={`/api/docs/submissions/${s.id}/pdf?download=1`}>Download</a>
              </li>
            ))}
          </ul>
        )}
      </section>
      {view && <PdfViewer title={view.name} url={`/api/docs/submissions/${view.id}/pdf`} onClose={() => setView(null)} />}
    </>
  );
}
export default function Page() {
  return <Shell roles={['admin', 'manager', 'crew', 'hr']}>{() => <Body />}</Shell>;
}
