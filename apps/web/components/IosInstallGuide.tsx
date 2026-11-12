'use client';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isAndroid, isIos, isStandalone } from '@/lib/device';
import { useInstall } from '@/components/useInstall';

const SEEN = 'lo-ios-guide'; // per device: shown once after the first sign-in on an iPhone
const seen = () => { try { return !!localStorage.getItem(SEEN); } catch { return true; } };
const kept = { open: false, step: 0 };
const markSeen = () => { try { localStorage.setItem(SEEN, String(Date.now())); } catch { /* storage blocked */ } };

/* ---------- Pictures of each step: a drawn iPhone screen with the thing to tap circled ---------- */
const INK = '#1c1c1e', SUB = '#8e8e93', LINE = '#e5e5ea', BLUE = '#0a84ff', HI = '#ff9f0a';
const Phone = ({ children, label, android }: { children: React.ReactNode; label: string; android?: boolean }) => (
  <svg viewBox="0 0 240 420" role="img" aria-label={label} className="iosg-pic">
    <rect x="4" y="4" width="232" height="412" rx={android ? 26 : 34} fill="#f2f2f7" stroke="#c7c7cc" strokeWidth="3" />
    {android ? <circle cx="120" cy="22" r="6" fill={INK} /> : <rect x="88" y="14" width="64" height="18" rx="9" fill={INK} />}
    <text x="30" y="28" fontSize="11" fontWeight="600" fill={INK}>9:41</text>
    {children}
  </svg>
);
const Ring = ({ cx, cy, r = 16 }: { cx: number; cy: number; r?: number }) => (
  <g>
    <circle cx={cx} cy={cy} r={r} fill="none" stroke={HI} strokeWidth="3" />
    <circle cx={cx} cy={cy} r={r} fill="none" stroke={HI} strokeWidth="3" className="iosg-pulse" />
  </g>
);
const Page = () => (
  <g>
    <rect x="22" y="50" width="196" height="40" rx="10" fill="#fff" />
    <image href="/brand/icon.png" x="30" y="56" width="28" height="28" />
    <text x="66" y="75" fontSize="13" fontWeight="700" fill={INK}>LaborOps</text>
    <rect x="22" y="100" width="196" height="70" rx="10" fill="#fff" />
    <rect x="34" y="114" width="110" height="9" rx="4" fill={LINE} />
    <rect x="34" y="132" width="160" height="9" rx="4" fill={LINE} />
    <rect x="34" y="150" width="80" height="9" rx="4" fill={LINE} />
    <rect x="22" y="180" width="196" height="70" rx="10" fill="#fff" />
    <rect x="34" y="194" width="130" height="9" rx="4" fill={LINE} />
    <rect x="34" y="212" width="90" height="9" rx="4" fill={LINE} />
  </g>
);

const Pic1 = () => (
  <Phone label="Safari with the three-dot button next to the address bar circled, and Share circled in the menu above it">
    <Page />
    <rect x="96" y="262" width="122" height="98" rx="14" fill="#fff" stroke={LINE} />
    <text x="110" y="286" fontSize="12" fill={INK}>Copy</text>
    <line x1="104" y1="296" x2="210" y2="296" stroke={LINE} />
    <text x="110" y="316" fontSize="12" fontWeight="700" fill={INK}>Share</text>
    <path d="M196 304v10M192 308l4-4 4 4M190 312v6h12v-6" fill="none" stroke={INK} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="104" y1="326" x2="210" y2="326" stroke={LINE} />
    <text x="110" y="346" fontSize="12" fill={INK}>Add Bookmark</text>
    <rect x="102" y="300" width="110" height="24" rx="8" fill="none" stroke={HI} strokeWidth="2.5" />
    <rect x="18" y="372" width="160" height="34" rx="17" fill="#fff" stroke={LINE} />
    <text x="40" y="393" fontSize="12" fill={INK}>laborops.app</text>
    <circle cx="200" cy="389" r="17" fill="#fff" stroke={LINE} />
    <text x="200" y="393" fontSize="16" fontWeight="700" fill={INK} textAnchor="middle">···</text>
    <Ring cx={200} cy={389} r={20} />
  </Phone>
);
const Pic2 = () => (
  <Phone label="The Share sheet with Add to Home Screen circled">
    <rect x="4" y="60" width="232" height="356" rx="22" fill="#fff" />
    <image href="/brand/icon.png" x="22" y="76" width="34" height="34" />
    <text x="64" y="90" fontSize="12" fontWeight="700" fill={INK}>LaborOps</text>
    <text x="64" y="106" fontSize="10" fill={SUB}>laborops.app</text>
    <line x1="18" y1="124" x2="222" y2="124" stroke={LINE} />
    {['Copy', 'Add to Reading List', 'Add Bookmark'].map((t, i) => (
      <g key={t}>
        <text x="26" y={154 + i * 40} fontSize="12" fill={INK}>{t}</text>
        <line x1="18" y1={168 + i * 40} x2="222" y2={168 + i * 40} stroke={LINE} />
      </g>
    ))}
    <text x="26" y="274" fontSize="12" fontWeight="700" fill={INK}>Add to Home Screen</text>
    <rect x="190" y="261" width="18" height="18" rx="4" fill="none" stroke={INK} strokeWidth="1.5" />
    <path d="M199 265v10M194 270h10" stroke={INK} strokeWidth="1.5" strokeLinecap="round" />
    <rect x="16" y="252" width="208" height="36" rx="10" fill="none" stroke={HI} strokeWidth="2.5" />
    <line x1="18" y1="288" x2="222" y2="288" stroke={LINE} />
    <text x="26" y="314" fontSize="12" fill={INK}>Find on Page</text>
    <text x="120" y="360" fontSize="10" fill={SUB} textAnchor="middle">scroll down to find it</text>
    <path d="M120 368v14M114 376l6 6 6-6" fill="none" stroke={SUB} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </Phone>
);
const Pic3 = () => (
  <Phone label="The Add to Home Screen window with Open as Web App switched on and the Add button circled">
    <rect x="4" y="44" width="232" height="372" rx="22" fill="#f2f2f7" />
    <text x="18" y="74" fontSize="10" fill={BLUE}>Cancel</text>
    <text x="114" y="74" fontSize="10" fontWeight="700" fill={INK} textAnchor="middle">Add to Home Screen</text>
    <text x="214" y="74" fontSize="12" fontWeight="700" fill={BLUE} textAnchor="end">Add</text>
    <Ring cx={202} cy={70} r={18} />
    <rect x="18" y="94" width="204" height="78" rx="12" fill="#fff" />
    <image href="/brand/icon.png" x="30" y="106" width="52" height="52" />
    <text x="94" y="126" fontSize="13" fill={INK}>LaborOps</text>
    <line x1="94" y1="134" x2="210" y2="134" stroke={LINE} />
    <text x="94" y="152" fontSize="10" fill={SUB}>laborops.app</text>
    <rect x="18" y="186" width="204" height="44" rx="12" fill="#fff" />
    <text x="30" y="213" fontSize="12" fill={INK}>Open as Web App</text>
    <rect x="170" y="197" width="40" height="24" rx="12" fill="#34c759" />
    <circle cx="198" cy="209" r="10" fill="#fff" />
    <text x="120" y="256" fontSize="10" fill={SUB} textAnchor="middle">leave this switched on</text>
  </Phone>
);
const Pic4 = () => (
  <Phone label="The Home Screen with the LaborOps icon circled">
    {Array.from({ length: 16 }).map((_, i) => {
      const x = 26 + (i % 4) * 50, y = 60 + Math.floor(i / 4) * 66;
      return i === 9 ? (
        <g key={i}>
          <image href="/brand/icon.png" x={x} y={y} width="40" height="40" />
          <text x={x + 20} y={y + 54} fontSize="9" fontWeight="700" fill={INK} textAnchor="middle">LaborOps</text>
          <Ring cx={x + 20} cy={y + 20} r={27} />
        </g>
      ) : (
        <g key={i}>
          <rect x={x} y={y} width="40" height="40" rx="10" fill={['#d1d1d6', '#c7c7cc', '#e5e5ea'][i % 3]} />
          <rect x={x + 8} y={y + 48} width="24" height="5" rx="2.5" fill={LINE} />
        </g>
      );
    })}
    <rect x="22" y="346" width="196" height="56" rx="18" fill="#e5e5ea" />
    {[0, 1, 2, 3].map((i) => <rect key={i} x={38 + i * 46} y="354" width="40" height="40" rx="10" fill="#d1d1d6" />)}
  </Phone>
);


/* Android (Chrome): the ⋮ menu is at the top right, next to the address bar */
const ChromeBar = () => (
  <g>
    <rect x="16" y="40" width="176" height="30" rx="15" fill="#fff" stroke={LINE} />
    <text x="34" y="59" fontSize="11" fill={INK}>laborops.app</text>
    <text x="214" y="61" fontSize="18" fontWeight="700" fill={INK} textAnchor="middle">⋮</text>
  </g>
);
const APage = () => (
  <g transform="translate(0,40)"><Page /></g>
);
const APic1 = () => (
  <Phone android label="Chrome with the three-dot menu button at the top right circled">
    <ChromeBar />
    <APage />
    <Ring cx={214} cy={55} r={16} />
    <text x="120" y="330" fontSize="10" fill={SUB} textAnchor="middle">menu button: top right</text>
  </Phone>
);
const APic2 = () => (
  <Phone android label="Chrome menu with Add to Home screen circled">
    <ChromeBar />
    <APage />
    <rect x="90" y="46" width="138" height="250" rx="12" fill="#fff" stroke={LINE} />
    {['New tab', 'History', 'Downloads', 'Bookmarks', 'Share…', 'Find in page'].map((t, i) => (
      <text key={t} x="104" y={74 + i * 30} fontSize="11" fill={INK}>{t}</text>
    ))}
    <text x="104" y="254" fontSize="11" fontWeight="700" fill={INK}>Add to Home screen</text>
    <rect x="96" y="238" width="126" height="26" rx="8" fill="none" stroke={HI} strokeWidth="2.5" />
    <text x="104" y="284" fontSize="10" fill={SUB}>(or Install app)</text>
  </Phone>
);
const APic3 = () => (
  <Phone android label="The Install app window with the Install button circled">
    <APage />
    <rect x="4" y="4" width="232" height="412" rx="26" fill="rgba(0,0,0,0.35)" />
    <rect x="24" y="130" width="192" height="150" rx="18" fill="#fff" />
    <text x="40" y="160" fontSize="13" fontWeight="700" fill={INK}>Install app</text>
    <image href="/brand/icon.png" x="40" y="176" width="40" height="40" />
    <text x="90" y="194" fontSize="12" fill={INK}>LaborOps</text>
    <text x="90" y="210" fontSize="10" fill={SUB}>laborops.app</text>
    <text x="134" y="260" fontSize="12" fill={BLUE} textAnchor="middle">Cancel</text>
    <text x="190" y="260" fontSize="12" fontWeight="700" fill={BLUE} textAnchor="middle">Install</text>
    <Ring cx={190} cy={256} r={20} />
  </Phone>
);
const APic4 = () => (
  <Phone android label="The home screen with the LaborOps icon circled">
    {Array.from({ length: 16 }).map((_, i) => {
      const x = 26 + (i % 4) * 50, y = 60 + Math.floor(i / 4) * 66;
      return i === 6 ? (
        <g key={i}>
          <image href="/brand/icon.png" x={x} y={y} width="40" height="40" />
          <text x={x + 20} y={y + 54} fontSize="9" fontWeight="700" fill={INK} textAnchor="middle">LaborOps</text>
          <Ring cx={x + 20} cy={y + 20} r={27} />
        </g>
      ) : (
        <g key={i}>
          <circle cx={x + 20} cy={y + 20} r="20" fill={['#d1d1d6', '#c7c7cc', '#e5e5ea'][i % 3]} />
          <rect x={x + 8} y={y + 48} width="24" height="5" rx="2.5" fill={LINE} />
        </g>
      );
    })}
    <rect x="22" y="358" width="196" height="34" rx="17" fill="#e5e5ea" />
  </Phone>
);

const IOS_STEPS = [
  { pic: <Pic1 />, title: 'Tap ••• then Share', text: <>In Safari, tap the <b>•••</b> button next to the address bar, then tap <b>Share</b>. On older iPhones, tap the <b>Share</b> button at the bottom of the screen instead.</> },
  { pic: <Pic2 />, title: 'Tap Add to Home Screen', text: <>Scroll down the list and tap <b>Add to Home Screen</b>.</> },
  { pic: <Pic3 />, title: 'Tap Add', text: <>Leave <b>Open as Web App</b> switched on and tap <b>Add</b> in the top corner.</> },
  { pic: <Pic4 />, title: 'Open it from your Home Screen', text: <>From now on, open <b>LaborOps</b> from its icon. That’s how your iPhone shows shift alerts; turn them on when it asks.</> },
];
const ANDROID_STEPS = [
  { pic: <APic1 />, title: 'Tap ⋮ at the top right', text: <>In Chrome, tap the <b>⋮</b> menu button at the top right, next to the address bar.</> },
  { pic: <APic2 />, title: 'Tap Add to Home screen', text: <>Tap <b>Add to Home screen</b>. Some phones call it <b>Install app</b>.</> },
  { pic: <APic3 />, title: 'Tap Install', text: <>Tap <b>Install</b> (or <b>Add</b>). LaborOps is added to your home screen.</> },
  { pic: <APic4 />, title: 'Open it from your home screen', text: <>From now on, open <b>LaborOps</b> from its icon. It opens like an app and works with no signal. Turn on shift alerts when it asks.</> },
];

/**
 * Picture-by-picture guide to putting LaborOps on the home screen of an iPhone (needed there for notifications) or an
 * Android phone. Opens by itself once per device after signing in on a phone's browser; `open` lets a button open it any time.
 */
/** Is the auto-opened install guide showing right now (the alerts prompt waits for it). */
export const installGuideShowing = () => kept.open;

export default function IosInstallGuide({ open: forced, onClose }: { open?: boolean; onClose?: () => void }) {
  const [android, setAndroid] = useState(false);
  const { canInstall, install } = useInstall();
  useEffect(() => setAndroid(isAndroid()), []);
  const STEPS = android ? ANDROID_STEPS : IOS_STEPS;
  // Each page mounts its own shell, so the auto-opened guide's state lives here to survive moving between pages.
  const [auto, setAutoState] = useState(kept.open);
  const [i, setIState] = useState(forced !== undefined ? 0 : kept.step);
  const setAuto = (v: boolean) => { kept.open = v; setAutoState(v); };
  const setI = (v: number | ((n: number) => number)) => setIState((n) => { const x = typeof v === 'function' ? v(n) : v; if (forced === undefined) kept.step = x; return x; });
  const box = useRef<HTMLDivElement>(null);
  const touch = useRef<number | null>(null);
  useEffect(() => {
    if (forced !== undefined) return;
    if ((isIos() || isAndroid()) && !isStandalone() && !seen() && matchMedia('(max-width: 900px)').matches) setAuto(true);
  }, [forced]);
  const open = forced ?? auto;
  useEffect(() => {
    if (!open) return;
    if (forced !== undefined) setI(0);
    box.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', esc);
    return () => document.removeEventListener('keydown', esc);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open || typeof document === 'undefined') return null;
  function close() { markSeen(); setAuto(false); onClose?.(); window.dispatchEvent(new Event('lo-guide-closed')); }
  const last = i === STEPS.length - 1;
  const s = STEPS[i]!;
  return createPortal(
    <div className="iosg-back" role="presentation">
      <div className="iosg" role="dialog" aria-modal="true" aria-label="Add LaborOps to your Home Screen" tabIndex={-1} ref={box}
        onTouchStart={(e) => { touch.current = e.touches[0]?.clientX ?? null; }}
        onTouchEnd={(e) => {
          const x0 = touch.current; touch.current = null;
          const dx = (e.changedTouches[0]?.clientX ?? 0) - (x0 ?? 0);
          if (x0 == null || Math.abs(dx) < 50) return;
          setI((n) => Math.max(0, Math.min(STEPS.length - 1, n + (dx < 0 ? 1 : -1))));
        }}>
        <div className="iosg-top">
          <span className="iosg-kicker">Add LaborOps to your Home Screen</span>
          <button type="button" className="chip-x" aria-label="Close" onClick={close}>✕</button>
        </div>
        <p className="iosg-why">{android ? 'It opens like an app, works with no signal and shows shift alerts. It takes about 10 seconds.' : 'It opens like an app, and it’s the only way your iPhone can show you shift alerts. It takes about 10 seconds.'}</p>
        {android && canInstall && (
          <button type="button" className="btn primary iosg-now" onClick={async () => { await install(); close(); }}>Install LaborOps now</button>
        )}
        <div className="iosg-pic-wrap">{s.pic}</div>
        <div className="iosg-step" aria-live="polite">
          <span className="iosg-n">Step {i + 1} of {STEPS.length}</span>
          <h2 id="iosg-h">{s.title}</h2>
          <p>{s.text}</p>
        </div>
        <div className="iosg-dots" role="tablist" aria-label="Steps">
          {STEPS.map((x, k) => <button key={k} type="button" role="tab" aria-selected={k === i} aria-label={`Step ${k + 1}: ${x.title}`} className={k === i ? 'on' : ''} onClick={() => setI(k)} />)}
        </div>
        <div className="iosg-acts">
          {i > 0 ? <button type="button" className="btn" onClick={() => setI(i - 1)}>Back</button> : <button type="button" className="btn ghost" onClick={close}>Not now</button>}
          {last ? <button type="button" className="btn primary" onClick={close}>Got it</button> : <button type="button" className="btn primary" onClick={() => setI(i + 1)}>Next</button>}
        </div>
        <p className="iosg-note">{android ? 'Samsung Internet: tap ≡ at the bottom right, then Add page to › Home screen.' : 'Using Chrome on iPhone? Tap the share icon in the address bar, then Add to Home Screen.'}</p>
      </div>
    </div>,
    document.body,
  );
}
