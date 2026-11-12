'use client';
import { useTabTitle } from '@/lib/tabs';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import Shell from '@/components/Shell';
import { Banner, Empty, Pill } from '@/components/ui';
import { roleKey } from '@/components/Stars';
import { EventRatings } from '@/components/Rating';
import { PRIORITY, STATUS, STATUS_ORDER, type PipelineStatus, type Priority } from '@/lib/pipeline';
import FillFromGroup from '@/components/FillFromGroup';
import CrewPick, { PickOption } from '@/components/CrewPick';
import TimeEdit from '@/components/TimeEdit';
import Modal from '@/components/Modal';
import ActionMenu, { ActIcon } from '@/components/ActionMenu';
import EventDocs from '@/components/EventDocs';
import WavePanel from '@/components/WavePanel';
import QrPanel from '@/components/QrPanel';
import { EventFormsCard } from '@/components/docs/SignedDocs';
import CrewMenu, { CrewPayForm, type CrewMenuItem } from '@/components/CrewMenu';
import InvoicePanel from '@/components/InvoicePanel';
import HrEventView from '@/components/HrEventView';
import EventCrewSearch from '@/components/EventCrewSearch';
import EventUpdates from '@/components/EventUpdates';
import { EventRuleSet } from '@/components/WorkRuleSets';
import AutoFill from '@/components/AutoFill';
import TopbarAction, { PlusIcon, TrashIcon, avClass, initialsOf } from '@/components/TopbarAction';
import CopyEvent from '@/components/CopyEvent';
import QuickAdd, { type RoleDefault } from '@/components/QuickAdd';
import CopyPhase from '@/components/CopyPhase';
import NeedsAttention from '@/components/NeedsAttention';
import AvailCheck from '@/components/AvailCheck';
import { setWallZone, wallZone, deviceZone, zoneLabel } from '@/lib/wallZone';
import { api, ApiError, Me, fmtDate, fmtDateTime, fmtTime, money, peek } from '@/lib/api';

// The time zone each event page used, so going back to it opens in the right zone straight away.
const knownZone = new Map<string, string | null>();
import LaborBudget from '@/components/LaborBudget';
import RolePicker from '@/components/RolePicker';
import { EventDetails, Phases, Clocking, RentmanCard, EventFull, Phase, RmView } from '@/components/EventInfo';
import { useSkillNames, useSkillSections } from '@/components/SkillPicker';
import { askConfirm, undoable } from '@/components/Toasts';
import Skeleton from '@/components/Skeleton';

type Assignment = { id: string; user_id: string; user_name: string; status: string; is_lead?: boolean; created_at?: string; nudged_at?: string | null; late_eta?: string | null; late_note?: string | null; planned?: boolean; clocked_in_at?: string | null; last_clock_out?: string | null; pay_type?: 'hourly' | 'day'; rate?: number | null; estimated_pay?: number | null };
type CrewRate = { user_id: string; user_name: string; role_name?: string; pay_type: 'hourly' | 'day'; rate: number; note: string | null };
type Elig = { user_id: string; missing_certs: string[]; time_off: boolean; outside_availability: boolean; booked?: { role_name: string; event_name: string; starts_at: string; ends_at: string } | null };
/** Stars for a position; on a lead role ("Audio Lead") the rating as that position ("Audio") counts. */
const starsFor = (m: { ratings?: Record<string, number> }, role: string) => {
  if (!role) return 0;
  const k = roleKey(role);
  return m.ratings?.[k] ?? m.ratings?.[k.replace(/\s*\blead$/, '').trim()] ?? 0;
};
/** Stars to show and sort by: their rating for this position, else their overall average (marked "overall"). */
const starsShown = (m: Member, role: string): { v: number; overall: boolean } => {
  const pos = starsFor(m, role);
  if (pos) return { v: pos, overall: false };
  return m.rating_avg ? { v: Number(m.rating_avg), overall: true } : { v: 0, overall: false };
};
/** One crew member as an option in the crew picker: why they can or cannot work it, and their stars for the position. */
const pickOption = (m: Member, e: Elig | undefined, stars: { v: number; overall: boolean } | number, sub?: string, eventName?: string): PickOption => {
  const st = typeof stars === 'number' ? { v: stars, overall: false } : stars;
  const kind = e?.missing_certs.length ? 'blocked' : e?.booked ? 'busy' : e?.time_off || e?.outside_availability ? 'soft' : 'ok';
  const note =
    kind === 'blocked' ? `needs ${e!.missing_certs.join(', ')}`
    : kind === 'busy' ? `Booked: ${e!.booked!.role_name}${e!.booked!.event_name === eventName ? ' on this event' : ` at ${e!.booked!.event_name}`}, ${fmtTime(e!.booked!.starts_at)}–${fmtTime(e!.booked!.ends_at)}`
    : kind === 'soft' ? (e?.time_off ? 'time off' : 'not available then')
    : undefined;
  return { id: m.id, name: m.name, sub: sub ?? m.skills.join(', '), stars: st.v || undefined, starsOverall: st.overall, kind, note, flag: kind === 'blocked' ? undefined : flagOf(m) };
};
type Shift = {
  id: string;
  lead_shift_id?: string | null;
  min_hours?: string | number | null;
  role_name: string;
  starts_at: string;
  ends_at: string;
  headcount: number;
  is_open: boolean;
  required_certs: string[];
  assignments: Assignment[];
  crew_status: Elig[];
  phase_id: string | null;
  group_id?: string | null;
  hourly_rate?: number | null;
  role_rate?: number | null;
  pay_rate_override?: string | null;
  estimated_cost?: number | null;
  unpriced_seats?: number;
  pay_type?: 'hourly' | 'day';
  ot_hours?: number;
  dt_hours?: number;
};
type Overtime = { otAfter: number | null; state: string | null; effectiveState: string | null; stateFromAddress: boolean; companyDailyOt: number; otMult: number; dtAfter: number | null; dtMult: number };
type PGroup = { id: string; phase_id: string; label: string; sort: number };
type Detail = { event: EventFull; shifts: Shift[]; phases: Phase[]; groups?: PGroup[]; overtime?: Overtime; crewRates?: CrewRate[] };
type Member = { id: string; name: string; role: string; skills: string[]; active: boolean; ratings?: Record<string, number>; rating_avg?: number | null; review_count?: number; no_show_count?: number; no_rehire_count?: number };
const times = (n: number) => (n === 1 ? '' : ` ×${n}`);
/** Short warning for the crew picker, from past reviews. */
const LEAD_ROLE = /(\(\s*lead\s*\)|\blead)\s*$/i;
const flagOf = (m: Member) => [m.no_rehire_count ? `Do not rehire${times(m.no_rehire_count)}` : '', m.no_show_count ? `No-show${times(m.no_show_count)}` : ''].filter(Boolean).join(' · ') || undefined;
type TplItem = { role: string; section?: string; dayOffset: number; start: string; end: string; headcount: number; isOpen: boolean; requiredCerts: string[] };
type Template = { id: string; name: string; items: TplItem[]; customer_id?: string | null };

const p2 = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
const dateOnly = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const hhmm = (d: Date) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const parseDate = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const at = (day: Date, time: string) => {
  const [h, m] = time.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h!, m!, 0, 0);
};
const certs = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Body({ me }: { me: Me }) {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  // Opens with what it showed last time (this tab), in the venue's zone, while the fresh copy loads.
  const [d, setD] = useState<Detail | null>(() => { if (knownZone.has(id)) setWallZone(knownZone.get(id)!); return peek<Detail>(`/api/events/${id}`); });
  const [crew, setCrew] = useState<Member[]>([]);
  const [crewGroups, setCrewGroups] = useState<{ id: string; name: string }[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [rmBuilding, setRmBuilding] = useState(false);
  const [copySignal, setCopySignal] = useState(0);
  // Building quietly: when the last open spot gets a pick, ask whether to send every request now or later.
  const [fullAsk, setFullAsk] = useState(false);
  const wasFull = useRef<boolean | null>(null);
  useEffect(() => {
    if (!d) return;
    const planned = d.shifts.reduce((k, s) => k + s.assignments.filter((a) => a.planned).length, 0);
    const full = !!d.event.staffing_draft && planned > 0 && d.shifts.length > 0
      && d.shifts.every((s) => s.assignments.filter((a) => a.status !== 'declined').length >= s.headcount);
    // Only when it becomes full while you're working (not every time a fully planned event is opened).
    if (full && wasFull.current === false) setFullAsk(true);
    if (!full) setFullAsk(false);
    wasFull.current = full;
  }, [d]);
  const [adding, setAdding] = useState<string | null>(null); // shift id whose crew picker is open ('new' = the add-shift form)
  // "Add as lead" in the open crew picker: on for lead roles ("Audio Lead"), off otherwise.
  const [asLead, setAsLead] = useState(false);
  const [busyAdd, setBusyAdd] = useState(false);
  const [payEdit, setPayEdit] = useState<{ id: string; value: string } | null>(null);
  // Editing a shift's role and times, or a phase's name and dates, in place.
  const [timeEdit, setTimeEdit] = useState<{ id: string; role: string; start: string; end: string; head: string } | null>(null);
  // The day (phase) whose shifts are on screen: a phase id, 'none', 'all', or '' for the first day.
  const [day, setDay] = useState('');
  const [phaseEdit, setPhaseEdit] = useState<{ id: string; label: string; start: string; end: string; move: boolean } | null>(null);
  const formDated = useRef(false);
  // Collapsed phases on this event, remembered in this browser.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      setClosed(new Set(JSON.parse(localStorage.getItem(`lo_phase_closed:${id}`) ?? '[]')));
    } catch {
      /* storage blocked */
    }
  }, [id]);
  const setClosedSaved = (next: Set<string>) => {
    setClosed(next);
    try {
      localStorage.setItem(`lo_phase_closed:${id}`, JSON.stringify([...next]));
    } catch {
      /* storage blocked */
    }
  };
  // Adding (no id) or renaming a named group inside a phase.
  const [groupEdit, setGroupEdit] = useState<{ phaseId: string; id?: string; label: string } | null>(null);
  // Linking crew shifts to a lead shift: the shift being edited and the shifts ticked.
  const [teamEdit, setTeamEdit] = useState<{ id: string; picked: Set<string> } | null>(null);
  // Adding time for someone who never clocked in (assignment id).
  const [docsOpen, setDocsOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  // On a phone or a narrow window the side column drops below the shifts, so what needs the coordinator moves to the top.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1180px)');
    const on = () => setNarrow(mq.matches);
    on();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  const [reminding, setReminding] = useState(false);
  // Offer waves: the shift whose window is open, and which shifts have a plan (for the chips).
  const [waveShift, setWaveShift] = useState<string | null>(null);
  const [wavePlans, setWavePlans] = useState<Record<string, { status: string; wave: number }>>({});
  const loadWaves = useCallback(() => {
    api<{ plans: { shift_id: string; status: string; wave: number }[] }>(`/api/events/${id}/waves`).then((r) => setWavePlans(Object.fromEntries(r.plans.map((p) => [p.shift_id, p])))).catch(() => {});
  }, [id]);
  useEffect(() => { loadWaves(); }, [loadWaves]);
  const [addTime, setAddTime] = useState<string | null>(null);
  // Right-click (or ⋯) menu on a crew member: which shift and assignment, and where it opens.
  const [crewMenu, setCrewMenu] = useState<{ sid: string; aid: string; x: number; y: number } | null>(null);
  // Select mode: tick several crew, then message, confirm, move or remove them together. null = off.
  const [sel, setSel] = useState<Set<string> | null>(null);
  const [msgPeople, setMsgPeople] = useState<string[] | undefined>(undefined);
  const [bulkBusy, setBulkBusy] = useState(false);
  const toggleSel = (aid: string) => setSel((x) => { if (!x) return x; const n = new Set(x); if (n.has(aid)) n.delete(aid); else n.add(aid); return n; });
  // Who is free for the shift being added (checked against its date, time and certificates while the picker is open).
  const [newElig, setNewElig] = useState<Map<string, Elig> | null>(null);
  // "Confirm automatically": crew are put straight on the shift instead of being asked to accept. Remembered on this device.
  const [autoConfirm, setAutoConfirmState] = useState(false);
  useEffect(() => {
    try {
      setAutoConfirmState(localStorage.getItem('lo_auto_confirm') === '1');
    } catch {
      /* storage unavailable */
    }
  }, []);
  const setAutoConfirm = (v: boolean) => {
    setAutoConfirmState(v);
    try {
      localStorage.setItem('lo_auto_confirm', v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const [f, setF] = useState(() => {
    // New shifts start at 8:00 AM for 8 hours (the date follows the event or phase you add to).
    const s = new Date();
    s.setDate(s.getDate() + 1);
    s.setHours(8, 0, 0, 0);
    return {
      roleName: '',
      startsAt: localInput(s),
      endsAt: localInput(new Date(s.getTime() + 8 * 3600_000)),
      headcount: 1,
      certs: '',
      isOpen: false,
      phaseId: '',
      groupId: '',
      payType: 'hourly' as 'hourly' | 'day',
      minHours: '' as '' | '4' | '5',
      crew: [] as string[],
      repeat: false,
      days: [] as number[],
      until: '',
    };
  });
  const skillNames = useSkillNames();
  const skillSections = useSkillSections();
  const [otherRole, setOtherRole] = useState(false);
  const [tplId, setTplId] = useState('');
  const [tplPhase, setTplPhase] = useState('');
  // Event settings panel: clock-in, overtime and shift templates live here to keep the page short.
  const [settings, setSettings] = useState<null | 'clock' | 'ot' | 'tpl' | 'pay' | 'rentman' | 'invoice' | 'rate' | 'update' | 'autofill' | 'avail'>(null);
  // Quick add (grid) or copy-to-other-days open under one phase.
  const [quick, setQuick] = useState<{ phaseId: string; kind: 'add' | 'copy' } | null>(null);
  // Defaults each role starts with (people needed, start and end).
  const [roleDefaults, setRoleDefaults] = useState<RoleDefault[]>([]);
  // Auto-fill from the people who said they're free in an "Are you free?" check.
  const [afCheck, setAfCheck] = useState('');
  const [freeChecks, setFreeChecks] = useState<{ id: string; label: string }[]>([]);
  const [evTplName, setEvTplName] = useState('');
  const [evTplCust, setEvTplCust] = useState(false);
  const [rateInfo, setRateInfo] = useState<{ rated: number; total: number; due: number } | null>(null);
  const loadRateInfo = () =>
    api<{ workers: { ended: boolean; review_id: string | null }[]; rated: number; total: number }>(`/api/events/${id}/reviews`)
      .then((r) => setRateInfo({ rated: r.rated, total: r.total, due: r.workers.filter((w) => w.ended && !w.review_id).length }))
      .catch(() => undefined);
  useEffect(() => {
    loadRateInfo();
    if (new URLSearchParams(window.location.search).get('rate')) setSettings('rate');
    // From the "Ready to invoice" message.
    else if (window.location.hash === '#invoice' && (me.role === 'admin' || me.canAdjustRates)) setSettings('invoice');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  // Rentman lives in the same side panel, opened from its own button next to Event settings.
  const [rm, setRm] = useState<RmView | null>(null);
  // The customer's main contact, shown in the strip at the top (like the design's Deal Details).
  const [custInfo, setCustInfo] = useState<{ id: string; name: string; contact: string | null; email: string | null; phone: string | null } | null>(null);
  const custId = d?.event.customer_id ?? null;
  useEffect(() => {
    if (!custId) return setCustInfo(null);
    api<{ customer: { id: string; name: string }; contacts: { name: string; email: string | null; phone: string | null; is_primary: boolean }[] }>(`/api/customers/${custId}`)
      .then((r) => {
        const m = r.contacts.find((x) => x.is_primary) ?? r.contacts[0];
        setCustInfo({ id: r.customer.id, name: r.customer.name, contact: m?.name ?? null, email: m?.email ?? null, phone: m?.phone ?? null });
      })
      .catch(() => setCustInfo(null));
  }, [custId]);
  useEffect(() => {
    api<RmView>(`/api/events/${id}/rentman`).then(setRm).catch(() => setRm(null));
  }, [id]);
  useEffect(() => {
    if (settings !== 'autofill') return;
    api<{ checks: { id: string; dates: string[]; answers: { answered_at: string | null; free_dates: string[] | null }[] }[] }>(`/api/events/${id}/avail-checks`)
      .then((r) =>
        setFreeChecks(
          r.checks
            .map((k) => ({ k, n: k.answers.filter((a) => a.answered_at && a.free_dates?.length).length }))
            .filter((x) => x.n > 0)
            .map(({ k, n }) => ({ id: k.id, label: `${n} free · ${k.dates.map((d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' })).join(', ')}` })),
        ),
      )
      .catch(() => setFreeChecks([]));
  }, [settings, id]);
  useEffect(() => {
    if (!settings) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setSettings(null);
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  }, [settings]);
  const shiftForm = useRef<HTMLElement | HTMLDivElement>(null);
  // The add-shift form opens in a window.
  const [shiftModal, setShiftModal] = useState(false);
  const openShiftModal = () => {
    setError('');
    setShiftModal(true);
    setTimeout(() => (shiftForm.current?.querySelector('select, input') as HTMLElement | null)?.focus(), 80);
  };
  const [tplStart, setTplStart] = useState('');
  const [tplName, setTplName] = useState('');

  const load = (): Promise<void> =>
    api<Detail>(`/api/events/${id}`)
      .then((r) => {
        // A venue in another time zone: show and enter every time on this page in the venue's time (see lib/wallZone).
        const tz = (r.event as { timezone?: string | null }).timezone || (r as { companyTimezone?: string }).companyTimezone || null;
        const want = tz && tz !== deviceZone() ? tz : null;
        knownZone.set(id, want);
        if (want !== wallZone()) { setWallZone(want); return load(); }
        setD(r);
        setTplStart((v) => v || r.event.start_date.slice(0, 10));
        // The add-shift form starts on the event's first day (not tomorrow); times and length are kept.
        if (!formDated.current) {
          formDated.current = true;
          const day = r.event.start_date.slice(0, 10);
          setF((x) => {
            const len = new Date(x.endsAt).getTime() - new Date(x.startsAt).getTime();
            const st = new Date(`${day}T${x.startsAt.slice(11)}`);
            return { ...x, startsAt: localInput(st), endsAt: localInput(new Date(st.getTime() + len)) };
          });
        }
      })
      .catch((e) => setError(e.message));
  const customerId = d?.event.customer_id ?? null;
  const loadTemplates = () => api<{ templates: Template[] }>(`/api/templates${customerId ? `?customerId=${customerId}` : ''}`).then((r) => setTemplates(r.templates));
  const [tplForCustomer, setTplForCustomer] = useState(false);
  // Leaving the event page goes back to this device's own time zone.
  useEffect(() => () => setWallZone(null), []);
  useEffect(() => {
    load();
    api<{ crew: Member[] }>('/api/crew').then((r) => setCrew(r.crew.filter((m) => m.role === 'crew' && m.active)));
    api<{ groups: { id: string; name: string }[] }>('/api/crew-groups').then((r) => setCrewGroups(r.groups)).catch(() => {});
    api<{ roles: RoleDefault[] }>('/api/role-defaults').then((r) => setRoleDefaults(r.roles)).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  useEffect(() => {
    if (d) loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, customerId, !!d]);

  const buildFromRentmanNow = async () => {
                  setRmBuilding(true);
                  setError('');
                  setNote('');
                  try {
                    const r = await api<{ result: { added: number; updated: number; removed: number; unchanged: number; conflicts: number } | null; unmatched: string[]; unscheduled: number }>(`/api/events/${id}/rentman/build`, { body: {} });
                    const x = r.result;
                    const done = x ? [x.added && `${x.added} added`, x.updated && `${x.updated} updated`, x.removed && `${x.removed} removed`].filter(Boolean).join(', ') : '';
                    const more = [
                      x?.conflicts ? `${x.conflicts} change${x.conflicts === 1 ? '' : 's'} need you to decide (open Rentman)` : '',
                      r.unmatched?.length ? `Rentman names with no LaborOps role yet: ${r.unmatched.join(', ')} (map them under Integrations › Rentman)` : '',
                      r.unscheduled ? `${r.unscheduled} Rentman function${r.unscheduled === 1 ? ' has' : 's have'} no times yet and ${r.unscheduled === 1 ? 'was' : 'were'} skipped` : '',
                    ].filter(Boolean).join('. ');
                    setNote(`${done ? `Crew built from Rentman: ${done}.` : 'The crew is already up to date with Rentman.'}${more ? ` ${more}.` : ''}`);
                    await load();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setRmBuilding(false);
                  }
  };
  const publish = async () => {
    setError(''); setNote('');
    try {
      const r = await api<{ offered: number; confirmed: number; failed: { name: string; role: string; error: string }[] }>(`/api/events/${id}/publish`, { body: {} });
      const parts = [r.offered && `${r.offered} offer${r.offered === 1 ? '' : 's'} sent`, r.confirmed && `${r.confirmed} confirmed booking${r.confirmed === 1 ? '' : 's'} sent`].filter(Boolean).join(', ');
      setNote(`Crew requested${parts ? `: ${parts}` : ''}.`);
      if (r.failed.length) setError(`Not sent: ${r.failed.map((f) => `${f.name} (${f.role}): ${f.error}`).join(' ')}`);
    } catch (e) { setError((e as Error).message); }
    load();
  };
  // Removals wait 5 seconds with Undo: the row disappears now, and the change (and any message to the crew) only goes out after.
  const removeLater = (text: string, url: string, hide: (x: Detail) => Detail) =>
    undoable(text, async () => { await api(url, { method: 'DELETE' }); await load(); }, { hide: () => setD((x) => (x ? hide(x) : x)), restore: () => { load(); } });
  const dropAssignment = (aid: string) => (x: Detail): Detail => ({ ...x, shifts: x.shifts.map((sh) => ({ ...sh, assignments: sh.assignments.filter((a) => a.id !== aid) })) });
  const dropShift = (sid: string) => (x: Detail): Detail => ({ ...x, shifts: x.shifts.filter((sh) => sh.id !== sid) });
  const run = async (fn: () => Promise<unknown>, okMsg = '') => {
    setError('');
    setNote('');
    try {
      await fn();
      if (okMsg) setNote(okMsg);
      await load();
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    }
  };

  const saveTime = async (force = false): Promise<void> => {
    if (!timeEdit) return;
    const st = new Date(timeEdit.start), en = new Date(timeEdit.end);
    if (!(en > st)) return setError('The shift must end after it starts.');
    setError('');
    setNote('');
    try {
      await api(`/api/shifts/${timeEdit.id}`, { method: 'PATCH', body: { roleName: timeEdit.role.trim() || undefined, startsAt: st.toISOString(), endsAt: en.toISOString(), headcount: Number(timeEdit.head) >= 1 ? Math.round(Number(timeEdit.head)) : undefined, force: force || undefined } });
      setTimeEdit(null);
      setPayEdit(null);
      setNote('Shift updated. Anyone on it has been told about any new time.');
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.reason === 'clash' && !force && (await askConfirm(`${err.message}\n\nSave the new time anyway?`))) return saveTime(true);
      setError((err as Error).message);
    }
  };
  const savePhase = async () => {
    if (!phaseEdit) return;
    if (phaseEdit.end < phaseEdit.start) return setError('The phase ends before it starts.');
    setError('');
    setNote('');
    try {
      const r = await api<{ phase: { movedShifts?: number } }>(`/api/event-phases/${phaseEdit.id}`, { method: 'PATCH', body: { label: phaseEdit.label, startDate: phaseEdit.start, endDate: phaseEdit.end, moveShifts: phaseEdit.move } });
      setPhaseEdit(null);
      setNote(r.phase.movedShifts ? `Phase updated and ${r.phase.movedShifts} shift${r.phase.movedShifts === 1 ? '' : 's'} moved with it. Crew on them have been told.` : 'Phase updated.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** A role's defaults (people needed, start and end on the same day) applied to the add-shift form. */
  const withRole = <T extends { roleName: string; headcount: number; startsAt: string; endsAt: string }>(x: T, role: string): T => {
    const df = roleDefaults.find((r) => r.name.toLowerCase() === role.trim().toLowerCase());
    if (!df) return { ...x, roleName: role };
    const day = x.startsAt.slice(0, 10);
    const st = df.start ? `${day}T${df.start}` : x.startsAt;
    let en = x.endsAt;
    if (df.end) {
      en = `${day}T${df.end}`;
      if (new Date(en) <= new Date(st)) en = localInput(new Date(new Date(en).getTime() + 86_400_000));
    } else if (df.start) en = localInput(new Date(new Date(st).getTime() + (new Date(x.endsAt).getTime() - new Date(x.startsAt).getTime())));
    return { ...x, roleName: role, headcount: x.headcount === 1 && df.headcount ? df.headcount : x.headcount, startsAt: st, endsAt: en };
  };

  const addShift = async (e: React.FormEvent) => {
    e.preventDefault();
    const start = new Date(f.startsAt);
    const end = new Date(f.endsAt);
    const base = { roleName: f.roleName, headcount: Number(f.headcount), isOpen: f.isOpen, requiredCerts: certs(f.certs), phaseId: f.phaseId || null, groupId: f.groupId || null, payType: f.payType, minHours: f.payType === 'hourly' && f.minHours ? Number(f.minHours) : null };
    let ok: boolean;
    if (f.repeat) {
      if (!f.until || f.days.length === 0) return setError('Choose the days to repeat on and an end date.');
      const last = parseDate(f.until);
      const first = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      const span = Math.round((end.getTime() - start.getTime()) / 1000);
      const list: unknown[] = [];
      for (let day = first; day <= last; day = addDays(day, 1)) {
        if (!f.days.includes(day.getDay())) continue;
        const s = at(day, hhmm(start));
        list.push({ ...base, startsAt: s.toISOString(), endsAt: new Date(s.getTime() + span * 1000).toISOString() });
      }
      if (list.length === 0) return setError('No dates match those days.');
      if (list.length > 120) return setError('That would create more than 120 shifts. Choose a shorter range.');
      ok = await run(() => api(`/api/events/${id}/shifts/bulk`, { body: { shifts: list } }), `Created ${list.length} shifts.`);
    } else {
      // Crew picked in the form go straight onto the new shift (one more spot is added for each extra person).
      const picked = f.crew;
      let shiftId = '';
      ok = await run(async () => {
        shiftId = (await api<{ shift: { id: string } }>(`/api/events/${id}/shifts`, { body: { ...base, headcount: Math.max(base.headcount, picked.length), startsAt: start.toISOString(), endsAt: end.toISOString() } })).shift.id;
      });
      if (ok && picked.length) {
        const failed: string[] = [];
        for (const uid of picked) {
          const err = await assignUser(shiftId, uid);
          if (err) failed.push(`${crew.find((m) => m.id === uid)?.name ?? 'Someone'}: ${err}`);
        }
        await load();
        if (failed.length) setError(`Shift added, but not everyone could be put on it. ${failed.join(' ')}`);
        else setNote(`Shift added with ${picked.length} crew.`);
      }
    }
    if (ok) {
      setF((x) => ({ ...x, roleName: '', crew: [] }));
      setShiftModal(false);
    }
  };

  const applyTemplate = () => {
    const t = templates.find((x) => x.id === tplId);
    if (!t || !tplStart) return;
    const base = parseDate(tplStart);
    const shifts = t.items.map((it) => {
      const day = addDays(base, it.dayOffset);
      const s = at(day, it.start);
      let e = at(day, it.end);
      if (e <= s) e = at(addDays(day, 1), it.end);
      return { roleName: it.role, startsAt: s.toISOString(), endsAt: e.toISOString(), headcount: it.headcount, isOpen: it.isOpen, requiredCerts: it.requiredCerts, phaseId: tplPhase || d?.phases.find((p) => it.section && p.label.toLowerCase() === it.section.toLowerCase())?.id || null };
    });
    run(() => api(`/api/events/${id}/shifts/bulk`, { body: { shifts } }), `Added ${shifts.length} shifts from “${t.name}”.`);
  };

  const saveTemplate = async () => {
    if (!d || !tplName.trim() || d.shifts.length === 0) return;
    const starts = d.shifts.map((s) => new Date(s.starts_at));
    const base = new Date(Math.min(...starts.map((x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime())));
    const items: TplItem[] = d.shifts.slice(0, 60).map((s) => {
      const a = new Date(s.starts_at);
      const b = new Date(s.ends_at);
      const day = new Date(a.getFullYear(), a.getMonth(), a.getDate());
      return {
        role: s.role_name,
        dayOffset: Math.round((day.getTime() - base.getTime()) / 86_400_000),
        start: hhmm(a),
        end: hhmm(b),
        headcount: s.headcount,
        isOpen: s.is_open,
        requiredCerts: s.required_certs ?? [],
      };
    });
    if (await run(() => api('/api/templates', { body: { name: tplName.trim(), items, customerId: tplForCustomer && customerId ? customerId : undefined } }), `Saved template “${tplName.trim()}”.`)) {
      setTplName('');
      loadTemplates();
    }
  };

  /** Put one person on a shift. Returns an error message, or null when they were added. Rule breaks ask before overriding when `ask` is set. */
  const assignUser = async (shiftId: string, userId: string, override = false, ask = true, acceptFlags = false, lead?: boolean): Promise<string | null> => {
    try {
      const r = await api<{ warnings?: string[] }>(`/api/shifts/${shiftId}/assign`, { body: { userId, override: override || undefined, confirmed: autoConfirm || undefined, acceptFlags: acceptFlags || undefined, lead } });
      if (r.warnings?.length) setNote(r.warnings.join(' '));
      return null;
    } catch (err) {
      if (ask && err instanceof ApiError && err.reason === 'rules' && !override && (await askConfirm(`${err.message}\n\nAssign anyway?`))) return assignUser(shiftId, userId, true, ask, acceptFlags, lead);
      // Flagged in past reviews (No-show / Do not rehire): always ask, even when adding several people at once.
      if (err instanceof ApiError && err.reason === 'flagged' && !acceptFlags) {
        if ((await askConfirm(`⚠ ${err.message}\n\nAdd them to this shift anyway?`))) return assignUser(shiftId, userId, override, ask, true, lead);
        return 'Not added. ' + err.message;
      }
      return (err as Error).message;
    }
  };

  /** "+" on a shift: adds the person, and when every spot is taken adds a spot first. */
  const addCrew = async (s: Shift, userId: string, override: boolean, full: boolean, lead?: boolean) => {
    setError('');
    setNote('');
    setBusyAdd(true);
    try {
      if (full) await api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { headcount: s.headcount + 1 } });
      const err = await assignUser(s.id, userId, override, true, false, lead);
      if (err) {
        if (full) await api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { headcount: s.headcount } }).catch(() => undefined);
        setError(err);
      }
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyAdd(false);
    }
  };

  useEffect(() => {
    if (adding !== 'new') return;
    const st = new Date(f.startsAt), en = new Date(f.endsAt);
    if (isNaN(st.getTime()) || !(en > st)) return setNewElig(new Map());
    setNewElig(null);
    let live = true;
    const qs = new URLSearchParams({ startsAt: st.toISOString(), endsAt: en.toISOString(), certs: f.certs });
    api<{ crew_status: Elig[] }>(`/api/events/${id}/candidates?${qs}`)
      .then((r) => live && setNewElig(new Map(r.crew_status.map((x) => [x.user_id, x]))))
      .catch(() => live && setNewElig(new Map()));
    return () => { live = false; };
  }, [adding, f.startsAt, f.endsAt, f.certs, id]);

  // Opening a shift's picker: "Add as lead" starts on for lead roles ("Audio Lead", "Audio (Lead)").
  useEffect(() => {
    const sh = d?.shifts.find((x) => x.id === adding);
    setAsLead(!!sh && /(\(\s*lead\s*\)|\blead)\s*$/i.test(sh.role_name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);

  useTabTitle(d?.event.name);
  if (!d) return error ? <Banner>{error}</Banner> : <Skeleton kind="event" />;
  const ev = d.event;
  const plannedCount = d.shifts.reduce((k, x) => k + x.assignments.filter((a) => a.planned).length, 0);

  const shortWhen = (iso: string) => `${new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}, ${fmtTime(iso)}`;
  const isLeadShift = (s: Shift) => LEAD_ROLE.test(s.role_name) || s.assignments.some((a) => a.is_lead) || d.shifts.some((x) => x.lead_shift_id === s.id);
  /** Lead shifts: which crew shifts they lead (linked), with a picker to change it. */
  const teamRow = (s: Shift) => {
    if (!isLeadShift(s)) return null;
    const team = d.shifts.filter((x) => x.lead_shift_id === s.id);
    const open = () => {
      let picked = new Set(team.map((t) => t.id));
      if (!picked.size) {
        // Suggest the shifts in the lead's department (Roles & rates group) that overlap the lead shift.
        const base = s.role_name.replace(LEAD_ROLE, '').trim().toLowerCase();
        const sec = skillSections.find((x) => x.roles.some((r) => r.toLowerCase() === s.role_name.toLowerCase()) || x.label.toLowerCase() === base);
        const inDept = (role: string) => (sec ? sec.roles.some((r) => roleKey(r) === roleKey(role)) : roleKey(role) === base);
        picked = new Set(d.shifts.filter((x) => x.id !== s.id && !LEAD_ROLE.test(x.role_name) && inDept(x.role_name) && new Date(x.starts_at) < new Date(s.ends_at) && new Date(x.ends_at) > new Date(s.starts_at)).map((x) => x.id));
      }
      setTeamEdit({ id: s.id, picked });
    };
    if (teamEdit?.id === s.id) {
      const leadsOthers = new Set(d.shifts.map((x) => x.lead_shift_id).filter(Boolean) as string[]);
      const day = s.starts_at.slice(0, 10);
      const options = d.shifts
        .filter((x) => x.id !== s.id && !leadsOthers.has(x.id))
        .sort((a, b) => Number(b.starts_at.slice(0, 10) === day) - Number(a.starts_at.slice(0, 10) === day) || a.starts_at.localeCompare(b.starts_at) || a.role_name.localeCompare(b.role_name));
      return (
        <div className="team-edit">
          <b className="small">Which crew shifts does this lead lead?</b>
          <p className="muted small" style={{ margin: '2px 0 6px' }}>The lead checks in and rates exactly the crew on the shifts you tick. Leave all unticked to use their department on overlapping times.</p>
          <div className="team-list">
            {options.length === 0 && <span className="muted small">No other shifts on this event yet.</span>}
            {options.map((x) => {
              const other = x.lead_shift_id && x.lead_shift_id !== s.id ? d.shifts.find((y) => y.id === x.lead_shift_id) : null;
              const on = teamEdit.picked.has(x.id);
              return (
                <label key={x.id} className="check team-opt">
                  <input type="checkbox" checked={on} onChange={() => { const n = new Set(teamEdit.picked); if (on) n.delete(x.id); else n.add(x.id); setTeamEdit({ ...teamEdit, picked: n }); }} />
                  <span>
                    <b>{x.role_name}</b> <span className="muted small">{shortWhen(x.starts_at)}–{fmtTime(x.ends_at)} · {x.assignments.filter((a) => a.status !== 'declined').length}/{x.headcount}</span>
                    {other && <span className="muted small"> · now led by {other.role_name}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 6 }}>
            <button type="button" className="btn small primary" onClick={() => run(() => api(`/api/shifts/${s.id}/team`, { method: 'PUT', body: { shiftIds: [...teamEdit.picked] } }), teamEdit.picked.size ? `Linked ${teamEdit.picked.size} shift${teamEdit.picked.size === 1 ? '' : 's'} to ${s.role_name}.` : `${s.role_name} now leads its department.`).then((ok) => ok && setTeamEdit(null))}>Save</button>
            <button type="button" className="btn ghost small" onClick={() => setTeamEdit(null)}>Cancel</button>
          </div>
        </div>
      );
    }
    return (
      <div className="team-row">
        <span className="small"><b>Leads:</b></span>
        {team.length ? team.map((t) => <span key={t.id} className="chip">{t.role_name} · {shortWhen(t.starts_at)}</span>) : <span className="muted small">its department, on overlapping times</span>}
        <button type="button" className="btn ghost small" onClick={open}>{team.length ? 'Change team' : 'Link crew shifts'}</button>
      </div>
    );
  };

  const ago = (iso: string) => {
    const m = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
  };
  /** Seats as a bar: confirmed, waiting, not sent, open. One block per seat on a shift, proportional for big counts. */
  const seatBar = (c: number, w: number, n: number, o: number, big = false) => {
    const total = c + w + n + o;
    const kinds: [string, number][] = [['seat-ok', c], ['seat-wait', w], ['seat-plan', n], ['seat-open', o]];
    return (
      <div className={`cs-bar${big ? ' big' : ''}${total > 30 ? ' dense' : ''}`} role="img" aria-label={`${c} confirmed, ${w} waiting, ${n} not sent, ${o} open`}>
        {!big && total <= 80
          ? kinds.flatMap(([k, num]) => Array.from({ length: num }).map((_, i) => <span key={`${k}${i}`} className={k} />))
          : kinds.filter(([, num]) => num > 0).map(([k, num]) => <span key={k} className={k} style={{ flexGrow: num }} />)}
      </div>
    );
  };
  const dayShort = (a: string, b: string) => {
    const f1 = (x: string) => new Date(`${x.slice(0, 10)}T12:00:00`).toLocaleDateString([], { weekday: 'short', day: 'numeric' });
    return a.slice(0, 10) === b.slice(0, 10) ? f1(a) : `${f1(a)} – ${f1(b)}`;
  };
  const staff = (() => {
    // Only people who said yes count as staffed; offers waiting and quiet plans are shown apart.
    const slots = d.shifts.reduce((n, s) => n + s.headcount, 0);
    let conf = 0, wait = 0, plan = 0;
    for (const s of d.shifts) {
      const c = Math.min(s.headcount, s.assignments.filter((a) => a.status === 'accepted' && !a.planned).length);
      const w = Math.min(s.headcount - c, s.assignments.filter((a) => (a.status === 'offered' || a.status === 'pending') && !a.planned).length);
      const pl = Math.min(s.headcount - c - w, s.assignments.filter((a) => a.planned).length);
      conf += c; wait += w; plan += pl;
    }
    return { slots, conf, wait, plan, open: slots - conf - wait - plan };
  })();

  const renderShifts = (list: Shift[]) =>
    list.map((s) => {
          const active = s.assignments.filter((a) => a.status !== 'declined');
          const pending = s.assignments.filter((a) => a.status === 'pending');
          const assignedIds = new Set(s.assignments.map((a) => a.user_id));
          const full = active.length >= s.headcount;
          const st = new Map(s.crew_status.map((x) => [x.user_id, x]));
          const candidates = crew.filter((m) => !assignedIds.has(m.id)).map((m) => ({ m, e: st.get(m.id) }));
          const stars = (m: Member) => starsShown(m, s.role_name).v;
          const best = (a: { m: Member }, b: { m: Member }) => Number(!!flagOf(a.m)) - Number(!!flagOf(b.m)) || stars(b.m) - stars(a.m) || a.m.name.localeCompare(b.m.name);
          const options = [...candidates].sort(best).map(({ m, e }) => pickOption(m, e, starsShown(m, s.role_name), undefined, d.event.name));
          const rank = (a: Assignment) => (a.planned ? 2 : a.status === 'accepted' ? 0 : 1);
          const seated = [...active].sort((a, b) => rank(a) - rank(b));
          const declined = s.assignments.filter((a) => a.status === 'declined');
          const nPlan = active.filter((a) => a.planned).length;
          const nConf = active.filter((a) => !a.planned && a.status === 'accepted').length;
          const nWait = active.length - nConf - nPlan;
          const nOpen = Math.max(0, s.headcount - active.length);
          const hrs = Math.round((new Date(s.ends_at).getTime() - new Date(s.starts_at).getTime()) / 360_000) / 10;
          const editing = timeEdit?.id === s.id;
          const grp = (d.groups ?? []).find((x) => x.id === s.group_id);
          const allIn = nOpen === 0 && nConf >= s.headcount;
          const count = allIn ? `${nConf}/${s.headcount} full` : [`${nConf}/${s.headcount}`, nWait && `${nWait} waiting`, nPlan && `${nPlan} not sent`, nOpen && `${nOpen} open`].filter(Boolean).join(' · ');
          // Check in sits on the row from 2 hours before the start until the end; otherwise it is under the row's ⋯ menu.
          const soon = new Date(s.starts_at).getTime() - Date.now() < 2 * 3600_000 && new Date(s.ends_at).getTime() > Date.now();
          const startEdit = () => setTimeEdit({ id: s.id, role: s.role_name, start: localInput(new Date(s.starts_at)), end: localInput(new Date(s.ends_at)), head: String(s.headcount) });
          const stChip = (a: Assignment) =>
            a.planned ? <span className="cs-st plan" title="Building quietly: they'll get the offer when you publish">Not sent</span>
            : a.status === 'accepted' ? <span className="cs-st ok">Confirmed</span>
            : a.status === 'declined' ? <span className="cs-st no">Declined</span>
            : <span className="cs-st wait">{a.status === 'pending' ? 'Asked to work' : 'Waiting'}</span>;
          const crewRow = (a: Assignment, n: number | null) => {
            const nudged = !!a.nudged_at && Date.now() - new Date(a.nudged_at).getTime() < 3600_000;
            return (
              <li
                key={a.id}
                className={`cs-row${a.status === 'declined' ? ' off' : ''}${crewMenu?.aid === a.id ? ' menu-on' : ''}`}
                onContextMenu={(e) => {
                  // Right-click (long-press on a phone) opens this person's menu; inputs keep the browser's own menu.
                  if ((e.target as HTMLElement).closest('input, textarea, select')) return;
                  e.preventDefault();
                  setCrewMenu({ sid: s.id, aid: a.id, x: e.clientX, y: e.clientY });
                }}
              >
                {sel ? (
                  <label className="cs-pick"><input type="checkbox" checked={sel.has(a.id)} onChange={() => toggleSel(a.id)} aria-label={`Select ${a.user_name}`} /></label>
                ) : <span className="cs-n" aria-hidden="true">{n == null ? '–' : p2(n)}</span>}
                <div className="cs-who">
                  <div>
                    <b>{a.user_name}</b>
                    {a.is_lead && a.status !== 'declined' && <span className="cs-lead" title="Leads their department on this event: checks the team in and out and rates them on the On site page">Lead</span>}
                    {a.late_eta && !a.clocked_in_at && a.status === 'accepted' && <span className="cs-late" title={a.late_note ? `“${a.late_note}”` : 'Told us they are running late'}>Late · ~{fmtTime(a.late_eta)}</span>}
                    {a.rate != null && a.status !== 'declined' && (
                      <button type="button" className="chip" style={{ border: 0, cursor: 'pointer', marginLeft: 6 }} title="This person's own rate on this event. Click to change it." onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCrewMenu({ sid: s.id, aid: a.id, x: r.left, y: r.bottom + 4 }); }}>
                        {money(a.rate)}{a.pay_type === 'day' ? '/day' : '/hr'}
                      </button>
                    )}
                  </div>
                  {a.planned ? (
                    <span className="cs-sub">sent when you publish</span>
                  ) : a.clocked_in_at ? (
                    <span className="cs-sub">on site since {fmtTime(a.clocked_in_at)}</span>
                  ) : a.status === 'offered' && a.created_at ? (
                    <span className="cs-sub">
                      sent {ago(a.created_at)} ago ·{' '}
                      <button type="button" className="cs-link" disabled={nudged} title={nudged ? 'Reminded in the last hour' : 'Send a reminder to answer (push and text)'} onClick={() => run(() => api(`/api/assignments/${a.id}/nudge`, { body: {} }), `Reminded ${a.user_name}.`)}>
                        {nudged ? 'reminded' : 'remind'}
                      </button>
                    </span>
                  ) : null}
                </div>
                {stChip(a)}
                <span className="cs-acts">
                  {a.planned ? (
                    <>
                      <button type="button" className="cs-x" aria-label={`Take ${a.user_name} out of the plan`} title="Take out of the plan" onClick={() => run(() => api(`/api/planned-picks/${a.id}`, { method: 'DELETE' }), `${a.user_name} taken out of the plan.`)}>×</button>
                      <button type="button" className="act-dots" aria-label={`Options for ${a.user_name}`} aria-haspopup="menu" aria-expanded={crewMenu?.aid === a.id} title="Options (or right-click the row)" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCrewMenu(crewMenu?.aid === a.id ? null : { sid: s.id, aid: a.id, x: r.right - 280, y: r.bottom + 4 }); }}>
                        <ActIcon n="more" size={18} />
                      </button>
                    </>
                  ) : (
                    <>
                      {(a.status === 'offered' || a.status === 'pending') && (
                        <button type="button" className="btn small primary" onClick={() => run(() => api(`/api/assignments/${a.id}/confirm`, { body: {} }), `Confirmed ${a.user_name}.`)}>Confirm</button>
                      )}
                      {a.status === 'accepted' && !a.clocked_in_at && soon && (
                        <button type="button" className="btn small" onClick={() => run(() => api(`/api/assignments/${a.id}/check-in`, { body: {} }))}>Check in</button>
                      )}
                      {a.clocked_in_at && (
                        <button type="button" className="btn small" onClick={() => run(() => api(`/api/assignments/${a.id}/check-out`, { body: {} }))}>Check out</button>
                      )}
                      {editing && (
                        <button type="button" className="cs-x" aria-label={`Remove ${a.user_name} from this shift`} title="Remove from this shift" onClick={() => removeLater(`${a.user_name} removed from ${s.role_name}.`, `/api/assignments/${a.id}`, dropAssignment(a.id))}>×</button>
                      )}
                      <button
                        type="button"
                        className="act-dots"
                        aria-label={`Options for ${a.user_name}`}
                        aria-haspopup="menu"
                        aria-expanded={crewMenu?.aid === a.id}
                        title="Options (or right-click the row)"
                        onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setCrewMenu(crewMenu?.aid === a.id ? null : { sid: s.id, aid: a.id, x: r.right - 280, y: r.bottom + 4 }); }}
                      >
                        <ActIcon n="more" size={18} />
                      </button>
                    </>
                  )}
                </span>
                {addTime === a.id && (
                  <div className="cs-row-wide">
                    <TimeEdit
                      title={`Add time for ${a.user_name}`}
                      clockIn={s.starts_at}
                      clockOut={new Date(s.ends_at) < new Date() ? s.ends_at : null}
                      onSave={async (t) => {
                        const r = await api<{ entry: { auto_approved: boolean; status: string } }>(`/api/assignments/${a.id}/time`, { body: t });
                        setAddTime(null);
                        setNote(r.entry.auto_approved ? `Time added for ${a.user_name} and approved.` : `Time added for ${a.user_name}. See Timesheets to approve it.`);
                        await load();
                      }}
                      onCancel={() => setAddTime(null)}
                    />
                  </div>
                )}
              </li>
            );
          };
          return (
            <section className={`cs-card${editing ? ' editing' : ''}`} key={s.id} id={`shift-${s.id}`}>
              <div className="cs-left">
                <div className="cs-time">{fmtTime(s.starts_at)}</div>
                <div className="cs-end">→ {fmtTime(s.ends_at)} · {hrs}h</div>
                <div className="cs-date">{new Date(s.starts_at).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>
                <h2 className="cs-role">{s.role_name}</h2>
                <div className="cs-pay">
                  {[s.hourly_rate != null ? `${money(s.hourly_rate)}${s.pay_type === 'day' ? ' day rate' : '/hr'}` : '', grp?.label ?? ''].filter(Boolean).join(' · ')}
                </div>
                {seatBar(nConf, nWait, nPlan, nOpen)}
                <div className={`cs-count${allIn ? ' ok' : nOpen ? ' bad' : ''}`}>{count}</div>
                {(s.estimated_cost != null || (s.hourly_rate != null && (!!s.ot_hours || !!s.dt_hours))) && (
                  <div className="cs-cost">
                    {s.estimated_cost != null && `est. ${money(s.estimated_cost)} for ${s.headcount - (s.unpriced_seats ?? 0)}${s.unpriced_seats ? ` of ${s.headcount}` : ''}`}
                    {s.hourly_rate != null && !!s.ot_hours && ` · ${s.ot_hours} h overtime`}
                    {s.hourly_rate != null && !!s.dt_hours && ` · ${s.dt_hours} h double time`}
                  </div>
                )}
                {editing ? (
                  <div className="cs-editing">Editing</div>
                ) : (
                  <div className="cs-tools">
                    <button type="button" className="btn small act-btn" title="Change the role, date or time" onClick={startEdit}>
                      <ActIcon n="quiet" /> Edit
                    </button>
                    <button type="button" className="btn small cs-ico" aria-label={`Duplicate ${s.role_name}`} title="Add the same position again (same times and pay, no crew)" onClick={() => run(() => api(`/api/shifts/${s.id}/duplicate`, { body: {} }), `Added another ${s.role_name}.`)}>
                      <ActIcon n="copy" />
                    </button>
                    <button type="button" className="btn small cs-ico danger" aria-label={`Delete ${s.role_name}`} title="Delete this shift" onClick={() => { setTimeEdit(null); removeLater(`${s.role_name} shift deleted.`, `/api/shifts/${s.id}`, dropShift(s.id)); }}>
                      <ActIcon n="trash" />
                    </button>
                  </div>
                )}
              </div>
              <div className="cs-right">
                {(s.is_open || !!s.required_certs?.length || s.lead_shift_id || wavePlans[s.id]) && (
                  <div className="shift-flags">
                    {wavePlans[s.id] && (
                      <button type="button" className="chip" style={{ border: 0, cursor: 'pointer' }} onClick={() => setWaveShift(s.id)} title="Open the offer waves for this shift">
                        {wavePlans[s.id]!.status === 'active' ? `Waves running · wave ${wavePlans[s.id]!.wave}` : wavePlans[s.id]!.status === 'paused' ? 'Waves paused' : 'Waves finished'}
                      </button>
                    )}
                    {s.is_open && <span className="chip open">Open for claiming</span>}
                    {s.required_certs?.map((c) => <span key={c} className="chip">{c}</span>)}
                    {s.lead_shift_id && (() => {
                      const l = d.shifts.find((x) => x.id === s.lead_shift_id);
                      return l ? <span className="chip lead-chip" title="The lead on that shift checks in and rates this shift's crew">Led by {l.role_name} · {shortWhen(l.starts_at)}</span> : null;
                    })()}
                  </div>
                )}
                {s.role_rate !== undefined && s.hourly_rate == null && (
                  <div className="small" style={{ margin: '.3rem 0', color: 'var(--staff-warn)' }}>
                    {skillNames.some((n) => n.trim().toLowerCase() === s.role_name.trim().toLowerCase()) ? (
                      <>
                        No {s.pay_type === 'day' ? 'day rate' : 'pay rate'} set for {s.role_name}
                        {s.unpriced_seats ? `, so ${s.unpriced_seats} seat${s.unpriced_seats === 1 ? ' is' : 's are'} not in the cost` : ''}.{' '}
                        <Link href="/skills">Set it in Roles &amp; rates</Link> or edit this shift&apos;s pay rate.
                      </>
                    ) : (
                      <>
                        {s.role_name} isn&apos;t in Roles &amp; rates, so it has no rate
                        {s.unpriced_seats ? ` and ${s.unpriced_seats} seat${s.unpriced_seats === 1 ? ' is' : 's are'} not in the cost` : ''}.{' '}
                        {me.role === 'admin' && (
                          <button type="button" className="btn small" style={{ marginLeft: 4 }} onClick={() => run(() => api('/api/skills', { body: { name: s.role_name.trim() } }), `${s.role_name} added to Roles & rates. Set its pay and bill rates there.`).then((ok) => ok && router.push('/skills'))}>
                            Add {s.role_name} to Roles &amp; rates
                          </button>
                        )}{' '}
                        {rm?.linked ? <>Or map the Rentman name to an existing role under <Link href="/integrations/rentman">Integrations › Rentman</Link>.</> : <>Or edit the shift and pick a role from the list.</>}
                      </>
                    )}
                  </div>
                )}
                {editing && timeEdit && (
                  <div className="cs-edit">
                    <form id={`edit-${s.id}`} className="cs-fields" onSubmit={(e) => { e.preventDefault(); saveTime(); }}>
                      <label>
                        Role
                        <RolePicker value={timeEdit.role} onChange={(v) => setTimeEdit({ ...timeEdit, role: v })} sections={skillSections} required ariaLabel="Role" />
                      </label>
                      <label>
                        Starts
                        <input
                          type="datetime-local"
                          value={timeEdit.start}
                          onChange={(e) => {
                            // Moving the start keeps the shift's length.
                            const len = new Date(timeEdit.end).getTime() - new Date(timeEdit.start).getTime();
                            const st = new Date(e.target.value);
                            setTimeEdit({ ...timeEdit, start: e.target.value, end: isNaN(st.getTime()) || !(len > 0) ? timeEdit.end : localInput(new Date(st.getTime() + len)) });
                          }}
                          required
                        />
                      </label>
                      <label>
                        Ends
                        <input type="datetime-local" value={timeEdit.end} min={timeEdit.start} onChange={(e) => setTimeEdit({ ...timeEdit, end: e.target.value })} required />
                      </label>
                      <label>
                        People needed
                        <input type="number" min={Math.max(1, active.length)} max={500} value={timeEdit.head} onChange={(e) => setTimeEdit({ ...timeEdit, head: e.target.value })} required />
                      </label>
                    </form>
                    <div className="cs-fields">
                      <label>
                        Pay
                        <select value={s.pay_type === 'day' ? 'day' : 'hourly'} onChange={(e) => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { payType: e.target.value } }), e.target.value === 'day' ? 'Now paid a flat day rate.' : 'Now paid hourly.')}>
                          <option value="hourly">Hourly</option>
                          <option value="day">Day rate</option>
                        </select>
                      </label>
                      {s.pay_type !== 'day' && (
                        <label>
                          Minimum call
                          <select
                            value={s.min_hours ? String(Number(s.min_hours)) : ''}
                            title="Minimum hours paid, even if crew are released earlier"
                            onChange={(e) => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { minHours: e.target.value ? Number(e.target.value) : null } }), e.target.value ? `${e.target.value} h minimum call set.` : 'Minimum call removed.')}
                          >
                            <option value="">None</option>
                            <option value="4">4 hours</option>
                            <option value="5">5 hours</option>
                            {s.min_hours && ![4, 5].includes(Number(s.min_hours)) && <option value={String(Number(s.min_hours))}>{Number(s.min_hours)} hours</option>}
                          </select>
                        </label>
                      )}
                      {d.phases.length > 0 && (
                        <label>
                          Day
                          <select value={s.phase_id ?? ''} onChange={(e) => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { phaseId: e.target.value || null } }), 'Shift moved.')}>
                            <option value="">No day</option>
                            {d.phases.map((p) => <option key={p.id} value={p.id}>{p.label} · {fmtDate(p.starts_on.slice(0, 10))}</option>)}
                          </select>
                        </label>
                      )}
                      {s.phase_id && groupsOf(s.phase_id).length > 0 && (
                        <label>
                          Group
                          <select value={s.group_id ?? ''} onChange={(e) => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { groupId: e.target.value || null } }), 'Shift moved.')}>
                            <option value="">No group</option>
                            {groupsOf(s.phase_id).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                          </select>
                        </label>
                      )}
                      <label className="check cs-check">
                        <input type="checkbox" checked={s.is_open} onChange={() => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { isOpen: !s.is_open } }))} />
                        Open for crew to claim
                      </label>
                    </div>
                    {s.role_rate !== undefined && (
                      <div className="small cs-rate">
                        {payEdit?.id === s.id ? (
                          <span className="row" style={{ gap: '.4rem', flexWrap: 'wrap' }}>
                            <span aria-hidden="true">$</span>
                            <input type="number" min={0.01} step="0.01" autoFocus value={payEdit.value} onChange={(e) => setPayEdit({ id: s.id, value: e.target.value })} aria-label="Pay rate for this shift" style={{ width: '6.5rem' }} />
                            <span className="muted">{s.pay_type === 'day' ? ' per day' : '/hr'} for this shift only{s.role_rate ? ` (role rate ${money(s.role_rate)})` : ''}</span>
                            <button type="button" className="btn small primary" disabled={!(Number(payEdit.value) > 0)} onClick={() => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { payRate: Math.round(Number(payEdit.value) * 100) / 100 } }), 'Pay rate updated. Anyone on the shift has been told.').then(() => setPayEdit(null))}>Save rate</button>
                            {s.pay_rate_override && <button type="button" className="btn small" onClick={() => run(() => api(`/api/shifts/${s.id}`, { method: 'PATCH', body: { payRate: null } }), 'Back to the role pay rate.').then(() => setPayEdit(null))}>Use role rate</button>}
                            <button type="button" className="btn ghost small" onClick={() => setPayEdit(null)}>Cancel</button>
                          </span>
                        ) : (
                          <>
                            Pay rate: <b>{s.hourly_rate != null ? `${money(s.hourly_rate)}${s.pay_type === 'day' ? ' per day' : '/hr'}` : 'not set'}</b>
                            {s.pay_rate_override && <span className="chip" style={{ marginLeft: 6 }}>Custom for this shift</span>}{' '}
                            <button type="button" className="btn ghost small" onClick={() => setPayEdit({ id: s.id, value: String(s.hourly_rate ?? s.role_rate ?? '') })}>Change pay rate</button>
                          </>
                        )}
                      </div>
                    )}
                    <p className="muted small" style={{ margin: '6px 0 0' }}>Role, times and people needed save with Save shift. The other choices save as soon as you change them.</p>
                  </div>
                )}
                {teamRow(s)}
                {pending.length > 0 && (
                  <p className="small muted" style={{ margin: '6px 0 0' }}>
                    {pending.length} pending claim{pending.length > 1 ? 's' : ''}: review in <Link href="/requests">Requests</Link>.
                  </p>
                )}
                <div className="crew-pick-anchor">
                  <ul className="cs-rows">
                    {seated.map((a, i) => crewRow(a, i + 1))}
                    {Array.from({ length: Math.min(nOpen, 6) }).map((_, n) => (
                      <li key={`open-${n}`} className="cs-row open">
                        <span className="cs-n" aria-hidden="true">{p2(active.length + n + 1)}</span>
                        <button type="button" className="cs-fill" onClick={() => setAdding(adding === s.id ? null : s.id)} aria-label={`Fill an open spot on ${s.role_name}`}>
                          + Fill this spot
                        </button>
                      </li>
                    ))}
                    {full && (
                      <li className="cs-row open">
                        <span className="cs-n" aria-hidden="true">+</span>
                        <button type="button" className="cs-fill more" onClick={() => setAdding(adding === s.id ? null : s.id)} title="Adds one more spot to this shift and puts the person in it">
                          + Add another person
                        </button>
                      </li>
                    )}
                    {declined.map((a) => crewRow(a, null))}
                  </ul>
                  {nOpen > 6 && <p className="muted small" style={{ margin: '6px 0 0' }}>{nOpen - 6} more open spots</p>}
                  {adding === s.id && (
                    <CrewPick
                      title={full ? `Add a spot on ${s.role_name}` : `Add crew to ${s.role_name} (${s.headcount - active.length} open)`}
                      busy={busyAdd}
                      extra={
                        <label className="check crew-pick-lead">
                          <input type="checkbox" checked={asLead} onChange={(e) => setAsLead(e.target.checked)} />
                          <span>Add as lead <span className="muted small">(checks in and rates their department on this event)</span></span>
                        </label>
                      }
                      onClose={() => setAdding(null)}
                      options={options}
                      onPick={(o) => {
                        if (active.length + 1 >= s.headcount && !full) setAdding(null);
                        addCrew(s, o.id, o.kind === 'soft' || o.kind === 'busy', full, asLead);
                      }}
                    />
                  )}
                </div>
                <div className="cs-foot">
                  {pending.length + s.assignments.filter((a) => a.status === 'offered').length > 1 && (
                    <button
                      type="button"
                      className="btn small"
                      onClick={() =>
                        run(async () => {
                          for (const a of s.assignments.filter((x) => x.status === 'offered' || x.status === 'pending')) await api(`/api/assignments/${a.id}/confirm`, { body: {} });
                        }, 'Confirmed everyone on this shift.')
                      }
                    >
                      Confirm everyone
                    </button>
                  )}
                  {!full && new Date(s.starts_at) > new Date() && (
                    <button type="button" className="btn small" onClick={() => setWaveShift(s.id)} title="Offer in rounds: best rated first, then everyone qualified, then an open shift">
                      {wavePlans[s.id] && wavePlans[s.id]!.status !== 'done' ? 'Offer waves…' : 'Fill in waves'}
                    </button>
                  )}
                  {!full && crewGroups.length > 0 && (
                    <FillFromGroup shiftId={s.id} groups={crewGroups} confirmed={autoConfirm} onError={setError} onDone={(m) => { setNote(m); load(); }} />
                  )}
                  <label className="row small cs-auto">
                    <input type="checkbox" style={{ width: 'auto' }} checked={autoConfirm} onChange={(e) => setAutoConfirm(e.target.checked)} />
                    Confirm automatically
                  </label>
                </div>
                {editing && (
                  <div className="cs-edit-foot">
                    <button type="submit" form={`edit-${s.id}`} className="btn primary">Save shift</button>
                    <button type="button" className="btn" onClick={() => { setTimeEdit(null); setPayEdit(null); }}>Cancel</button>
                    <button type="button" className="btn ghost danger" style={{ marginLeft: 'auto' }} onClick={() => { setTimeEdit(null); removeLater(`${s.role_name} shift deleted.`, `/api/shifts/${s.id}`, dropShift(s.id)); }}>Delete shift</button>
                  </div>
                )}
              </div>
            </section>
          );
    });

  const groups: { key: string; phase: Phase | null; shifts: Shift[] }[] = [
    ...d.phases.map((p) => ({ key: p.id, phase: p as Phase | null, shifts: d.shifts.filter((s) => s.phase_id === p.id) })),
    ...(d.phases.length === 0 || d.shifts.some((s) => !s.phase_id || !d.phases.some((p) => p.id === s.phase_id))
      ? [{ key: 'none', phase: null as Phase | null, shifts: d.shifts.filter((s) => !s.phase_id || !d.phases.some((p) => p.id === s.phase_id)) }]
      : []),
  ];
  // Pick a phase for the new shift: it goes into that phase and the dates start on the phase's first day (times are kept).
  const addToPhase = (p: Phase, scroll = true) => {
    const day = p.starts_on.slice(0, 10);
    // Same time of day on the phase's day, and the same length (an overnight shift still ends the next morning).
    setF((x) => {
      const len = new Date(x.endsAt).getTime() - new Date(x.startsAt).getTime();
      const st = new Date(`${day}T${x.startsAt.slice(11)}`);
      return { ...x, phaseId: p.id, groupId: x.phaseId === p.id ? x.groupId : '', startsAt: localInput(st), endsAt: localInput(new Date(st.getTime() + (len > 0 ? len : 8 * 3600_000))) };
    });
    if (scroll) openShiftModal();
  };
  const templateForPhase = (p: Phase) => {
    setTplPhase(p.id);
    setTplStart(p.starts_on.slice(0, 10));
    setSettings('tpl');
  };
  // Named groups inside a phase (Load In → Stage hands, Loaders, Pushers …); each one collapses on its own.
  const groupsOf = (phaseId: string) => (d.groups ?? []).filter((x) => x.phase_id === phaseId);
  const gKey = (groupId: string) => `grp:${groupId}`;
  const addShiftToGroup = (p: Phase, groupId: string) => {
    addToPhase(p, false);
    setF((x) => ({ ...x, phaseId: p.id, groupId }));
    openShiftModal();
  };
  const saveGroup = async () => {
    if (!groupEdit || !groupEdit.label.trim()) return;
    const ge = groupEdit;
    await run(
      () => (ge.id ? api(`/api/phase-groups/${ge.id}`, { method: 'PATCH', body: { label: ge.label.trim() } }) : api(`/api/event-phases/${ge.phaseId}/groups`, { body: { label: ge.label.trim() } })),
      ge.id ? 'Group renamed.' : `Group “${ge.label.trim()}” added.`,
    );
    setGroupEdit(null);
  };
  const groupForm = (phaseId: string, groupId?: string) =>
    groupEdit && groupEdit.phaseId === phaseId && (groupEdit.id ?? '') === (groupId ?? '') ? (
      <form className="group-form" onSubmit={(e) => { e.preventDefault(); saveGroup(); }}>
        <input autoFocus value={groupEdit.label} onChange={(e) => setGroupEdit({ ...groupEdit, label: e.target.value })} placeholder="Group name, e.g. Loaders" maxLength={80} aria-label="Group name" />
        <button className="btn small primary">{groupId ? 'Save' : 'Add group'}</button>
        <button type="button" className="btn ghost small" onClick={() => setGroupEdit(null)}>Cancel</button>
      </form>
    ) : null;
  const fillOf = (list: Shift[]) => {
    const need = list.reduce((n, x) => n + x.headcount, 0);
    const have = list.reduce((n, x) => n + Math.min(x.headcount, x.assignments.filter((a) => a.status !== 'declined').length), 0);
    return <span className={need > 0 && have >= need ? 'filled-ok' : ''}>{have}/{need} filled</span>;
  };
  const phaseBody = (g: { key: string; phase: Phase | null; shifts: Shift[] }) => {
    const named = g.phase ? groupsOf(g.phase.id) : [];
    const loose = g.shifts.filter((s) => !s.group_id || !named.some((x) => x.id === s.group_id));
    return (
      <>
        {named.map((grp) => {
          const list = g.shifts.filter((s) => s.group_id === grp.id);
          const k = gKey(grp.id);
          const open = !closed.has(k);
          return (
            <div key={grp.id} className="role-group">
              {groupEdit?.id === grp.id ? (
                groupForm(g.phase!.id, grp.id)
              ) : (
                <div className="role-head">
                  <button
                    type="button"
                    className="phase-toggle role-toggle"
                    aria-expanded={open}
                    onClick={() => { const n = new Set(closed); if (n.has(k)) n.delete(k); else n.add(k); setClosedSaved(n); }}
                  >
                    <svg className="chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
                    <span>
                      <b>{grp.label}</b>
                      <span className="muted small">
                        {list.length} shift{list.length === 1 ? '' : 's'}
                        {list.length > 0 && <> · {[...new Set(list.map((x) => x.role_name))].join(', ')} · {fillOf(list)}</>}
                      </span>
                    </span>
                  </button>
                  <div className="row" style={{ gap: 4 }}>
                    <button type="button" className="btn ghost small" onClick={() => addShiftToGroup(g.phase!, grp.id)}>+ Add shift</button>
                    <button type="button" className="btn ghost small" title="Rename this group" aria-label={`Rename ${grp.label}`} onClick={() => setGroupEdit({ phaseId: g.phase!.id, id: grp.id, label: grp.label })}>✎</button>
                    <button
                      type="button"
                      className="btn ghost small danger"
                      title="Remove this group (its shifts stay in the phase)"
                      aria-label={`Remove ${grp.label}`}
                      onClick={async () => { if ((await askConfirm(`Remove the group “${grp.label}”? Its shifts stay in ${g.phase!.label}.`))) run(() => api(`/api/phase-groups/${grp.id}`, { method: 'DELETE' }), 'Group removed.'); }}
                    >
                      ×
                    </button>
                  </div>
                </div>
              )}
              {open && (list.length ? <div className="role-shifts">{renderShifts(list)}</div> : <p className="muted small" style={{ margin: '0 0 8px' }}>No shifts in {grp.label} yet.</p>)}
            </div>
          );
        })}
        {g.phase && groupForm(g.phase.id)}
        {loose.length > 0 && named.length > 0 && <div className="muted small group-loose">Not in a group</div>}
        {loose.length > 0 && renderShifts(loose)}
        {g.shifts.length === 0 && named.length === 0 && <Empty>{g.phase ? `No shifts in ${g.phase.label} yet.` : 'No shifts yet. Add the first one above.'}</Empty>}
      </>
    );
  };
  const groupSection = (g: { key: string; phase: Phase | null; shifts: Shift[] }, one = false) => (
    <div key={g.key} className={one ? 'phase-group one' : 'phase-group'}>
      {(g.phase || (d.phases.length > 0 && !one)) && (
        <div className="phase-head">
          {phaseEdit && g.phase && phaseEdit.id === g.phase.id ? (
            <form className="time-edit phase-edit" onSubmit={(e) => { e.preventDefault(); savePhase(); }}>
              <label>
                Phase
                <input value={phaseEdit.label} onChange={(e) => setPhaseEdit({ ...phaseEdit, label: e.target.value })} required maxLength={80} />
              </label>
              <label>
                Starts
                <input type="date" value={phaseEdit.start} onChange={(e) => setPhaseEdit({ ...phaseEdit, start: e.target.value, end: phaseEdit.end < e.target.value ? e.target.value : phaseEdit.end })} required />
              </label>
              <label>
                Ends
                <input type="date" value={phaseEdit.end} min={phaseEdit.start} onChange={(e) => setPhaseEdit({ ...phaseEdit, end: e.target.value })} required />
              </label>
              {g.shifts.length > 0 && (
                <label className="check">
                  <input type="checkbox" checked={phaseEdit.move} onChange={(e) => setPhaseEdit({ ...phaseEdit, move: e.target.checked })} />
                  Move its {g.shifts.length} shift{g.shifts.length === 1 ? '' : 's'} by the same number of days
                </label>
              )}
              <div className="row" style={{ gap: 6 }}>
                <button className="btn small primary">Save</button>
                <button type="button" className="btn ghost small" onClick={() => setPhaseEdit(null)}>Cancel</button>
              </div>
            </form>
          ) : (
          <>
          {!one && <button
            type="button"
            className="phase-toggle"
            aria-expanded={!closed.has(g.key)}
            title={closed.has(g.key) ? 'Show the shifts in this phase' : 'Hide the shifts in this phase'}
            onClick={() => { const n = new Set(closed); if (n.has(g.key)) n.delete(g.key); else n.add(g.key); setClosedSaved(n); }}
          >
            <svg className="chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
            <span>
              <h2>{g.phase ? g.phase.label : 'Not in a phase'}</h2>
              <span className="muted small">
                {g.phase && <>{g.phase.starts_on.slice(0, 10) === g.phase.ends_on.slice(0, 10) ? fmtDate(g.phase.starts_on.slice(0, 10)) : `${fmtDate(g.phase.starts_on.slice(0, 10))} – ${fmtDate(g.phase.ends_on.slice(0, 10))}`} · </>}
                {g.shifts.length} shift{g.shifts.length === 1 ? '' : 's'}
                {g.shifts.length > 0 && (() => {
                  const need = g.shifts.reduce((n, x) => n + x.headcount, 0);
                  const have = g.shifts.reduce((n, x) => n + Math.min(x.headcount, x.assignments.filter((a) => a.status !== 'declined').length), 0);
                  return ` · ${have}/${need} filled`;
                })()}
              </span>
            </span>
          </button>}
          {g.phase && (
            <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
              <button className="btn small primary" onClick={() => addToPhase(g.phase!)}>
                + Add shift
              </button>
              <button className="btn small" title="Add a named group of shifts inside this phase (Loaders, Pushers …)" onClick={() => { const n = new Set(closed); n.delete(g.key); setClosedSaved(n); setGroupEdit({ phaseId: g.phase!.id, label: '' }); }}>
                + Group
              </button>
              <button className="btn small" title="Add many positions at once: a grid, or type “10 stagehands 8a-4p”" onClick={() => { const n = new Set(closed); n.delete(g.key); setClosedSaved(n); setQuick(quick?.phaseId === g.phase!.id && quick.kind === 'add' ? null : { phaseId: g.phase!.id, kind: 'add' }); }}>
                ⚡ Quick add
              </button>
              <button className="btn small" title="Copy this day's groups and positions to other days" disabled={g.shifts.length === 0} onClick={() => setQuick(quick?.phaseId === g.phase!.id && quick.kind === 'copy' ? null : { phaseId: g.phase!.id, kind: 'copy' })}>
                ⧉ Copy day
              </button>
              <button className="btn small" onClick={() => templateForPhase(g.phase!)}>
                Use template
              </button>
              <button className="btn ghost small" title="Change this phase's name or dates" onClick={() => setPhaseEdit({ id: g.phase!.id, label: g.phase!.label, start: g.phase!.starts_on.slice(0, 10), end: g.phase!.ends_on.slice(0, 10), move: true })}>
                {one ? '✎ Edit day' : '✎ Edit dates'}
              </button>
            </div>
          )}
          </>
          )}
        </div>
      )}
      {g.phase && quick?.phaseId === g.phase.id && quick.kind === 'add' && (
        <QuickAdd
          eventId={id}
          phase={g.phase}
          groups={groupsOf(g.phase.id)}
          roles={skillNames}
          defaults={roleDefaults}
          onClose={() => setQuick(null)}
          onError={setError}
          onDone={(m) => { setQuick(null); setNote(m); load(); }}
        />
      )}
      {g.phase && quick?.phaseId === g.phase.id && quick.kind === 'copy' && (
        <CopyPhase
          phase={g.phase}
          eventStart={d.event.start_date}
          eventEnd={d.event.end_date}
          onClose={() => setQuick(null)}
          onError={setError}
          onDone={(m) => { setQuick(null); setNote(m); load(); }}
        />
      )}
      {!one && closed.has(g.key) ? null : phaseBody(g)}
    </div>
  );

  /** Open the crew picker on a shift (expanding its phase and group) and bring it into view. */
  const openPicker = (shiftId: string) => {
    const s = d.shifts.find((x) => x.id === shiftId);
    if (!s) return;
    const n = new Set(closed);
    n.delete(s.phase_id && d.phases.some((p) => p.id === s.phase_id) ? s.phase_id : 'none');
    if (s.group_id) n.delete(gKey(s.group_id));
    setClosedSaved(n);
    if (day !== 'all') setDay(s.phase_id && d.phases.some((p) => p.id === s.phase_id) ? s.phase_id : 'none');
    setAdding(shiftId);
    setTimeout(() => document.getElementById(`shift-${shiftId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 80);
  };

  const dayKey = day === 'all' || groups.some((g) => g.key === day) ? day : groups[0]?.key ?? 'all';
  const addDay = () => {
    const el = document.getElementById('ev-phases');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => (el?.querySelector('.grid-form input') as HTMLElement | null)?.focus({ preventScroll: true }), 350);
  };
  const shiftModalTitle = (() => {
    const ph = d.phases.find((p) => p.id === f.phaseId);
    const gr = (d.groups ?? []).find((x) => x.id === f.groupId);
    return ph ? `Add a shift · ${ph.label}${gr ? ` › ${gr.label}` : ''}, ${fmtDate(ph.starts_on.slice(0, 10))}` : 'Add a shift';
  })();
  const shiftFormBody = (
    <div className="shift-modal-body" ref={shiftForm as React.RefObject<HTMLDivElement>}>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
        {d.phases.length > 0 && (
          <div className="phase-tabs" role="tablist" aria-label="Phase for the new shift">
            {d.phases.map((p) => (
              <button key={p.id} type="button" role="tab" aria-selected={f.phaseId === p.id} className={f.phaseId === p.id ? 'tab on' : 'tab'} onClick={() => addToPhase(p, false)}>
                {p.label}
                <span className="muted small"> {fmtDate(p.starts_on.slice(0, 10))}</span>
              </button>
            ))}
            <button type="button" role="tab" aria-selected={f.phaseId === ''} className={f.phaseId === '' ? 'tab on' : 'tab'} onClick={() => setF((x) => ({ ...x, phaseId: '', groupId: '' }))}>
              No phase
            </button>
          </div>
        )}
        {f.phaseId && groupsOf(f.phaseId).length > 0 && (
          <div className="phase-tabs group-tabs" role="tablist" aria-label="Group inside the phase">
            {groupsOf(f.phaseId).map((x) => (
              <button key={x.id} type="button" role="tab" aria-selected={f.groupId === x.id} className={f.groupId === x.id ? 'tab on' : 'tab'} onClick={() => setF((y) => ({ ...y, groupId: x.id }))}>
                {x.label}
              </button>
            ))}
            <button type="button" role="tab" aria-selected={!f.groupId} className={!f.groupId ? 'tab on' : 'tab'} onClick={() => setF((y) => ({ ...y, groupId: '' }))}>
              No group
            </button>
          </div>
        )}
        <form className="grid-form" onSubmit={addShift}>
          <label>
            Role
            {skillNames.length > 0 && !otherRole ? (
              <select
                value={f.roleName}
                required
                onChange={(e) => {
                  if (e.target.value === '__other') {
                    setOtherRole(true);
                    setF({ ...f, roleName: '' });
                  } else setF(withRole(f, e.target.value));
                }}
              >
                <option value="">Choose a role…</option>
                {skillSections.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.roles.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value="__other">Other (type a name)…</option>
              </select>
            ) : (
              <input value={f.roleName} onChange={(e) => setF({ ...f, roleName: e.target.value })} placeholder="Audio Tech" required />
            )}
          </label>
          <label>
            Starts
            <input type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} required />
          </label>
          <label>
            Ends
            <input type="datetime-local" value={f.endsAt} min={f.startsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} required />
          </label>
          <label>
            People needed
            <input type="number" min={1} max={500} value={f.headcount} onChange={(e) => setF({ ...f, headcount: Number(e.target.value) })} required />
          </label>
          <div role="group" aria-label="How this shift is paid" style={{ gridColumn: '1 / -1' }}>
            <div className="small muted" style={{ marginBottom: 4 }}>Paid</div>
            <div className="phase-tabs">
              {([['hourly', 'Hourly'], ['day', 'Day rate']] as const).map(([k, label]) => (
                <button key={k} type="button" aria-pressed={f.payType === k} className={f.payType === k ? 'tab on' : 'tab'} onClick={() => setF({ ...f, payType: k })}>
                  {label}
                </button>
              ))}
            </div>
            {f.payType === 'day' && <div className="small muted">One flat amount for the day (the role&apos;s day rate), no overtime.</div>}
          </div>
          {f.payType === 'hourly' && (
            <div role="group" aria-label="Minimum call" style={{ gridColumn: '1 / -1' }}>
              <div className="small muted" style={{ marginBottom: 4 }}>Minimum call</div>
              <div className="phase-tabs">
                {([['', 'None'], ['4', '4 h'], ['5', '5 h']] as const).map(([k, label]) => (
                  <button key={k} type="button" aria-pressed={f.minHours === k} className={f.minHours === k ? 'tab on' : 'tab'} onClick={() => setF({ ...f, minHours: k })}>
                    {label}
                  </button>
                ))}
              </div>
              {f.minHours && <div className="small muted">Crew are paid at least {f.minHours} hours, even if released earlier.</div>}
            </div>
          )}
          {!f.repeat && (
            <div style={{ gridColumn: '1 / -1' }}>
              <div className="small muted" style={{ marginBottom: 4 }}>Crew (optional)</div>
              <div className="crew-slots crew-pick-anchor">
                {f.crew.map((uid) => (
                  <span key={uid} className="crew-chip">
                    {crew.find((m) => m.id === uid)?.name ?? 'Crew'}
                    <button type="button" className="chip-x" aria-label={`Take ${crew.find((m) => m.id === uid)?.name ?? 'them'} off`} onClick={() => setF((x) => ({ ...x, crew: x.crew.filter((y) => y !== uid) }))}>✕</button>
                  </span>
                ))}
                <button type="button" className="slot-add" onClick={() => setAdding(adding === 'new' ? null : 'new')}>
                  + Add crew
                </button>
                {f.crew.length > Number(f.headcount) && <span className="muted small">People needed will be raised to {f.crew.length}.</span>}
                {adding === 'new' && (
                  <CrewPick
                    title="Add crew to the new shift"
                    onClose={() => setAdding(null)}
                    loading={!newElig}
                    options={crew
                      .filter((m) => !f.crew.includes(m.id))
                      .map((m) => ({ m, fit: !!f.roleName && m.skills.some((k) => roleKey(k) === roleKey(f.roleName)), st: starsShown(m, f.roleName) }))
                      .sort((a, b) => Number(!!flagOf(a.m)) - Number(!!flagOf(b.m)) || b.st.v - a.st.v || Number(b.fit) - Number(a.fit) || a.m.name.localeCompare(b.m.name))
                      .map(({ m, fit, st }) => pickOption(m, newElig?.get(m.id), st, fit ? `${m.skills.join(', ')} · matches role` : m.skills.join(', '), d.event.name))}
                    onPick={(o) => setF((x) => ({ ...x, crew: [...x.crew, o.id] }))}
                  />
                )}
              </div>
              <div className="muted small">They are checked against certificates, availability and labor rules when the shift is saved.</div>
            </div>
          )}
          <label>
            Required certificates
            <input value={f.certs} onChange={(e) => setF({ ...f, certs: e.target.value })} placeholder="Forklift, Rigging (comma separated)" />
          </label>
          <label className="check">
            <input type="checkbox" checked={f.isOpen} onChange={(e) => setF({ ...f, isOpen: e.target.checked })} />
            Open for claiming
          </label>
          <label className="check">
            <input type="checkbox" checked={f.repeat} onChange={(e) => setF({ ...f, repeat: e.target.checked })} />
            Repeat on certain days
          </label>
          {f.repeat && (
            <div className="repeat-days">
              {DAYS.map((n, i) => (
                <label key={n} className="check">
                  <input
                    type="checkbox"
                    checked={f.days.includes(i)}
                    onChange={(e) => setF({ ...f, days: e.target.checked ? [...f.days, i] : f.days.filter((x) => x !== i) })}
                  />
                  {n}
                </label>
              ))}
              <label>
                Until
                <input type="date" value={f.until} min={f.startsAt.slice(0, 10)} onChange={(e) => setF({ ...f, until: e.target.value })} required />
              </label>
            </div>
          )}
          <div className="form-actions">
            <button className="btn primary">{f.repeat ? 'Add repeating shifts' : 'Add shift'}</button>
          </div>
        </form>
    </div>
  );

  const attention = (
      <NeedsAttention
        eventId={id}
        shifts={d.shifts}
        onDone={(m) => { setNote(m); load(); }}
        onError={setError}
        onFill={(sid) => openPicker(sid)}
        onReplace={async (sid, aid) => {
          const a = d.shifts.find((s) => s.id === sid)?.assignments.find((x) => x.id === aid);
          if (a && a.status !== 'declined' && !(await askConfirm(`Take ${a.user_name} off this shift and pick someone else? They'll be told.`))) return;
          setError('');
          try {
            await api(`/api/assignments/${aid}`, { method: 'DELETE' });
            await load();
            openPicker(sid);
          } catch (e) { setError((e as Error).message); }
        }}
      />
  );
  const waitingNow = d.shifts.filter((x) => new Date(x.ends_at).getTime() > Date.now()).reduce((n, x) => n + x.assignments.filter((a) => a.status === 'offered' && !a.planned).length, 0);
  const remindAll = async () => {
    setReminding(true); setError(''); setNote('');
    try {
      const r = await api<{ sent: number; skipped: number }>(`/api/events/${id}/nudge`, { body: {} });
      setNote(r.sent ? `Reminded ${r.sent} ${r.sent === 1 ? 'person' : 'people'} to answer.${r.skipped ? ` ${r.skipped} were reminded in the last hour.` : ''}` : 'Everyone waiting was reminded in the last hour.');
      await load();
    } catch (e) { setError((e as Error).message); } finally { setReminding(false); }
  };
  return (
    <div className="split">
      {crewMenu && (() => {
        const s = d.shifts.find((x) => x.id === crewMenu.sid);
        const a = s?.assignments.find((x) => x.id === crewMenu.aid);
        if (!s || !a) return null;
        const close = () => setCrewMenu(null);
        const canRates = me.role === 'admin' || !!me.canAdjustRates;
        const low = (x: string) => x.trim().toLowerCase();
        const ownRow = (d.crewRates ?? []).find((r) => r.user_id === a.user_id && low(r.role_name ?? '') === low(s.role_name));
        const started = new Date(s.starts_at) < new Date();
        const ended = new Date(s.ends_at) < new Date();
        const nudged = !!a.nudged_at && Date.now() - new Date(a.nudged_at).getTime() < 3600_000;
        const status = a.planned ? 'Not sent yet' : a.status === 'accepted' ? 'Confirmed' : a.status === 'declined' ? 'Declined' : a.status === 'pending' ? 'Asked to work' : 'Waiting for an answer';
        const live = a.status !== 'declined';
        const items: CrewMenuItem[] = [
          ...(!a.planned && (a.status === 'offered' || a.status === 'pending') ? [{ label: 'Confirm for them', icon: 'publish', hint: 'They said yes by phone or in person', onClick: () => { run(() => api(`/api/assignments/${a.id}/confirm`, { body: {} }), `Confirmed ${a.user_name}.`); } }] : []),
          ...(!a.planned && a.status === 'offered' ? [{ label: nudged ? 'Reminded in the last hour' : 'Remind them to answer', icon: 'update', disabled: nudged, onClick: () => { run(() => api(`/api/assignments/${a.id}/nudge`, { body: {} }), `Reminded ${a.user_name}.`); } }] : []),
          ...(live ? [{ label: a.is_lead ? 'Remove as lead' : 'Make lead', icon: 'rate', hint: a.is_lead ? undefined : 'Checks in and rates their department here', onClick: () => { run(() => api(`/api/assignments/${a.id}/lead`, { method: 'PUT', body: { lead: !a.is_lead } }), a.is_lead ? `${a.user_name} is no longer a lead.` : `${a.user_name} is now the lead on this event.`); } }] : []),
          ...(!a.planned && a.status === 'accepted' && !a.clocked_in_at && !ended ? [{ label: 'Check in', icon: 'free', onClick: () => { run(() => api(`/api/assignments/${a.id}/check-in`, { body: {} }), `${a.user_name} checked in.`); } }] : []),
          ...(a.clocked_in_at ? [{ label: 'Check out', icon: 'free', onClick: () => { run(() => api(`/api/assignments/${a.id}/check-out`, { body: {} }), `${a.user_name} checked out.`); } }] : []),
          ...(!a.planned && a.status === 'accepted' && !a.clocked_in_at && started ? [{ label: 'Add time', icon: 'pay', hint: 'They didn’t clock in', onClick: () => setAddTime(a.id) }] : []),
          'divider',
          { label: 'Message', icon: 'chat', onClick: () => { api<{ id: string }>('/api/chat/dm', { body: { userId: a.user_id } }).then((r) => router.push(`/chat?c=${r.id}`)).catch((e) => setError(e.message)); } },
          { label: 'View profile', icon: 'link', hint: 'Skills, certificates, ratings', onClick: () => router.push(`/crew/${a.user_id}`) },
          ...(ended && a.status === 'accepted' ? [{ label: 'Rate their work', icon: 'rate', onClick: () => setSettings('rate') }] : []),
          'divider',
          ...(live ? [{ label: 'Replace with someone else', icon: 'restore', hint: a.planned ? undefined : 'They’ll be told', onClick: async () => {
            if (!a.planned && !(await askConfirm(`Take ${a.user_name} off ${s.role_name} and pick someone else? They'll be told.`))) return;
            run(() => api(a.planned ? `/api/planned-picks/${a.id}` : `/api/assignments/${a.id}`, { method: 'DELETE' })).then((ok) => ok && openPicker(s.id));
          } }] : []),
          a.planned
            ? { label: 'Take out of the plan', icon: 'trash', danger: true, onClick: () => removeLater(`${a.user_name} taken out of the plan.`, `/api/planned-picks/${a.id}`, dropAssignment(a.id)) }
            : { label: 'Remove from this shift', icon: 'trash', danger: true, onClick: () => removeLater(a.status === 'declined' ? `${a.user_name} cleared.` : `${a.user_name} removed from ${s.role_name}. They’ll be told.`, `/api/assignments/${a.id}`, dropAssignment(a.id)) },
        ];
        return (
          <CrewMenu
            x={crewMenu.x}
            y={crewMenu.y}
            title={a.user_name}
            sub={`${s.role_name} · ${status}`}
            items={items}
            onClose={close}
            pay={canRates && live ? (
              <CrewPayForm
                key={a.id}
                eventId={id}
                userId={a.user_id}
                name={a.user_name}
                role={s.role_name}
                own={ownRow ? { pay_type: ownRow.pay_type, rate: Number(ownRow.rate) } : null}
                shiftRate={s.hourly_rate ?? null}
                shiftPay={s.pay_type === 'day' ? 'day' : 'hourly'}
                onSaved={(m) => { close(); setError(''); setNote(m); load(); }}
                onError={setError}
              />
            ) : undefined}
          />
        );
      })()}
      {waveShift && (
        <Modal title="Offer waves" onClose={() => setWaveShift(null)} wide>
          <WavePanel shiftId={waveShift} onChanged={() => { loadWaves(); load(); }} />
        </Modal>
      )}
      {qrOpen && (
        <Modal title={`QR clock-in · ${ev.name}`} onClose={() => setQrOpen(false)}>
          <QrPanel eventId={id} onClockSettings={() => { setQrOpen(false); setSettings('clock'); }} />
        </Modal>
      )}
      {docsOpen && (
        <Modal title={`Call sheet & wrap report · ${ev.name}`} onClose={() => setDocsOpen(false)} wide>
          <EventDocs eventId={id} phases={d.phases} customerEmail={custInfo?.email} onNote={setNote} />
        </Modal>
      )}
      {shiftModal && <Modal title={shiftModalTitle} onClose={() => { setShiftModal(false); setAdding(null); }} wide>{shiftFormBody}</Modal>}
      <datalist id="role-names">{skillNames.map((n) => <option key={n} value={n} />)}</datalist>
      <div className="split-main">
      <TopbarAction>
        <button className="btn primary" onClick={() => openShiftModal()}>
          Add Shift
          <PlusIcon />
        </button>
      </TopbarAction>
      <p className="small" style={{ margin: '0 0 12px' }}>
        <Link href="/events">← All events</Link>
      </p>
      <div className="evh">
        <div className="evh-main">
          <div className="evh-chips">
            {ev.pipeline_status && (
              <select
                className="pm-stage"
                value={ev.pipeline_status}
                style={{ ['--c' as string]: STATUS[ev.pipeline_status as PipelineStatus]?.color }}
                title="Where this event is in the pipeline"
                aria-label="Pipeline stage"
                onChange={(e) => api(`/api/events/${id}/pipeline`, { method: 'PATCH', body: { status: e.target.value } }).then(() => { setNote(`Moved to ${STATUS[e.target.value as PipelineStatus].label}.`); load(); }).catch((x) => setError(x.message))}
              >
                {STATUS_ORDER.map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
              </select>
            )}
            {ev.priority && (
              <select
                className={`pm-stage prio ${PRIORITY[ev.priority as Priority]?.tone}`}
                value={ev.priority}
                aria-label="Priority"
                onChange={(e) => api(`/api/events/${id}/pipeline`, { method: 'PATCH', body: { priority: e.target.value } }).then(load).catch((x) => setError(x.message))}
              >
                {(['low', 'medium', 'high'] as Priority[]).map((p) => <option key={p} value={p}>{PRIORITY[p].label} priority</option>)}
              </select>
            )}
            {rm?.linked && rm.project && (
              <button type="button" className="evh-chip" onClick={() => setSettings('rentman')} title="The linked Rentman project: equipment, crew build and options">
                Rentman {rm.project.number ? `#${rm.project.number}` : rm.project.name}
              </button>
            )}
            {rm?.linked && rm.url && (
              <a className="evh-chip" href={rm.url} target="_blank" rel="noopener noreferrer" title="Open this project in Rentman (new tab)">
                Open in Rentman ↗
              </a>
            )}
            {ev.staffing_draft && (
              <span className="evh-chip quiet" title="Picks are kept as a plan. Nobody is told until you press Publish crew.">
                Building quietly{plannedCount ? ` · ${plannedCount} not sent` : ''}
              </span>
            )}
            <Link href="/pipeline" className="evh-chip">View pipeline</Link>
            {wallZone() && <span className="evh-chip quiet" title={`Times on this page are in the venue’s time zone (${wallZone()}), not this device’s.`}>Times in {zoneLabel(wallZone()!)}</span>}
          </div>
          <h1>{ev.name}</h1>
          <div className="sub">
            {fmtDate(ev.start_date.slice(0, 10))}
            {ev.end_date.slice(0, 10) !== ev.start_date.slice(0, 10) && <> to {fmtDate(ev.end_date.slice(0, 10))}</>}
            {[ev.venue, ev.client].filter(Boolean).map((x) => ` · ${x}`).join('')}
          </div>
        </div>
        <div className="evh-staff" aria-label="Staffing">
          {staff.slots ? (
            <>
              <div className="evh-num">
                <b>{staff.conf}</b>
                <span> / {staff.slots} confirmed</span>
                <em>{Math.round((staff.conf / staff.slots) * 100)}%</em>
              </div>
              {seatBar(staff.conf, staff.wait, staff.plan, staff.open, true)}
              <div className="evh-legend">
                <span className="lg-ok"><b>{staff.conf}</b> confirmed</span>
                {staff.wait > 0 && <span className="lg-wait" title="Offered, waiting for an answer"><b>{staff.wait}</b> waiting</span>}
                {staff.plan > 0 && <span className="lg-plan" title="Picked while building quietly: not sent yet"><b>{staff.plan}</b> not sent</span>}
                {staff.open > 0 && <span className="lg-bad" title="Seats with nobody on them"><b>{staff.open}</b> open</span>}
              </div>
            </>
          ) : (
            <span className="muted">No shifts yet. Add the first one to start staffing.</span>
          )}
        </div>
      </div>
      {narrow && attention}
      {(me.role === 'admin' || me.role === 'manager') && d.shifts.length > 0 && (
        <nav className="ev-quick" aria-label="Quick actions">
          <button type="button" onClick={() => { setAfCheck(''); setSettings('autofill'); }} aria-haspopup="dialog">
            <ActIcon n="autofill" size={20} /><span>Auto-fill</span>{staff.open > 0 && <em aria-label={`${staff.open} open`}>{staff.open}</em>}
          </button>
          <button type="button" disabled={!waitingNow || reminding} onClick={remindAll} title="Remind everyone who has not answered (push and text)">
            <ActIcon n="nudge" size={20} /><span>{reminding ? 'Sending…' : 'Remind'}</span>{waitingNow > 0 && <em aria-label={`${waitingNow} waiting`}>{waitingNow}</em>}
          </button>
          <button type="button" onClick={() => setQrOpen(true)} aria-haspopup="dialog">
            <ActIcon n="qr" size={20} /><span>QR clock-in</span>
          </button>
          <button type="button" onClick={() => { setMsgPeople(undefined); setSettings('update'); }} aria-haspopup="dialog">
            <ActIcon n="update" size={20} /><span>Message</span>
          </button>
        </nav>
      )}
      <div className="ev-bar">
            {/* Main actions: building and sending the crew, then talking to them and billing. Everything else is under More. */}
            {ev.staffing_draft ? (
              <button className="btn primary act-btn" title="Send every planned pick at once" onClick={publish}>
                <ActIcon n="publish" /> Publish crew{plannedCount ? ` · ${plannedCount}` : ''}
              </button>
            ) : (
              <button className="btn act-btn" title="Pick crew without telling anyone, then send every offer at once with Publish" onClick={() => run(() => api(`/api/events/${id}/build-quietly`, { method: 'PUT', body: { on: true } }), 'Building quietly: picks are kept as a plan until you press Publish.')}>
                <ActIcon n="quiet" /> Build quietly
              </button>
            )}
            <button className="btn act-btn" onClick={() => openShiftModal()} aria-haspopup="dialog" title="Set the role, times, pay, minimum call and crew">
              <PlusIcon /> Add shift
            </button>
            <button className="btn act-btn in-quick" onClick={() => { setAfCheck(''); setSettings('autofill'); }} aria-haspopup="dialog" title="Propose the best available crew for every open seat">
              <ActIcon n="autofill" /> Auto-fill
            </button>
            {rm?.linked && rm.project && (me.role === 'admin' || me.role === 'manager') && (
              <button className="btn act-btn" disabled={rmBuilding} title="Make this event's days and shifts from the Rentman project's crew and transport, and keep them in step" onClick={buildFromRentmanNow}>
                <ActIcon n="rentman" /> {rmBuilding ? 'Building the crew…' : 'Build from Rentman'}
              </button>
            )}
            <button className="btn act-btn in-quick" onClick={() => { setMsgPeople(undefined); setSettings('update'); }} aria-haspopup="dialog" title="Send an update to the crew scheduled on this event">
              <ActIcon n="update" /> Send update
            </button>
            {(me.role === 'admin' || me.canAdjustRates) && (
              <button className="btn act-btn" onClick={() => setSettings('invoice')} aria-haspopup="dialog" title="Bill the customer for this event">
                <ActIcon n="invoice" /> Invoice
              </button>
            )}
            {d.shifts.some((x) => x.assignments.length) && (
              <button className={`btn act-btn${sel ? ' on' : ''}`} aria-pressed={!!sel} onClick={() => setSel(sel ? null : new Set())} title="Tick several crew to message, confirm, move or remove them together">
                <ActIcon n="check" /> {sel ? 'Done selecting' : 'Select crew'}
              </button>
            )}
            <ActionMenu
              badge={!!rateInfo?.due}
              items={[
                { label: 'Call sheet & wrap report', icon: 'quote', hint: 'Printable PDFs for the crew and the customer', onClick: () => setDocsOpen(true) },
                { label: 'QR clock-in', icon: 'rentman', hint: 'A code at the venue that crew scan to clock in', onClick: () => setQrOpen(true) },
                { label: 'Who’s free?', icon: 'free', hint: 'Ask crew which days they’re free before booking', onClick: () => setSettings('avail') },
                { label: 'Rate crew', icon: 'rate', badge: rateInfo?.due ? `${rateInfo.due} to rate` : rateInfo?.total ? `${rateInfo.rated}/${rateInfo.total}` : null, onClick: () => setSettings('rate') },
                ...((me.role === 'admin' || me.canAdjustRates) ? [{ label: 'Crew pay', icon: 'pay', hint: 'Personal rates for this event', onClick: () => setSettings('pay') }] : []),
                ...(ev.staffing_draft && !plannedCount ? [{ label: 'Stop building quietly', icon: 'publish', hint: 'Picks go out straight away again', onClick: () => { run(() => api(`/api/events/${id}/build-quietly`, { method: 'PUT', body: { on: false } }), 'Picks now go out straight away.'); } }] : []),
                'divider',
                ...(rm?.linked && rm.url ? [{ label: 'Open in Rentman', icon: 'link', hint: 'The project in Rentman, in a new tab', onClick: () => { window.open(rm.url!, '_blank', 'noopener'); } }] : []),
                ...(rm && (rm.connected || rm.linked) ? [{ label: rm.linked && rm.project ? `Rentman · ${rm.project.number ? `#${rm.project.number}` : rm.project.name}` : 'Link a Rentman project', icon: 'link', onClick: () => setSettings('rentman') }] : []),
                { label: 'Create a quote', icon: 'quote', onClick: () => api<{ quote: { id: string } }>('/api/quotes', { body: { eventId: id } }).then((r) => router.push(`/quotes/${r.quote.id}`)).catch((e) => setError(e.message)) },
                { label: 'Event chat', icon: 'chat', onClick: () => api<{ id: string }>('/api/chat/channels', { body: { eventId: id } }).then((r) => router.push(`/chat?c=${r.id}`)).catch((e) => setError(e.message)) },
                { label: 'Copy into a new event', icon: 'copy', onClick: () => setCopySignal((n) => n + 1) },
                { label: 'Event settings', icon: 'settings', hint: 'Clock-in, overtime and work rules, templates', onClick: () => setSettings('clock') },
                'divider',
                ...((ev.pipeline_status === 'completed' || ev.pipeline_status === 'canceled')
                  ? [(ev as { archived_at?: string | null }).archived_at
                    ? { label: 'Restore to the pipeline', icon: 'restore', onClick: () => api(`/api/events/${id}/restore`, { body: {} }).then(() => { setNote('Back on the pipeline.'); load(); }).catch((e) => setError(e.message)) }
                    : { label: 'Archive', icon: 'archive', hint: 'Take it off the pipeline (kept in the Archive: 4 years, or 2 if canceled)', onClick: () => api(`/api/events/${id}/archive`, { body: {} }).then(() => { setNote(ev.pipeline_status === 'canceled' ? 'Archived. It stays on the Archive page for 2 years.' : 'Archived. It stays on the Archive page for 4 years.'); load(); }).catch((e) => setError(e.message)) }]
                  : []),
                { label: 'Delete event', icon: 'trash', danger: true, onClick: async () => { if ((await askConfirm(`Delete "${ev.name}" and all its shifts?`))) api(`/api/events/${id}`, { method: 'DELETE' }).then(() => router.replace('/events')); } },
              ]}
            />
            <CopyEvent eventId={id} name={ev.name} customerId={ev.customer_id ?? null} onError={setError} openSignal={copySignal} />
      </div>
      {!!rateInfo?.due && settings !== 'rate' && (
        <div className="rt-prompt" role="status">
          <span className="rt-prompt-ico" aria-hidden="true">★</span>
          <span><b>How did the crew do?</b> <span className="muted">{rateInfo.due} {rateInfo.due === 1 ? 'person has' : 'people have'} finished a shift here without a rating. It takes a few seconds and helps you pick the best people next time.</span></span>
          <button className="btn primary small" onClick={() => setSettings('rate')}>Rate crew</button>
        </div>
      )}
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {note && (
        <Banner kind="ok" onClose={() => setNote('')}>
          {note}
        </Banner>
      )}

      {fullAsk && ev.staffing_draft && (
        <Modal title="Every position is filled" onClose={() => setFullAsk(false)}>
          <p>
            All {d.shifts.reduce((k, s) => k + s.headcount, 0)} spots on {ev.name} have someone picked. Nobody has been told yet.
          </p>
          <p className="muted small">Request all crew sends every offer now (people already confirmed get their booking). Save and request later keeps the plan; press Publish when you’re ready.</p>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button type="button" className="btn" onClick={() => { setFullAsk(false); setNote('Saved. Nobody has been told yet; press Publish when you’re ready.'); }}>Save and request later</button>
            <button type="button" className="btn primary" onClick={async () => { setFullAsk(false); await publish(); }}>Request all crew</button>
          </div>
        </Modal>
      )}
      {d.shifts.some((s) => s.assignments.length > 0) && (
        <EventCrewSearch
          shifts={d.shifts}
          phases={d.phases}
          onJump={(shiftId, key) => {
            const gid = d.shifts.find((x) => x.id === shiftId)?.group_id;
            const sk = gid ? gKey(gid) : '';
            if (day !== 'all') setDay(key);
            if (closed.has(key) || closed.has(sk)) { const n = new Set(closed); n.delete(key); n.delete(sk); setClosedSaved(n); }
            setTimeout(() => {
              const el = document.getElementById(`shift-${shiftId}`);
              if (!el) return;
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
            }, 60);
          }}
        />
      )}
      {d.phases.length > 0 && (
        <div className="cs-days" role="tablist" aria-label="Days of this event">
          {groups.map((g) => {
            const need = g.shifts.reduce((n, x) => n + x.headcount, 0);
            const have = g.shifts.reduce((n, x) => n + Math.min(x.headcount, x.assignments.filter((a) => a.status !== 'declined').length), 0);
            return (
              <button key={g.key} type="button" role="tab" aria-selected={dayKey === g.key} className={`cs-day${dayKey === g.key ? ' on' : ''}`} onClick={() => setDay(g.key)}>
                <b>{g.phase ? g.phase.label : 'No day'}</b>
                <span>{g.phase ? `${dayShort(g.phase.starts_on, g.phase.ends_on)} · ` : ''}{p2(have)}/{p2(need)}</span>
              </button>
            );
          })}
          {groups.length > 1 && (
            <button type="button" role="tab" aria-selected={dayKey === 'all'} className={`cs-day${dayKey === 'all' ? ' on' : ''}`} onClick={() => setDay('all')}>
              <b>All days</b>
              <span>{d.shifts.length} shift{d.shifts.length === 1 ? '' : 's'}</span>
            </button>
          )}
          <button type="button" className="cs-day add" onClick={addDay} title="Add a day or phase: load in, show days, strike">+ Add day</button>
        </div>
      )}
      {d.phases.length > 0 && dayKey !== 'all' ? (
        groupSection(groups.find((g) => g.key === dayKey) ?? groups[0]!, true)
      ) : (
        <>
          {groups.length > 1 && (
            <div className="row phase-all">
              <button type="button" className="btn ghost small" onClick={() => setClosedSaved(new Set())} disabled={closed.size === 0}>Expand all</button>
              <button type="button" className="btn ghost small" onClick={() => setClosedSaved(new Set(groups.map((g) => g.key)))}>Collapse all</button>
            </div>
          )}
          {groups.map((g) => groupSection(g))}
        </>
      )}
      </div>
      {sel && (() => {
        const picked = d.shifts.flatMap((x) => x.assignments.filter((a) => sel.has(a.id)).map((a) => ({ a, s: x })));
        const offered = picked.filter(({ a }) => !a.planned && (a.status === 'offered' || a.status === 'pending'));
        const live = picked.filter(({ a }) => a.status !== 'declined' && !a.planned);
        const bulk = async (label: string, list: typeof picked, fn: (p: (typeof picked)[number]) => Promise<unknown>) => {
          setBulkBusy(true); setError(''); setNote('');
          const fails: string[] = [];
          for (const p of list) { try { await fn(p); } catch (e) { fails.push(`${p.a.user_name}: ${(e as Error).message}`); } }
          setBulkBusy(false); await load();
          if (fails.length) setError(`${label}: ${list.length - fails.length} done, ${fails.length} not. ${fails.join(' · ')}`);
          else { setNote(`${label}: ${list.length} ${list.length === 1 ? 'person' : 'people'}.`); setSel(new Set()); }
        };
        const ids = new Set(picked.map((p) => p.a.id));
        return (
          <div className="bulk-bar" role="toolbar" aria-label="Selected crew">
            <span className="bulk-n"><b>{picked.length}</b> selected</span>
            <button type="button" className="btn small" disabled={!picked.length} onClick={() => setSel(new Set(d.shifts.flatMap((x) => x.assignments.map((a) => a.id))))}>All</button>
            <button type="button" className="btn small" disabled={!live.length || bulkBusy} onClick={() => { setMsgPeople([...new Set(live.map((p) => p.a.user_id))]); setSettings('update'); }}>
              <ActIcon n="update" /> Message
            </button>
            <button type="button" className="btn small" disabled={!offered.length || bulkBusy} title="Mark as confirmed for people who said yes another way" onClick={() => bulk('Confirmed', offered, ({ a }) => api(`/api/assignments/${a.id}/confirm`, { body: {} }))}>
              <ActIcon n="check" /> Confirm{offered.length ? ` ${offered.length}` : ''}
            </button>
            <label className="bulk-move">
              <span className="sr-only">Move to shift</span>
              <select value="" disabled={!live.length || bulkBusy} onChange={(e) => {
                const to = e.target.value; if (!to) return;
                bulk('Moved', live.filter((p) => p.s.id !== to), ({ a }) => api(`/api/assignments/${a.id}/move`, { body: { shiftId: to } }));
              }}>
                <option value="">Move to…</option>
                {d.shifts.map((x) => <option key={x.id} value={x.id}>{x.role_name} · {shortWhen(x.starts_at)}</option>)}
              </select>
            </label>
            <button type="button" className="btn small danger" disabled={!picked.length || bulkBusy} onClick={() => {
              const list = picked; setSel(new Set());
              undoable(`${list.length} removed. They’ll be told.`, async () => {
                for (const { a } of list) await api(a.planned ? `/api/planned-picks/${a.id}` : `/api/assignments/${a.id}`, { method: 'DELETE' }).catch(() => undefined);
                await load();
              }, { hide: () => setD((x) => (x ? { ...x, shifts: x.shifts.map((sh) => ({ ...sh, assignments: sh.assignments.filter((a) => !ids.has(a.id)) })) } : x)), restore: () => { load(); } });
            }}>
              <ActIcon n="trash" /> Remove
            </button>
            <button type="button" className="btn small ghost" onClick={() => setSel(null)}>Done</button>
          </div>
        );
      })()}
      <aside className="split-aside ev-aside">
      {!narrow && attention}
      <EventDetails ev={ev} hasPhases={d.phases.length > 0} shiftCount={d.shifts.length} onSaved={load} onError={setError} companyTz={(d as { companyTimezone?: string }).companyTimezone} />
      <div id="ev-phases">
        <Phases eventId={id} phases={d.phases} onChanged={load} onError={setError} />
      </div>
      <LaborBudget eventId={id} budget={(ev as any).labor_budget} onError={setError} />
      <EventFormsCard eventId={id} shiftLabel={(sid) => { const x = d.shifts.find((y) => y.id === sid); return x ? `${x.role_name} · ${shortWhen(x.starts_at)}` : 'Shift'; }} />
      <section className="card ev-rules">
        <h2>Rules for this event</h2>
        <div className="ev-rule">
          <div>
            <b>Clock-in</b>
            <span className="muted small">{ev.clock_mode === 'coordinator' ? 'Coordinator clocks crew in' : 'Crew clock themselves in'}{ev.geofence_m ? ` · within ${ev.geofence_m} m` : ''}</span>
          </div>
          <button type="button" className="btn ghost small" onClick={() => setSettings('clock')}>Change</button>
        </div>
        {d.overtime && (
          <div className="ev-rule">
            <div>
              <b>Overtime</b>
              <span className="muted small">{d.overtime.otAfter ? `After ${d.overtime.otAfter} h a day` : 'Company overtime'}{d.overtime.effectiveState ? ` · ${d.overtime.effectiveState}` : ''}</span>
            </div>
            <button type="button" className="btn ghost small" onClick={() => setSettings('ot')}>Change</button>
          </div>
        )}
        {custInfo && (
          <div className="ev-rule">
            <div>
              <b>Customer contact</b>
              <span className="muted small">
                {[custInfo.contact ?? custInfo.name, custInfo.phone, custInfo.email].filter(Boolean).join(' · ')}
              </span>
            </div>
            <Link href={`/customers/${custInfo.id}`} className="btn ghost small">Open</Link>
          </div>
        )}
      </section>
      </aside>


      {settings && typeof document !== 'undefined' && createPortal(
        <div className="drawer-backdrop" onMouseDown={() => setSettings(null)}>
          <aside className={settings === 'rentman' || settings === 'invoice' || settings === 'rate' || settings === 'update' || settings === 'autofill' || settings === 'avail' ? 'drawer wide' : 'drawer'} role="dialog" aria-modal="true" aria-label={settings === 'rentman' ? 'Rentman' : settings === 'invoice' ? 'Invoice' : settings === 'rate' ? 'Rate crew' : settings === 'update' ? 'Send an update' : settings === 'autofill' ? 'Auto-fill' : settings === 'avail' ? 'Who is free' : 'Event settings'} onMouseDown={(e) => e.stopPropagation()}>
            <div className="row space">
              <h2 style={{ margin: 0 }}>{settings === 'rentman' ? 'Rentman' : settings === 'invoice' ? `Invoice · ${ev.name}` : settings === 'rate' ? `Rate crew · ${ev.name}` : settings === 'update' ? `Send an update · ${ev.name}` : settings === 'autofill' ? `Auto-fill · ${ev.name}` : settings === 'avail' ? `Who's free? · ${ev.name}` : 'Event settings'}</h2>
              <button className="btn ghost small" aria-label="Close" onClick={() => setSettings(null)}>✕</button>
            </div>
            {settings === 'rentman' && <div style={{ marginTop: 12 }}><RentmanCard eventId={id} isAdmin={me.role === 'admin'} onError={setError} onView={setRm} onShifts={(m) => { setNote(m); load(); }} /></div>}
            {settings === 'invoice' && <InvoicePanel eventId={id} isAdmin={me.role === 'admin'} />}
            {settings === 'rate' && <div style={{ marginTop: 12 }}><EventRatings me={me} eventId={id} onProgress={() => loadRateInfo()} /></div>}
            {settings === 'autofill' && <div style={{ marginTop: 12 }}><AutoFill key={afCheck || 'all'} eventId={id} groups={crewGroups} freeChecks={freeChecks} initialCheck={afCheck} held={!!ev.staffing_draft} onDone={(m) => { setSettings(null); setNote(m); load(); }} /></div>}
            {settings === 'avail' && (
              <div style={{ marginTop: 12 }}>
                <AvailCheck
                  eventId={id}
                  days={(() => {
                    const out: string[] = [];
                    for (let x = ev.start_date.slice(0, 10); x <= ev.end_date.slice(0, 10) && out.length < 62; x = new Date(Date.parse(`${x}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)) out.push(x);
                    return out;
                  })()}
                  groups={crewGroups}
                  roles={skillNames}
                  crew={crew}
                  onBook={(k) => { setAfCheck(k); setSettings('autofill'); }}
                  onDone={setNote}
                  onError={setError}
                />
              </div>
            )}
            {settings === 'update' && <div style={{ marginTop: 12 }}><EventUpdates key={msgPeople?.join(',') ?? 'all'} eventId={id} eventName={ev.name} shifts={d.shifts} phases={d.phases} groups={d.groups ?? []} people={msgPeople} /></div>}
            {settings !== 'rentman' && settings !== 'invoice' && settings !== 'rate' && settings !== 'update' && settings !== 'autofill' && settings !== 'avail' && <div className="phase-tabs" role="tablist" aria-label="Settings section" style={{ margin: '12px 0' }}>
              {([['clock', 'Clock-in'], ['ot', 'Overtime & work rules'], ['tpl', 'Templates'], ...((me.role === 'admin' || me.canAdjustRates) ? [['pay', 'Crew pay']] as const : [])] as const).map(([k, label]) => (
                <button key={k} type="button" role="tab" aria-selected={settings === k} className={settings === k ? 'tab on' : 'tab'} onClick={() => setSettings(k)}>
                  {label}
                </button>
              ))}
            </div>}
            {settings === 'clock' && <Clocking ev={ev} onSaved={load} onError={setError} />}
            {settings === 'ot' && d.overtime && <OvertimeCard eventId={id} ot={d.overtime} onSaved={load} onError={setError} />}
            {settings === 'ot' && <EventRuleSet eventId={id} onSaved={load} />}
            {settings === 'pay' && <CrewPay eventId={id} shifts={d.shifts} rates={d.crewRates ?? []} onSaved={load} />}
            {settings === 'tpl' && (
              <>
              <section className="card">
                <h2>Event template</h2>
                <p className="muted small">Save this whole event (its days, groups and positions with times and people needed) to start new events from it in one step: Add New Event → Template.</p>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <input value={evTplName} onChange={(e) => setEvTplName(e.target.value)} placeholder={`${ev.name} template`} aria-label="Event template name" />
                  <button
                    className="btn small primary"
                    disabled={d.shifts.length === 0 && d.phases.length === 0}
                    onClick={async () => {
                      const name = evTplName.trim() || `${ev.name} template`;
                      setError(''); setNote('');
                      try {
                        const r = await api<{ template: { positions: number; days: number }; replaced: boolean }>(`/api/events/${id}/save-template`, { body: { name, customerOnly: evTplCust && !!customerId } });
                        setNote(`${r.replaced ? 'Updated' : 'Saved'} event template “${name}”: ${r.template.days} day${r.template.days === 1 ? '' : 's'}, ${r.template.positions} position${r.template.positions === 1 ? '' : 's'}.`);
                        setEvTplName('');
                      } catch (e) { setError((e as Error).message); }
                    }}
                  >
                    Save as event template
                  </button>
                  {customerId && <label className="check"><input type="checkbox" checked={evTplCust} onChange={(e) => setEvTplCust(e.target.checked)} /> Only for {d.event.client}</label>}
                </div>
              </section>
              <section className="card">
                <h2>Shift templates</h2>
                <p className="muted small">Create a whole day or week of shifts in one step, or save this event&apos;s shifts for next time.</p>
        <div>
          <div className="row">
            <select value={tplId} onChange={(e) => setTplId(e.target.value)} aria-label="Template">
              <option value="">Choose a template…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.customer_id ? `★ ${t.name}` : t.name} ({t.items.length} shifts)
                </option>
              ))}
            </select>
            {d.phases.length > 0 && (
              <select
                value={tplPhase}
                onChange={(e) => {
                  setTplPhase(e.target.value);
                  const p = d.phases.find((x) => x.id === e.target.value);
                  if (p) setTplStart(p.starts_on.slice(0, 10));
                }}
                aria-label="Add the shifts to a phase"
              >
                <option value="">No phase</option>
                {d.phases.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({fmtDate(p.starts_on.slice(0, 10))})
                  </option>
                ))}
              </select>
            )}
            <input type="date" value={tplStart} onChange={(e) => setTplStart(e.target.value)} aria-label="Template start date" />
            <button className="btn small primary" disabled={!tplId || !tplStart} onClick={applyTemplate}>
              Apply
            </button>
            {tplId && (
              <button
                className="btn ghost small danger"
                onClick={() => askConfirm('Delete this template?').then((ok): unknown => ok && (run(() => api(`/api/templates/${tplId}`, { method: 'DELETE' })).then(() => (setTplId(''), loadTemplates()))))}
              >
                Delete template
              </button>
            )}
          </div>
          <div className="row" style={{ marginTop: 12 }}>
            <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="Name for a new template" aria-label="New template name" />
            <button className="btn small" disabled={!tplName.trim() || d.shifts.length === 0} onClick={saveTemplate}>
              Save this event’s shifts as template
            </button>
            {customerId && <label className="check"><input type="checkbox" checked={tplForCustomer} onChange={(e) => setTplForCustomer(e.target.checked)} /> Only for {d.event.client}</label>}
          </div>
        </div>
              </section>
              </>
            )}
            {error && <Banner onClose={() => setError('')}>{error}</Banner>}
            {note && <Banner kind="ok" onClose={() => setNote('')}>{note}</Banner>}
          </aside>
        </div>,
        document.body,
      )}
    </div>
  );
}

export default function Page() {
  return <Shell roles={['admin', 'manager', 'hr']}>{(me) => (me.role === 'hr' ? <HrEventView /> : <Body me={me} />)}</Shell>;
}

const US_STATES = 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' ');

/** Daily overtime for this job: after 8, 10 or 15 hours, using the multipliers of the state the job works in. */
function OvertimeCard({ eventId, ot, onSaved, onError }: { eventId: string; ot: Overtime; onSaved: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  const save = async (body: { otAfter: number | null; state?: string | null }) => {
    setBusy(true);
    try {
      await api(`/api/events/${eventId}/overtime`, { method: 'PUT', body });
      onSaved();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const opts: [number | null, string][] = [[null, ot.companyDailyOt > 0 ? `Company default (after ${ot.companyDailyOt} h)` : 'Company default'], [8, 'After 8 hours'], [10, 'After 10 hours'], [15, 'After 15 hours']];
  return (
    <section className="card">
      <h2>Overtime for this job</h2>
      <div className="phase-tabs" role="group" aria-label="Daily overtime starts">
        {opts.map(([v, label]) => (
          <button key={String(v)} type="button" disabled={busy} aria-pressed={ot.otAfter === v} className={ot.otAfter === v ? 'tab on' : 'tab'} onClick={() => save({ otAfter: v })}>
            {label}
          </button>
        ))}
      </div>
      <label style={{ display: 'block', marginTop: 10, maxWidth: 320 }}>
        State the job works in
        <select value={ot.state ?? ''} disabled={busy} onChange={(e) => save({ otAfter: ot.otAfter, state: e.target.value || null })}>
          <option value="">{ot.effectiveState ? `Automatic (${ot.effectiveState}${ot.stateFromAddress ? ', from the address' : ''})` : 'Automatic (not found in the address)'}</option>
          {US_STATES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small" style={{ marginTop: 8 }}>
        {ot.otAfter ?? (ot.companyDailyOt || 0) ? (
          <>
            Each person&apos;s hours on this job are counted per day. Past {ot.otAfter ?? ot.companyDailyOt} h they earn {ot.otMult}× their position&apos;s rate
            {ot.dtAfter ? `, and ${ot.dtMult}× after ${ot.dtAfter} h` : ''}
            {ot.effectiveState ? ` (${ot.effectiveState} rules)` : ''}.
          </>
        ) : (
          'No daily overtime on this job. Weekly overtime from the company rules still applies.'
        )}{' '}
        State rates are set under Labor rules. Day-rate shifts never earn overtime.
      </p>
    </section>
  );
}

/** Pay for each crew member on this event: their role's rate by default, or their own hourly or day rate. */
function CrewPay({ eventId, shifts, rates, onSaved }: { eventId: string; shifts: Shift[]; rates: CrewRate[]; onSaved: () => void }) {
  // One line per person per position they work here, plus an "all positions" line: a position's own rate wins,
  // then the person's rate for every position on this event, then the shift's / role's rate.
  const low = (r: string) => r.trim().toLowerCase();
  const defaultOf = new Map<string, string>();
  for (const s of shifts)
    if (!defaultOf.has(low(s.role_name)))
      defaultOf.set(low(s.role_name), s.pay_type === 'day' ? (s.hourly_rate ? `${money(s.hourly_rate)}/day` : 'day rate not set') : s.hourly_rate ? `${money(s.hourly_rate)}/hr` : 'no rate set');
  const eventRoles = [...new Map(shifts.map((s) => [low(s.role_name), s.role_name])).values()].sort();
  type Person = { id: string; name: string; roles: string[] };
  const people = new Map<string, Person>();
  for (const s of shifts)
    for (const a of s.assignments.filter((x) => x.status !== 'declined')) {
      const p = people.get(a.user_id) ?? { id: a.user_id, name: a.user_name, roles: [] };
      if (!p.roles.some((r) => low(r) === low(s.role_name))) p.roles.push(s.role_name);
      people.set(a.user_id, p);
    }
  // People who have a rate but are no longer on a shift still show, so the rate can be removed.
  for (const r of rates) if (!people.has(r.user_id)) people.set(r.user_id, { id: r.user_id, name: r.user_name, roles: [] });
  const [extra, setExtra] = useState<Record<string, string[]>>({}); // positions added by hand, per person
  const list = [...people.values()].sort((a, b) => a.name.localeCompare(b.name));
  const saved = (uid: string, role: string) => rates.find((r) => r.user_id === uid && low(r.role_name ?? '') === low(role));
  const key = (uid: string, role: string) => `${uid}|${low(role)}`;
  const [edit, setEdit] = useState<Record<string, { type: 'default' | 'hourly' | 'day'; rate: string }>>({});
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const cur = (uid: string, role: string) => {
    const k = key(uid, role), sv = saved(uid, role);
    return edit[k] ?? (sv ? { type: sv.pay_type, rate: String(sv.rate) } : { type: 'default' as const, rate: '' });
  };
  const save = async (p: Person, role: string) => {
    const k = key(p.id, role), e = cur(p.id, role);
    const what = role ? `${p.name} as ${role}` : `${p.name} (all positions)`;
    setErr(''); setMsg(''); setBusy(k);
    try {
      if (e.type === 'default') {
        if (saved(p.id, role)) await api(`/api/events/${eventId}/crew-rates/${p.id}${role ? `?role=${encodeURIComponent(role)}` : ''}`, { method: 'DELETE' });
        setMsg(`${what}: back on the default rate.`);
      } else {
        const n = Math.round(Number(e.rate) * 100) / 100;
        if (!(n > 0)) throw new Error('Enter a rate above 0.');
        await api(`/api/events/${eventId}/crew-rates/${p.id}`, { method: 'PUT', body: { payType: e.type, rate: n, role: role || null } });
        setMsg(`${what}: ${money(n)}${e.type === 'day' ? ' per day' : '/hr'} on this event.`);
      }
      setEdit((x) => { const { [k]: _, ...rest } = x; return rest; });
      onSaved();
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy('');
    }
  };
  const rateLine = (p: Person, role: string, label: React.ReactNode, def: string) => {
    const k = key(p.id, role), e = cur(p.id, role), sv = saved(p.id, role), dirty = !!edit[k];
    const who = role ? `${p.name} as ${role}` : `${p.name}, all positions`;
    return (
      <tr key={k} className="pay-line">
        <td className="small">{label}</td>
        <td className="small">{def}</td>
        <td>
          <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <select value={e.type} aria-label={`Pay type for ${who}`} onChange={(x) => setEdit({ ...edit, [k]: { type: x.target.value as 'default' | 'hourly' | 'day', rate: e.rate } })} style={{ width: 'auto' }}>
              <option value="default">Default</option>
              <option value="hourly">Hourly</option>
              <option value="day">Day rate</option>
            </select>
            {e.type !== 'default' && (
              <span className="money-input">
                <span aria-hidden="true">$</span>
                <input type="number" min={0.01} max={100000} step="0.01" inputMode="decimal" value={e.rate} aria-label={`Rate for ${who}`} placeholder={e.type === 'day' ? '300.00' : '35.00'}
                  onChange={(x) => setEdit({ ...edit, [k]: { type: e.type, rate: x.target.value } })} style={{ width: '6.5rem' }} />
                <span className="muted small">{e.type === 'day' ? '/day' : '/hr'}</span>
              </span>
            )}
          </div>
          {sv && !dirty && <div className="small" style={{ marginTop: 4 }}><span className="chip open">Own rate · {money(sv.rate)}{sv.pay_type === 'day' ? '/day' : '/hr'}</span></div>}
        </td>
        <td>{dirty && <button className="btn small primary" disabled={busy === k} onClick={() => save(p, role)}>{busy === k ? 'Saving…' : 'Save'}</button>}</td>
      </tr>
    );
  };
  return (
    <div>
      <p className="muted small">
        Set a different pay for one person on this event, per position: an hourly rate (overtime still applies) or a flat day rate. A position&apos;s rate wins; &ldquo;All positions&rdquo; covers any position without its own rate; otherwise the shift&apos;s or role&apos;s rate is used. They are told when their pay changes, and payroll uses it.
      </p>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {msg && <Banner kind="ok" onClose={() => setMsg('')}>{msg}</Banner>}
      {list.length === 0 ? (
        <Empty>No one is on this event yet. Add crew to a shift first.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table crew-pay">
            <thead><tr><th>Position</th><th>Default</th><th>Pay on this event</th><th></th></tr></thead>
            <tbody>
              {list.map((p) => {
                const own = rates.filter((r) => r.user_id === p.id && r.role_name).map((r) => r.role_name!);
                const roles = [...new Map([...p.roles, ...own, ...(extra[p.id] ?? [])].map((r) => [low(r), r])).values()];
                const others = eventRoles.filter((r) => !roles.some((x) => low(x) === low(r)));
                const allSaved = saved(p.id, '');
                return (
                  <Fragment key={p.id}>
                    <tr className="pay-person"><th colSpan={4}>{p.name}{p.roles.length === 0 && <span className="muted small"> · not on a shift now</span>}</th></tr>
                    {roles.map((r) =>
                      rateLine(p, r, <>{r}{!p.roles.some((x) => low(x) === low(r)) && <span className="muted"> (not on it now)</span>}</>,
                        allSaved ? `${money(allSaved.rate)}${allSaved.pay_type === 'day' ? '/day' : '/hr'} (all positions)` : defaultOf.get(low(r)) ?? '—'))}
                    {(roles.length !== 1 || allSaved) && rateLine(p, '', <i>All positions</i>, 'role rates')}
                    {others.length > 0 && (
                      <tr className="pay-add">
                        <td colSpan={4}>
                          <select value="" aria-label={`Add a position rate for ${p.name}`} onChange={(x) => x.target.value && setExtra({ ...extra, [p.id]: [...(extra[p.id] ?? []), x.target.value] })} style={{ width: 'auto' }}>
                            <option value="">+ Rate for another position…</option>
                            {others.map((r) => <option key={r} value={r}>{r}</option>)}
                          </select>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
