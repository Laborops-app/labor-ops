'use client';
import { useEffect, useState } from 'react';
import Modal from '@/components/Modal';
import { api } from '@/lib/api';
import { askConfirm } from '@/components/Toasts';

type Field = 'name' | 'first' | 'last' | 'email' | 'phone' | 'roles' | 'address' | 'emergencyName' | 'emergencyPhone' | 'notes';
type Row = { row: number; name: string; email: string; phone: string | null; roles: string[]; address: string | null; emergencyName: string | null; emergencyPhone: string | null; notes: string | null; problems: string[] };
type Preview = { header: string[]; columns: (Field | null)[]; rows: Row[]; unknownRoles: string[]; ready: number };

const LABEL: Record<Field, string> = {
  name: 'Full name', first: 'First name', last: 'Last name', email: 'Email', phone: 'Phone', roles: 'Roles / positions',
  address: 'Address', emergencyName: 'Emergency contact', emergencyPhone: 'Emergency phone', notes: 'Notes',
};

const toBase64 = (f: File) => new Promise<string>((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1] ?? '');
  r.onerror = () => rej(new Error('Could not read that file'));
  r.readAsDataURL(f);
});

/** Crew › Import: upload an Excel or CSV file, check how its columns were read and which rows have problems, then add. */
export default function CrewImport({ isAdmin, onClose, onDone }: { isAdmin: boolean; onClose: () => void; onDone: (msg: string) => void }) {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [p, setP] = useState<Preview | null>(null);
  const [cols, setCols] = useState<(Field | null)[] | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [invite, setInvite] = useState(false);
  const [createRoles, setCreateRoles] = useState(true);
  const [result, setResult] = useState<{ created: number; skipped: { row: number; name: string; reason: string }[]; rolesAdded: number } | null>(null);

  const preview = async (f: { name: string; data: string }, columns?: (Field | null)[]) => {
    setBusy('preview'); setErr('');
    try {
      const r = await api<Preview>('/api/crew/import/preview', { body: { file: f.data, filename: f.name, columns } });
      setP(r); setCols(r.columns);
    } catch (e) { setErr((e as Error).message); setP(null); }
    finally { setBusy(''); }
  };
  useEffect(() => { if (file) preview(file); }, [file]);

  const run = async () => {
    if (!p) return;
    setBusy('import'); setErr('');
    try {
      const r = await api<NonNullable<typeof result>>('/api/crew/import', { body: { rows: p.rows, invite, createRoles: createRoles && isAdmin } });
      setResult(r);
      onDone(`${r.created} crew member${r.created === 1 ? '' : 's'} added${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}.`);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(''); }
  };

  const bad = p?.rows.filter((r) => r.problems.length) ?? [];
  return (
    <Modal title="Import crew from a spreadsheet" onClose={onClose} wide>
      {result ? (
        <>
          <p><b>{result.created}</b> added{result.rolesAdded ? `, ${result.rolesAdded} new role${result.rolesAdded === 1 ? '' : 's'} added to the role list` : ''}.</p>
          {result.skipped.length > 0 && (
            <>
              <p className="muted small">Skipped:</p>
              <ul className="plain small">{result.skipped.map((s) => <li key={s.row}>Row {s.row}{s.name ? ` · ${s.name}` : ''}: {s.reason}</li>)}</ul>
            </>
          )}
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" onClick={onClose}>Done</button></div>
        </>
      ) : (
        <>
          <p className="muted small">
            Upload an Excel file (.xlsx) or a CSV with one person per row and a header row. Columns like Name (or First and Last name), Email, Phone, Roles,
            Address, Emergency contact and Notes are picked up automatically; you can change how each column is read below. Every person needs an email to sign in.{' '}
            <a href="/api/crew/import/template.csv">Download a sample sheet</a>.
          </p>
          <label className="btn" style={{ display: 'inline-flex', cursor: 'pointer' }}>
            {file ? `Change file (${file.name})` : 'Choose a file…'}
            <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden
              onChange={async (e) => { const f = e.target.files?.[0]; if (f) { if (f.size > 8 * 1024 * 1024) return setErr('That file is over 8 MB.'); setResult(null); setFile({ name: f.name, data: await toBase64(f) }); } }} />
          </label>
          {busy === 'preview' && <span className="muted small" style={{ marginLeft: 8 }}>Reading…</span>}
          {err && <p className="error small">{err}</p>}

          {p && cols && (
            <>
              <h3 style={{ marginTop: 16 }}>Columns</h3>
              <div className="imp-cols">
                {p.header.map((h, i) => (
                  <label key={i} className="small">
                    <span className="muted">{h || `Column ${i + 1}`}</span>
                    <select value={cols[i] ?? ''} onChange={(e) => { const next = [...cols]; next[i] = (e.target.value || null) as Field | null; setCols(next); preview(file!, next); }}>
                      <option value="">Don’t import</option>
                      {(Object.keys(LABEL) as Field[]).map((f) => <option key={f} value={f}>{LABEL[f]}</option>)}
                    </select>
                  </label>
                ))}
              </div>

              <h3 style={{ marginTop: 16 }}>{p.ready} of {p.rows.length} ready to add</h3>
              <div className="table-wrap" style={{ maxHeight: 320, overflow: 'auto' }}>
                <table className="report-table">
                  <thead><tr><th>Row</th><th>Name</th><th>Email</th><th>Phone</th><th>Roles</th><th></th></tr></thead>
                  <tbody>
                    {p.rows.slice(0, 300).map((r) => (
                      <tr key={r.row} style={r.problems.length ? { opacity: 0.6 } : undefined}>
                        <td>{r.row}</td><td>{r.name || '—'}</td><td>{r.email || '—'}</td><td>{r.phone ?? '—'}</td><td>{r.roles.join(', ') || '—'}</td>
                        <td>{r.problems.length ? <span className="chip warn">{r.problems.join(', ')}</span> : <span className="chip open">Ready</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {p.rows.length > 300 && <p className="muted small">Showing the first 300 rows; all {p.rows.length} are imported.</p>}
              {bad.length > 0 && <p className="muted small">{bad.length} row{bad.length === 1 ? '' : 's'} with a problem will be skipped. Fix them in the file and import it again any time; people already added are skipped.</p>}

              {p.unknownRoles.length > 0 && (
                isAdmin ? (
                  <label className="check small">
                    <input type="checkbox" checked={createRoles} onChange={(e) => setCreateRoles(e.target.checked)} />
                    Add new roles to the role list: {p.unknownRoles.join(', ')} <span className="muted">(set their pay rates on the Roles page)</span>
                  </label>
                ) : <p className="muted small">Roles not on your role list yet: {p.unknownRoles.join(', ')}. An admin can add them on the Roles page.</p>
              )}
              <label className="check small">
                <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
                Email each person an invite to set their password
              </label>
              <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
                <button className="btn" onClick={onClose}>Cancel</button>
                <button className="btn primary" disabled={!p.ready || !!busy} onClick={run}>{busy === 'import' ? 'Adding…' : `Add ${p.ready} crew member${p.ready === 1 ? '' : 's'}`}</button>
              </div>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

/** Admin: sample crew with star ratings for trying the app, and removing them again. */
export function DemoCrew({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [count, setCount] = useState<number | null>(null);
  const [per, setPer] = useState(15);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api<{ count: number }>('/api/crew/demo').then((r) => setCount(r.count)).catch(() => setCount(0)); }, []);
  const add = async () => {
    setBusy('add'); setErr('');
    try {
      const r = await api<{ made: number; roles: number; reviews: number }>('/api/crew/demo', { body: { perRole: per } });
      onDone(`Added ${r.made} demo crew (${per} for each of your ${r.roles} roles) with ${r.reviews} star ratings.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  const remove = async () => {
    if (!(await askConfirm(`Remove all ${count} demo crew? Their shifts, time and ratings go with them.`))) return;
    setBusy('remove'); setErr('');
    try {
      const r = await api<{ removed: number }>('/api/crew/demo', { method: 'DELETE' });
      onDone(`Removed ${r.removed} demo crew.`);
      onClose();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  };
  return (
    <Modal title="Demo crew" onClose={onClose}>
      <p className="muted small">
        Adds sample people for each of your active roles, each with a few star ratings and notes, so you can try scheduling, auto-fill and reports.
        They’re marked <span className="chip">Demo</span>, can’t sign in, and never get emails or texts. Remove them all here when you’re done.
      </p>
      {err && <p className="error small">{err}</p>}
      <label className="small">
        People per role{' '}
        <input type="number" min={1} max={50} value={per} onChange={(e) => setPer(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} style={{ width: '5rem' }} />
      </label>
      <div className="row" style={{ justifyContent: 'space-between', marginTop: 16, gap: 8 }}>
        <button className="btn danger" disabled={!count || !!busy} onClick={remove}>{busy === 'remove' ? 'Removing…' : `Remove demo crew${count ? ` (${count})` : ''}`}</button>
        <button className="btn primary" disabled={!!busy} onClick={add}>{busy === 'add' ? 'Adding…' : 'Add demo crew'}</button>
      </div>
    </Modal>
  );
}

/** Crew › Export for Rentman: an .xlsx laid out for Rentman's crew import (Crew members › More actions › Import). */
export function RentmanExport({ onClose }: { onClose: () => void }) {
  const [missing, setMissing] = useState(true);
  const [folders, setFolders] = useState(true);
  const [linked, setLinked] = useState<boolean | null>(null);
  useEffect(() => { api<{ crew: unknown[] }>('/api/rentman/crew').then((r) => setLinked(r.crew.length > 0)).catch(() => setLinked(false)); }, []);
  const href = `/api/crew/export/rentman.xlsx?missing=${linked && missing ? 1 : 0}&folders=${folders ? 1 : 0}`;
  return (
    <Modal title="Export crew for Rentman" onClose={onClose}>
      <p className="muted small">
        Downloads an Excel file in the layout Rentman’s crew import expects: one sheet, plain text, with columns named First name, Middle name, Last name, Email,
        Phone, Folder, Description (their roles), Emergency contact and Address, so Rentman matches them on its own. Active crew only; demo crew are left out.
      </p>
      {linked && (
        <label className="check small">
          <input type="checkbox" checked={missing} onChange={(e) => setMissing(e.target.checked)} />
          Only people not linked to Rentman crew yet (so nobody is added twice)
        </label>
      )}
      <label className="check small">
        <input type="checkbox" checked={folders} onChange={(e) => setFolders(e.target.checked)} />
        Put each person in a Rentman folder named after their first role
      </label>
      <p className="muted small" style={{ marginTop: 12 }}>
        In Rentman: <b>Crew members › More actions › Import</b>, choose <b>Add new and skip existing</b> with Email as the match column, upload the file, check the
        columns, pick a root folder, then import. Rentman may email each new crew member an invitation when they’re imported. Once they’re in, turn on
        <b> Link Rentman crew</b> under Integrations › Rentman so LaborOps links them by email.
      </p>
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button className="btn" onClick={onClose}>Close</button>
        <a className="btn primary" href={href} download onClick={() => setTimeout(onClose, 300)}>Download .xlsx</a>
      </div>
    </Modal>
  );
}
