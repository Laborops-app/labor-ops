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

