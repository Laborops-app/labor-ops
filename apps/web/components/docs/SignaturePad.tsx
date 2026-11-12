'use client';
import { useEffect, useRef, useState } from 'react';

/** Draw a signature with a finger, pen or mouse, or type a name. Reports a PNG (transparent background) or null when empty. */
export default function SignaturePad({ name, onChange }: { name: string; onChange: (png: string | null) => void }) {
  const [mode, setMode] = useState<'draw' | 'type'>('draw');
  const [typed, setTyped] = useState(name);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const W = 600, H = 200;

  const ctx = () => {
    const c = canvas.current!.getContext('2d')!;
    c.lineWidth = 5; c.lineCap = 'round'; c.lineJoin = 'round'; c.strokeStyle = '#101a2e'; c.fillStyle = '#101a2e';
    return c;
  };
  const emit = () => onChange(dirty.current ? canvas.current!.toDataURL('image/png') : null);
  const clear = () => { ctx().clearRect(0, 0, W, H); dirty.current = false; onChange(null); };
  const at = (e: React.PointerEvent) => { const r = canvas.current!.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };

  // Typed name: drawn in a script face so it reads as a signature.
  useEffect(() => {
    if (mode !== 'type' || !canvas.current) return;
    const c = ctx();
    c.clearRect(0, 0, W, H);
    const text = typed.trim();
    dirty.current = !!text;
    if (text) {
      let size = 84;
      do { c.font = `italic ${size}px "Snell Roundhand", "Segoe Script", "Brush Script MT", "Apple Chancery", cursive`; size -= 4; } while (c.measureText(text).width > W - 40 && size > 24);
      c.textBaseline = 'middle';
      c.fillText(text, 20, H / 2);
    }
    emit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, typed]);

  return (
    <div className="sigpad">
      <div className="sigpad-top">
        <div className="seg" role="radiogroup" aria-label="How to sign">
          <button type="button" role="radio" aria-checked={mode === 'draw'} className={mode === 'draw' ? 'seg-btn on' : 'seg-btn'} onClick={() => { setMode('draw'); setTimeout(clear, 0); }}>Draw</button>
          <button type="button" role="radio" aria-checked={mode === 'type'} className={mode === 'type' ? 'seg-btn on' : 'seg-btn'} onClick={() => setMode('type')}>Type my name</button>
        </div>
        {mode === 'draw' && <button type="button" className="btn ghost small" onClick={clear}>Clear</button>}
      </div>
      {mode === 'type' && <input type="text" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Your full name" placeholder="Your full name" autoComplete="name" maxLength={80} />}
      <canvas
        ref={canvas}
        width={W}
        height={H}
        className="sigpad-canvas"
        role="img"
        aria-label={mode === 'draw' ? 'Signature area: draw your signature here' : 'Your typed signature'}
        style={{ touchAction: 'none', pointerEvents: mode === 'draw' ? 'auto' : 'none' }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drawing.current = true; last.current = at(e); const c = ctx(); c.beginPath(); c.arc(last.current.x, last.current.y, 1.5, 0, Math.PI * 2); c.fill(); dirty.current = true; }}
        onPointerMove={(e) => { if (!drawing.current || !last.current) return; const p = at(e); const c = ctx(); c.beginPath(); c.moveTo(last.current.x, last.current.y); c.lineTo(p.x, p.y); c.stroke(); last.current = p; }}
        onPointerUp={() => { drawing.current = false; emit(); }}
        onPointerCancel={() => { drawing.current = false; emit(); }}
      />
      {mode === 'draw' && <p className="muted small" style={{ margin: 0 }}>Sign in the box with your finger or mouse. Can’t draw? Choose “Type my name”.</p>}
    </div>
  );
}
