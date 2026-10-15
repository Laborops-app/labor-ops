/* Line icons for the CRM screens (1.6px stroke, inherit color). */
const I = ({ children, size = 18 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {children}
  </svg>
);
export const PinIcon = (p: { size?: number }) => <I {...p}><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></I>;
export const MailIcon = (p: { size?: number }) => <I {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3.5 6 8.5 7 8.5-7M3.5 18.5 9.5 12M20.5 18.5 14.5 12" /></I>;
export const PhoneIcon = (p: { size?: number }) => <I {...p}><path d="M5 4h3.5l1.7 4.3-2.2 1.4a11 11 0 0 0 6.3 6.3l1.4-2.2L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5A16.5 16.5 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4z" /></I>;
export const DotsVIcon = (p: { size?: number }) => <I {...p}><circle cx="12" cy="5" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="19" r="1.2" fill="currentColor" /></I>;
export const DotsHIcon = (p: { size?: number }) => <I {...p}><circle cx="5" cy="12" r="1.2" fill="currentColor" /><circle cx="12" cy="12" r="1.2" fill="currentColor" /><circle cx="19" cy="12" r="1.2" fill="currentColor" /></I>;
export const BriefcaseIcon = (p: { size?: number }) => <I {...p}><rect x="3" y="7" width="18" height="13" rx="2" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 12.5h18" /></I>;
export const IdIcon = (p: { size?: number }) => <I {...p}><circle cx="8" cy="9" r="3" /><path d="M3 19c.6-3 2.6-4.5 5-4.5s4.4 1.5 5 4.5M15 8h6M15 12h6M17 16h4" /></I>;
export const CalendarIcon = (p: { size?: number }) => <I {...p}><rect x="3.5" y="5" width="17" height="15" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></I>;
export const NoteIcon = (p: { size?: number }) => <I {...p}><path d="M5 4h14v11l-5 5H5z" /><path d="M14 20v-5h5M8 9h8M8 13h4" /></I>;
export const SendIcon = (p: { size?: number }) => <I {...p}><path d="M4 4l16 8-16 8 3-8-3-8zM7 12h13" /></I>;
export const BuildingIcon = (p: { size?: number }) => <I {...p}><path d="M4 21V5l8-2v18M12 8h8v13M2.5 21h19M7.5 8h1M7.5 12h1M7.5 16h1M15.5 12h1M15.5 16h1" /></I>;
export const ChevronUpIcon = (p: { size?: number }) => <I {...p}><path d="m6 15 6-6 6 6" /></I>;
export const PlusLineIcon = (p: { size?: number }) => <I {...p}><path d="M12 5v14M5 12h14" /></I>;
export const ListIcon = (p: { size?: number }) => <I {...p}><rect x="3.5" y="5" width="17" height="5" rx="1" /><rect x="3.5" y="14" width="17" height="5" rx="1" /></I>;
export const KanbanIcon = (p: { size?: number }) => <I {...p}><rect x="4" y="4" width="5" height="16" rx="1" /><rect x="15" y="4" width="5" height="10" rx="1" /></I>;
export const CloseIcon = (p: { size?: number }) => <I {...p}><path d="M6 6l12 12M18 6 6 18" /></I>;
export const SortIcon = (p: { size?: number }) => <I {...p}><path d="M4 7h16M7 12h10M10 17h4" /></I>;
export const GridIcon = (p: { size?: number }) => <I {...p}><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></I>;
