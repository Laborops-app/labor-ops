'use client';
import { useRef, useState } from 'react';

/* Small SVG charts for reports. Colors come from CSS variables (.rc-*) so light and dark each use validated steps. */

type Tip = { x: number; y: number; lines: string[] } | null;

function Tooltip({ tip }: { tip: Tip }) {
  if (!tip) return null;
  return (
    <div className="rc-tip" style={{ left: tip.x, top: tip.y }} role="status">
      {tip.lines.map((l, i) => <div key={i} className={i === 0 ? 'rc-tip-head' : undefined}>{l}</div>)}
    </div>
  );
}

const niceMax = (v: number) => {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / p;
  const step = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => n <= x) ?? 10;
  return step * p;
};

/** Horizontal bars, one series: a label, a bar, and the value at the end. Best for "which is biggest". */
export function HBars({ rows, format, sub }: { rows: { label: string; value: number; note?: string }[]; format: (n: number) => string; sub?: (r: { label: string; value: number; note?: string }) => string }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  if (!rows.length) return <p className="muted small">Nothing to show yet.</p>;
  return (
    <div className="rc-hbars" role="table">
      {rows.map((r) => (
        <div key={r.label} className="rc-hbar" role="row" title={`${r.label}: ${format(r.value)}${r.note ? ` · ${r.note}` : ''}`}>
          <span className="rc-hbar-label" role="cell">{r.label}{sub && <span className="muted small"> {sub(r)}</span>}</span>
          <span className="rc-hbar-track" role="cell" aria-hidden="true">
            <span className="rc-hbar-fill" style={{ width: `${max > 0 && r.value > 0 ? Math.max(1.5, (r.value / max) * 100) : 0}%` }} />
          </span>
          <span className="rc-hbar-value" role="cell">{format(r.value)}</span>
        </div>
      ))}
    </div>
  );
}

/** Vertical bars, two series side by side per category (e.g. scheduled vs worked hours by day), with a legend. */
export function PairBars({ data, a, b, format, height = 200 }: { data: { label: string; full?: string; a: number; b: number; extra?: string }[]; a: string; b: string; format: (n: number) => string; height?: number }) {
  const [tip, setTip] = useState<Tip>(null);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  if (!data.length) return <p className="muted small">Nothing to show yet.</p>;
  // Few categories: stretch to the card's width; many: keep 56px per category and scroll sideways.
  const W = Math.max(560, data.length * 56), H = height, padL = 40, padB = 26, padT = 10;
  const max = niceMax(Math.max(...data.map((d) => Math.max(d.a, d.b))));
  const step = (W - padL) / data.length, bw = Math.min(28, (step - 12) / 2);
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, max / 2, max];
  const showLabel = (i: number) => data.length <= 12 || i % Math.ceil(data.length / 12) === 0;
  return (
    <div className="rc-wrap" ref={box}>
      <div className="rc-legend">
        <span><i className="rc-key rc-s1" /> {a}</span>
        <span><i className="rc-key rc-s2" /> {b}</span>
      </div>
      <div className="rc-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} width={W > 560 ? W : '100%'} style={{ maxHeight: W > 560 ? undefined : H * 1.6 }} role="img" aria-label={`${a} and ${b}`} onMouseLeave={() => { setTip(null); setHover(null); }}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W} y1={y(t)} y2={y(t)} className="rc-grid" />
              <text x={padL - 6} y={y(t) + 4} className="rc-axis" textAnchor="end">{format(t)}</text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + step * i + step / 2;
            const bar = (v: number, x: number, cls: string) => {
              const h = Math.max(0, y(0) - y(v));
              const r = Math.min(4, bw / 2, h);
              // rounded top only, anchored to the baseline
              return h > 0 ? <path className={cls} d={`M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + bw - r} Q${x + bw},${y(v)} ${x + bw},${y(v) + r} V${y(0)} Z`} /> : null;
            };
            return (
              <g key={d.label} opacity={hover === null || hover === i ? 1 : 0.45}>
                {bar(d.a, cx - bw - 1, 'rc-s1')}
                {bar(d.b, cx + 1, 'rc-s2')}
                {showLabel(i) && <text x={cx} y={H - 8} className="rc-axis" textAnchor="middle">{d.label}</text>}
                <rect
                  x={padL + step * i} y={padT} width={step} height={H - padT - padB} fill="transparent"
                  onMouseMove={(ev) => {
                    const r = box.current!.getBoundingClientRect();
                    setHover(i);
                    setTip({ x: ev.clientX - r.left + 12, y: ev.clientY - r.top - 10, lines: [d.full ?? d.label, `${a}: ${format(d.a)}`, `${b}: ${format(d.b)}`, ...(d.extra ? [d.extra] : [])] });
                  }}
                />
              </g>
            );
          })}
          <line x1={padL} x2={W} y1={y(0)} y2={y(0)} className="rc-base" />
        </svg>
      </div>
      <Tooltip tip={tip} />
    </div>
  );
}

/** A running total over time as a step line (e.g. confirmed crew by day), with a target line and crosshair hover. */
export function StepLine({ points, target, format, targetLabel, height = 180 }: { points: { date: string; label: string; value: number }[]; target?: number; targetLabel?: string; format: (n: number) => string; height?: number }) {
  const [tip, setTip] = useState<Tip>(null);
  const [hx, setHx] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  if (!points.length) return <p className="muted small">Nobody confirmed yet.</p>;
  const W = 560, H = height, padL = 36, padR = 12, padB = 24, padT = 12;
  const max = niceMax(Math.max(target ?? 0, ...points.map((p) => p.value)));
  const t0 = Date.parse(points[0].date), t1 = Math.max(t0 + 86400_000, Date.parse(points[points.length - 1].date));
  const x = (d: string) => padL + (W - padL - padR) * ((Date.parse(d) - t0) / (t1 - t0));
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  let d = `M${x(points[0].date)},${y(0)}`;
  points.forEach((p, i) => { d += ` V${y(p.value)}`; if (points[i + 1]) d += ` H${x(points[i + 1].date)}`; });
  d += ` H${W - padR}`;
  return (
    <div className="rc-wrap" ref={box}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" role="img" aria-label="Confirmed crew over time"
        onMouseLeave={() => { setTip(null); setHx(null); }}
        onMouseMove={(ev) => {
          const svg = ev.currentTarget.getBoundingClientRect();
          const px = ((ev.clientX - svg.left) / svg.width) * W;
          let best = points[0];
          for (const p of points) if (x(p.date) <= px) best = p;
          const r = box.current!.getBoundingClientRect();
          setHx(x(best.date));
          setTip({ x: ev.clientX - r.left + 12, y: ev.clientY - r.top - 10, lines: [best.label, `${format(best.value)} confirmed`, ...(target ? [`${format(Math.max(0, target - best.value))} still open`] : [])] });
        }}>
        {[0, max / 2, max].map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} className="rc-grid" />
            <text x={padL - 6} y={y(t) + 4} className="rc-axis" textAnchor="end">{format(t)}</text>
          </g>
        ))}
        {target ? (
          <g>
            <line x1={padL} x2={W - padR} y1={y(target)} y2={y(target)} className="rc-target" />
            <text x={W - padR} y={y(target) - 5} className="rc-axis" textAnchor="end">{targetLabel ?? 'Target'}</text>
          </g>
        ) : null}
        <path d={d} className="rc-line" />
        {hx !== null && <line x1={hx} x2={hx} y1={padT} y2={H - padB} className="rc-cross" />}
        <text x={padL} y={H - 6} className="rc-axis">{points[0].label}</text>
        <text x={W - padR} y={H - 6} className="rc-axis" textAnchor="end">{points[points.length - 1].label}</text>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

/** One value against a limit (labor cost vs budget, filled vs needed). Turns to the warning color past the limit. */
export function Meter({ value, max, label, format }: { value: number; max: number; label: string; format: (n: number) => string }) {
  const pct = max > 0 ? value / max : 0;
  const over = pct > 1;
  return (
    <div className="rc-meter" title={`${label}: ${format(value)} of ${format(max)}`}>
      <div className="rc-meter-track" aria-hidden="true">
        <span className={over ? 'rc-meter-fill over' : 'rc-meter-fill'} style={{ width: `${Math.min(100, pct * 100)}%` }} />
      </div>
      <div className="rc-meter-text small">
        <span>{label}</span>
        <b>{Math.round(pct * 100)}%{over ? ' · over' : ''}</b>
      </div>
    </div>
  );
}
