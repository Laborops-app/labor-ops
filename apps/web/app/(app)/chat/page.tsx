'use client';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Shell from '@/components/Shell';
import { Banner } from '@/components/ui';
import { api, fmtDateTime, fmtTime, Me, roleLabel } from '@/lib/api';

type Channel = { id: string; kind: 'dm' | 'group' | 'event'; name: string | null; unread: number; muted: boolean; member_count: number; last_body: string | null; last_user: string | null; last_at: string | null; other_role: string | null };
type Msg = { id: string; seq: number; user_id: string | null; user_name: string | null; user_role: string | null; created_at: string; deleted: boolean; body: string };
type Person = { id: string; name: string; role: string };
type Detail = { channel: { id: string; kind: string; name: string; eventId: string | null; muted: boolean; canManage: boolean }; members: Person[] };

const short = (s: string | null, n = 48) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '');
const sameDay = (a: string, b: string) => new Date(a).toDateString() === new Date(b).toDateString();

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
          <button className="btn ghost small" onClick={onClose} aria-label="Close">✕</button>
        </div>
        {staff && (
          <div className="seg" role="tablist" style={{ margin: '0.7rem 0' }}>
            <button role="tab" aria-selected={mode === 'dm'} className={mode === 'dm' ? 'active' : ''} onClick={() => setMode('dm')}>Direct message</button>
            <button role="tab" aria-selected={mode === 'group'} className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')}>Group channel</button>
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
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" />
        </label>
        <ul className="pick-list">
          {shown.map((p) => (
            <li key={p.id}>
              {mode === 'dm' ? (
                <button className="pick" onClick={() => startDm(p.id)}>
                  <span>{p.name}</span>
                  <span className="muted small">{roleLabel(p.role)}</span>
                </button>
              ) : (
                <label className="pick check">
                  <input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} />
                  <span>{p.name}</span>
                  <span className="muted small">{roleLabel(p.role)}</span>
                </label>
              )}
            </li>
          ))}
          {!shown.length && <li className="muted small" style={{ padding: '0.6rem' }}>No one found.</li>}
        </ul>
        {mode === 'group' && (
          <div className="form-actions">
            <button className="btn primary" disabled={!name.trim()} onClick={createGroup}>
              Create channel{picked.length ? ` with ${picked.length}` : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Members({ me, detail, onChange, onClose }: { me: Me; detail: Detail; onChange: () => void; onClose: () => void }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [add, setAdd] = useState('');
  const [err, setErr] = useState('');
  const can = detail.channel.canManage;
  useEffect(() => {
    if (can) api<{ people: Person[] }>('/api/chat/people').then((r) => setPeople(r.people)).catch(() => undefined);
  }, [can]);
  const ids = new Set(detail.members.map((m) => m.id));
  const addable = people.filter((p) => !ids.has(p.id));
  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      onChange();
    } catch (e: any) {
      setErr(e.message);
    }
  };
  return (
    <aside className="chat-members card" aria-label="Members">
      <div className="row space">
        <h3 style={{ margin: 0 }}>Members ({detail.members.length})</h3>
        <button className="btn ghost small" onClick={onClose} aria-label="Close members">✕</button>
      </div>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      <ul className="pick-list">
        {detail.members.map((m) => (
          <li key={m.id} className="row space" style={{ padding: '0.35rem 0.2rem' }}>
            <span>
              {m.name} {m.id === me.id && <span className="muted small">(you)</span>}
              <span className="muted small"> · {roleLabel(m.role)}</span>
            </span>
            {can && m.id !== me.id && (
              <button className="btn ghost small danger" onClick={() => run(() => api(`/api/chat/channels/${detail.channel.id}/members/${m.id}`, { method: 'DELETE' }))}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
      {can && addable.length > 0 && (
        <div className="row" style={{ gap: '0.5rem' }}>
          <select value={add} onChange={(e) => setAdd(e.target.value)} aria-label="Add a person" style={{ flex: 1 }}>
            <option value="">Add a person…</option>
            {addable.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button className="btn small primary" disabled={!add} onClick={() => run(async () => { await api(`/api/chat/channels/${detail.channel.id}/members`, { body: { userIds: [add] } }); setAdd(''); })}>
            Add
          </button>
        </div>
      )}
      {detail.channel.kind !== 'dm' && (
        <button className="btn ghost small danger" style={{ marginTop: '0.6rem' }} onClick={() => run(async () => { await api(`/api/chat/channels/${detail.channel.id}/members/${me.id}`, { method: 'DELETE' }); location.href = '/chat'; })}>
          Leave conversation
        </button>
      )}
    </aside>
  );
}

function Thread({ me, id, onBack, onChanged }: { me: Me; id: string; onBack: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [showMembers, setShowMembers] = useState(false);
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastSeq = useRef(0);

  const loadDetail = useCallback(() => api<Detail>(`/api/chat/channels/${id}`).then(setDetail).catch((e) => setErr(e.message)), [id]);
  const markRead = useCallback(() => api(`/api/chat/channels/${id}/read`, { body: {} }).then(onChanged).catch(() => undefined), [id, onChanged]);

  useEffect(() => {
    setMsgs([]);
    setDetail(null);
    setShowMembers(false);
    lastSeq.current = 0;
    stick.current = true;
    loadDetail();
    api<{ messages: Msg[]; hasMore: boolean }>(`/api/chat/channels/${id}/messages`)
      .then((r) => {
        setMsgs(r.messages);
        setHasMore(r.hasMore);
        lastSeq.current = r.messages.at(-1)?.seq ?? 0;
        markRead();
      })
      .catch((e) => setErr(e.message));
    const t = setInterval(async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await api<{ messages: Msg[] }>(`/api/chat/channels/${id}/messages?after=${lastSeq.current}`);
        if (r.messages.length) {
          lastSeq.current = r.messages.at(-1)!.seq;
          setMsgs((m) => [...m, ...r.messages.filter((x) => !m.some((y) => y.id === x.id))]);
          markRead();
        }
      } catch {
        /* transient */
      }
    }, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs]);

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

  const send = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const r = await api<{ message: Msg }>(`/api/chat/channels/${id}/messages`, { body: { body } });
      stick.current = true;
      lastSeq.current = Math.max(lastSeq.current, r.message.seq);
      setMsgs((m) => (m.some((x) => x.id === r.message.id) ? m : [...m, r.message]));
      setText('');
      onChanged();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSending(false);
    }
  };

  const del = async (m: Msg) => {
    if (!confirm('Delete this message?')) return;
    try {
      await api(`/api/chat/messages/${m.id}`, { method: 'DELETE' });
      setMsgs((x) => x.map((y) => (y.id === m.id ? { ...y, deleted: true, body: '' } : y)));
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const toggleMute = async () => {
    if (!detail) return;
    await api(`/api/chat/channels/${id}`, { method: 'PATCH', body: { muted: !detail.channel.muted } });
    loadDetail();
    onChanged();
  };

  return (
    <section className="chat-thread" aria-label="Conversation">
      <header className="chat-head">
        <button className="btn ghost small chat-back" onClick={onBack} aria-label="Back to conversations">←</button>
        <div className="chat-title">
          <b>{detail?.channel.name ?? '…'}</b>
          {detail && detail.channel.kind !== 'dm' && <span className="muted small"> · {detail.members.length} members</span>}
        </div>
        {detail && (
          <>
            <button className="btn ghost small" onClick={toggleMute} title={detail.channel.muted ? 'Unmute notifications' : 'Mute notifications'}>
              {detail.channel.muted ? '🔕 Muted' : '🔔'}
            </button>
            {detail.channel.kind !== 'dm' && (
              <button className="btn ghost small" onClick={() => setShowMembers((v) => !v)} aria-expanded={showMembers}>
                Members
              </button>
            )}
          </>
        )}
      </header>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      <div className="chat-body">
        <div
          className="chat-msgs"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          {hasMore && (
            <button className="btn ghost small" style={{ alignSelf: 'center' }} onClick={older}>
              Load earlier messages
            </button>
          )}
          {!msgs.length && <div className="muted small" style={{ margin: 'auto' }}>No messages yet. Say hello.</div>}
          {msgs.map((m, i) => {
            const mine = m.user_id === me.id;
            const prev = msgs[i - 1];
            const newDay = !prev || !sameDay(prev.created_at, m.created_at);
            const grouped = prev && !newDay && prev.user_id === m.user_id && !prev.deleted && new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() < 5 * 60_000;
            return (
              <div key={m.id} className="msg-wrap">
                {newDay && <div className="day-sep">{new Date(m.created_at).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</div>}
                <div className={`msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`}>
                  {!grouped && !mine && (
                    <div className="msg-who">
                      {m.user_name ?? 'Former member'}
                      {m.user_role && m.user_role !== 'crew' && <span className="muted"> · {roleLabel(m.user_role)}</span>}
                    </div>
                  )}
                  <div className={`bubble ${m.deleted ? 'gone' : ''}`} title={fmtDateTime(m.created_at)}>
                    {m.deleted ? 'Message deleted' : m.body}
                    {!m.deleted && (mine || me.role !== 'crew') && (
                      <button className="msg-del" onClick={() => del(m)} aria-label="Delete message">✕</button>
                    )}
                  </div>
                  {!grouped && <div className="msg-time">{fmtTime(m.created_at)}</div>}
                </div>
              </div>
            );
          })}
        </div>
        {showMembers && detail && <Members me={me} detail={detail} onChange={loadDetail} onClose={() => setShowMembers(false)} />}
      </div>
      <form className="chat-compose" onSubmit={send}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) send(e);
          }}
          placeholder="Write a message…"
          rows={1}
          maxLength={4000}
          aria-label="Message"
        />
        <button className="btn primary" disabled={!text.trim() || sending}>Send</button>
      </form>
    </section>
  );
}

function ChatInner({ me }: { me: Me }) {
  const router = useRouter();
  const params = useSearchParams();
  const active = params.get('c');
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => api<{ channels: Channel[] }>('/api/chat/channels').then((r) => setChannels(r.channels)).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    load();
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  const open = (id: string) => {
    setCreating(false);
    router.push(`/chat?c=${id}`);
    load();
  };

  return (
    <>
      <div className="row space page-head">
        <h1>Chat</h1>
        <button className="btn primary small" onClick={() => setCreating(true)}>+ New</button>
      </div>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      <div className={`chat ${active ? 'has-active' : ''}`}>
        <nav className="chat-list card" aria-label="Conversations">
          {channels === null && <div className="muted small" style={{ padding: '1rem' }}>Loading…</div>}
          {channels?.length === 0 && <div className="muted small" style={{ padding: '1rem' }}>No conversations yet. Start one with “+ New”.</div>}
          {channels?.map((c) => (
            <button key={c.id} className={`chat-item ${c.id === active ? 'on' : ''}`} onClick={() => open(c.id)}>
              <span className="chat-ico" aria-hidden="true">{c.kind === 'dm' ? (c.name ?? '?')[0] : c.kind === 'event' ? '📅' : '#'}</span>
              <span className="chat-meta">
                <span className="chat-name">
                  {c.name ?? 'Conversation'} {c.muted && <span title="Muted">🔕</span>}
                </span>
                <span className="chat-last muted small">{c.last_body ? `${c.kind !== 'dm' && c.last_user ? c.last_user + ': ' : ''}${short(c.last_body)}` : 'No messages yet'}</span>
              </span>
              {c.unread > 0 && <span className="bell-badge static" aria-label={`${c.unread} unread`}>{c.unread > 99 ? '99+' : c.unread}</span>}
            </button>
          ))}
        </nav>
        {active ? (
          <Thread key={active} me={me} id={active} onBack={() => router.push('/chat')} onChanged={load} />
        ) : (
          <section className="chat-thread chat-empty muted">Pick a conversation or start a new one.</section>
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
