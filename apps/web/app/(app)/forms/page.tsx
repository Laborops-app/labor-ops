'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Shell from '@/components/Shell';
import { Banner, Empty } from '@/components/ui';
import { api, type Me } from '@/lib/api';
import FormBuilder from '@/components/docs/FormBuilder';
import PdfFieldEditor from '@/components/docs/PdfFieldEditor';
import { DEFAULT_SETTINGS, FORM_PRESETS, newId, type DocSettings, type FormField, type PdfField, type Template } from '@/components/docs/types';

type Settings = { onboardingOn: boolean; onboardingBlock: boolean; onboardingRemind: boolean; formsOn: boolean };
type Progress = { total: number; people: { id: string; name: string; done: number; left: string[]; reminded_at: string | null; finished_at: string | null }[] };
type Draft = { id: string | null; name: string; kind: 'pdf' | 'form'; purpose: 'onboarding' | 'shift'; fields: (PdfField | FormField)[]; settings: DocSettings };
const day = (iso: string) => new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });
const toBase64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] ?? ''); r.onerror = () => rej(new Error('That file couldn’t be read.')); r.readAsDataURL(f); });
const summary = (s: DocSettings) =>
  [s.who === 'lead' ? 'The lead' : s.who === 'everyone' ? 'Everyone on the shift' : 'A coordinator', s.when === 'clock_in' ? 'at clock-in' : s.when === 'clock_out' ? 'before clock-out' : 'any time',
    s.useOn === 'all' ? 'every shift' : s.useOn === 'days' ? `days named “${s.dayContains}”` : `roles: ${s.roles.join(', ')}`].join(' · ');

function Body({ me }: { me: Me }) {
  const [tab, setTab] = useState<'onboarding' | 'shift'>('onboarding');
  const [st, setSt] = useState<Settings | null>(null);
  const [list, setList] = useState<Template[]>([]);
  const [prog, setProg] = useState<Progress | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const isAdmin = me.role === 'admin';
  const load = useCallback(() => {
    api<Settings>('/api/docs/settings').then(setSt).catch((e) => setError(e.message));
    api<{ templates: Template[] }>('/api/docs/templates').then((r) => setList(r.templates)).catch((e) => setError(e.message));
    api<Progress>('/api/docs/onboarding/progress').then(setProg).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn: () => Promise<unknown>, msg?: string) => {
    setError(''); setOk(''); setBusy(true);
    try { await fn(); if (msg) setOk(msg); load(); return true; } catch (e) { setError((e as Error).message); return false; } finally { setBusy(false); }
  };
  const setting = (p: Partial<Settings>, msg: string) => run(() => api('/api/docs/settings', { method: 'PUT', body: p }), msg);
  const upload = async (f: File) => {
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) return setError('Choose a PDF file. To use a Word document, save it as a PDF first.');
    if (f.size > 10 * 1024 * 1024) return setError('That PDF is over 10 MB. Save a smaller copy and try again.');
    setError(''); setBusy(true);
    try {
      const name = f.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim() || 'Document';
      const r = await api<{ id: string }>('/api/docs/templates', { body: { name, kind: 'pdf', purpose: tab, file: await toBase64(f), fileName: f.name, fields: [] } });
      setDraft({ id: r.id, name, kind: 'pdf', purpose: tab, fields: [], settings: DEFAULT_SETTINGS });
      load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!draft) return;
    if (!draft.name.trim()) return setError('Give it a name.');
    if (draft.kind === 'form' && !draft.fields.length) return setError('Add at least one question.');
    if (draft.kind === 'form' && (draft.fields as FormField[]).some((f) => !f.label.trim())) return setError('Every question needs its wording.');
    if (draft.purpose === 'shift' && draft.settings.useOn === 'days' && !draft.settings.dayContains.trim()) return setError('Type the day name this form is used on, like “Load in”.');
    if (draft.purpose === 'shift' && draft.settings.useOn === 'roles' && !draft.settings.roles.length) return setError('Type at least one role this form is used on.');
    const body = { name: draft.name.trim(), fields: draft.fields, settings: draft.settings };
    const done = await run(
      () => (draft.id ? api(`/api/docs/templates/${draft.id}`, { method: 'PUT', body }) : api('/api/docs/templates', { body: { ...body, kind: draft.kind, purpose: draft.purpose } })),
      `${draft.name.trim()} saved.`,
    );
    if (done) setDraft(null);
  };
  const order = (i: number, by: number, items: Template[]) => {
    const next = [...items];
    const j = i + by;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    run(() => api('/api/docs/templates-order', { method: 'PUT', body: { ids: next.map((t) => t.id) } }));
  };
  const starter = () =>
    run(async () => {
      const r = await api<{ added: string[]; skipped: number }>('/api/docs/starter-packet', { body: {} });
      setOk(r.added.length ? `Added ${r.added.length} document${r.added.length === 1 ? '' : 's'}: ${r.added.join(', ')}. Open each one to read it; turn off or remove any you don’t want.` : 'The starter packet is already in your list.');
    });
  if (!st) return <p className="muted">Loading…</p>;

  // ---------- editing one document or form ----------
  if (draft) {
    const s = draft.settings;
    const setS = (p: Partial<DocSettings>) => setDraft({ ...draft, settings: { ...s, ...p } });
    return (
      <>
        <p className="small" style={{ margin: '0 0 12px' }}><button type="button" className="cs-link" onClick={() => { setDraft(null); setError(''); }}>← Back to Forms &amp; documents</button></p>
        {error && <Banner onClose={() => setError('')}>{error}</Banner>}
        <section className="card">
          <h2>{draft.id ? 'Edit' : 'New'} {draft.kind === 'pdf' ? 'PDF to sign' : 'form'}</h2>
          <div className="grid-form">
            <label>Name<input type="text" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={120} required /></label>
            {draft.purpose === 'onboarding' ? (
              <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={s.required} onChange={(e) => setS({ required: e.target.checked })} /> Required to finish onboarding</label>
            ) : (
              <>
                <label>Who fills it in
                  <select value={s.who} onChange={(e) => setS({ who: e.target.value as DocSettings['who'] })}>
                    <option value="lead">The lead on the shift (once per shift)</option>
                    <option value="everyone">Everyone on the shift</option>
                    <option value="coordinator">A coordinator, from the event page</option>
                  </select>
                </label>
                <label>When
                  <select value={s.when} onChange={(e) => setS({ when: e.target.value as DocSettings['when'], blockClockIn: e.target.value === 'clock_in' ? s.blockClockIn : false })}>
                    <option value="any">Any time during the shift</option>
                    <option value="clock_in">At clock-in</option>
                    <option value="clock_out">Before clock-out</option>
                  </select>
                </label>
                <label>Use on
                  <select value={s.useOn} onChange={(e) => setS({ useOn: e.target.value as DocSettings['useOn'] })}>
                    <option value="all">Every shift</option>
                    <option value="days">Shifts on days with a certain name</option>
                    <option value="roles">Shifts for certain roles</option>
                  </select>
                </label>
                {s.useOn === 'days' && <label>Day name contains<input type="text" value={s.dayContains} onChange={(e) => setS({ dayContains: e.target.value })} placeholder="Load in" maxLength={60} /></label>}
                {s.useOn === 'roles' && <label>Roles (separate with commas)<input type="text" defaultValue={s.roles.join(', ')} onBlur={(e) => setS({ roles: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} placeholder="Rigger, Stagehand" /></label>}
              </>
            )}
          </div>
          {draft.purpose === 'shift' && (
            <div className="row" style={{ gap: 18, flexWrap: 'wrap', marginTop: 8 }}>
              {draft.kind === 'form' && <label className="check"><input type="checkbox" checked={s.alertOnNo} onChange={(e) => setS({ alertOnNo: e.target.checked })} /> A “No” answer alerts the coordinators</label>}
              {s.when === 'clock_in' && s.who !== 'coordinator' && <label className="check"><input type="checkbox" checked={s.blockClockIn} onChange={(e) => setS({ blockClockIn: e.target.checked })} /> Can’t clock in until it’s done</label>}
            </div>
          )}
        </section>
        <section className="card">
          <h2>{draft.kind === 'pdf' ? 'Where people fill in and sign' : 'Questions'}</h2>
          {draft.kind === 'pdf' && draft.id ? (
            <>
              <p className="muted small" style={{ marginTop: 0 }}>Signature, date and the signer’s name fill themselves in when someone signs. Add text boxes and checkboxes for anything they need to type or tick.</p>
              <PdfFieldEditor url={`/api/docs/templates/${draft.id}/file`} fields={draft.fields as PdfField[]} onChange={(f) => setDraft({ ...draft, fields: f })} />
            </>
          ) : (
            <FormBuilder fields={draft.fields as FormField[]} onChange={(f) => setDraft({ ...draft, fields: f })} />
          )}
        </section>
        <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
          <button type="button" className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
          <button type="button" className="btn" onClick={() => { setDraft(null); setError(''); }}>Cancel</button>
          {draft.id && <Link className="btn ghost" href={`/my-documents/${draft.id}?preview=1`} target="_blank">Preview as crew</Link>}
          {draft.kind === 'pdf' && !(draft.fields as PdfField[]).some((f) => f.type === 'signature') && <span className="muted small" style={{ alignSelf: 'center' }}>No signature field yet: people will only confirm they’ve read it.</span>}
        </div>
      </>
    );
  }

  // ---------- the lists ----------
  const items = list.filter((t) => t.purpose === tab);
  const on = tab === 'onboarding' ? st.onboardingOn : st.formsOn;
  const waiting = (prog?.people ?? []).filter((p) => p.left.length);
  return (
    <>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}
      <div className="seg" role="tablist" aria-label="Forms and documents">
        <button type="button" role="tab" aria-selected={tab === 'onboarding'} className={tab === 'onboarding' ? 'seg-btn on' : 'seg-btn'} onClick={() => setTab('onboarding')}>Onboarding packet</button>
        <button type="button" role="tab" aria-selected={tab === 'shift'} className={tab === 'shift' ? 'seg-btn on' : 'seg-btn'} onClick={() => setTab('shift')}>Shift forms &amp; checklists</button>
      </div>
      <section className="card">
        <label className="qrp-toggle">
          <input type="checkbox" checked={on} disabled={!isAdmin || busy} onChange={(e) => setting(tab === 'onboarding' ? { onboardingOn: e.target.checked } : { formsOn: e.target.checked }, e.target.checked ? 'Turned on.' : 'Turned off. Signed copies are kept.')} />
          <span>
            <b>{tab === 'onboarding' ? 'Use an onboarding packet' : 'Use forms and checklists on shifts'}</b>
            <span className="muted small">
              {tab === 'onboarding'
                ? 'New crew fill in and sign these once, in LaborOps, on their phone or computer. The signed PDFs are kept on their profile.'
                : 'Crew fill these in on their shift (a load-in safety check, an incident report). Each completed form becomes a signed PDF on the event.'}
              {!isAdmin && ' Only an admin can turn this on or off.'}
            </span>
          </span>
        </label>
        {tab === 'onboarding' && on && (
          <div className="row" style={{ gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
            <label className="check"><input type="checkbox" checked={st.onboardingBlock} disabled={!isAdmin} onChange={(e) => setting({ onboardingBlock: e.target.checked }, e.target.checked ? 'Offers are held until onboarding is done.' : 'Offers go out whether or not onboarding is done.')} /> Hold offers until onboarding is done</label>
            <label className="check"><input type="checkbox" checked={st.onboardingRemind} disabled={!isAdmin} onChange={(e) => setting({ onboardingRemind: e.target.checked }, e.target.checked ? 'People are reminded every 2 days.' : 'Automatic reminders are off.')} /> Remind people every 2 days until done</label>
          </div>
        )}
      </section>
      <section className="card">
        <div className="row space" style={{ flexWrap: 'wrap', gap: 8 }}>
          <h2 style={{ margin: 0 }}>{tab === 'onboarding' ? 'Steps in the packet' : 'Forms'}</h2>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary small" disabled={busy} onClick={() => file.current?.click()}>+ Upload a PDF</button>
            <input ref={file} type="file" accept="application/pdf,.pdf" className="sr-only" aria-label="Upload a PDF" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f); e.target.value = ''; }} />
            <button type="button" className="btn small" onClick={() => setDraft({ id: null, name: '', kind: 'form', purpose: tab, fields: [], settings: DEFAULT_SETTINGS })}>+ Build a form</button>
            {tab === 'onboarding' && (
              <button type="button" className="btn small" disabled={busy} title="Five ready-made PDFs with the fill-in and signature fields already placed" onClick={starter}>+ Add the starter packet</button>
            )}
          </div>
        </div>
        {tab === 'onboarding' && (
          <p className="muted small" style={{ margin: '10px 0 0' }}>
            The starter packet is general wording, not legal advice: have whoever handles your HR or legal matters read it before you use it. It leaves out tax forms (W-4, W-9, I-9) and bank details; upload the official forms yourself, and collect bank details through your payroll provider.
          </p>
        )}
        {tab === 'shift' && (
          <p className="small" style={{ margin: '10px 0 0' }}>
            <span className="muted">Start from a template: </span>
            {FORM_PRESETS.map((p, i) => (
              <span key={p.name}>{i > 0 && ' · '}<button type="button" className="cs-link" onClick={() => setDraft({ id: null, name: p.name, kind: 'form', purpose: 'shift', settings: { ...DEFAULT_SETTINGS, ...p.settings }, fields: p.fields.map(([type, label, required]) => ({ id: newId(), type, label, required: required ?? true })) })}>{p.name}</button></span>
            ))}
          </p>
        )}
        {items.length === 0 ? (
          <Empty>{tab === 'onboarding' ? 'Nothing in the packet yet. Add the starter packet (five ready-made documents), upload your own PDF (a handbook, a W-9, a waiver), or build a form.' : 'No forms yet. Build one, start from a template, or upload a PDF.'}</Empty>
        ) : (
          <ul className="doc-list">
            {items.map((t, i) => (
              <li key={t.id} className={t.active ? '' : 'off'}>
                {tab === 'onboarding' && <span className="doc-n">{i + 1}</span>}
                <div className="doc-main">
                  <b>{t.name}</b>
                  <span className="muted small">
                    {t.kind === 'pdf' ? `PDF · ${t.page_count ?? '?'} page${t.page_count === 1 ? '' : 's'} · ${(t.fields as PdfField[]).length} field${t.fields.length === 1 ? '' : 's'}` : `Form · ${t.fields.length} question${t.fields.length === 1 ? '' : 's'}`}
                    {tab === 'shift' ? ` · ${summary(t.settings)}` : ''} · completed {t.completed ?? 0} time{t.completed === 1 ? '' : 's'}
                  </span>
                </div>
                {tab === 'onboarding' && <span className="chip">{t.settings.required ? 'Required' : 'Optional'}</span>}
                {!t.active && <span className="chip">Off</span>}
                <span className="doc-acts">
                  {tab === 'onboarding' && <><button type="button" className="btn ghost small" disabled={i === 0} onClick={() => order(i, -1, items)} aria-label={`Move ${t.name} up`}>↑</button><button type="button" className="btn ghost small" disabled={i === items.length - 1} onClick={() => order(i, 1, items)} aria-label={`Move ${t.name} down`}>↓</button></>}
                  <button type="button" className="btn small" onClick={() => setDraft({ id: t.id, name: t.name, kind: t.kind, purpose: t.purpose, fields: t.fields, settings: t.settings })}>Edit</button>
                  <button type="button" className="btn ghost small" onClick={() => run(() => api(`/api/docs/templates/${t.id}`, { method: 'PUT', body: { active: !t.active } }), t.active ? `${t.name} is off.` : `${t.name} is back on.`)}>{t.active ? 'Turn off' : 'Turn on'}</button>
                  <button type="button" className="btn ghost small danger" onClick={() => confirm(`Remove “${t.name}”? Copies people already signed are kept.`) && run(() => api(`/api/docs/templates/${t.id}`, { method: 'DELETE' }), `${t.name} removed.`)}>Remove</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {tab === 'onboarding' && on && prog && prog.total > 0 && (
        <section className="card">
          <div className="row space" style={{ flexWrap: 'wrap', gap: 8 }}>
            <h2 style={{ margin: 0 }}>Who still has steps to do</h2>
            {waiting.length > 0 && <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api('/api/docs/onboarding/remind', { body: {} }), `Reminded ${waiting.length} ${waiting.length === 1 ? 'person' : 'people'}.`)}>Remind all {waiting.length}</button>}
          </div>
          {waiting.length === 0 ? <p className="small" style={{ color: 'var(--good)' }}>Everyone has finished onboarding.</p> : (
            <ul className="doc-list">
              {waiting.map((p) => (
                <li key={p.id}>
                  <div className="doc-main"><Link href={`/crew/${p.id}`}><b>{p.name}</b></Link><span className="muted small">Left: {p.left.join(', ')}{p.reminded_at ? ` · reminded ${day(p.reminded_at)}` : ''}</span></div>
                  <span className="cs-st wait">{p.done} of {prog.total}</span>
                  <button type="button" className="btn ghost small" disabled={busy} onClick={() => run(() => api('/api/docs/onboarding/remind', { body: { userId: p.id } }), `Reminded ${p.name}.`)}>Remind</button>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small" style={{ marginBottom: 0 }}>{prog.people.length - waiting.length} of {prog.people.length} crew have finished. Signed copies are on each person’s profile.</p>
        </section>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{(me) => <Body me={me} />}</Shell>;
}
