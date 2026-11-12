'use client';
import { useMemo, useState } from 'react';
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
  const set = (id: string, v: Value) => setAnswers((a) => ({ ...a, [id]: v }));
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
              if (f.type === 'date') return <span key={f.id} className="pf pf-auto" style={{ ...style, fontSize: Math.max(9, f.h * p.height * 0.6) }}>{today}</span>;
              if (f.type === 'name') return <span key={f.id} className="pf pf-auto" style={{ ...style, fontSize: Math.max(9, f.h * p.height * 0.6) }}>{signerName}</span>;
              if (f.type === 'checkbox')
                return <input key={f.id} type="checkbox" className="pf pf-check" style={style} checked={answers[f.id] === true} onChange={(e) => set(f.id, e.target.checked)} aria-label={f.label || 'Checkbox'} aria-required={f.required} />;
              return <input key={f.id} type="text" className="pf pf-text" style={{ ...style, fontSize: Math.max(10, f.h * p.height * 0.6) }} value={String(answers[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)} placeholder={f.label || 'Type here'} aria-label={f.label || 'Text'} aria-required={f.required} />;
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
