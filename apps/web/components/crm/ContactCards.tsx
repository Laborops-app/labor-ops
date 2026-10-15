'use client';
import { useEffect, useRef, useState } from 'react';
import Modal from '@/components/Modal';
import { avClass, initialsOf } from '@/components/TopbarAction';
import { BriefcaseIcon, BuildingIcon, CalendarIcon, DotsHIcon, DotsVIcon, IdIcon, MailIcon, NoteIcon, PhoneIcon, PinIcon, SendIcon } from './icons';

export type Contact = { id: string; name: string; title: string | null; email: string | null; phone: string | null; notes: string | null; is_primary: boolean; created_at?: string };

const tel = (p: string) => `tel:${p.replace(/[^\d+]/g, '')}`;
const sms = (p: string) => `sms:${p.replace(/[^\d+]/g, '')}`;
const added = (iso?: string) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) : null);

/** The three-dot menu on a card: edit, make main contact, remove. */
function CardMenu({ c, onEdit, onMain, onRemove }: { c: Contact; onEdit: () => void; onMain: () => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);
  const pick = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(false);
    fn();
  };
  return (
    <div className="ct-menu" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="ct-kebab" aria-label={`Options for ${c.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}><DotsVIcon size={20} /></button>
      {open && (
        <div className="ct-pop" role="menu">
          <button role="menuitem" onClick={pick(onEdit)}>Edit contact</button>
          {!c.is_primary && <button role="menuitem" onClick={pick(onMain)}>Make main contact</button>}
          <button role="menuitem" className="danger" onClick={pick(onRemove)}>Remove</button>
        </div>
      )}
    </div>
  );
}

/** Contacts as a grid of cards (Contacts · Grid design). Clicking a card opens its details. */
export function ContactGrid({ contacts, onOpen, onEdit, onMain, onRemove }: {
  contacts: Contact[]; onOpen: (c: Contact) => void; onEdit: (c: Contact) => void; onMain: (c: Contact) => void; onRemove: (c: Contact) => void;
}) {
  return (
    <div className="ct-grid">
      {contacts.map((c) => (
        <article
          key={c.id}
          className="ct-card"
          tabIndex={0}
          aria-label={`${c.name}${c.title ? `, ${c.title}` : ''}. Open details`}
          onClick={() => onOpen(c)}
          onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onOpen(c); }}
        >
          <div className="ct-top">
            <span className={`${avClass(c.name)} ct-av`} aria-hidden="true">{initialsOf(c.name)}</span>
            <div className="ct-who">
              <b>{c.name}</b>
              <span className="ct-role"><BriefcaseIcon size={16} />{c.title || <span className="muted">No role</span>}</span>
            </div>
            <CardMenu c={c} onEdit={() => onEdit(c)} onMain={() => onMain(c)} onRemove={() => onRemove(c)} />
          </div>
          <span className={`ct-badge ${c.is_primary ? 'main' : ''}`}>{c.is_primary ? 'Main contact' : 'Contact'}</span>
          <div className="ct-lines">
            <span><MailIcon />{c.email ? <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()}>{c.email}</a> : <span className="muted">No email</span>}</span>
            <span><PhoneIcon />{c.phone ? <span>{c.phone}</span> : <span className="muted">No phone</span>}</span>
          </div>
          <div className="ct-acts" onClick={(e) => e.stopPropagation()}>
            {c.phone ? <a className="btn" href={tel(c.phone)}><PhoneIcon size={16} /> Call</a> : <button className="btn" disabled title="No phone number"><PhoneIcon size={16} /> Call</button>}
            {c.email ? <a className="btn" href={`mailto:${c.email}`}><MailIcon size={16} /> Mail</a> : <button className="btn" disabled title="No email"><MailIcon size={16} /> Mail</button>}
          </div>
        </article>
      ))}
    </div>
  );
}

/** Contact Details popup: who they are on the left with quick actions, their details on the right. */
export function ContactDetails({ c, company, address, onClose, onEdit }: { c: Contact; company: string; address: string | null; onClose: () => void; onEdit: () => void }) {
  const Act = ({ href, label, icon, onClick }: { href?: string | null; label: string; icon: React.ReactNode; onClick?: () => void }) =>
    href || onClick ? (
      href ? (
        <a className="cd-act" href={href}><span>{icon}</span>{label}</a>
      ) : (
        <button className="cd-act" onClick={onClick}><span>{icon}</span>{label}</button>
      )
    ) : (
      <span className="cd-act off" aria-disabled="true" title={`No ${label === 'Mail' ? 'email' : 'phone number'}`}><span>{icon}</span>{label}</span>
    );
  return (
    <Modal title="Contact Details" onClose={onClose} wide>
      <div className="cd">
        <div className="cd-left">
          <span className={`${avClass(c.name)} cd-av`} aria-hidden="true">{initialsOf(c.name)}</span>
          <b className="cd-name">{c.name}</b>
          <span className="cd-pill"><i aria-hidden="true" />{c.is_primary ? 'Main contact' : `Contact at ${company}`}</span>
          <div className="cd-acts">
            <Act href={c.phone ? tel(c.phone) : null} label="Call" icon={<PhoneIcon size={20} />} />
            <Act href={c.email ? `mailto:${c.email}` : null} label="Mail" icon={<MailIcon size={20} />} />
            <Act href={c.phone ? sms(c.phone) : null} label="Message" icon={<SendIcon size={20} />} />
            <Act onClick={onEdit} label="Edit" icon={<DotsHIcon size={20} />} />
          </div>
        </div>
        <div className="cd-right">
          <h3>Contact Information</h3>
          <ul className="cd-list">
            <li><IdIcon />{c.title || <span className="muted">No role</span>}</li>
            <li><MailIcon />{c.email ? <a href={`mailto:${c.email}`}>{c.email}</a> : <span className="muted">No email</span>}</li>
            <li><PhoneIcon />{c.phone || <span className="muted">No phone</span>}</li>
            <li><BuildingIcon />{company}</li>
          </ul>
          <h3>More</h3>
          <ul className="cd-list">
            <li><PinIcon />{address || <span className="muted">No address for {company}</span>}</li>
            {added(c.created_at) && <li><CalendarIcon />Added {added(c.created_at)}</li>}
            <li className="cd-notes"><NoteIcon /><span>{c.notes || <span className="muted">No notes</span>}</span></li>
          </ul>
        </div>
      </div>
    </Modal>
  );
}
