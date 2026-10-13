'use client';
import { useEffect, useState } from 'react';

type Prompt = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let saved: Prompt | null = null; // survives page-to-page navigation

/** "Install app" button: shows only where the browser can install LaborOps (Chrome, Edge, Android) and it isn't installed yet. */
export function useInstall() {
  const [prompt, setPrompt] = useState<Prompt | null>(saved);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    setInstalled(matchMedia('(display-mode: standalone)').matches);
    const before = (e: Event) => {
      e.preventDefault();
      saved = e as Prompt;
      setPrompt(saved);
    };
    const done = () => {
      saved = null;
      setPrompt(null);
      setInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', before);
    window.addEventListener('appinstalled', done);
    return () => {
      window.removeEventListener('beforeinstallprompt', before);
      window.removeEventListener('appinstalled', done);
    };
  }, []);
  const install = async () => {
    if (!prompt) return;
    await prompt.prompt();
    await prompt.userChoice.catch(() => undefined);
    saved = null;
    setPrompt(null);
  };
  return { canInstall: !!prompt && !installed, installed, install };
}

export default function InstallApp({ className = 'btn small' }: { className?: string }) {
  const { canInstall, install } = useInstall();
  if (!canInstall) return null;
  return (
    <button className={className} onClick={install} title="Install LaborOps as an app">
      Install app
    </button>
  );
}

/** Profile-page card; hidden where installing isn't possible (the browser's own menu still works). */
export function InstallCard() {
  const { canInstall, install } = useInstall();
  if (!canInstall) return null;
  return (
    <section className="card">
      <h2>Install the app</h2>
      <p className="muted small">Add LaborOps to your desktop or phone so it opens in its own window, like any other app.</p>
      <button className="btn primary small" onClick={install}>
        Install app
      </button>
    </section>
  );
}

const KEY = 'lo-install-prompt'; // per browser/device: { installed?: true, dismissedAt?: ms }
const DELAY_MS = 45_000;
const SNOOZE_MS = 30 * 24 * 3600_000;
const read = (): { installed?: boolean; dismissedAt?: number } => {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
};
const write = (v: object) => { try { localStorage.setItem(KEY, JSON.stringify({ ...read(), ...v })); } catch { /* storage blocked */ } };

/** Pops up 45s after the page opens, offering to install. Never shown when the app is already installed on this device, or after it was dismissed in the last 30 days. */
export function InstallPopup() {
  const { canInstall, installed, install } = useInstall();
  const [due, setDue] = useState(false);
  const [open, setOpen] = useState(false);
  const [related, setRelated] = useState(false);

  useEffect(() => {
    const st = read();
    if (installed) write({ installed: true });
    if (st.installed || (st.dismissedAt && Date.now() - st.dismissedAt < SNOOZE_MS)) return;
    // Installed earlier from this browser? (Chrome/Edge/Android; ignored where unsupported.)
    (navigator as any).getInstalledRelatedApps?.().then((a: unknown[]) => { if (a?.length) { write({ installed: true }); setRelated(true); } }).catch(() => undefined);
    const t = setTimeout(() => setDue(true), DELAY_MS);
    return () => clearTimeout(t);
  }, [installed]);

  useEffect(() => {
    if (due && canInstall && !installed && !related && !read().installed) setOpen(true);
  }, [due, canInstall, installed, related]);

  useEffect(() => {
    const done = () => { write({ installed: true }); setOpen(false); };
    window.addEventListener('appinstalled', done);
    return () => window.removeEventListener('appinstalled', done);
  }, []);

  if (!open) return null;
  const dismiss = () => { write({ dismissedAt: Date.now() }); setOpen(false); };
  return (
    <div role="dialog" aria-label="Install LaborOps" className="card" style={{ position: 'fixed', right: 16, bottom: 16, zIndex: 60, maxWidth: 340, boxShadow: '0 8px 30px rgba(0,0,0,.35)' }}>
      <h3 style={{ marginTop: 0 }}>Install LaborOps</h3>
      <p className="muted small">Add it to your desktop so it opens in its own window and is one click away.</p>
      <div className="row">
        <button className="btn primary small" onClick={async () => { await install(); write({ dismissedAt: Date.now() }); setOpen(false); }}>Install</button>
        <button className="btn ghost small" onClick={dismiss}>Not now</button>
      </div>
    </div>
  );
}
