'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { show, askConfirm } from '@/components/Toasts';

/*
 * Crew instructions + uniform (event page), pay by position (event › Crew pay), the change log (event History and
 * the Activity page), uniform presets and tidying old skills into positions (Positions & rates).
 */

type Uniform = { id: string; name: string; description: string | null; events?: number };
const money = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US', { style: 'currency', currency: 'USD' }));

/** Event page: what crew need to know and what to wear. */
export function EventInstructions({ eventId, instructions, uniform, uniformNote, onSaved }: {
  eventId: string; instructions: string | null; uniform: Uniform | null; uniformNote: string | null; onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(instructions ?? '');
  const [uid, setUid] = useState(uniform?.id ?? '');
  const [note, setNote] = useState(uniformNote ?? '');
  const [tell, setTell] = useState(true);
  const [list, setList] = useState<Uniform[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { if (editing) api<{ uniforms: Uniform[] }>('/api/uniforms').then((r) => setList(r.uniforms)).catch(() => setList([])); }, [editing]);
  useEffect(() => { if (!editing) { setText(instructions ?? ''); setUid(uniform?.id ?? ''); setNote(uniformNote ?? ''); } }, [instructions, uniform, uniformNote, editing]);
  const picked = list.find((u) => u.id === uid) ?? (uniform?.id === uid ? uniform : null);
  const save = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api<{ told: number }>(`/api/events/${eventId}/instructions`, { method: 'PUT', body: { instructions: text.trim() || null, uniformId: uid || null, uniformNote: note.trim() || null, notify: tell } });
      show(r.told ? `Saved. ${r.told} booked ${r.told === 1 ? 'person was' : 'people were'} told.` : 'Saved.');
      setEditing(false); onSaved();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  const empty = !instructions && !uniform && !uniformNote;
  return (
    <section className="card ev-instr" aria-labelledby="ev-instr-h">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 id="ev-instr-h" style={{ margin: 0 }}>Crew instructions</h2>
        {!editing && <button type="button" className="btn ghost small" onClick={() => setEditing(true)}>{empty ? 'Add' : 'Edit'}</button>}
      </div>
      {!editing ? (
        empty ? <p className="muted small">Parking, load-in door, who to ask for, what to bring. Crew see it on their offer, My shifts and the reminder.</p> : (
          <div className="ev-instr-view">
            {(uniform || uniformNote) && (
              <div className="ev-uniform">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true"><path d="M8 3 4 5.5 2 10l3 1.5V21h14v-9.5l3-1.5-2-4.5L16 3c-.6 1.4-2.1 2.5-4 2.5S8.6 4.4 8 3Z" /></svg>
                <div><b>{uniform?.name ?? 'Uniform'}</b>{uniform?.description && <span className="muted small"> · {uniform.description}</span>}{uniformNote && <div className="small">{uniformNote}</div>}</div>
              </div>
            )}
            {instructions && <p className="ev-instr-text">{instructions}</p>}
          </div>
        )
      ) : (
        <div className="ev-instr-form">
          <label>Instructions for the crew
            <textarea rows={5} value={text} onChange={(e) => setText(e.target.value.slice(0, 4000))} placeholder={'Park in Lot C, enter through the loading dock on 5th St.\nAsk for Dana (stage manager) on arrival.\nBring gloves and a flashlight.'} />
          </label>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ flex: '1 1 200px' }}>Uniform
              <select aria-label="Uniform" value={uid} onChange={(e) => setUid(e.target.value)}>
                <option value="">No uniform set</option>
                {list.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
            </label>
            <label style={{ flex: '2 1 240px' }}>Uniform note for this event
              <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 300))} placeholder="e.g. Plus hi-vis vest on the dock" />
            </label>
          </div>
          {picked?.description && <p className="muted small" style={{ margin: 0 }}>{picked.name}: {picked.description}</p>}
          <p className="muted small" style={{ margin: 0 }}>Uniforms are set up on <Link href="/skills#uniforms">Positions &amp; rates › Uniforms</Link>.</p>
          <label className="check small"><input type="checkbox" checked={tell} onChange={(e) => setTell(e.target.checked)} /> Tell booked crew about the change</label>
          {err && <p className="cr-err" role="alert">{err}</p>}
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setEditing(false)}>Cancel</button>
            <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Event › Crew pay: one rate per position for everyone on this event. */
export function PositionPay({ eventId }: { eventId: string }) {
  type P = { role: string; standard: { hourly: number | null; day: number | null }; rate: { payType: 'hourly' | 'day'; rate: number } | null };
  const [list, setList] = useState<P[] | null>(null);
  const [edit, setEdit] = useState<Record<string, { payType: 'hourly' | 'day'; rate: string }>>({});
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api<{ positions: P[] }>(`/api/events/${eventId}/position-rates`).then((r) => setList(r.positions)).catch((e) => setErr(e.message)), [eventId]);
  useEffect(() => { load(); }, [load]);
  const save = async (p: P, clear = false) => {
    const e = edit[p.role];
    const n = clear ? null : Number(e?.rate);
    if (!clear && !(n! > 0)) { setErr('Enter a rate above $0, or use Standard.'); return; }
    setBusy(p.role); setErr('');
    try {
      await api(`/api/events/${eventId}/position-rates`, { method: 'PUT', body: { role: p.role, payType: e?.payType ?? p.rate?.payType ?? 'hourly', rate: n } });
      show(clear ? `${p.role} is back to the standard rate on this event.` : `${p.role}: ${money(n)}${(e?.payType ?? 'hourly') === 'day' ? '/day' : '/hr'} for everyone on this event.`);
      setEdit((x) => { const { [p.role]: _, ...rest } = x; return rest; });
      await load();
    } catch (er) { setErr((er as Error).message); } finally { setBusy(''); }
  };
  if (err && !list) return <p className="cr-err">{err}</p>;
  if (!list) return null;
  return (
    <section className="card">
      <h2>Pay by position</h2>
      <p className="muted small">One rate for everyone working a position on this event, in place of the standard rate. A person’s own rate (theirs on this event, or their standing rate) still wins, and so does a rate typed on a single shift.</p>
      {list.length === 0 ? <p className="muted">Add shifts to set pay by position.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Position</th><th>Standard</th><th>This event</th><th aria-label="Actions" /></tr></thead>
            <tbody>
              {list.map((p) => {
                const e = edit[p.role];
                const dirty = !!e;
                const t = e?.payType ?? p.rate?.payType ?? 'hourly';
                return (
                  <tr key={p.role}>
                    <td><b>{p.role}</b></td>
                    <td className="muted">{p.standard.hourly ? `${money(p.standard.hourly)}/hr` : '—'}{p.standard.day ? ` · ${money(p.standard.day)}/day` : ''}</td>
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        <select aria-label={`${p.role} pay type`} value={t} onChange={(x) => setEdit({ ...edit, [p.role]: { payType: x.target.value as 'hourly' | 'day', rate: e?.rate ?? (p.rate ? String(p.rate.rate) : '') } })} style={{ width: 'auto' }}>
                          <option value="hourly">Hourly</option><option value="day">Day rate</option>
                        </select>
                        <span className="cr-money"><i>$</i><input inputMode="decimal" aria-label={`${p.role} pay on this event`} value={e?.rate ?? (p.rate ? String(p.rate.rate) : '')} placeholder="Standard"
                          onChange={(x) => setEdit({ ...edit, [p.role]: { payType: t, rate: x.target.value.replace(/[^\d.]/g, '') } })} /><em>{t === 'day' ? '/day' : '/hr'}</em></span>
                      </div>
                    </td>
                    <td className="cr-acts">
                      {dirty && <button type="button" className="btn small primary" disabled={busy === p.role} onClick={() => save(p)}>Save</button>}
                      {p.rate && !dirty && <button type="button" className="cr-link" disabled={busy === p.role} onClick={() => save(p, true)}>Use standard</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {err && <p className="cr-err" role="alert">{err}</p>}
    </section>
  );
}

type Item = { id: string; at: string; kind: string; action: string; text: string; actor: string | null; subject: string | null; event: { id: string; name: string } | null };
const dayOf = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** The change log list, grouped by day. Used by the event History drawer and the Activity page. */
export function LogFeed({ url, showEvent }: { url: (p: URLSearchParams) => string; showEvent?: boolean }) {
  const [kind, setKind] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [kinds, setKinds] = useState<Record<string, string>>({});
  const [next, setNext] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const fetchPage = useCallback(async (before: number | null) => {
    const p = new URLSearchParams();
    if (kind) p.set('kind', kind);
    if (before) p.set('before', String(before));
    setBusy(true);
    try {
      const r = await api<{ items: Item[]; next: number | null; kinds: Record<string, string> }>(url(p));
      setKinds(r.kinds); setNext(r.next);
      setItems((x) => (before && x ? [...x, ...r.items] : r.items));
      setErr('');
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [kind, url]);
  useEffect(() => { setItems(null); fetchPage(null); }, [fetchPage]);
  let lastDay = '';
  return (
    <div className="log">
      <div className="log-kinds" role="group" aria-label="Show">
        <button type="button" aria-pressed={!kind} onClick={() => setKind('')}>Everything</button>
        {Object.entries(kinds).map(([k, label]) => <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)}>{label}</button>)}
      </div>
      {err && <p className="cr-err" role="alert">{err}</p>}
      {!items ? <p className="muted">Loading…</p> : items.length === 0 ? <p className="muted">Nothing recorded yet.</p> : (
        <ol className="log-list">
          {items.map((it) => {
            const d = dayOf(it.at);
            const head = d !== lastDay ? d : null;
            lastDay = d;
            return [
              head ? <li key={`d-${it.id}`} className="log-day">{head}</li> : null,
              <li key={it.id} className={`log-item ${it.kind}`}>
                <span className="log-ico" aria-hidden="true" />
                <span className="log-text">{it.text}{showEvent && it.event && <> · <Link href={`/events/${it.event.id}`}>{it.event.name}</Link></>}</span>
                <time dateTime={it.at}>{timeOf(it.at)}</time>
              </li>,
            ];
          })}
        </ol>
      )}
      {next && <button type="button" className="btn" disabled={busy} onClick={() => fetchPage(next)}>{busy ? 'Loading…' : 'Show older'}</button>}
    </div>
  );
}

export function EventHistory({ eventId }: { eventId: string }) {
  const url = useCallback((p: URLSearchParams) => `/api/events/${eventId}/history?${p}`, [eventId]);
  return (
    <div style={{ marginTop: 12 }}>
      <p className="muted small">Every change on this event: who added, removed or declined crew, who clocked people in and out, time edits, shift and pay changes.</p>
      <LogFeed url={url} />
    </div>
  );
}

/** Positions & rates › Uniforms */
export function UniformsCard() {
  const [list, setList] = useState<Uniform[] | null>(null);
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [edit, setEdit] = useState<Uniform | null>(null);
  const [err, setErr] = useState('');
  const load = () => api<{ uniforms: Uniform[] }>('/api/uniforms').then((r) => setList(r.uniforms)).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const add = async () => {
    if (!name.trim()) return;
    setErr('');
    try { await api('/api/uniforms', { body: { name: name.trim(), description: desc.trim() || null } }); setName(''); setDesc(''); show('Uniform added.'); load(); } catch (e) { setErr((e as Error).message); }
  };
  const saveEdit = async () => {
    if (!edit) return;
    try { await api(`/api/uniforms/${edit.id}`, { method: 'PATCH', body: { name: edit.name.trim(), description: edit.description?.trim() || null } }); setEdit(null); show('Saved.'); load(); } catch (e) { setErr((e as Error).message); }
  };
  const remove = async (u: Uniform) => {
    if (!(await askConfirm(`Delete the uniform “${u.name}”?${u.events ? ` ${u.events} event${u.events === 1 ? '' : 's'} using it will show no uniform.` : ''}`))) return;
    try { await api(`/api/uniforms/${u.id}`, { method: 'DELETE' }); load(); } catch (e) { setErr((e as Error).message); }
  };
  return (
    <section className="card" id="uniforms">
      <h2>Uniforms</h2>
      <p className="muted small">Dress codes you pick on each event (Crew instructions). Crew see the uniform on their offer, My shifts and the reminder.</p>
      {list && list.length > 0 && (
        <ul className="uni-list">
          {list.map((u) => (
            <li key={u.id}>
              {edit?.id === u.id ? (
                <div className="row" style={{ gap: 8, flexWrap: 'wrap', width: '100%' }}>
                  <input aria-label="Uniform name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value.slice(0, 60) })} style={{ flex: '1 1 160px' }} />
                  <input aria-label="What it means" value={edit.description ?? ''} onChange={(e) => setEdit({ ...edit, description: e.target.value.slice(0, 600) })} style={{ flex: '3 1 260px' }} />
                  <button type="button" className="btn small" onClick={() => setEdit(null)}>Cancel</button>
                  <button type="button" className="btn small primary" onClick={saveEdit}>Save</button>
                </div>
              ) : (
                <>
                  <div><b>{u.name}</b>{u.description && <span className="muted small"> · {u.description}</span>}{u.events ? <span className="muted small"> · on {u.events} event{u.events === 1 ? '' : 's'}</span> : null}</div>
                  <span className="row" style={{ gap: 10 }}>
                    <button type="button" className="cr-link" onClick={() => setEdit(u)}>Edit</button>
                    <button type="button" className="cr-link danger" onClick={() => remove(u)}>Delete</button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
        <input aria-label="New uniform name" value={name} onChange={(e) => setName(e.target.value.slice(0, 60))} placeholder="e.g. Show blacks" style={{ flex: '1 1 160px' }} />
        <input aria-label="What it means" value={desc} onChange={(e) => setDesc(e.target.value.slice(0, 600))} placeholder="Black shirt, black pants, closed-toe black shoes, no logos" style={{ flex: '3 1 260px' }} />
        <button type="button" className="btn primary" onClick={add} disabled={!name.trim()}>Add uniform</button>
      </div>
      {err && <p className="cr-err" role="alert">{err}</p>}
    </section>
  );
}

/** Positions & rates: old free-text skills on crew that aren't positions yet. */
export function LeftoverSkills() {
  const [d, setD] = useState<{ leftovers: { name: string; people: number }[]; positions: string[] } | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const load = () => api<NonNullable<typeof d>>('/api/positions/leftovers').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!d || d.leftovers.length === 0) return null;
  const act = async (name: string, action: 'map' | 'make' | 'remove') => {
    setErr('');
    try {
      const r = await api<{ people: number; to: string | null }>('/api/positions/leftovers', { body: { name, action, to: pick[name] } });
      show(action === 'remove' ? `Removed “${name}” from ${r.people} ${r.people === 1 ? 'person' : 'people'}.` : `${r.people} ${r.people === 1 ? 'person' : 'people'} now have ${r.to}.`);
      load();
    } catch (e) { setErr((e as Error).message); }
  };
  return (
    <section className="card" id="tidy">
      <h2>Old skills to tidy up</h2>
      <p className="muted small">These were typed on crew profiles before positions came from this list. Swap each for a position, make it a position, or remove it. Crew can’t pick their own positions; coordinators set them on the crew profile.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Old skill</th><th>People</th><th>Use this position instead</th><th aria-label="Actions" /></tr></thead>
          <tbody>
            {d.leftovers.map((l) => (
              <tr key={l.name}>
                <td><b>{l.name}</b></td>
                <td>{l.people}</td>
                <td>
                  <select aria-label={`Position to use instead of ${l.name}`} value={pick[l.name] ?? ''} onChange={(e) => setPick({ ...pick, [l.name]: e.target.value })} style={{ width: 'auto' }}>
                    <option value="">Pick a position…</option>
                    {d.positions.map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </td>
                <td className="cr-acts">
                  <button type="button" className="btn small primary" disabled={!pick[l.name]} onClick={() => act(l.name, 'map')}>Swap</button>
                  <button type="button" className="cr-link" onClick={() => act(l.name, 'make')}>Make it a position</button>
                  <button type="button" className="cr-link danger" onClick={() => act(l.name, 'remove')}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {err && <p className="cr-err" role="alert">{err}</p>}
    </section>
  );
}
