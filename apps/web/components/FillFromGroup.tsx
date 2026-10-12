'use client';
import { useState } from 'react';
import { api } from '@/lib/api';

type Cand = { user_id: string; name: string; stars: number; week_hours: number; overtime: boolean };
type Preview = { candidates: Cand[]; skipped: { user_id: string; name: string; reason: string }[]; spots: number };

/** Staff a shift from a crew group: preview the best available people, then auto-pick the top ones or offer the shift to the whole group. */
export default function FillFromGroup({ shiftId, groups, onDone, onError }: { shiftId: string; groups: { id: string; name: string }[]; onDone: (msg: string) => void; onError: (m: string) => void }) {
  const [groupId, setGroupId] = useState('');
  const [pv, setPv] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = async (id: string) => {
    setGroupId(id);
    setPv(null);
    onError('');
    if (!id) return;
    try {
      setPv(await api<Preview>(`/api/shifts/${shiftId}/group-candidates?groupId=${id}`));
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const fill = async (mode: 'auto' | 'offer') => {
    setBusy(true);
    onError('');
    try {
      const r = await api<{ offered?: { name: string }[]; notified?: number }>(`/api/shifts/${shiftId}/fill-from-group`, { body: { groupId, mode } });
      onDone(mode === 'auto' ? `Offered the shift to ${r.offered?.map((x) => x.name).join(', ')}.` : `Offered to ${r.notified} people in the group. First to claim gets it.`);
      setGroupId('');
      setPv(null);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const n = pv ? Math.min(pv.spots, pv.candidates.length) : 0;
  return (
    <div className="fill-group">
      <div className="row">
        <select value={groupId} onChange={(e) => pick(e.target.value)} aria-label="Fill from group">
          <option value="">Fill from group…</option>
          {groups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
      </div>
      {pv && (
        <div className="small">
          {pv.candidates.length === 0 ? (
            <div className="muted">Nobody in this group is free for this shift.</div>
          ) : (
            <ol className="plain" style={{ margin: '.4rem 0' }}>
              {pv.candidates.map((c, i) => (
                <li key={c.user_id} className={i < n ? '' : 'muted'}>
                  {c.stars ? '★'.repeat(c.stars) + '☆'.repeat(5 - c.stars) : 'unrated'} {c.name}
                  <span className="muted"> · {c.week_hours} h this week{c.overtime ? ' · would be overtime' : ''}</span>
                </li>
              ))}
            </ol>
          )}
          {pv.skipped.length > 0 && (
            <details className="muted">
              <summary>{pv.skipped.length} left out</summary>
              <ul className="plain">
                {pv.skipped.map((s) => (
                  <li key={s.user_id}>{s.name}: {s.reason}</li>
                ))}
              </ul>
            </details>
          )}
          {pv.candidates.length > 0 && (
            <div className="row" style={{ marginTop: '.4rem' }}>
              <button className="btn small primary" disabled={busy} onClick={() => fill('auto')}>Offer to top {n}</button>
              <button className="btn small" disabled={busy} onClick={() => fill('offer')}>Offer to whole group</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
