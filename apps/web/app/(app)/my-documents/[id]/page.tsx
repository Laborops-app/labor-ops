'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, type Me } from '@/lib/api';
import DocFill from '@/components/docs/DocFill';
import PdfViewer from '@/components/docs/PdfViewer';
import type { Template } from '@/components/docs/types';

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const q = useSearchParams();
  const shiftId = q.get('shift') ?? undefined;
  const preview = q.get('preview') === '1';
  const [t, setT] = useState<Template | null>(null);
  const [people, setPeople] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ id: string; left: number } | null>(null);
  const [view, setView] = useState(false);
  useEffect(() => {
    api<{ template: Template }>(`/api/docs/templates/${id}`).then((r) => setT(r.template)).catch((e) => setError(e.message));
    if (shiftId) api<{ people: { id: string; name: string }[] }>(`/api/my/shifts/${shiftId}/forms`).then((r) => setPeople(r.people)).catch(() => {});
  }, [id, shiftId]);
  if (error) return <Banner>{error}</Banner>;
  if (!t) return <p className="muted">Loading…</p>;
  const back = shiftId ? '/my-shifts' : '/my-documents';
  if (done)
    return (
      <section className="card doc-done">
        <div className="clk-badge" aria-hidden="true">✓</div>
        <h1 aria-live="polite">{t.name} is done</h1>
        <p className="muted">The signed PDF is saved. {t.purpose === 'onboarding' ? (done.left ? `${done.left} onboarding ${done.left === 1 ? 'step' : 'steps'} left.` : 'That was the last onboarding step.') : 'Your coordinator can see it on the event.'}</p>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          <Link className="btn primary" href={back}>{t.purpose === 'onboarding' && done.left ? 'Next step' : shiftId ? 'Back to my shifts' : 'Back to my documents'}</Link>
          <button type="button" className="btn" onClick={() => setView(true)}>Open the signed PDF</button>
        </div>
        {view && <PdfViewer title={t.name} url={`/api/docs/submissions/${done.id}/pdf`} onClose={() => setView(false)} />}
      </section>
    );
  return (
    <>
      <p className="small" style={{ margin: '0 0 12px' }}><Link href={back}>← {shiftId ? 'My shifts' : 'My documents'}</Link></p>
      {preview && <Banner kind="info">This is how crew see it. Nothing is saved from a preview.</Banner>}
      <h1 className="doc-title">{t.name}</h1>
      <p className="muted" style={{ marginTop: 0 }}>{t.kind === 'pdf' ? 'Read it, fill in anything highlighted, then sign at the bottom.' : 'Answer each question, then sign at the bottom.'}</p>
      {preview
        ? <fieldset disabled style={{ border: 0, padding: 0, margin: 0 }}><DocFill template={t} shiftId={shiftId} people={people} signerName={me.name} onDone={() => {}} /></fieldset>
        : <DocFill template={t} shiftId={shiftId} people={people} signerName={me.name} onDone={(sid, left) => { setDone({ id: sid, left }); window.scrollTo({ top: 0 }); }} />}
    </>
  );
}
export default function Page() {
  return <Shell roles={['admin', 'manager', 'crew', 'hr']}>{(me) => <Body me={me} />}</Shell>;
}
