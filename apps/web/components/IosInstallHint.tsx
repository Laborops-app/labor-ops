'use client';
import { useEffect, useState } from 'react';
import BrowserPush from '@/components/BrowserPush';
import { useInstall } from '@/components/InstallApp';

const KEY = 'lo-install-hint';
const SNOOZE = 14 * 24 * 3600_000;
const snoozed = (k: string) => { try { return Date.now() - Number(localStorage.getItem(`${KEY}:${k}`) || 0) < SNOOZE; } catch { return false; } };
const snooze = (k: string) => { try { localStorage.setItem(`${KEY}:${k}`, String(Date.now())); } catch { /* ignore */ } };

export const isIos = () =>
  typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1));
export const isStandalone = () =>
  typeof window !== 'undefined' && (matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);

const ShareIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label="Share" style={{ verticalAlign: '-3px' }}>
    <path d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7" />
  </svg>
);

/**
 * The install funnel on My shifts. On iPhone, notifications only work once LaborOps is on the Home Screen, so this walks
 * crew through Share → Add to Home Screen. Once it is installed (any phone), it asks to turn on shift alerts.
 */
export default function IosInstallHint() {
  const { canInstall, install } = useInstall();
  const [step, setStep] = useState<'none' | 'ios' | 'android' | 'push'>('none');
  useEffect(() => {
    const decide = async () => {
      if (isStandalone()) {
        if (!('Notification' in window) || !('serviceWorker' in navigator) || snoozed('push')) return setStep('none');
        if (Notification.permission === 'denied') return setStep('none');
        const reg = await navigator.serviceWorker.getRegistration('/sw.js').catch(() => undefined);
        const sub = await reg?.pushManager?.getSubscription().catch(() => null);
        return setStep(sub && Notification.permission === 'granted' ? 'none' : 'push');
      }
      if (isIos() && !snoozed('ios')) return setStep('ios');
      setStep('none');
    };
    decide();
  }, []);
  useEffect(() => {
    if (step === 'none' && canInstall && !isStandalone() && !snoozed('android') && /Android/.test(navigator.userAgent)) setStep('android');
  }, [canInstall, step]);

  if (step === 'none') return null;
  const close = (k: string) => { snooze(k); setStep('none'); };
  if (step === 'ios')
    return (
      <section className="card install-hint">
        <div className="row space"><h2>Get shift alerts on your iPhone</h2><button className="chip-x" aria-label="Not now" onClick={() => close('ios')}>✕</button></div>
        <p className="small muted">iPhones only show LaborOps notifications once it is on your Home Screen. It takes 10 seconds:</p>
        <ol className="install-steps">
          <li>Tap <b>Share</b> <ShareIcon /> at the bottom of Safari (top right on iPad).</li>
          <li>Scroll down and tap <b>Add to Home Screen</b>, then <b>Add</b>.</li>
          <li>Open <b>LaborOps</b> from your Home Screen and turn on notifications.</li>
        </ol>
        <p className="small muted">Using Chrome on iPhone? Tap the share icon in the address bar, then Add to Home Screen.</p>
      </section>
    );
  if (step === 'android')
    return (
      <section className="card install-hint">
        <div className="row space"><h2>Install LaborOps</h2><button className="chip-x" aria-label="Not now" onClick={() => close('android')}>✕</button></div>
        <p className="small muted">Put LaborOps on your home screen: it opens like an app, works with no signal, and can alert you about shifts.</p>
        <button className="btn primary" onClick={install}>Install</button>
      </section>
    );
  return (
    <section className="card install-hint">
      <div className="row space"><h2>Turn on shift alerts</h2><button className="chip-x" aria-label="Not now" onClick={() => close('push')}>✕</button></div>
      <p className="small muted">Get new shifts, changes and reminders on this phone the moment they happen.</p>
      <BrowserPush />
    </section>
  );
}
