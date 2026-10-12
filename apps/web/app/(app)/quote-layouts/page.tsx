'use client';
import { useEffect, useRef, useState } from 'react';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api } from '@/lib/api';

type Block =
  | { id: string; type: 'header'; showLogo: boolean; logoAlign: 'left' | 'center' | 'right'; logoHeight: number; companyName: string; lines: string; align: 'left' | 'center' | 'right' }
  | { id: string; type: 'title'; label: string; showNumber: boolean; showDates: boolean; align: 'left' | 'center' | 'right' }
  | { id: string; type: 'billto'; heading: string; showEvent: boolean }
  | { id: string; type: 'text'; heading: string; body: string; align: 'left' | 'center' | 'right' }
  | { id: string; type: 'lines'; groupBySection: boolean; showDate: boolean; showPeople: boolean; showHours: boolean; showRate: boolean; zebra: boolean }
  | { id: string; type: 'totals' }
  | { id: string; type: 'terms'; heading: string }
  | { id: string; type: 'signature'; heading: string; text: string }
  | { id: string; type: 'divider' }
  | { id: string; type: 'spacer'; height: number };
type Layout = { page: 'letter' | 'a4'; margin: number; font: 'Helvetica' | 'Times' | 'Courier'; fontSize: number; accent: string; textColor: string; logo: string | null; footer: string; pageNumbers: boolean; blocks: Block[] };
type Item = { id: string; name: string; is_default: boolean };

const uid = () => Math.random().toString(36).slice(2, 10);
const LABEL: Record<Block['type'], string> = { header: 'Header (logo & company)', title: 'Quote title', billto: 'Prepared for', text: 'Text', lines: 'Shifts & line items', totals: 'Totals', terms: 'Terms', signature: 'Signature', divider: 'Divider line', spacer: 'Space' };
const fresh = (t: Block['type']): Block => {
  const id = uid();
  switch (t) {
    case 'header': return { id, type: t, showLogo: true, logoAlign: 'left', logoHeight: 48, companyName: '{{company}}', lines: '', align: 'left' };
    case 'title': return { id, type: t, label: 'Quote', showNumber: true, showDates: true, align: 'left' };
    case 'billto': return { id, type: t, heading: 'Prepared for', showEvent: true };
    case 'text': return { id, type: t, heading: '', body: '', align: 'left' };
    case 'lines': return { id, type: t, groupBySection: true, showDate: true, showPeople: true, showHours: true, showRate: true, zebra: true };
    case 'terms': return { id, type: t, heading: 'Terms' };
    case 'signature': return { id, type: t, heading: 'Acceptance', text: 'By signing below you accept this quote.' };
    case 'spacer': return { id, type: t, height: 24 };
    default: return { id, type: t } as Block;
  }
};

const Check = ({ label, v, set }: { label: string; v: boolean; set: (b: boolean) => void }) => (
  <label className="check"><input type="checkbox" checked={v} onChange={(e) => set(e.target.checked)} /> {label}</label>
);
const Align = ({ v, set }: { v: string; set: (a: 'left' | 'center' | 'right') => void }) => (
  <label>Align<select value={v} onChange={(e) => set(e.target.value as 'left')}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
);

/** Shrink a logo so the saved layout stays small. */
function shrink(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const sc = Math.min(1, 700 / img.width);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * sc);
      c.height = Math.round(img.height * sc);
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let out = c.toDataURL('image/png');
      if (out.length > 800_000) {
        g.globalCompositeOperation = 'destination-over';
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        out = c.toDataURL('image/jpeg', 0.85);
      }
      out.length > 850_000 ? rej(new Error('That image is too large. Try a smaller one.')) : res(out);
    };
    img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('Could not read that image. Use a PNG or JPG.')); };
    img.src = url;
  });
}

function Body() {
  const [items, setItems] = useState<Item[]>([]);
  const [builtIn, setBuiltIn] = useState<Layout | null>(null);
  const [sel, setSel] = useState<string>('new');
  const [name, setName] = useState('My layout');
  const [cfg, setCfg] = useState<Layout | null>(null);
  const [quotes, setQuotes] = useState<{ id: string; number: number; title: string }[]>([]);
  const [quoteId, setQuoteId] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  const [rendering, setRendering] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [drag, setDrag] = useState<number | null>(null);
  const last = useRef('');

  const loadList = () => api<{ layouts: Item[]; builtIn: Layout }>('/api/quote-layouts').then((r) => { setItems(r.layouts); setBuiltIn(r.builtIn); return r; });
  useEffect(() => {
    loadList().then((r) => { if (r.layouts[0]) open(r.layouts[0].id); else { setCfg(r.builtIn); setName('Standard'); } }).catch((e) => setError(e.message));
    api<{ quotes: { id: string; number: number; title: string }[] }>('/api/quotes').then((r) => setQuotes(r.quotes)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = async (id: string) => {
    try {
      const r = await api<{ layout: { id: string; name: string; config: Layout } }>(`/api/quote-layouts/${id}`);
      setSel(id); setName(r.layout.name); setCfg(r.layout.config); setDirty(false);
    } catch (e) { setError((e as Error).message); }
  };
  const change = (fn: (c: Layout) => Layout) => { setCfg((c) => (c ? fn(c) : c)); setDirty(true); };
  const setBlock = (i: number, patch: Partial<Block>) => change((c) => ({ ...c, blocks: c.blocks.map((b, j) => (j === i ? ({ ...b, ...patch } as Block) : b)) }));
  const move = (i: number, to: number) => change((c) => {
    if (to < 0 || to >= c.blocks.length || to === i) return c;
    const bl = [...c.blocks];
    const [x] = bl.splice(i, 1);
    bl.splice(to, 0, x);
    return { ...c, blocks: bl };
  });

  // The preview is the real PDF, rendered by the same code that makes the quote PDF.
  useEffect(() => {
    if (!cfg) return;
    const key = JSON.stringify([cfg, quoteId]);
    if (key === last.current) return;
    const t = setTimeout(async () => {
      last.current = key;
      setRendering(true);
      try {
        const res = await fetch('/api/quote-layouts/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ config: cfg, quoteId: quoteId || undefined }), credentials: 'same-origin' });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Could not draw the preview');
        const url = URL.createObjectURL(await res.blob());
        setPdfUrl((old) => { if (old) URL.revokeObjectURL(old); return url; });
        setError('');
      } catch (e) { setError((e as Error).message); } finally { setRendering(false); }
    }, 500);
    return () => clearTimeout(t);
  }, [cfg, quoteId]);

  const save = async () => {
    if (!cfg) return;
    setError('');
    try {
      if (sel === 'new') {
        const r = await api<{ layout: Item }>('/api/quote-layouts', { body: { name, config: cfg } });
        await loadList();
        setSel(r.layout.id);
      } else await api(`/api/quote-layouts/${sel}`, { method: 'PUT', body: { name, config: cfg } });
      await loadList();
      setDirty(false);
      setNote('Layout saved.');
    } catch (e) { setError((e as Error).message); }
  };

  if (!cfg || !builtIn) return error ? <Banner>{error}</Banner> : <div className="muted">Loading…</div>;
  return (
    <>
      <h1>Quote layouts</h1>
      <p className="muted">Design how your quote PDFs look. The preview on the right is the real PDF, so what you see is what the customer gets. Coordinators choose a layout on each quote before sending.</p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
      <section className="card">
        <div className="row" style={{ flexWrap: 'wrap', gap: '.5rem' }}>
          <select value={sel} onChange={(e) => (e.target.value === 'new' ? (setSel('new'), setName('New layout'), setCfg(builtIn), setDirty(true)) : open(e.target.value))} aria-label="Layout">
            {items.map((i) => <option key={i.id} value={i.id}>{i.name}{i.is_default ? ' (default)' : ''}</option>)}
            <option value="new">+ New layout</option>
          </select>
          <input value={name} onChange={(e) => { setName(e.target.value); setDirty(true); }} aria-label="Layout name" style={{ maxWidth: '16rem' }} maxLength={80} />
          <button className="btn primary" disabled={!name.trim() || (!dirty && sel !== 'new')} onClick={save}>{sel === 'new' ? 'Create layout' : 'Save changes'}</button>
          {sel !== 'new' && <button className="btn" onClick={() => { setSel('new'); setName(`${name} copy`); setDirty(true); }}>Duplicate</button>}
          {sel !== 'new' && !items.find((i) => i.id === sel)?.is_default && <button className="btn" onClick={() => api(`/api/quote-layouts/${sel}/default`, { body: {} }).then(() => { loadList(); setNote('This is now the default layout.'); }).catch((e) => setError(e.message))}>Make default</button>}
          {sel !== 'new' && <button className="btn ghost danger" onClick={() => confirm('Delete this layout? Quotes using it fall back to the default.') && api(`/api/quote-layouts/${sel}`, { method: 'DELETE' }).then(async () => { const r = await loadList(); r.layouts[0] ? open(r.layouts[0].id) : (setSel('new'), setCfg(builtIn)); }).catch((e) => setError(e.message))}>Delete</button>}
        </div>
      </section>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: '1rem', alignItems: 'start' }} className="designer">
        <div>
          <section className="card">
            <h2>Page and style</h2>
            <div className="grid-form">
              <label>Paper<select value={cfg.page} onChange={(e) => change((c) => ({ ...c, page: e.target.value as 'a4' }))}><option value="letter">US Letter</option><option value="a4">A4</option></select></label>
              <label>Font<select value={cfg.font} onChange={(e) => change((c) => ({ ...c, font: e.target.value as 'Times' }))}><option value="Helvetica">Sans (Helvetica)</option><option value="Times">Serif (Times)</option><option value="Courier">Mono (Courier)</option></select></label>
              <label>Text size<input type="number" min={8} max={13} value={cfg.fontSize} onChange={(e) => change((c) => ({ ...c, fontSize: Number(e.target.value) }))} /></label>
              <label>Margin<input type="number" min={24} max={90} value={cfg.margin} onChange={(e) => change((c) => ({ ...c, margin: Number(e.target.value) }))} /></label>
              <label>Accent color<input type="color" value={cfg.accent} onChange={(e) => change((c) => ({ ...c, accent: e.target.value }))} style={{ height: '2.4rem', padding: 2 }} /></label>
              <label>Text color<input type="color" value={cfg.textColor} onChange={(e) => change((c) => ({ ...c, textColor: e.target.value }))} style={{ height: '2.4rem', padding: 2 }} /></label>
              <label>Footer text<input value={cfg.footer} maxLength={300} onChange={(e) => change((c) => ({ ...c, footer: e.target.value }))} placeholder="{{company}} · 555-0100 · you@company.com" /></label>
              <Check label="Page numbers" v={cfg.pageNumbers} set={(b) => change((c) => ({ ...c, pageNumbers: b }))} />
            </div>
            <div className="row" style={{ marginTop: '.5rem', flexWrap: 'wrap' }}>
              <label className="btn small" style={{ cursor: 'pointer' }}>
                {cfg.logo ? 'Replace logo' : 'Upload logo'}
                <input type="file" accept="image/png,image/jpeg" hidden onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { const logo = await shrink(f); change((c) => ({ ...c, logo })); } catch (x) { setError((x as Error).message); } }} />
              </label>
              {cfg.logo && <><img src={cfg.logo} alt="Logo" style={{ maxHeight: 40, maxWidth: 140 }} /><button className="btn ghost small" onClick={() => change((c) => ({ ...c, logo: null }))}>Remove</button></>}
            </div>
          </section>

          <section className="card">
            <h2>Page contents</h2>
            <p className="muted small">Drag a block (or use the arrows) to reorder. In text you can use {'{{company}} {{customer}} {{contact}} {{quote_number}} {{quote_title}} {{event}} {{total}} {{valid_until}} {{date}} {{intro}}'}.</p>
            {cfg.blocks.map((b, i) => (
              <div key={b.id} className="card" draggable onDragStart={() => setDrag(i)} onDragOver={(e) => e.preventDefault()} onDrop={() => { if (drag !== null) move(drag, i); setDrag(null); }} style={{ margin: '.5rem 0', opacity: drag === i ? 0.5 : 1 }}>
                <div className="row space">
                  <b title="Drag to reorder" style={{ cursor: 'grab' }}>⠿ {LABEL[b.type]}</b>
                  <span className="row" style={{ gap: '.25rem' }}>
                    <button className="btn ghost small" disabled={i === 0} onClick={() => move(i, i - 1)} aria-label="Move up">↑</button>
                    <button className="btn ghost small" disabled={i === cfg.blocks.length - 1} onClick={() => move(i, i + 1)} aria-label="Move down">↓</button>
                    <button className="btn ghost small danger" onClick={() => change((c) => ({ ...c, blocks: c.blocks.filter((_, j) => j !== i) }))} aria-label="Remove block">✕</button>
                  </span>
                </div>
                {b.type === 'header' && (
                  <div className="grid-form">
                    <label>Company name<input value={b.companyName} onChange={(e) => setBlock(i, { companyName: e.target.value })} maxLength={120} /></label>
                    <label>Address, phone, email<textarea rows={3} value={b.lines} onChange={(e) => setBlock(i, { lines: e.target.value })} maxLength={600} /></label>
                    <Align v={b.align} set={(a) => setBlock(i, { align: a })} />
                    <Check label="Show logo" v={b.showLogo} set={(v) => setBlock(i, { showLogo: v })} />
                    <label>Logo position<select value={b.logoAlign} onChange={(e) => setBlock(i, { logoAlign: e.target.value as 'left' })}><option value="left">Left</option><option value="center">Center</option><option value="right">Right</option></select></label>
                    <label>Logo height<input type="number" min={20} max={160} value={b.logoHeight} onChange={(e) => setBlock(i, { logoHeight: Number(e.target.value) })} /></label>
                  </div>
                )}
                {b.type === 'title' && (
                  <div className="grid-form">
                    <label>Heading word<input value={b.label} onChange={(e) => setBlock(i, { label: e.target.value })} maxLength={60} placeholder="Quote, Estimate, Proposal" /></label>
                    <Align v={b.align} set={(a) => setBlock(i, { align: a })} />
                    <Check label="Show quote number" v={b.showNumber} set={(v) => setBlock(i, { showNumber: v })} />
                    <Check label="Show dates" v={b.showDates} set={(v) => setBlock(i, { showDates: v })} />
                  </div>
                )}
                {b.type === 'billto' && (
                  <div className="grid-form">
                    <label>Heading<input value={b.heading} onChange={(e) => setBlock(i, { heading: e.target.value })} maxLength={60} /></label>
                    <Check label="Show event name" v={b.showEvent} set={(v) => setBlock(i, { showEvent: v })} />
                  </div>
                )}
                {b.type === 'text' && (
                  <div className="grid-form">
                    <label>Heading (optional)<input value={b.heading} onChange={(e) => setBlock(i, { heading: e.target.value })} maxLength={100} /></label>
                    <Align v={b.align} set={(a) => setBlock(i, { align: a })} />
                    <label style={{ gridColumn: '1 / -1' }}>Text<textarea rows={4} value={b.body} onChange={(e) => setBlock(i, { body: e.target.value })} maxLength={4000} /></label>
                  </div>
                )}
                {b.type === 'lines' && (
                  <div className="grid-form">
                    <Check label="Group by phase" v={b.groupBySection} set={(v) => setBlock(i, { groupBySection: v })} />
                    <Check label="Date / time column" v={b.showDate} set={(v) => setBlock(i, { showDate: v })} />
                    <Check label="People column" v={b.showPeople} set={(v) => setBlock(i, { showPeople: v })} />
                    <Check label="Hours column" v={b.showHours} set={(v) => setBlock(i, { showHours: v })} />
                    <Check label="Rate column" v={b.showRate} set={(v) => setBlock(i, { showRate: v })} />
                    <Check label="Striped rows" v={b.zebra} set={(v) => setBlock(i, { zebra: v })} />
                  </div>
                )}
                {b.type === 'terms' && <label>Heading<input value={b.heading} onChange={(e) => setBlock(i, { heading: e.target.value })} maxLength={100} /></label>}
                {b.type === 'signature' && (
                  <div className="grid-form">
                    <label>Heading<input value={b.heading} onChange={(e) => setBlock(i, { heading: e.target.value })} maxLength={100} /></label>
                    <label>Wording<input value={b.text} onChange={(e) => setBlock(i, { text: e.target.value })} maxLength={1000} /></label>
                  </div>
                )}
                {b.type === 'spacer' && <label>Height<input type="number" min={4} max={200} value={b.height} onChange={(e) => setBlock(i, { height: Number(e.target.value) })} /></label>}
                {(b.type === 'totals' || b.type === 'divider') && <div className="muted small">{b.type === 'totals' ? 'Subtotal, discount, tax and total.' : 'A line across the page in the accent color.'}</div>}
              </div>
            ))}
            <select value="" onChange={(e) => { const t = e.target.value as Block['type']; if (t) change((c) => ({ ...c, blocks: [...c.blocks, fresh(t)] })); }} aria-label="Add a block">
              <option value="">+ Add a block…</option>
              {(Object.keys(LABEL) as Block['type'][]).map((t) => <option key={t} value={t}>{LABEL[t]}</option>)}
            </select>
          </section>
        </div>
        <div style={{ position: 'sticky', top: '1rem' }}>
          <div className="row space" style={{ marginBottom: '.4rem' }}>
            <b>Live preview {rendering && <span className="muted small">updating…</span>}</b>
            <select value={quoteId} onChange={(e) => setQuoteId(e.target.value)} aria-label="Preview with" style={{ maxWidth: '14rem' }}>
              <option value="">Sample quote</option>
              {quotes.map((q) => <option key={q.id} value={q.id}>#{q.number} {q.title}</option>)}
            </select>
          </div>
          {pdfUrl ? <iframe title="Quote PDF preview" src={pdfUrl} style={{ width: '100%', height: '80vh', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} /> : <div className="muted">Drawing the preview…</div>}
        </div>
      </div>
      <style>{'@media (max-width: 1000px){.designer{grid-template-columns:1fr !important}}'}</style>
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
