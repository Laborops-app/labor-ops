/**
 * Staffing bar used across the app: confirmed, waiting for an answer, picked but not sent yet, open.
 * One block per seat on small crews; proportional segments when `big` or above 80 seats.
 */
export default function SeatBar({ confirmed, waiting = 0, planned = 0, open, big = false }: { confirmed: number; waiting?: number; planned?: number; open: number; big?: boolean }) {
  const c = Math.max(0, confirmed), w = Math.max(0, waiting), n = Math.max(0, planned), o = Math.max(0, open);
  const total = c + w + n + o;
  const kinds: [string, number][] = [['seat-ok', c], ['seat-wait', w], ['seat-plan', n], ['seat-open', o]];
  const label = [`${c} confirmed`, w ? `${w} waiting` : '', n ? `${n} not sent` : '', `${o} open`].filter(Boolean).join(', ');
  return (
    <div className={`cs-bar${big ? ' big' : ''}${total > 30 ? ' dense' : ''}`} role="img" aria-label={label}>
      {total === 0 ? <span className="seat-open" /> : !big && total <= 80
        ? kinds.flatMap(([k, num]) => Array.from({ length: num }).map((_, i) => <span key={`${k}${i}`} className={k} />))
        : kinds.filter(([, num]) => num > 0).map(([k, num]) => <span key={k} className={k} style={{ flexGrow: num }} />)}
    </div>
  );
}

/** The words under a bar: only the states that have someone in them. */
export function SeatLegend({ confirmed, waiting = 0, planned = 0, open }: { confirmed: number; waiting?: number; planned?: number; open: number }) {
  return (
    <div className="evh-legend">
      <span className="lg-ok"><b>{confirmed}</b> confirmed</span>
      {waiting > 0 && <span className="lg-wait"><b>{waiting}</b> waiting</span>}
      {planned > 0 && <span className="lg-plan"><b>{planned}</b> not sent yet</span>}
      {open > 0 && <span className="lg-bad"><b>{open}</b> open</span>}
    </div>
  );
}
