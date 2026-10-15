'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import Shell from '@/components/Shell';
import Modal from '@/components/Modal';
import TopbarAction, { PlusIcon, EditIcon, SearchIcon, avClass, initialsOf } from '@/components/TopbarAction';
import { Banner, Empty } from '@/components/ui';
import { api, fmtDate } from '@/lib/api';
import { STAGES, cityOf, stageLabel, type Stage } from '@/lib/crm';
import { ChevronUpIcon, KanbanIcon, ListIcon, PinIcon, PlusLineIcon } from '@/components/crm/icons';

type Cust = {
  id: string; name: string; stage: Stage; board_position: number; parent_id?: string | null; parent_name?: string | null; division_count?: number;
  contact_name: string | null; email: string | null; phone: string | null; address: string | null; event_count: number; quote_count: number; last_event: string | null; created_at: string;
};
type Sort = 'board' | 'name' | 'created' | 'recent' | 'events';
type View = 'kanban' | 'list';
const PAGE = 25;
const VIEW_KEY = 'lo_customers_view';
const FOLD_KEY = 'lo_customers_folded';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

function Body() {
  const router = useRouter();
  const [list, setList] = useState<Cust[] | null>(null);
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>('kanban');
  const [sort, setSort] = useState<Sort>('board');
  const [folded, setFolded] = useState<Stage[]>([]);
  const [shown, setShown] = useState(PAGE);
  const [adding, setAdding] = useState<Stage | null>(null);
  const [f, setF] = useState({ name: '', contactName: '', email: '', phone: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<{ col: Stage; index: number } | null>(null);

  const load = () => api<{ customers: Cust[] }>('/api/customers').then((r) => setList(r.customers)).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const v = store.get(VIEW_KEY);
    if (v === 'list' || v === 'kanban') {
      setView(v);
      if (v === 'list') setSort('name');
    }
    try {
      setFolded(JSON.parse(store.get(FOLD_KEY) ?? '[]'));
    } catch {
      /* ignore */
    }
  }, []);
  const pickView = (v: View) => {
    setView(v);
    store.set(VIEW_KEY, v);
    if (v === 'list' && sort === 'board') setSort('name');
  };
  const fold = (s: Stage) => {
    const next = folded.includes(s) ? folded.filter((x) => x !== s) : [...folded, s];
    setFolded(next);
    store.set(FOLD_KEY, JSON.stringify(next));
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api<{ customer: { id: string } }>('/api/customers', { body: { name: f.name, contactName: f.contactName || null, email: f.email || null, phone: f.phone || null, stage: adding ?? 'lead' } });
      setF({ name: '', contactName: '', email: '', phone: '' });
      setAdding(null);
      router.push(`/customers/${r.customer.id}`);
    } catch (x) {
      setError((x as Error).message);
    }
  };
  const imp = async () => {
    setError('');
    try {
      const r = await api<{ created: number; linked: number }>('/api/customers/import-from-events', { body: {} });
      setNote(r.created ? `Added ${r.created} customer${r.created === 1 ? '' : 's'} from your events and linked ${r.linked} event${r.linked === 1 ? '' : 's'}.` : 'Nothing new to import. Every client name on your events is already a customer.');
      load();
    } catch (x) {
      setError((x as Error).message);
    }
  };

  const needle = q.trim().toLowerCase();
  const rows = useMemo(
    () =>
      (list ?? [])
        .filter((c) => !needle || `${c.name} ${c.contact_name ?? ''} ${c.email ?? ''} ${c.phone ?? ''} ${c.address ?? ''}`.toLowerCase().includes(needle))
        .sort((a, b) =>
          sort === 'board' ? a.board_position - b.board_position || a.name.localeCompare(b.name)
          : sort === 'created' ? +new Date(b.created_at) - +new Date(a.created_at)
          : sort === 'recent' ? String(b.last_event ?? '').localeCompare(String(a.last_event ?? ''))
          : sort === 'events' ? b.event_count - a.event_count
          : a.name.localeCompare(b.name),
        ),
    [list, needle, sort],
  );

  // Moving a card: change its stage, and (in board order) put it where it was dropped.
  const move = async (c: Cust, to: Stage, index: number) => {
    const target = rows.filter((x) => x.stage === to && x.id !== c.id);
    let position: number | undefined;
    if (sort === 'board') {
      const prev = target[index - 1]?.board_position, next = target[index]?.board_position;
      position = prev == null && next == null ? 0 : prev == null ? next! - 1 : next == null ? prev + 1 : (prev + next) / 2;
    }
    if (c.stage === to && position === undefined) return;
    const before = list;
    setList((l) => l && l.map((x) => (x.id === c.id ? { ...x, stage: to, board_position: position ?? x.board_position } : x)));
    if (c.stage !== to) setNote(`Moved ${c.name} to ${stageLabel(to)}.`);
    try {
      await api(`/api/customers/${c.id}`, { method: 'PATCH', body: { stage: to, ...(position !== undefined ? { position } : {}) } });
    } catch (x) {
      setList(before);
      setError((x as Error).message);
    }
  };
  const onDragStart = (e: React.DragEvent, c: Cust) => {
    setDrag(c.id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', c.id);
  };
  const onDragOver = (e: React.DragEvent, s: Stage) => {
    if (!drag) return;
    e.preventDefault();
    const cards = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.co-card:not(.dragging)');
    let index = cards.length;
    for (let i = 0; i < cards.length; i++) {
      const r = cards[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }
    if (!over || over.col !== s || over.index !== index) setOver({ col: s, index });
  };
  const onDrop = (e: React.DragEvent, s: Stage) => {
    e.preventDefault();
    const c = list?.find((x) => x.id === drag);
    if (c && over) move(c, s, over.index);
    setDrag(null);
    setOver(null);
  };

  const card = (c: Cust) => (
    <Link
      key={c.id}
      href={`/customers/${c.id}`}
      className={`co-card${drag === c.id ? ' dragging' : ''}`}
      draggable
      onDragStart={(e) => onDragStart(e, c)}
      onDragEnd={() => { setDrag(null); setOver(null); }}
    >
      <span className={`${avClass(c.name)} co-logo`} aria-hidden="true">{initialsOf(c.name)}</span>
      <b className="co-name">{c.name}</b>
      <span className="co-sub">{c.parent_name ? `Division of ${c.parent_name}` : c.contact_name ?? (c.division_count ? `${c.division_count} division${c.division_count === 1 ? '' : 's'}` : 'No contact yet')}</span>
      <span className="co-loc"><PinIcon size={18} />{cityOf(c.address) ?? <span className="muted">No address</span>}</span>
      {(c.event_count > 0 || c.quote_count > 0) && (
        <span className="co-meta">
          {c.event_count} event{c.event_count === 1 ? '' : 's'}{c.quote_count ? ` · ${c.quote_count} quote${c.quote_count === 1 ? '' : 's'}` : ''}
          {c.last_event ? ` · last ${fmtDate(String(c.last_event).slice(0, 10))}` : ''}
        </span>
      )}
    </Link>
  );

  return (
    <>
      <TopbarAction>
        <button className="btn primary" onClick={() => setAdding('lead')}>
          Add New Customer
          <PlusIcon />
        </button>
      </TopbarAction>
      <div className="co-head">
        <h1>Customers</h1>
        <div className="co-views" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === 'list'} className={view === 'list' ? 'on' : ''} onClick={() => pickView('list')}><ListIcon /> List</button>
          <button role="tab" aria-selected={view === 'kanban'} className={view === 'kanban' ? 'on' : ''} onClick={() => pickView('kanban')}><KanbanIcon /> Kanban</button>
        </div>
        <span className="spacer" />
        <span className="pill-input">
          <SearchIcon />
          <input value={q} onChange={(e) => { setQ(e.target.value); setShown(PAGE); }} placeholder="Search name, contact, email" aria-label="Search customers" />
        </span>
        <span className="pill-input">
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort customers">
            {view === 'kanban' && <option value="board">Sort by: Board order</option>}
            <option value="name">Sort by: Name</option>
            <option value="created">Sort by: Date added</option>
            <option value="recent">Sort by: Latest event</option>
            <option value="events">Sort by: Most events</option>
          </select>
        </span>
        <button className="btn" onClick={imp} title="Create customers from the client names typed on your events">Import from events</button>
      </div>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}

      {!list ? (
        <div className="muted">Loading…</div>
      ) : list.length === 0 ? (
        <Empty>No customers yet. Add one, or import the client names already on your events.</Empty>
      ) : view === 'kanban' ? (
        <div className="co-board">
          {STAGES.map((s) => {
            const items = rows.filter((c) => c.stage === s.key);
            const isFolded = folded.includes(s.key);
            return (
              <section
                key={s.key}
                className={`co-col${isFolded ? ' folded' : ''}${over?.col === s.key ? ' over' : ''}`}
                aria-label={`${s.label}: ${items.length}`}
                onDragOver={(e) => onDragOver(e, s.key)}
                onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver((o) => (o?.col === s.key ? null : o)); }}
                onDrop={(e) => onDrop(e, s.key)}
              >
                <header className="co-col-head">
                  <button className="co-fold" onClick={() => fold(s.key)} aria-expanded={!isFolded} aria-label={`${isFolded ? 'Show' : 'Hide'} ${s.label}`}><ChevronUpIcon /></button>
                  <span className={`co-stage ${s.key}`} title={s.hint}><i aria-hidden="true" />{s.label}</span>
                  <span className="co-count">{items.length}</span>
                  <span className="spacer" />
                  <button className="co-add" onClick={() => setAdding(s.key)} aria-label={`Add a customer to ${s.label}`} title={`Add a customer to ${s.label}`}><PlusLineIcon size={22} /></button>
                </header>
                {!isFolded && (
                  <div className="co-cards">
                    {items.map((c, i) => (
                      <div key={c.id} style={{ display: 'contents' }}>
                        {over?.col === s.key && over.index === i && drag !== c.id && <div className="co-slot" aria-hidden="true" />}
                        {card(c)}
                      </div>
                    ))}
                    {over?.col === s.key && over.index >= items.filter((c) => c.id !== drag).length && <div className="co-slot" aria-hidden="true" />}
                    {!items.length && over?.col !== s.key && <p className="co-empty">{needle ? 'No matches' : s.hint}</p>}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : rows.length === 0 ? (
        <Empty>No customers match that search.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="dlist">
            <thead>
              <tr>
                <th className="av-col" aria-label="Avatar" />
                <th>Name</th>
                <th>Stage</th>
                <th>Main contact</th>
                <th className="hide-sm">Email</th>
                <th className="hide-sm">Phone</th>
                <th className="hide-sm">Address</th>
                <th>Events</th>
                <th className="edit-col">Edit</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, shown).map((c) => (
                <tr key={c.id} onClick={() => router.push(`/customers/${c.id}`)}>
                  <td className="av-col"><span className={avClass(c.name)} aria-hidden="true">{initialsOf(c.name)}</span></td>
                  <td>
                    <Link href={`/customers/${c.id}`} className="rowlink" onClick={(e) => e.stopPropagation()}>{c.name}</Link>
                    {c.parent_name && <span className="sub">Division of {c.parent_name}</span>}
                    {!!c.division_count && <span className="sub">{c.division_count} division{c.division_count === 1 ? '' : 's'}</span>}
                    {c.last_event && <span className="sub">Last event {fmtDate(String(c.last_event).slice(0, 10))}</span>}
                  </td>
                  <td><span className={`co-stage ${c.stage}`}><i aria-hidden="true" />{stageLabel(c.stage)}</span></td>
                  <td>{c.contact_name ?? <span className="muted">—</span>}</td>
                  <td className="hide-sm">{c.email ?? <span className="muted">—</span>}</td>
                  <td className="hide-sm">{c.phone ?? <span className="muted">—</span>}</td>
                  <td className="hide-sm">{c.address ?? <span className="muted">—</span>}</td>
                  <td>
                    {c.event_count}
                    {c.quote_count > 0 && <span className="sub">{c.quote_count} quote{c.quote_count === 1 ? '' : 's'}</span>}
                  </td>
                  <td className="edit-col">
                    <Link href={`/customers/${c.id}`} className="btn-round sm" aria-label={`Edit ${c.name}`} onClick={(e) => e.stopPropagation()} style={{ border: 0, background: 'transparent' }}>
                      <EditIcon />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > shown && (
            <div className="load-more">
              <button className="btn" onClick={() => setShown(shown + PAGE)}>Load More</button>
            </div>
          )}
        </div>
      )}

      {adding && (
        <Modal title="Add New Customer" onClose={() => setAdding(null)}>
          <form onSubmit={add}>
            <label>
              Company or customer name
              <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={150} autoFocus />
            </label>
            <div className="two">
              <label>
                Contact person
                <input value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} maxLength={150} />
              </label>
              <label>
                Phone
                <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} maxLength={50} />
              </label>
            </div>
            <div className="two">
              <label>
                Email
                <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} maxLength={200} />
              </label>
              <label>
                Stage
                <select value={adding} onChange={(e) => setAdding(e.target.value as Stage)}>
                  {STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </label>
            </div>
            <div className="acts">
              <button type="button" className="btn" onClick={() => setAdding(null)}>Cancel</button>
              <button className="btn primary">Save Customer</button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager']}>{() => <Body />}</Shell>;
}
