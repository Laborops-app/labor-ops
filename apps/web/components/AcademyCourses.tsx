'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Panel from '@/components/Panel';
import Modal from '@/components/Modal';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';

type Course = { id: number; title: string; url: string };
type Invite = { id: string; user_id: string; name: string; email: string; created_at: string; last_sent_at: string; send_count: number; completed_at: string | null; coursesDone: number; done: boolean };
type Group = { id: string; name: string; description: string | null; url: string; courses: Course[]; invites: Invite[] };
type StaffData = { siteUrl: string | null; lastSync: string | null; groups: Group[] };
type MyGroup = { id: string; invite_id: string; name: string; description: string | null; url: string; courses: Course[]; created_at: string; completed_at: string | null; coursesDone: number; done: boolean; signupUrl: string | null; doneCourseIds: number[] };
type CrewData = { siteUrl: string | null; email: string; groups: MyGroup[] };
type Person = { id: string; name: string; email: string; role: string; active: boolean };
type CrewGroup = { id: string; name: string; members: { id: string }[] };

const day = (iso: string) => fmtDate(iso.slice(0, 10));

/** Ask people to complete one course group: pick people, a crew group, or everyone. */
function InviteDialog({ g, onClose, onSent }: { g: Group; onClose: () => void; onSent: (msg: string) => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [crewGroups, setCrewGroups] = useState<CrewGroup[]>([]);
  const [mode, setMode] = useState<'people' | 'group' | 'everyone'>('people');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [crewGroupId, setCrewGroupId] = useState('');
  const [q, setQ] = useState('');
  const [note, setNote] = useState('');
  const [text, setText] = useState(false);
  const [resend, setResend] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ crew: Person[] }>('/api/crew').then((r) => setPeople(r.crew.filter((p) => p.active))).catch((e) => setError(e.message));
    api<{ groups: CrewGroup[] }>('/api/crew-groups').then((r) => setCrewGroups(r.groups)).catch(() => {});
  }, []);
  const by = new Map(g.invites.map((i) => [i.user_id, i]));
  const needle = q.trim().toLowerCase();
  const shown = (people ?? []).filter((p) => !needle || `${p.name} ${p.email}`.toLowerCase().includes(needle));
  const toggle = (id: string) => {
    const n = new Set(picked);
    if (n.has(id)) n.delete(id); else n.add(id);
    setPicked(n);
  };
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api<{ sent: number; skippedDone: number; skippedInvited: number }>(`/api/academy/groups/${g.id}/invite`, {
        body: { userIds: mode === 'people' ? [...picked] : [], crewGroupId: mode === 'group' && crewGroupId ? crewGroupId : undefined, everyone: mode === 'everyone', note: note || null, text, resend },
      });
      const extra = [r.skippedDone ? `${r.skippedDone} already completed it` : '', r.skippedInvited ? `${r.skippedInvited} were already asked (tick “Send again” to remind them)` : ''].filter(Boolean).join('; ');
      onSent(`Sent ${g.name} to ${r.sent} ${r.sent === 1 ? 'person' : 'people'}.${extra ? ` ${extra}.` : ''}`);
    } catch (x) {
      setError((x as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const ready = mode === 'everyone' || (mode === 'group' ? !!crewGroupId : picked.size > 0);
  return (
    <Modal title={`Send “${g.name}” to crew`} onClose={onClose} wide>
      <form onSubmit={send}>
        {error && <Banner onClose={() => setError('')}>{error}</Banner>}
        <p className="muted small">
          Each person gets the sign-up link (with the email address to use) and the course link, in the app, by push and by email. When they finish, the academy certificate lands on their profile and this list updates.
        </p>
        <div className="phase-tabs" role="tablist" aria-label="Who to send it to" style={{ marginBottom: 10 }}>
          {([['people', 'Pick people'], ['group', 'A crew group'], ['everyone', 'All crew']] as const).map(([k, l]) => (
            <button key={k} type="button" role="tab" aria-selected={mode === k} className={mode === k ? 'tab on' : 'tab'} onClick={() => setMode(k)}>{l}</button>
          ))}
        </div>
        {mode === 'people' && (
          <>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name or email" aria-label="Search crew" />
            <div className="pick-list" role="group" aria-label="Crew">
              {!people ? <div className="muted small">Loading…</div> : shown.length === 0 ? <div className="muted small">No one matches.</div> : shown.map((p) => {
                const i = by.get(p.id);
                return (
                  <label key={p.id} className="check pick-row">
                    <input type="checkbox" checked={picked.has(p.id)} onChange={() => toggle(p.id)} disabled={!!i?.done} />
                    <span>{p.name} <span className="muted small">{p.email}</span></span>
                    <span className="muted small" style={{ marginLeft: 'auto' }}>{i ? (i.done ? 'Completed' : `Asked ${day(i.last_sent_at)}`) : p.role === 'crew' ? '' : p.role === 'manager' ? 'Coordinator' : 'Admin'}</span>
                  </label>
                );
              })}
            </div>
            <div className="row space small" style={{ marginTop: 6 }}>
              <span className="muted">{picked.size} picked</span>
              <span className="row">
                <button type="button" className="btn ghost small" onClick={() => setPicked(new Set(shown.filter((p) => p.role === 'crew' && !by.get(p.id)).map((p) => p.id)))}>Pick everyone not asked yet</button>
                {picked.size > 0 && <button type="button" className="btn ghost small" onClick={() => setPicked(new Set())}>Clear</button>}
              </span>
            </div>
          </>
        )}
        {mode === 'group' && (
          <label>
            Crew group
            <select value={crewGroupId} onChange={(e) => setCrewGroupId(e.target.value)} required>
              <option value="">Choose a group…</option>
              {crewGroups.map((x) => <option key={x.id} value={x.id}>{x.name} ({x.members.length})</option>)}
            </select>
          </label>
        )}
        {mode === 'everyone' && <p className="small">Everyone with the crew role who is active. People who already completed it are skipped.</p>}
        <label>
          Note to include (optional)
          <textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Please finish this before the next load-in." />
        </label>
        <label className="check"><input type="checkbox" checked={text} onChange={(e) => setText(e.target.checked)} /> Also send a text message (only to crew who accept texts)</label>
        <label className="check"><input type="checkbox" checked={resend} onChange={(e) => setResend(e.target.checked)} /> Send again to people already asked</label>
        <div className="acts">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={busy || !ready}>{busy ? 'Sending…' : 'Send'}</button>
        </div>
      </form>
    </Modal>
  );
}

function StaffView({ isAdmin }: { isAdmin: boolean }) {
  const [d, setD] = useState<StaffData | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');
  const [inviting, setInviting] = useState<Group | null>(null);
  const load = () => api<StaffData>('/api/academy/courses').then(setD).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const run = async (key: string, fn: () => Promise<string>) => {
    setError(''); setOk(''); setBusy(key);
    try { setOk(await fn()); await load(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const sync = () => run('sync', async () => {
    const r = await api<{ groups: number; courses: number; removed: number }>('/api/academy/sync', { body: {} });
    return `Synced ${r.groups} course group${r.groups === 1 ? '' : 's'} (${r.courses} course${r.courses === 1 ? '' : 's'}) from the academy.${r.removed ? ` ${r.removed} removed.` : ''}`;
  });
  if (!d) return error ? <Banner>{error}</Banner> : null;
  return (
    <>
      <div className="row space" style={{ alignItems: 'flex-end' }}>
        <h2 className="panel-group-title" style={{ margin: '0.4rem 0 0.6rem' }}>Online courses · Upstage Academy</h2>
        {d.siteUrl && (
          <span className="row small" style={{ marginBottom: 6 }}>
            {d.lastSync && <span className="muted">Synced {new Date(d.lastSync).toLocaleString()}</span>}
            <button className="btn small" disabled={!!busy} onClick={sync}>{busy === 'sync' ? 'Syncing…' : d.groups.length ? 'Sync again' : 'Sync course groups'}</button>
          </span>
        )}
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      {!d.siteUrl ? (
        <section className="card">
          <p className="small" style={{ margin: 0 }}>
            Connect Upstage Academy to send its course groups to crew.{' '}
            {isAdmin ? <>Add the academy&apos;s web address under <Link href="/integrations">Integrations → Upstage Academy</Link>.</> : 'Ask an admin to add the academy under Integrations.'}
          </p>
        </section>
      ) : d.groups.length === 0 ? (
        <Empty>No course groups yet. Press Sync course groups to bring them in from the academy.</Empty>
      ) : (
        d.groups.map((g) => {
          const done = g.invites.filter((i) => i.done).length;
          return (
            <Panel
              key={g.id}
              id={`academy-${g.id}`}
              title={g.name}
              summary={`${g.courses.length} course${g.courses.length === 1 ? '' : 's'}${g.description ? ` · ${g.description}` : ''}`}
              status={g.invites.length ? <span className={`chip${done === g.invites.length ? ' open' : ''}`}>{done}/{g.invites.length} completed</span> : <span className="chip">Not sent yet</span>}
            >
              <div className="row space" style={{ alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                <ol className="course-list">
                  {g.courses.map((c) => <li key={c.id}><a href={c.url} target="_blank" rel="noreferrer">{c.title}</a></li>)}
                  {g.courses.length === 0 && <li className="muted small">No published courses in this group yet.</li>}
                </ol>
                <span className="row">
                  <a className="btn ghost small" href={g.url} target="_blank" rel="noreferrer">View on academy</a>
                  <button className="btn primary small" onClick={() => setInviting(g)}>Send to crew</button>
                </span>
              </div>
              {g.invites.length > 0 && (
                <div className="table-wrap" style={{ marginTop: 12 }}>
                  <table className="table">
                    <thead><tr><th>Crew member</th><th>Progress</th><th>Asked</th><th></th></tr></thead>
                    <tbody>
                      {g.invites.map((i) => (
                        <tr key={i.id}>
                          <td>{i.name}<div className="muted small">{i.email}</div></td>
                          <td>
                            {i.done ? (
                              <span className="chip open">Completed{i.completed_at ? ` ${day(i.completed_at)}` : ''}</span>
                            ) : (
                              <>
                                {i.coursesDone}/{g.courses.length} courses
                                <span className="mini-bar" aria-hidden="true"><i style={{ width: `${g.courses.length ? Math.round((i.coursesDone / g.courses.length) * 100) : 0}%` }} /></span>
                              </>
                            )}
                          </td>
                          <td className="small">{day(i.last_sent_at)}{i.send_count > 1 ? <span className="muted"> · sent {i.send_count}×</span> : null}</td>
                          <td>
                            {!i.done && (
                              <span className="row">
                                <button className="btn ghost small" disabled={!!busy} onClick={() => run(i.id, async () => { await api(`/api/academy/invites/${i.id}/remind`, { body: {} }); return `Reminder sent to ${i.name}.`; })}>Remind</button>
                                <button className="btn ghost small danger" disabled={!!busy} onClick={() => confirm(`Stop asking ${i.name} to complete ${g.name}?`) && run(i.id, async () => { await api(`/api/academy/invites/${i.id}`, { method: 'DELETE' }); return `${i.name} removed from ${g.name}.`; })}>Remove</button>
                              </span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          );
        })
      )}
      {inviting && <InviteDialog g={inviting} onClose={() => setInviting(null)} onSent={(m) => { setInviting(null); setOk(m); load(); }} />}
    </>
  );
}

function CrewView() {
  const [d, setD] = useState<CrewData | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { api<CrewData>('/api/academy/courses').then(setD).catch((e) => setError(e.message)); }, []);
  if (!d) return error ? <Banner>{error}</Banner> : null;
  if (!d.groups.length) return null;
  return (
    <>
      <h2 className="panel-group-title">Online courses · Upstage Academy</h2>
      <p className="muted small">Sign up on the academy with <b>{d.email}</b> so your certificates come back to your LaborOps profile.</p>
      {d.groups.map((g) => (
        <section className="card" key={g.invite_id}>
          <div className="row space" style={{ alignItems: 'flex-start' }}>
            <div>
              <h2 style={{ marginBottom: 2 }}>{g.name}</h2>
              {g.description && <div className="muted small">{g.description}</div>}
            </div>
            {g.done ? <span className="chip open">Completed</span> : <span className="chip">{g.coursesDone}/{g.courses.length} done</span>}
          </div>
          <ol className="course-list">
            {g.courses.map((c) => (
              <li key={c.id} className={g.done || g.doneCourseIds.includes(c.id) ? 'done' : ''}>
                <a href={c.url} target="_blank" rel="noreferrer">{c.title}</a>
                {(g.done || g.doneCourseIds.includes(c.id)) && <span className="sr-only"> (completed)</span>}
              </li>
            ))}
          </ol>
          {!g.done && (
            <div className="row">
              {g.signupUrl && g.coursesDone === 0 && <a className="btn primary" href={g.signupUrl} target="_blank" rel="noreferrer">Create academy account</a>}
              <a className="btn" href={g.url} target="_blank" rel="noreferrer">Open the courses</a>
            </div>
          )}
        </section>
      ))}
    </>
  );
}

/** Upstage Academy course groups on the Trainings page. */
export default function AcademyCourses({ role }: { role: string }) {
  return role === 'crew' ? <CrewView /> : <StaffView isAdmin={role === 'admin'} />;
}
