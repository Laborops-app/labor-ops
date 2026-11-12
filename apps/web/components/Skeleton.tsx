/** Grey placeholder layout while a page loads, so it doesn't jump from a blank "Loading…" line to the full page. */
export default function Skeleton({ kind = 'page' }: { kind?: 'page' | 'list' | 'event' | 'cards' }) {
  const bar = (w: string, h = 14) => <span className="sk-bar" style={{ width: w, height: h }} />;
  if (kind === 'list')
    return (
      <div className="sk" role="status" aria-label="Loading">
        <div className="sk-card">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="sk-row">{bar('36px', 36)}<div className="sk-col">{bar(`${40 + ((i * 17) % 30)}%`)}{bar(`${20 + ((i * 11) % 20)}%`, 10)}</div>{bar('80px')}</div>)}</div>
      </div>
    );
  if (kind === 'cards')
    return (
      <div className="sk sk-grid" role="status" aria-label="Loading">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="sk-card">{bar('60%', 18)}{bar('40%', 12)}{bar('100%', 8)}{bar('30%', 12)}</div>)}
      </div>
    );
  if (kind === 'event')
    return (
      <div className="sk" role="status" aria-label="Loading">
        <div className="sk-head"><div className="sk-col">{bar('140px', 22)}{bar('55%', 34)}{bar('35%')}</div><div className="sk-card sk-staff">{bar('50%', 28)}{bar('100%', 12)}{bar('70%')}</div></div>
        <div className="sk-card">{bar('70%', 40)}</div>
        {Array.from({ length: 3 }).map((_, i) => <div key={i} className="sk-card sk-shift"><div className="sk-col">{bar('80px', 24)}{bar('60%')}{bar('100%', 8)}</div><div className="sk-col">{Array.from({ length: 3 }).map((__, k) => <span key={k}>{bar(`${50 + k * 12}%`)}</span>)}</div></div>)}
      </div>
    );
  return (
    <div className="sk" role="status" aria-label="Loading">
      <div className="sk-col">{bar('30%', 28)}{bar('45%')}</div>
      <div className="sk-grid">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="sk-card">{bar('50%')}{bar('35%', 26)}</div>)}</div>
      <div className="sk-card">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="sk-row">{bar('25%')}{bar('45%')}{bar('15%')}</div>)}</div>
    </div>
  );
}
