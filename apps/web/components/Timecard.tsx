'use client';
import { fmtTime } from '@/lib/api';

export type CardItem = {
  kind: 'punch' | 'event'; id: string; in: string; out: string | null; breakMin: number; minutes: number; note?: string | null; status: string;
  source?: string; edited?: boolean; inLoc?: { lat: number; lng: number; acc: number | null } | null; outLoc?: { lat: number; lng: number; acc: number | null } | null;
  event?: string; eventId?: string; role?: string;
};
export type CardDay = { date: string; minutes: number; items: CardItem[] };

export const hm = (min: number) => `${Math.floor(min / 60)}h ${String(Math.round(min % 60)).padStart(2, '0')}m`;
export const clockFace = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
export const mapLink = (l: { lat: number; lng: number }) => `https://www.google.com/maps?q=${l.lat},${l.lng}`;

/** One punch or event entry on a timecard. */
export function CardLine({ i, children }: { i: CardItem; children?: React.ReactNode }) {
  return (
    <li className={`tc-line${i.kind === 'event' ? ' ev' : ''}`}>
      <span className="tc-when">{fmtTime(i.in)} – {i.out ? fmtTime(i.out) : <b className="tc-on">on the clock</b>}</span>
      <span className="tc-what">
        {i.kind === 'event' ? <>Event · {i.role} · {i.event}</> : <>Time clock{i.source === 'office' ? ' · added by the office' : i.edited ? ' · edited' : ''}</>}
        {i.breakMin > 0 && <span className="muted"> · {i.breakMin} min break</span>}
        {i.note && <span className="tc-note">“{i.note}”</span>}
        {(i.inLoc || i.outLoc) && (
          <span className="tc-locs">
            {i.inLoc && <a href={mapLink(i.inLoc)} target="_blank" rel="noreferrer">In location</a>}
            {i.outLoc && <a href={mapLink(i.outLoc)} target="_blank" rel="noreferrer">Out location</a>}
          </span>
        )}
      </span>
      <span className="tc-hrs">{hm(i.minutes)}{i.status === 'approved' && <span className="tc-ok" title="Approved"> ✓</span>}</span>
      {children}
    </li>
  );
}

