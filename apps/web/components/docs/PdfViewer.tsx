'use client';
import Modal from '@/components/Modal';
import PdfPages from './PdfPages';

/** A PDF opened inside the app, with download and print. */
export default function PdfViewer({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  const print = () => {
    const w = window.open(url, '_blank');
    w?.addEventListener('load', () => setTimeout(() => { try { w.print(); } catch { /* use the viewer's own print button */ } }, 400));
  };
  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="row" style={{ gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <a className="btn primary small" href={`${url}${url.includes('?') ? '&' : '?'}download=1`}>Download PDF</a>
        <button type="button" className="btn small" onClick={print}>Print</button>
        <a className="btn ghost small" href={url} target="_blank" rel="noreferrer">Open in a new tab</a>
      </div>
      <PdfPages url={url} maxWidth={800} />
    </Modal>
  );
}
