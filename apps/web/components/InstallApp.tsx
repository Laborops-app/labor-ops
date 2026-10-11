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
