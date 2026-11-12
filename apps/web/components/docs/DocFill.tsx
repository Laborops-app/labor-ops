'use client';
import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import PdfPages from './PdfPages';
import SignaturePad from './SignaturePad';
import type { FormField, PdfField, Template } from './types';

type Value = string | boolean | number | null;

/** A photo from the camera or library, shrunk so it uploads quickly and fits in the PDF. */
async function shrink(file: File, max = 1280): Promise<string> {
  const img = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(img.width, img.height));
  const cv = document.createElement('canvas');
  cv.width = Math.round(img.width * s); cv.height = Math.round(img.height * s);
  cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
  let q = 0.8, out = cv.toDataURL('image/jpeg', q);
  while (out.length > 480_000 && q > 0.35) { q -= 0.15; out = cv.toDataURL('image/jpeg', q); }
  return out;
}

/**
 * Fill in and sign one document: an uploaded PDF with fields on its pages, or a form built in the app.
 * On success the signed PDF exists on the server and `onDone` gets its id.
 */
export default function DocFill({ template, shiftId, people, signerName, onDone }: { template: Template; shiftId?: string; people?: { id: string; name: string }[]; signerName: string; onDone: (submissionId: string, left: number) => void }) {
  const [answers, setAnswers] = useState<Record<string, Value>>({});
  const [signature, setSignature] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fields = template.fields;
  const needsSig = fields.some((f) => f.type === 'signature');
  const others = template.kind === 'pdf' ? (fields as PdfField[]).filter((f) => f.type === 'sign_other') : [];
  const set = (id: string, v: Value) => setAnswers((a) => ({ ...a, [id]: v }));
  // On a phone the boxes on the page are too small to type in, so they're also listed below as normal-sized fields.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const m = matchMedia('(max-width: 700px)');
    const on = () => setNarrow(m.matches);
    on();
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  const fillable = template.kind === 'pdf' ? (fields as PdfField[]).filter((f) => f.type === 'text' || f.type === 'checkbox').sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x) : [];
  const toField = (id: string) => { const el = document.getElementById(`in-${id}`); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); setTimeout(() => el?.focus({ preventScroll: true }), 300); };
  const today = useMemo(() => new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }), []);
  const submit = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<{ submissionId: string; left: number }>(`/api/docs/templates/${template.id}/submit`, { body: { answers, signature: signature ?? undefined, consent, signedName: signerName, shiftId } });
      onDone(r.submissionId, r.left);
    } catch (e) {
      setErr((e as Error).message);
      document.getElementById('docfill-error')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    } finally { setBusy(false); }
  };
  const toSign = () => document.getElementById('docfill-sign')?.scrollIntoView({ block: 'center', behavior: 'smooth' });

  return (
    <div className="docfill">
      {template.kind === 'pdf' ? (
        <PdfPages
          url={`/api/docs/templates/${template.id}/file`}
          overlay={(p) =>
            (fields as PdfField[]).filter((f) => f.page === p.index).map((f) => {
              const style = { left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` };
              if (f.type === 'signature')
                return (
                  <button key={f.id} type="button" className={`pf pf-sign${signature ? ' done' : ''}`} style={style} onClick={toSign} aria-label={signature ? 'Signed. Change your signature below.' : 'Sign here: opens the signature box below'}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {signature ? <img src={signature} alt="" /> : 'Tap to sign'}
                  </button>
                );
              if (f.type === 'sign_other') {
                const v = answers[f.id];
                return (
                  <button key={f.id} type="button" className={`pf pf-sign${v ? ' done' : ''}`} style={{ ...style, fontSize: 11 }} onClick={() => document.getElementById(`other-${f.id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })} aria-label={`${f.label || 'Another person’s signature'}: ${v ? 'signed' : 'opens the signature box below'}`}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {typeof v === 'string' ? <img src={v} alt="" /> : f.required ? 'Tap to sign' : 'Sign (if any)'}
                  </button>
                );
              }
              if (f.type === 'text' && f.h > 0.037)
                return <textarea key={f.id} className="pf pf-text pf-area" style={style} value={String(answers[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} placeholder={f.required ? 'Type here' : 'Type here (optional)'} aria-label={f.label || 'Text'} aria-required={f.required} maxLength={1500} />;
              if (f.type === 'date') return <span key={f.id} className="pf pf-auto" style={{ ...style, fontSize: Math.max(9, f.h * p.height * 0.6) }}>{today}</span>;
              if (f.type === 'name') return <span key={f.id} className="pf pf-auto" style={{ ...style, fontSize: Math.max(9, f.h * p.height * 0.6) }}>{signerName}</span>;
              if (narrow && (f.type === 'text' || f.type === 'checkbox'))
                return (
                  <button key={f.id} type="button" className={`pf pf-tap${answers[f.id] ? ' done' : ''}`} style={{ ...style, fontSize: Math.min(11, Math.max(7, f.h * p.height * 0.7)) }} onClick={() => toField(f.id)} aria-label={`${f.label || (f.type === 'checkbox' ? 'Checkbox' : 'Text')}: fill in below`}>
                    {f.type === 'checkbox' ? (answers[f.id] === true ? '✓' : '') : String(answers[f.id] ?? '')}
                  </button>
                );
              if (f.type === 'checkbox')
                return <input key={f.id} type="checkbox" className="pf pf-check" style={style} checked={answers[f.id] === true} onChange={(e) => set(f.id, e.target.checked)} aria-label={f.label || 'Checkbox'} aria-required={f.required} />;
              return <input key={f.id} type="text" className="pf pf-text" style={{ ...style, fontSize: Math.min(15, Math.max(10, f.h * p.height * 0.6)) }} value={String(answers[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} placeholder={f.label || 'Type here'} aria-label={f.label || 'Text'} aria-required={f.required} />;
            })
          }
        />
      ) : (
        <div className="docform">
          {(fields as FormField[]).filter((f) => f.type !== 'signature').map((f) => (
            <div key={f.id} className="docform-q">
              {f.type === 'checkbox' ? (
                <label className="check big"><input type="checkbox" checked={answers[f.id] === true} onChange={(e) => set(f.id, e.target.checked)} aria-required={f.required} /> <span>{f.label}{!f.required && <span className="muted small"> (optional)</span>}</span></label>
              ) : (
                <>
                  <div className="docform-label" id={`q-${f.id}`}>{f.label}{!f.required && <span className="muted small"> (optional)</span>}</div>
                  {f.type === 'yesno' && (
                    <div className="seg" role="radiogroup" aria-labelledby={`q-${f.id}`}>
                      <button type="button" role="radio" aria-checked={answers[f.id] === true} className={answers[f.id] === true ? 'seg-btn on' : 'seg-btn'} onClick={() => set(f.id, true)}>Yes</button>
                      <button type="button" role="radio" aria-checked={answers[f.id] === false} className={answers[f.id] === false ? 'seg-btn on' : 'seg-btn'} onClick={() => set(f.id, false)}>No</button>
                    </div>
                  )}
                  {f.type === 'text' && <textarea rows={2} value={String(answers[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} aria-labelledby={`q-${f.id}`} maxLength={2000} />}
                  {f.type === 'number' && <input type="number" inputMode="decimal" value={answers[f.id] === undefined || answers[f.id] === null ? '' : String(answers[f.id])} onChange={(e) => set(f.id, e.target.value === '' ? null : Number(e.target.value))} aria-labelledby={`q-${f.id}`} />}
                  {f.type === 'person' && (
                    <select value={String(answers[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value || null)} aria-labelledby={`q-${f.id}`}>
                      <option value="">Choose…</option>
                      {(people ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                  {f.type === 'photo' && (
                    <div className="docform-photo">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {typeof answers[f.id] === 'string' && <img src={answers[f.id] as string} alt="The photo you added" />}
                      <label className="btn small">
                        {answers[f.id] ? 'Replace photo' : 'Take or choose a photo'}
                        <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={async (e) => { const file = e.target.files?.[0]; if (file) { try { set(f.id, await shrink(file)); } catch { setErr('That photo couldn’t be read. Try another one.'); } } e.target.value = ''; }} />
                      </label>
                      {answers[f.id] && <button type="button" className="btn ghost small" onClick={() => set(f.id, null)}>Remove</button>}
                    </div>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
      {narrow && fillable.length > 0 && (
        <div className="docfill-foot docfill-list">
          <h2>Fill in</h2>
          <p className="muted small" style={{ margin: 0 }}>Everything you type here goes onto the document above.</p>
          {fillable.map((f) =>
            f.type === 'checkbox' ? (
              <label key={f.id} className="check big"><input id={`in-${f.id}`} type="checkbox" checked={answers[f.id] === true} onChange={(e) => set(f.id, e.target.checked)} /> <span>{f.label || 'Tick to confirm'}{!f.required && <span className="muted small"> (optional)</span>}</span></label>
            ) : (
              <label key={f.id} className="docfill-field">
                <span>{f.label || 'Text'}{!f.required && <span className="muted small"> (optional)</span>}</span>
                {f.h > 0.037
                  ? <textarea id={`in-${f.id}`} rows={3} value={String(answers[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} maxLength={1500} />
                  : <input id={`in-${f.id}`} type={/phone/i.test(f.label) ? 'tel' : /email/i.test(f.label) ? 'email' : 'text'} inputMode={/zip|phone/i.test(f.label) ? (/phone/i.test(f.label) ? 'tel' : 'numeric') : undefined} autoComplete={/email/i.test(f.label) ? 'email' : /phone/i.test(f.label) && !/contact/i.test(f.label) ? 'tel' : undefined} value={String(answers[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} maxLength={300} />}
              </label>
            ),
          )}
        </div>
      )}
      {others.length > 0 && (
        <div className="docfill-foot">
          <h2>Other people signing</h2>
          <p className="muted small" style={{ margin: 0 }}>Hand them this device to sign. Each person signs only for themselves.</p>
          {others.map((f) => (
            <div key={f.id} id={`other-${f.id}`} className="docfill-other">
              <b>{f.label || 'Another person’s signature'}{!f.required && <span className="muted small"> (leave empty if there is none)</span>}</b>
              <SignaturePad name="" onChange={(png) => set(f.id, png)} />
            </div>
          ))}
        </div>
      )}
      <div className="docfill-foot" id="docfill-sign">
        {needsSig && (
          <>
            <h2>Your signature</h2>
            <SignaturePad name={signerName} onChange={setSignature} />
            <label className="check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> <span>I agree that this is my electronic signature and has the same effect as signing on paper.</span></label>
          </>
        )}
        <div id="docfill-error">{err && <p className="error" role="alert">{err}</p>}</div>
        <button type="button" className="btn primary" disabled={busy} onClick={submit}>{busy ? 'Saving…' : needsSig ? 'Sign and finish' : 'Finish'}</button>
        <p className="muted small" style={{ margin: 0 }}>The finished PDF is saved with the date, time and device, and you can open it again under My documents.</p>
      </div>
    </div>
  );
}
