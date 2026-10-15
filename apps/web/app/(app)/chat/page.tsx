'use client';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { avClass, initialsOf } from '@/components/TopbarAction';
import { api, fmtDateTime, Me, roleLabel } from '@/lib/api';

type Channel = {
  id: string; kind: 'dm' | 'group' | 'event'; name: string | null; unread: number; muted: boolean; pinned: boolean; member_count: number;
  last_body: string | null; last_user: string | null; last_at: string | null; last_mine: boolean | null; last_read: boolean; last_file: boolean | null;
  other_role: string | null; other_id: string | null; other_online: boolean; typing: string | null;
};
type FileRef = { id: string; filename: string; kind: 'image' | 'file'; size: number; content_type?: string };
type Msg = { id: string; seq: number; user_id: string | null; user_name: string | null; user_role: string | null; created_at: string; deleted: boolean; body: string; files: FileRef[] };
type Person = { id: string; name: string; role: string; online?: boolean; last_seen_at?: string | null; email?: string | null; phone?: string | null };
type Detail = { channel: { id: string; kind: string; name: string; eventId: string | null; muted: boolean; pinned: boolean; canManage: boolean }; members: Person[]; online: number };
type SharedFile = FileRef & { created_at: string; user_name: string | null };

const URL_RE = /(https?:\/\/[^\s<]+)/g;
/** Turn links in a message into tappable links (Accept / Decline links from shift offers arrive this way). */
const linkify = (text: string) =>
  text.split(URL_RE).map((part, i) => {
    if (i % 2 === 0) return part;
    const label = /respond\?t=.*a=accept/.test(part) ? 'Tap to accept' : /respond\?t=.*a=decline/.test(part) ? 'Tap to decline' : part;
    return (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="cx-link">
        {label}
      </a>
    );
  });
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** List time: "4:30 PM" today, "Yesterday", a weekday this week, else "Mar 3". */
function listTime(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso), now = new Date();
  if (sameDay(iso, now.toISOString())) return time(iso);
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
/** Day divider: "Today, March 24". */
function dayLabel(iso: string) {
  const d = new Date(iso), now = new Date();
  const md = d.toLocaleDateString([], { month: 'long', day: 'numeric' });
  const days = Math.floor((new Date(now.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400000);
  return days === 0 ? `Today, ${md}` : days === 1 ? `Yesterday, ${md}` : d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}
function lastSeen(iso: string | null | undefined) {
  if (!iso) return 'Offline';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 60) return `Last seen ${Math.max(m, 1)} min ago`;
  if (m < 1440) return `Last seen ${Math.round(m / 60)} h ago`;
  return `Last seen ${new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' })}`;
}
const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase().slice(0, 4) : 'file');
const extTone = (e: string) =>
  /^(pdf)$/.test(e) ? 'red' : /^(doc|docx|txt|rtf|pages)$/.test(e) ? 'blue' : /^(xls|xlsx|csv|numbers)$/.test(e) ? 'green' : /^(ppt|pptx|key)$/.test(e) ? 'orange' : /^(png|jpg|jpeg|gif|webp|heic|svg)$/.test(e) ? 'purple' : 'grey';
const fileUrl = (id: string, download = false) => `/api/chat/files/${id}${download ? '?download=1' : ''}`;

/* ---------- small icons (stroke, follow the text colour) ---------- */
const Icon = ({ d, size = 18 }: { d: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {d}
  </svg>
);
const I = {
  plus: <path d="M12 5v14M5 12h14" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  pin: <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6" />,
  chat: <path d="M4 5h16v11H9l-5 4z" />,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  bellOff: <><path d="M6 8a6 6 0 0 1 9.3-5M18 8c0 7 3 9 3 9H7" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0M3 3l18 18" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></>,
  dots: <><circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" /></>,
  clip: <path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7" />,
  send: <path d="M4 12 20 4l-6 16-3-7z" />,
  back: <path d="M15 18 9 12l6-6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  hash: <path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16" />,
  cal: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  checks: <path d="m2 12 4 4L16 6M10 15l1 1L21 6" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  trash: <path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></>,
  download: <path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14" />,
  leave: <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10" />,
};

function Avatar({ name, kind = 'dm', online, size = 44 }: { name: string; kind?: string; online?: boolean; size?: number }) {
  return (
    <span className="cx-av-wrap" style={{ width: size, height: size }}>
      {kind === 'dm' ? (
        <span className={avClass(name)} style={{ width: size, height: size, fontSize: Math.round(size * 0.34) }} aria-hidden="true">
          {initialsOf(name)}
        </span>
      ) : (
        <span className="av cx-av-group" style={{ width: size, height: size }} aria-hidden="true">
          <Icon d={kind === 'event' ? I.cal : I.hash} size={Math.round(size * 0.45)} />
        </span>
      )}
      {online && <i className="cx-online" aria-label="Online" />}
    </span>
  );
}

/* ---------- new conversation ---------- */
function NewChat({ me, onClose, onOpen }: { me: Me; onClose: () => void; onOpen: (id: string) => void }) {
  const staff = me.role !== 'crew';
  const [mode, setMode] = useState<'dm' | 'group'>('dm');
  const [people, setPeople] = useState<Person[]>([]);
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    api<{ people: Person[] }>('/api/chat/people').then((r) => setPeople(r.people)).catch((e) => setErr(e.message));
  }, []);
  const shown = people.filter((p) => p.name.toLowerCase().includes(q.toLowerCase()));
  const startDm = async (userId: string) => {
    try {
      onOpen((await api<{ id: string }>('/api/chat/dm', { body: { userId } })).id);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const createGroup = async () => {
    try {
      onOpen((await api<{ id: string }>('/api/chat/channels', { body: { name, memberIds: picked } })).id);
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label="New conversation">
        <div className="row space">
          <h2 style={{ margin: 0 }}>New conversation</h2>
          <button className="btn-round sm" onClick={onClose} aria-label="Close"><Icon d={I.x} size={16} /></button>
        </div>
        {staff && (
          <div className="phase-tabs" role="tablist" style={{ margin: '0.8rem 0' }}>
            <button role="tab" aria-selected={mode === 'dm'} className={mode === 'dm' ? 'tab on' : 'tab'} onClick={() => setMode('dm')}>Direct message</button>
            <button role="tab" aria-selected={mode === 'group'} className={mode === 'group' ? 'tab on' : 'tab'} onClick={() => setMode('group')}>Group channel</button>
          </div>
        )}
        {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
        {mode === 'group' && (
          <label>
            Channel name
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Load-in crew" maxLength={80} />
          </label>
        )}
        <label style={{ marginTop: '0.6rem' }}>
          {mode === 'dm' ? 'Who do you want to message?' : 'Add people'}
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" autoFocus />
        </label>
        <ul className="cx-pick">
          {shown.map((p) => (
            <li key={p.id}>
              {mode === 'dm' ? (
                <button className="cx-pick-row" onClick={() => startDm(p.id)}>
                  <Avatar name={p.name} size={34} />
                  <span className="grow">{p.name}</span>
                  <span className="muted small">{roleLabel(p.role)}</span>
                </button>
              ) : (
                <label className="cx-pick-row">
                  <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
                  <Avatar name={p.name} size={34} />
                  <span className="grow">{p.name}</span>
                  <span className="muted small">{roleLabel(p.role)}</span>
                </label>
              )}
            </li>
          ))}
          {!shown.length && <li className="muted small" style={{ padding: '0.6rem' }}>No one found.</li>}
        </ul>
        {mode === 'group' && (
          <div className="acts">
            <button className="btn primary" disabled={!name.trim()} onClick={createGroup}>
              Create channel{picked.length ? ` with ${picked.length}` : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- conversation list ---------- */
function ConvRow({ c, active, onOpen }: { c: Channel; active: boolean; onOpen: () => void }) {
  const preview = c.typing ? null : c.last_body || c.last_file ? `${c.kind !== 'dm' && c.last_user && !c.last_mine ? c.last_user.split(' ')[0] + ': ' : c.last_mine ? 'You: ' : ''}${c.last_body || (c.last_file ? '📎 File' : '')}` : 'No messages yet';
  return (
    <button className={`cx-row ${active ? 'on' : ''} ${c.unread ? 'unread' : ''}`} onClick={onOpen} aria-current={active ? 'true' : undefined}>
      <Avatar name={c.name ?? '?'} kind={c.kind} online={c.kind === 'dm' && c.other_online} />
      <span className="cx-row-main">
        <span className="cx-row-top">
          <b>{c.name ?? 'Conversation'}</b>
          {c.muted && <span className="cx-mini" title="Muted"><Icon d={I.bellOff} size={13} /></span>}
          <span className="cx-row-time">{listTime(c.last_at)}</span>
        </span>
        <span className="cx-row-bot">
          {c.typing ? <span className="cx-typing-txt">{c.kind === 'dm' ? 'Typing…' : `${c.typing.split(',')[0]} is typing…`}</span> : <span className="cx-row-prev">{preview}</span>}
          {c.unread > 0 ? (
            <span className="cx-badge" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>
          ) : c.last_mine && c.kind === 'dm' ? (
            <span className={`cx-tick ${c.last_read ? 'read' : ''}`} aria-label={c.last_read ? 'Read' : 'Sent'}>
              <Icon d={c.last_read ? I.checks : I.check} size={15} />
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

/* ---------- details panel ---------- */
function Details({ me, detail, files, onChange, onClose, onDelete }: { me: Me; detail: Detail; files: SharedFile[] | null; onChange: () => void; onClose: () => void; onDelete: () => void }) {
  const ch = detail.channel;
  const other = ch.kind === 'dm' ? detail.members.find((m) => m.id !== me.id) : null;
  const [open, setOpen] = useState({ files: true, members: true });
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [people, setPeople] = useState<Person[]>([]);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (adding && !people.length) api<{ people: Person[] }>('/api/chat/people').then((r) => setPeople(r.people)).catch((e) => setErr(e.message));
  }, [adding, people.length]);
  const ids = new Set(detail.members.map((m) => m.id));
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const shown = files ? (all ? files : files.slice(0, 4)) : [];
  return (
    <aside className="cx-info" aria-label="Conversation details">
      <button className="btn-round sm cx-info-close" onClick={onClose} aria-label="Close details"><Icon d={I.x} size={16} /></button>
      <div className="cx-info-hero">
        <Avatar name={other?.name ?? ch.name} kind={ch.kind} online={!!other?.online} size={96} />
        <b>{other?.name ?? ch.name}</b>
        <span className="muted small">
          {other ? `${roleLabel(other.role)} · ${other.online ? 'Online' : lastSeen(other.last_seen_at)}` : `${detail.members.length} members · ${detail.online} online`}
        </span>
        {other?.email && <a className="small cx-contact" href={`mailto:${other.email}`}>{other.email}</a>}
        {other?.phone && <a className="small cx-contact" href={`tel:${other.phone}`}>{other.phone}</a>}
        <div className="cx-info-acts">
          <button className={`cx-chip ${ch.pinned ? 'on' : ''}`} onClick={() => run(() => api(`/api/chat/channels/${ch.id}`, { method: 'PATCH', body: { pinned: !ch.pinned } }))}>
            <Icon d={I.pin} size={15} /> {ch.pinned ? 'Pinned' : 'Pin'}
          </button>
          <button className={`cx-chip ${ch.muted ? 'on' : ''}`} onClick={() => run(() => api(`/api/chat/channels/${ch.id}`, { method: 'PATCH', body: { muted: !ch.muted } }))}>
            <Icon d={ch.muted ? I.bellOff : I.bell} size={15} /> {ch.muted ? 'Muted' : 'Mute'}
          </button>
        </div>
      </div>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}

      <section className="cx-sec">
        <button className="cx-sec-h" aria-expanded={open.files} onClick={() => setOpen({ ...open, files: !open.files })}>
          Attachments{files && files.length ? ` (${files.length})` : ''}
          <span className={`cx-caret ${open.files ? 'open' : ''}`}><Icon d={I.chevron} size={16} /></span>
        </button>
        {open.files && (
          <>
            {!files ? (
              <div className="muted small">Loading…</div>
            ) : !files.length ? (
              <div className="muted small">Files and photos shared here show up in this list.</div>
            ) : (
              <ul className="cx-files">
                {shown.map((f) => {
                  const e = ext(f.filename);
                  return (
                    <li key={f.id}>
                      <a href={fileUrl(f.id, f.kind !== 'image')} target={f.kind === 'image' ? '_blank' : undefined} rel="noreferrer" className="cx-file">
                        {f.kind === 'image' ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={fileUrl(f.id)} alt="" className="cx-file-thumb" loading="lazy" />
                        ) : (
                          <span className={`cx-ext ${extTone(e)}`}>{e}</span>
                        )}
                        <span className="cx-file-main">
                          <b>{f.filename}</b>
                          <span className="muted small">{fmtSize(f.size)} · {new Date(f.created_at).toLocaleDateString([], { month: 'numeric', day: 'numeric', year: '2-digit' })} {time(f.created_at)}</span>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ul>
            )}
            {files && files.length > 4 && (
              <button className="cx-link-btn" onClick={() => setAll(!all)}>{all ? 'Show fewer' : 'View all'}</button>
            )}
          </>
        )}
      </section>

      {ch.kind !== 'dm' && (
        <section className="cx-sec">
          <button className="cx-sec-h" aria-expanded={open.members} onClick={() => setOpen({ ...open, members: !open.members })}>
            Members ({detail.members.length})
            <span className={`cx-caret ${open.members ? 'open' : ''}`}><Icon d={I.chevron} size={16} /></span>
          </button>
          {open.members && (
            <>
              {ch.canManage && (
                <button className="cx-add" onClick={() => setAdding(!adding)} aria-expanded={adding}>
                  <span className="cx-add-ico"><Icon d={I.plus} size={16} /></span> Add Member
                </button>
              )}
              {adding && (
                <ul className="cx-pick" style={{ maxHeight: 220 }}>
                  {people.filter((p) => !ids.has(p.id)).map((p) => (
                    <li key={p.id}>
                      <button className="cx-pick-row" onClick={() => run(() => api(`/api/chat/channels/${ch.id}/members`, { body: { userIds: [p.id] } }))}>
                        <Avatar name={p.name} size={30} />
                        <span className="grow">{p.name}</span>
                        <span className="muted small">Add</span>
                      </button>
                    </li>
                  ))}
                  {people.length > 0 && people.every((p) => ids.has(p.id)) && <li className="muted small" style={{ padding: 8 }}>Everyone is already here.</li>}
                </ul>
              )}
              <ul className="cx-members">
                {detail.members.map((m) => (
                  <li key={m.id}>
                    <Avatar name={m.name} size={34} online={m.online} />
                    <span className="cx-member-main">
                      <b>{m.name}{m.id === me.id && <span className="muted"> (you)</span>}</b>
                      <span className="muted small">{roleLabel(m.role)}</span>
                    </span>
                    {ch.canManage && m.id !== me.id && (
                      <button className="btn-round sm" title={`Remove ${m.name}`} aria-label={`Remove ${m.name}`} onClick={() => run(() => api(`/api/chat/channels/${ch.id}/members/${m.id}`, { method: 'DELETE' }))}>
                        <Icon d={I.x} size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      <div className="cx-info-foot">
        {ch.kind !== 'dm' && (
          <button className="cx-danger" onClick={() => confirm('Leave this conversation?') && run(async () => { await api(`/api/chat/channels/${ch.id}/members/${me.id}`, { method: 'DELETE' }); location.href = '/chat'; })}>
            <Icon d={I.leave} size={16} /> Leave conversation
          </button>
        )}
        <button className="cx-danger" onClick={onDelete}>
          <Icon d={I.trash} size={16} /> Delete conversation
        </button>
      </div>
    </aside>
  );
}

/* ---------- one message's menu ---------- */
function MsgMenu({ m, canDelete, onDelete }: { m: Msg; canDelete: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => box.current && !box.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  return (
    <span className="cx-menu" ref={box}>
      <button className="cx-kebab" aria-label="Message options" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon d={I.dots} size={16} />
      </button>
      {open && (
        <span className="cx-menu-pop" role="menu">
          {m.body && (
            <button role="menuitem" onClick={() => { navigator.clipboard?.writeText(m.body); setOpen(false); }}>
              <Icon d={I.copy} size={15} /> Copy text
            </button>
          )}
          {m.files.map((f) => (
            <a key={f.id} role="menuitem" href={fileUrl(f.id, true)} onClick={() => setOpen(false)}>
              <Icon d={I.download} size={15} /> Download {m.files.length > 1 ? f.filename : ''}
            </a>
          ))}
          {canDelete && (
            <button role="menuitem" className="danger" onClick={() => { setOpen(false); onDelete(); }}>
              <Icon d={I.trash} size={15} /> Delete
            </button>
          )}
          {!m.body && !m.files.length && !canDelete && <span className="muted small" style={{ padding: 8 }}>No actions</span>}
        </span>
      )}
    </span>
  );
}

/* ---------- thread ---------- */
function Thread({ me, id, channel, infoOpen, onInfo, onBack, onChanged }: { me: Me; id: string; channel: Channel | undefined; infoOpen: boolean; onInfo: (v: boolean) => void; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [files, setFiles] = useState<SharedFile[] | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [readSeq, setReadSeq] = useState(0);
  const [typing, setTyping] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [drag, setDrag] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const stick = useRef(true);
  const lastSeq = useRef(0);
  const lastPing = useRef(0);

  const loadDetail = useCallback(() => api<Detail>(`/api/chat/channels/${id}`).then(setDetail).catch((e) => setErr(e.message)), [id]);
  const loadFiles = useCallback(() => api<{ files: SharedFile[] }>(`/api/chat/channels/${id}/files`).then((r) => setFiles(r.files)).catch(() => setFiles([])), [id]);
  const markRead = useCallback(() => api(`/api/chat/channels/${id}/read`, { body: {} }).then(onChanged).catch(() => undefined), [id, onChanged]);

  useEffect(() => {
    setMsgs([]);
    setDetail(null);
    setFiles(null);
    setTyping(null);
    lastSeq.current = 0;
    stick.current = true;
    loadDetail();
    loadFiles();
    api<{ messages: Msg[]; hasMore: boolean; readSeq: number; typing: string | null }>(`/api/chat/channels/${id}/messages`)
      .then((r) => {
        setMsgs(r.messages);
        setHasMore(r.hasMore);
        setReadSeq(r.readSeq);
        lastSeq.current = r.messages.at(-1)?.seq ?? 0;
        markRead();
      })
      .catch((e) => setErr(e.message));
    const t = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await api<{ messages: Msg[]; readSeq: number; typing: string | null }>(`/api/chat/channels/${id}/messages?after=${lastSeq.current}`);
        setReadSeq(r.readSeq);
        setTyping(r.typing);
        if (r.messages.length) {
          lastSeq.current = r.messages.at(-1)!.seq;
          setMsgs((m) => [...m, ...r.messages.filter((x) => !m.some((y) => y.id === x.id))]);
          if (r.messages.some((x) => x.files.length)) loadFiles();
          markRead();
        }
      } catch {
        /* transient */
      }
    }, 2500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, typing]);

  const older = async () => {
    const first = msgs[0]?.seq;
    if (!first) return;
    const el = scroller.current;
    const before = el?.scrollHeight ?? 0;
    const r = await api<{ messages: Msg[]; hasMore: boolean }>(`/api/chat/channels/${id}/messages?before=${first}`);
    stick.current = false;
    setMsgs((m) => [...r.messages, ...m]);
    setHasMore(r.hasMore);
    requestAnimationFrame(() => el && (el.scrollTop = el.scrollHeight - before));
  };

  const add = (m: Msg) => {
    stick.current = true;
    lastSeq.current = Math.max(lastSeq.current, m.seq);
    setMsgs((x) => (x.some((y) => y.id === m.id) ? x : [...x, m]));
  };
  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      add((await api<{ message: Msg }>(`/api/chat/channels/${id}/messages`, { body: { body } })).message);
      setText('');
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  };
  const upload = async (list: FileList | File[]) => {
    const picked = Array.from(list).slice(0, 10);
    for (const f of picked) {
      if (f.size > 10 * 1024 * 1024) {
        setErr(`${f.name} is larger than 10 MB.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const res = await fetch(`/api/chat/channels/${id}/files?filename=${encodeURIComponent(f.name || 'photo.png')}`, {
          method: 'POST',
          body: f,
          headers: { 'content-type': 'application/octet-stream' },
          credentials: 'same-origin',
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error ?? `Upload failed (${res.status})`);
        add(data.message);
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    loadFiles();
    onChanged();
  };
  const ping = () => {
    if (Date.now() - lastPing.current < 3000) return;
    lastPing.current = Date.now();
    api(`/api/chat/channels/${id}/typing`, { body: {} }).catch(() => undefined);
  };
  const del = async (m: Msg) => {
    if (!confirm('Delete this message for everyone?')) return;
    try {
      await api(`/api/chat/messages/${m.id}`, { method: 'DELETE' });
      setMsgs((x) => x.map((y) => (y.id === m.id ? { ...y, deleted: true, body: '', files: [] } : y)));
      loadFiles();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  const deleteConversation = async () => {
    if (!confirm('Delete this conversation? Its messages are removed from your view only; the others still have them. It comes back if someone writes again.')) return;
    try {
      await api(`/api/chat/channels/${id}`, { method: 'DELETE' });
      onChanged();
      onBack();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const ch = detail?.channel;
  const other = ch?.kind === 'dm' ? detail?.members.find((m) => m.id !== me.id) : null;
  const title = ch?.name ?? channel?.name ?? '…';
  const sub = !detail ? '' : other ? (other.online ? 'Online' : lastSeen(other.last_seen_at)) : `${detail.members.length} member${detail.members.length === 1 ? '' : 's'}, ${detail.online} online`;
  const stack = (detail?.members ?? []).filter((m) => m.id !== me.id).slice(0, 3);
  const lastMine = [...msgs].reverse().find((m) => m.user_id === me.id && !m.deleted);

  return (
    <div className={`cx-main ${infoOpen ? 'with-info' : ''}`}>
      <section
        className={`cx-thread ${drag ? 'drag' : ''}`}
        aria-label="Conversation"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            setDrag(true);
          }
        }}
        onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) upload(e.dataTransfer.files);
        }}
      >
        <header className="cx-head">
          <button className="btn-round sm cx-back" onClick={onBack} aria-label="Back to conversations"><Icon d={I.back} /></button>
          <button className="cx-head-who" onClick={() => onInfo(!infoOpen)} aria-label="Show conversation details">
            <Avatar name={other?.name ?? title} kind={ch?.kind ?? channel?.kind ?? 'dm'} online={!!other?.online} size={52} />
            <span className="cx-head-text">
              <b>{title}</b>
              <span className={`small ${other?.online ? 'cx-green' : 'muted'}`}>{sub}</span>
            </span>
          </button>
          <span className="cx-head-acts">
            {ch && ch.kind !== 'dm' && stack.length > 0 && (
              <span className="cx-stack" aria-label={`${detail!.members.length} members`}>
                {stack.map((m) => (
                  <span key={m.id} className={avClass(m.name)} title={m.name}>{initialsOf(m.name)}</span>
                ))}
                {detail!.members.length - 1 > stack.length && <span className="av cx-stack-more">+{detail!.members.length - 1 - stack.length}</span>}
              </span>
            )}
            {ch?.canManage && (
              <button className="btn-round sm" title="Add member" aria-label="Add member" onClick={() => onInfo(true)}><Icon d={I.plus} size={16} /></button>
            )}
            {ch && (
              <button className={`btn-round sm ${ch.pinned ? 'on' : ''}`} title={ch.pinned ? 'Unpin' : 'Pin to top'} aria-pressed={ch.pinned} onClick={async () => { await api(`/api/chat/channels/${id}`, { method: 'PATCH', body: { pinned: !ch.pinned } }); loadDetail(); onChanged(); }}>
                <Icon d={I.pin} size={16} />
              </button>
            )}
            <button className={`btn-round sm ${infoOpen ? 'on' : ''}`} title="Details" aria-pressed={infoOpen} onClick={() => onInfo(!infoOpen)}><Icon d={I.info} size={16} /></button>
          </span>
        </header>
        {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
        <div
          className="cx-msgs"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {hasMore && (
            <button className="btn small" style={{ alignSelf: 'center' }} onClick={older}>Load earlier messages</button>
          )}
          {!msgs.length && <div className="cx-empty-thread muted">No messages yet. Say hello, or drop a file here.</div>}
          {msgs.map((m, i) => {
            const mine = m.user_id === me.id;
            const prev = msgs[i - 1];
            const newDay = !prev || !sameDay(prev.created_at, m.created_at);
            const grouped = !!prev && !newDay && prev.user_id === m.user_id && !prev.deleted && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
            const canDelete = !m.deleted && (mine || me.role !== 'crew');
            const imgs = m.files.filter((f) => f.kind === 'image');
            const docs = m.files.filter((f) => f.kind !== 'image');
            return (
              <div key={m.id} className="cx-item">
                {newDay && <div className="cx-day"><span>{dayLabel(m.created_at)}</span></div>}
                {!grouped && (
                  <div className={`cx-who ${mine ? 'mine' : ''}`}>
                    <Avatar name={m.user_name ?? 'Former member'} size={32} />
                    <b>{mine ? 'You' : m.user_name ?? 'Former member'}</b>
                    {!mine && m.user_role && m.user_role !== 'crew' && <span className="cx-role">{roleLabel(m.user_role)}</span>}
                    <span className="muted small" title={fmtDateTime(m.created_at)}>{time(m.created_at)}</span>
                  </div>
                )}
                <div className={`cx-line ${mine ? 'mine' : ''}`}>
                  {m.deleted ? (
                    <div className="cx-bubble gone">Message deleted</div>
                  ) : (
                    <div className="cx-stackcol">
                      {m.body && <div className="cx-bubble" title={fmtDateTime(m.created_at)}>{linkify(m.body)}</div>}
                      {imgs.length > 0 && (
                        <div className={`cx-imgs n${Math.min(imgs.length, 3)}`}>
                          {imgs.map((f) => (
                            <a key={f.id} href={fileUrl(f.id)} target="_blank" rel="noreferrer" className="cx-img" title={f.filename}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={fileUrl(f.id)} alt={f.filename} loading="lazy" />
                            </a>
                          ))}
                        </div>
                      )}
                      {docs.map((f) => {
                        const e = ext(f.filename);
                        return (
                          <a key={f.id} href={fileUrl(f.id, true)} className="cx-doc">
                            <span className={`cx-ext ${extTone(e)}`}>{e}</span>
                            <span className="cx-file-main">
                              <b>{f.filename}</b>
                              <span className="small">{fmtSize(f.size)} · Download</span>
                            </span>
                          </a>
                        );
                      })}
                    </div>
                  )}
                  {!m.deleted && <MsgMenu m={m} canDelete={canDelete} onDelete={() => del(m)} />}
                </div>
                {ch?.kind === 'dm' && lastMine?.id === m.id && (
                  <div className="cx-seen small">{readSeq >= m.seq ? <><Icon d={I.checks} size={14} /> Seen</> : <><Icon d={I.check} size={14} /> Sent</>}</div>
                )}
              </div>
            );
          })}
          {typing && (
            <div className="cx-typing" aria-live="polite">
              <span className="cx-dots"><i /><i /><i /></span>
              {ch?.kind === 'dm' ? `${typing.split(' ')[0]} is typing…` : `${typing} ${typing.includes(',') ? 'are' : 'is'} typing…`}
            </div>
          )}
        </div>
        {drag && <div className="cx-drop">Drop files to send</div>}
        <form className="cx-compose" onSubmit={send}>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ''; }} />
          <button type="button" className="btn-round" title="Attach a file or photo" aria-label="Attach a file or photo" onClick={() => fileInput.current?.click()} disabled={uploading > 0}>
            <Icon d={I.clip} />
          </button>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              if (e.target.value.trim()) ping();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) send(e);
            }}
            onPaste={(e) => {
              const fs = Array.from(e.clipboardData.files);
              if (fs.length) {
                e.preventDefault();
                upload(fs);
              }
            }}
            placeholder={uploading ? `Sending ${uploading} file${uploading > 1 ? 's' : ''}…` : 'Type a message…'}
            rows={1}
            maxLength={4000}
            aria-label="Message"
          />
          <button className="cx-send" disabled={!text.trim() || sending} aria-label="Send">
            <Icon d={I.send} size={20} />
          </button>
        </form>
      </section>
      {infoOpen && detail && (
        <>
          <div className="cx-info-back" onClick={() => onInfo(false)} />
          <Details me={me} detail={detail} files={files} onChange={() => { loadDetail(); onChanged(); }} onClose={() => onInfo(false)} onDelete={deleteConversation} />
        </>
      )}
    </div>
  );
}

/* ---------- page ---------- */
function ChatInner({ me }: { me: Me }) {
  const router = useRouter();
  const params = useSearchParams();
  const active = params.get('c');
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  const [infoOpen, setInfoOpen] = useState(false);

  useEffect(() => {
    try {
      setInfoOpen(localStorage.getItem('lo_chat_info') !== '0' && window.matchMedia('(min-width: 1500px)').matches);
    } catch {
      /* storage blocked */
    }
  }, []);
  const setInfo = (v: boolean) => {
    setInfoOpen(v);
    try {
      localStorage.setItem('lo_chat_info', v ? '1' : '0');
    } catch {
      /* storage blocked */
    }
  };

  const load = useCallback(() => api<{ channels: Channel[] }>('/api/chat/channels').then((r) => setChannels(r.channels)).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const open = (id: string) => {
    setCreating(false);
    router.push(`/chat?c=${id}`);
    load();
  };
  const needle = q.trim().toLowerCase();
  const shown = useMemo(() => (channels ?? []).filter((c) => !needle || `${c.name ?? ''} ${c.last_body ?? ''}`.toLowerCase().includes(needle)), [channels, needle]);
  const pinned = shown.filter((c) => c.pinned);
  const rest = shown.filter((c) => !c.pinned);

  return (
    <>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      <div className={`cx ${active ? 'has-active' : ''}`}>
        <nav className="cx-list" aria-label="Conversations">
          <div className="cx-list-head">
            <h2>Messages</h2>
            <button className="btn-round sm primary-round" onClick={() => setCreating(true)} title="New conversation" aria-label="New conversation"><Icon d={I.plus} size={18} /></button>
          </div>
          <label className="cx-search">
            <Icon d={I.search} size={17} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search conversations" />
          </label>
          <div className="cx-list-scroll">
            {channels === null && <div className="muted small cx-pad">Loading…</div>}
            {channels?.length === 0 && <div className="muted small cx-pad">No conversations yet. Start one with the + button.</div>}
            {channels && channels.length > 0 && !shown.length && <div className="muted small cx-pad">No conversations match “{q}”.</div>}
            {pinned.length > 0 && (
              <>
                <div className="cx-label"><Icon d={I.pin} size={14} /> Pinned</div>
                {pinned.map((c) => <ConvRow key={c.id} c={c} active={c.id === active} onOpen={() => open(c.id)} />)}
              </>
            )}
            {rest.length > 0 && (
              <>
                {pinned.length > 0 && <div className="cx-label"><Icon d={I.chat} size={14} /> All messages</div>}
                {rest.map((c) => <ConvRow key={c.id} c={c} active={c.id === active} onOpen={() => open(c.id)} />)}
              </>
            )}
          </div>
        </nav>
        {active ? (
          <Thread key={active} me={me} id={active} channel={channels?.find((c) => c.id === active)} infoOpen={infoOpen} onInfo={setInfo} onBack={() => router.push('/chat')} onChanged={load} />
        ) : (
          <section className="cx-thread cx-none">
            <span className="cx-none-ico"><Icon d={I.chat} size={34} /></span>
            <b>Your messages</b>
            <span className="muted small">Pick a conversation, or start a new one.</span>
            <button className="btn primary" onClick={() => setCreating(true)}>New conversation</button>
          </section>
        )}
      </div>
      {creating && <NewChat me={me} onClose={() => setCreating(false)} onOpen={open} />}
    </>
  );
}

export default function ChatPage() {
  return (
    <Shell roles={['admin', 'manager', 'crew']}>
      {(me) => (
        <Suspense fallback={<div className="muted">Loading…</div>}>
          <ChatInner me={me} />
        </Suspense>
      )}
    </Shell>
  );
}
