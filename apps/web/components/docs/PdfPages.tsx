'use client';
import { useEffect, useRef, useState } from 'react';

type PageInfo = { index: number; width: number; height: number };
type Doc = { numPages: number; getPage: (n: number) => Promise<any>; destroy?: () => void };

let pdfjsLoad: Promise<any> | null = null;
/** pdf.js, loaded once and only in the browser. */
export const loadPdfjs = () =>
  (pdfjsLoad ??= import('pdfjs-dist').then((m) => {
    m.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs';
    return m;
  }));

function Page({ doc, index, width, children, onClick }: { doc: Doc; index: number; width: number; children?: (p: PageInfo) => React.ReactNode; onClick?: (x: number, y: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    let off = false;
    let task: { cancel?: () => void } | null = null;
    doc.getPage(index + 1).then((page) => {
      if (off || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      const css = width / base.width;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const vp = page.getViewport({ scale: css * dpr });
      const cv = canvas.current;
      cv.width = Math.floor(vp.width);
      cv.height = Math.floor(vp.height);
      setSize({ w: width, h: (base.height / base.width) * width });
      task = page.render({ canvasContext: cv.getContext('2d')!, viewport: vp, canvas: cv });
      (task as any).promise?.catch(() => {});
    });
    return () => { off = true; task?.cancel?.(); };
  }, [doc, index, width]);
  return (
    <div
      className="pdfp-page"
      style={{ width, height: size?.h ?? width * 1.294 }}
      onClick={onClick ? (e) => { const r = e.currentTarget.getBoundingClientRect(); onClick((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); } : undefined}
    >
      <canvas ref={canvas} style={{ width: '100%', height: '100%' }} aria-label={`Page ${index + 1}`} role="img" />
      {size && children?.({ index, width: size.w, height: size.h })}
    </div>
  );
}

/**
 * A PDF shown page by page inside the app (no browser plug-in), sized to its container. `overlay` draws on top of
 * each page (fields to fill in, boxes to place); `onPageClick` reports a click as fractions of the page.
 */
export default function PdfPages({ url, overlay, onPageClick, maxWidth = 860, onLoaded }: { url: string; overlay?: (p: PageInfo) => React.ReactNode; onPageClick?: (page: number, x: number, y: number) => void; maxWidth?: number; onLoaded?: (pages: number) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<Doc | null>(null);
  const [err, setErr] = useState('');
  const [width, setWidth] = useState(0);
  useEffect(() => {
    let off = false;
    let loaded: Doc | null = null;
    setDoc(null); setErr('');
    loadPdfjs()
      .then((pdfjs) => pdfjs.getDocument({ url, withCredentials: true }).promise)
      .then((d: Doc) => { if (off) return d.destroy?.(); loaded = d; setDoc(d); onLoaded?.(d.numPages); })
      .catch(() => !off && setErr('This PDF couldn’t be shown here.'));
    return () => { off = true; loaded?.destroy?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setWidth(Math.max(240, Math.min(maxWidth, Math.floor(el.clientWidth))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth]);
  return (
    <div className="pdfp" ref={box}>
      {err && <p className="error" role="alert">{err} <a href={url} target="_blank" rel="noreferrer">Open it in a new tab</a>.</p>}
      {!doc && !err && <p className="muted" role="status">Loading the document…</p>}
      {doc && width > 0 && Array.from({ length: doc.numPages }).map((_, i) => (
        <Page key={i} doc={doc} index={i} width={width} onClick={onPageClick ? (x, y) => onPageClick(i, x, y) : undefined}>{overlay}</Page>
      ))}
    </div>
  );
}
