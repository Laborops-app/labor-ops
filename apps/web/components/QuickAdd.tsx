'use client';
import { useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { parseQuickAdd } from '@/lib/quickAdd';

export type RoleDefault = { name: string; headcount: number | null; start: string | null; end: string | null };
type Row = { role: string; count: number; start: string; end: string; groupId: string };

/**
 * Add many positions to one day (phase) at once: type "10 stagehands 8a-4p, 4 riggers 7a-3p" or fill the grid,
 * Tab through it, Enter adds a row. Each role starts with its defaults (people needed and times).
 */
export default function QuickAdd({
  eventId, phase, groups, roles, defaults, onDone, onError, onClose,
}: {
  eventId: string;
  phase: { id: string; label: string; starts_on: string };
  groups: { id: string; label: string }[];
  roles: string[];
  defaults: RoleDefault[];
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
  onClose: () => void;
}) {
  const day = phase.starts_on.slice(0, 10);
  const def = useMemo(() => new Map(defaults.map((d) => [d.name.toLowerCase(), d])), [defaults]);
  const timesFor = (role: string) => {
    const d = def.get(role.toLowerCase());
    return { start: d?.start ?? '08:00', end: d?.end ?? '16:00' };
  };
  const blank = (groupId = ''): Row => ({ role: '', count: 1, start: '08:00', end: '16:00', groupId });
  const [rows, setRows] = useState<Row[]>([blank(), blank(), blank()]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const grid = useRef<HTMLTableSectionElement>(null);

  const set = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  // Picking a known role fills in its defaults (unless the row was already changed by hand).
  const setRole = (i: number, role: string) => {
    const d = def.get(role.toLowerCase());
    setRows((rs) => rs.map((r, j) => (j !== i ? r : { ...r, role, ...(d ? { count: r.count === 1 && d.headcount ? d.headcount : r.count, start: d.start ?? r.start, end: d.end ?? r.end } : {}) })));
  };
  const addRow = (focus = false) => {
    setRows((rs) => [...rs, blank(rs[rs.length - 1]?.groupId ?? '')]);
    if (focus) setTimeout(() => (grid.current?.querySelector('tr:last-child input') as HTMLInputElement | null)?.focus(), 30);
  };
  const fromText = () => {
    const parsed = parseQuickAdd(text, roles, timesFor);
    if (!parsed.length) return onError('Type something like "10 stagehands 8a-4p, 4 riggers 7a-3p".');
    const filled = rows.filter((r) => r.role.trim());
    setRows([...filled, ...parsed.map((p) => ({ role: p.role, count: p.count, start: p.start, end: p.end, groupId: '' }))]);
    setText('');
  };

  const ready = rows.filter((r) => r.role.trim() && r.count > 0 && r.start && r.end);
  const at = (hhmm: string, plus = 0) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(`${day}T00:00:00`);
    d.setDate(d.getDate() + plus);
    d.setHours(h, m, 0, 0);
    return d;
  };
  const save = async () => {
    if (!ready.length) return onError('Add at least one position with a role.');
    setBusy(true);
    try {
      const shifts = ready.map((r) => {
        const s = at(r.start);
        let e = at(r.end);
        if (e <= s) e = at(r.end, 1); // ends after midnight
        return { roleName: r.role.trim(), startsAt: s.toISOString(), endsAt: e.toISOString(), headcount: Math.min(500, Math.max(1, Math.round(r.count))), phaseId: phase.id, groupId: r.groupId || null };
      });
      await api(`/api/events/${eventId}/shifts/bulk`, { body: { shifts } });
      const people = shifts.reduce((n, s) => n + s.headcount, 0);
      onDone(`Added ${shifts.length} position${shifts.length === 1 ? '' : 's'} (${people} people) to ${phase.label}.`);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="quick-add">
      <div className="qa-line">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); fromText(); } }}
          placeholder='Type it: 10 stagehands 8a-4p, 4 riggers 7a-3p'
          aria-label="Quick add: type positions"
        />
        <button type="button" className="btn small" onClick={fromText} disabled={!text.trim()}>Add to list</button>
      </div>
      <div className="table-wrap qa-wrap">
        <table className="qa-grid">
          <thead>
            <tr>
              <th>Role</th>
              <th className="qa-num">People</th>
              <th>Start</th>
              <th>End</th>
              {groups.length > 0 && <th>Group</th>}
              <th aria-label="Remove" />
            </tr>
          </thead>
          <tbody ref={grid}>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>
                  <input list="role-names" value={r.role} onChange={(e) => setRole(i, e.target.value)} placeholder="Role" aria-label={`Role, row ${i + 1}`}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(true); } }} />
                </td>
                <td className="qa-num">
                  <input type="number" min={1} max={500} value={r.count} onChange={(e) => set(i, { count: Number(e.target.value) })} aria-label={`People needed, row ${i + 1}`}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(true); } }} />
                </td>
                <td><input type="time" value={r.start} onChange={(e) => set(i, { start: e.target.value })} aria-label={`Start, row ${i + 1}`} /></td>
                <td>
                  <input type="time" value={r.end} onChange={(e) => set(i, { end: e.target.value })} aria-label={`End, row ${i + 1}`}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRow(true); } }} />
                  {r.end && r.start && r.end <= r.start && <span className="muted small qa-next">next day</span>}
                </td>
                {groups.length > 0 && (
                  <td>
                    <select value={r.groupId} onChange={(e) => set(i, { groupId: e.target.value })} aria-label={`Group, row ${i + 1}`}>
                      <option value="">No group</option>
                      {groups.map((g) => <option key={g.id} value={g.id}>{g.label}</option>)}
                    </select>
                  </td>
                )}
                <td>
                  <button type="button" className="btn ghost small" aria-label={`Remove row ${i + 1}`} onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : [blank()]))}>✕</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row qa-actions">
        <button type="button" className="btn ghost small" onClick={() => addRow(true)}>+ Row</button>
        <span className="muted small">Enter adds a row. Ends before it starts = the next morning.</span>
        <span style={{ marginLeft: 'auto' }} />
        <button type="button" className="btn ghost small" onClick={onClose}>Cancel</button>
        <button type="button" className="btn primary small" disabled={busy || !ready.length} onClick={save}>
          {busy ? 'Adding…' : `Add ${ready.length || ''} position${ready.length === 1 ? '' : 's'}`.replace('  ', ' ')}
        </button>
      </div>
    </div>
  );
}
