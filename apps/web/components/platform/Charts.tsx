'use client';
import { useEffect, useRef, useState } from 'react';

/* Small single-series charts for the platform console. One series each, so no legend: the card title names it. */

export type Point = { at: string; value: number };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const niceMax = (v: number) => {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = [1, 2, 2.5, 5, 10].find((m) => m * p >= v)!;
  return n * p;
};

export const bucketLabel = (iso: string, unit: string, long = false) => {
  const d = new Date(iso);
  if (unit === 'month') return d.toLocaleDateString([], { month: long ? 'long' : 'short', year: long ? 'numeric' : undefined, timeZone: 'UTC' });
  if (unit === 'week') return `${long ? 'Week of ' : ''}${d.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
  return d.toLocaleDateString([], { weekday: long ? 'short' : undefined, month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/**
 * Bars (counts per day/week/month) or a line with a soft area (a running total). Hover or focus shows the exact value.
 */
export function TimeChart({ data, unit, kind = 'bar', format = (n) => n.toLocaleString(), label, height = 190 }: {
  data: Point[]; unit: string; kind?: 'bar' | 'line'; format?: (n: number) => string; label: string; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 36, r: 8, t: 10, b: 24 };
  const iw = Math.max(0, w - pad.l - pad.r), ih = height - pad.t - pad.b;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const n = data.length || 1;
  const step = iw / n;
  const x = (i: number) => pad.l + step * i + step / 2;
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, max / 2, max];
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(iw / 64))));
  const bw = Math.max(2, Math.min(28, step - Math.max(2, step * 0.3)));
  const path = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.value).toFixed(1)}`).join('');
  const h = hover != null ? data[hover] : null;

  return (
    <div className="cs-chart" ref={ref} onMouseLeave={() => setHover(null)}>
      {w > 0 && (
        <svg width={w} height={height} role="img" aria-label={`${label}: ${data.map((d) => `${bucketLabel(d.at, unit)} ${format(d.value)}`).join(', ')}`}
          onMouseMove={(e) => {
            const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
            const i = Math.floor((e.clientX - r.left - pad.l) / step);
            setHover(i >= 0 && i < n ? i : null);
          }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={w - pad.r} y1={y(t)} y2={y(t)} className="cs-grid" />
              <text x={pad.l - 8} y={y(t)} dy="0.32em" textAnchor="end" className="cs-axis">{format(Math.round(t))}</text>
            </g>
          ))}
          {data.map((d, i) => (i % every === 0 || i === n - 1) && (i === n - 1 || n - 1 - i >= every / 2) ? (
            <text key={d.at} x={x(i)} y={height - 6} textAnchor="middle" className="cs-axis">{bucketLabel(d.at, unit)}</text>
          ) : null)}
          {kind === 'bar' ? (
            data.map((d, i) => {
              const top = y(d.value), hh = pad.t + ih - top;
              if (hh <= 0) return null;
              const r = Math.min(4, bw / 2, hh);
              const x0 = x(i) - bw / 2, x1 = x(i) + bw / 2, base = pad.t + ih;
              return (
                <path key={d.at} className={`cs-bar${hover === i ? ' on' : ''}`}
                  d={`M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x1 - r}Q${x1},${top} ${x1},${top + r}V${base}Z`} />
              );
            })
          ) : (
            <>
              <path className="cs-area" d={`${path}L${x(n - 1)},${pad.t + ih}L${x(0)},${pad.t + ih}Z`} />
              <path className="cs-line" d={path} />
            </>
          )}
          {h && (
            <g pointerEvents="none">
              <line x1={x(hover!)} x2={x(hover!)} y1={pad.t} y2={pad.t + ih} className="cs-cross" />
              {kind === 'line' && <circle cx={x(hover!)} cy={y(h.value)} r={5} className="cs-dot-mark" />}
            </g>
          )}
        </svg>
      )}
      {h && (
        <div className="cs-tip" style={{ left: Math.min(Math.max(x(hover!), 70), w - 70), top: Math.max(0, y(h.value) - 52) }}>
          <span className="muted small">{bucketLabel(h.at, unit, true)}</span>
          <b>{format(h.value)}</b>
        </div>
      )}
    </div>
  );
}

/** A tiny trend line for table rows and tiles (no axes). */
export function Spark({ values, width = 120, height = 32, label }: { values: number[]; width?: number; height?: number; label: string }) {
  const max = Math.max(1, ...values);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${(i * step).toFixed(1)},${(height - 3 - (v / max) * (height - 6)).toFixed(1)}`).join('');
  return (
    <svg width={width} height={height} role="img" aria-label={label} className="cs-spark">
      <path d={`${d}L${width},${height}L0,${height}Z`} className="cs-area" />
      <path d={d} className="cs-line" />
    </svg>
  );
}

/** Horizontal bars for a share breakdown (e.g. companies by plan). Labels and values in text ink. */
export function ShareBars({ rows, format = (n) => n.toLocaleString() }: { rows: { label: string; value: number }[]; format?: (n: number) => string }) {
  const total = rows.reduce((a, r) => a + r.value, 0) || 1;
  return (
    <ul className="cs-share">
      {rows.map((r) => (
        <li key={r.label}>
          <span className="cs-share-label">{r.label}</span>
          <span className="cs-share-track" aria-hidden="true"><span style={{ width: `${(r.value / total) * 100}%` }} /></span>
          <span className="cs-share-val">{format(r.value)} <span className="muted small">{Math.round((r.value / total) * 100)}%</span></span>
        </li>
      ))}
    </ul>
  );
}
