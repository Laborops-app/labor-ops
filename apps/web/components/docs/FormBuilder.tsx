'use client';
import { FORM_FIELD, newId, type FormField, type FormFieldType } from './types';

/** The questions of a form built in the app: add, word, reorder, remove. */
export default function FormBuilder({ fields, onChange }: { fields: FormField[]; onChange: (f: FormField[]) => void }) {
  const update = (id: string, p: Partial<FormField>) => onChange(fields.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const shift = (i: number, by: number) => {
    const j = i + by;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  const add = (type: FormFieldType) => onChange([...fields, { id: newId(), type, label: type === 'signature' ? 'Signature' : '', required: type !== 'photo' }]);
  return (
    <div className="fb">
      {fields.length === 0 && <p className="muted">No questions yet. Add the first one below.</p>}
      <ol className="fb-list">
        {fields.map((f, i) => (
          <li key={f.id} className="fb-q">
            <span className="chip">{FORM_FIELD[f.type]}</span>
            <input type="text" value={f.label} onChange={(e) => update(f.id, { label: e.target.value })} placeholder={f.type === 'checkbox' ? 'What they confirm, e.g. “Hard hats on”' : f.type === 'yesno' ? 'A yes or no question' : 'The question'} aria-label={`Question ${i + 1}`} maxLength={200} />
            <label className="check"><input type="checkbox" checked={f.required} onChange={(e) => update(f.id, { required: e.target.checked })} /> Required</label>
            <span className="fb-move">
              <button type="button" className="btn ghost small" disabled={i === 0} onClick={() => shift(i, -1)} aria-label={`Move question ${i + 1} up`}>↑</button>
              <button type="button" className="btn ghost small" disabled={i === fields.length - 1} onClick={() => shift(i, 1)} aria-label={`Move question ${i + 1} down`}>↓</button>
              <button type="button" className="btn ghost small danger" onClick={() => onChange(fields.filter((x) => x.id !== f.id))} aria-label={`Remove question ${i + 1}`}>×</button>
            </span>
          </li>
        ))}
      </ol>
      <div className="fb-add">
        <span className="muted small">Add:</span>
        {(Object.keys(FORM_FIELD) as FormFieldType[]).map((t) => (
          <button key={t} type="button" className="btn small" disabled={t === 'signature' && fields.some((f) => f.type === 'signature')} onClick={() => add(t)}>{FORM_FIELD[t]}</button>
        ))}
      </div>
    </div>
  );
}
