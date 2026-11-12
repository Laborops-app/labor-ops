'use client';
import { useRef, useState } from 'react';
import PdfPages from './PdfPages';
import { PDF_FIELD, newId, type PdfField, type PdfFieldType } from './types';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Place fields on an uploaded PDF: pick a kind, click the page where it goes, drag to move, drag the corner to resize.
 * Signature, date and name fill themselves in when someone signs; text and checkboxes are for them to fill in.
 * "Another person's signature" is for a witness or supervisor who signs on the same device.
 */
export default function PdfFieldEditor({ url, fields, onChange }: { url: string; fields: PdfField[]; onChange: (f: PdfField[]) => void }) {
  const [tool, setTool] = useState<PdfFieldType | null>('signature');
  const [sel, setSel] = useState<string | null>(null);
  const drag = useRef<{ id: string; mode: 'move' | 'size'; sx: number; sy: number; f: PdfField; pw: number; ph: number } | null>(null);
  const place = (page: number, x: number, y: number) => {
    if (!tool) return setSel(null);
    const d = PDF_FIELD[tool];
    const f: PdfField = { id: newId(), type: tool, page, x: clamp(x - d.w / 2, 0, 1 - d.w), y: clamp(y - d.h / 2, 0, 1 - d.h), w: d.w, h: d.h, label: tool === 'text' ? '' : tool === 'sign_other' ? 'Witness signature' : d.label, required: tool !== 'sign_other' };
    onChange([...fields, f]);
    setSel(f.id);
  };
  const update = (id: string, p: Partial<PdfField>) => onChange(fields.map((f) => (f.id === id ? { ...f, ...p } : f)));
  const down = (e: React.PointerEvent, f: PdfField, mode: 'move' | 'size') => {
    e.stopPropagation(); e.preventDefault();
    const page = (e.currentTarget as HTMLElement).closest('.pdfp-page') as HTMLElement;
    const r = page.getBoundingClientRect();
    drag.current = { id: f.id, mode, sx: e.clientX, sy: e.clientY, f, pw: r.width, ph: r.height };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setSel(f.id);
  };
  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / d.pw, dy = (e.clientY - d.sy) / d.ph;
    if (d.mode === 'move') update(d.id, { x: clamp(d.f.x + dx, 0, 1 - d.f.w), y: clamp(d.f.y + dy, 0, 1 - d.f.h) });
    else update(d.id, { w: clamp(d.f.w + dx, 0.015, 1 - d.f.x), h: clamp(d.f.h + dy, 0.012, 1 - d.f.y) });
  };
  // Arrow keys nudge the selected field, for people who can't or would rather not drag.
  const key = (e: React.KeyboardEvent, f: PdfField) => {
    const step = e.shiftKey ? 0.02 : 0.004;
    const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (d[e.key]) { e.preventDefault(); update(f.id, { x: clamp(f.x + d[e.key]![0], 0, 1 - f.w), y: clamp(f.y + d[e.key]![1], 0, 1 - f.h) }); }
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); onChange(fields.filter((x) => x.id !== f.id)); }
  };
  const cur = fields.find((f) => f.id === sel);
  return (
    <div className="pfe">
      <div className="pfe-tools" role="toolbar" aria-label="Field to place">
        <span className="muted small">Click the page to place:</span>
        {(Object.keys(PDF_FIELD) as PdfFieldType[]).map((t) => (
          <button key={t} type="button" className={tool === t ? 'btn small primary' : 'btn small'} aria-pressed={tool === t} onClick={() => setTool(tool === t ? null : t)}>{PDF_FIELD[t].label}</button>
        ))}
        <span className="muted small" style={{ marginLeft: 'auto' }}>{fields.length} field{fields.length === 1 ? '' : 's'}</span>
      </div>
      {cur && (
        <div className="pfe-sel">
          <b>{PDF_FIELD[cur.type].label}</b> on page {cur.page + 1}
          {(cur.type === 'text' || cur.type === 'checkbox' || cur.type === 'sign_other') && (
            <>
              <input type="text" value={cur.label} onChange={(e) => update(cur.id, { label: e.target.value })} placeholder={cur.type === 'text' ? 'What goes here? (e.g. Address)' : cur.type === 'sign_other' ? 'Who signs here? (e.g. Witness signature)' : 'What are they ticking?'} aria-label="Field label" maxLength={80} />
              <label className="check"><input type="checkbox" checked={cur.required} onChange={(e) => update(cur.id, { required: e.target.checked })} /> Required</label>
            </>
          )}
          <button type="button" className="btn ghost small danger" onClick={() => { onChange(fields.filter((f) => f.id !== cur.id)); setSel(null); }}>Remove</button>
          <span className="muted small">Drag to move, drag the corner to resize, or use the arrow keys.</span>
        </div>
      )}
      <div className={tool ? 'pfe-pages placing' : 'pfe-pages'}>
        <PdfPages
          url={url}
          onPageClick={place}
          overlay={(p) =>
            fields.filter((f) => f.page === p.index).map((f) => (
              <div
                key={f.id}
                role="button"
                tabIndex={0}
                aria-label={`${PDF_FIELD[f.type].label}${f.label && f.type !== 'signature' ? `: ${f.label}` : ''}. Arrow keys move it, Delete removes it.`}
                className={`pf pfe-box ${f.type}${sel === f.id ? ' sel' : ''}`}
                style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
                onClick={(e) => { e.stopPropagation(); setSel(f.id); }}
                onPointerDown={(e) => down(e, f, 'move')}
                onPointerMove={move}
                onPointerUp={() => { drag.current = null; }}
                onKeyDown={(e) => key(e, f)}
              >
                <span>{f.type === 'checkbox' ? '☐' : f.type === 'text' || f.type === 'sign_other' ? f.label || PDF_FIELD[f.type].label : PDF_FIELD[f.type].label}</span>
                <i className="pfe-grip" aria-hidden="true" onPointerDown={(e) => down(e, f, 'size')} onPointerMove={move} onPointerUp={() => { drag.current = null; }} />
              </div>
            ))
          }
        />
      </div>
    </div>
  );
}
