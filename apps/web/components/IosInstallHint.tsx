'use client';
import { useEffect, useState } from 'react';
import BrowserPush from '@/components/BrowserPush';
import { useInstall } from '@/components/useInstall';
import IosInstallGuide from '@/components/IosInstallGuide';

const KEY = 'lo-install-hint';
const SNOOZE = 14 * 24 * 3600_000;
const snoozed = (k: string) => { try { return Date.now() - Number(localStorage.getItem(`${KEY}:${k}`) || 0) < SNOOZE; } catch { return false; } };
const snooze = (k: string) => { try { localStorage.setItem(`${KEY}:${k}`, String(Date.now())); } catch { /* ignore */ } };

export { isIos, isStandalone } from '@/lib/device';
import { isIos, isStandalone } from '@/lib/device';

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
  const [guide, setGuide] = useState(false);
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
    if (step === 'none' && !isStandalone() && !snoozed('android') && /Android/.test(navigator.userAgent)) setStep('android');
  }, [step]);

  if (step === 'none') return null;
  const close = (k: string) => { snooze(k); setStep('none'); };
  if (step === 'ios')
    return (
      <section className="card install-hint">
        <div className="row space"><h2>Get shift alerts on your iPhone</h2><button className="chip-x" aria-label="Not now" onClick={() => close('ios')}>✕</button></div>
        <p className="small muted">iPhones only show LaborOps notifications once it is on your Home Screen. It takes 10 seconds:</p>
        <button type="button" className="btn primary" onClick={() => setGuide(true)}>Show me how</button>
        <IosInstallGuide open={guide} onClose={() => setGuide(false)} />
      </section>
    );
  if (step === 'android')
    return (
      <section className="card install-hint">
        <div className="row space"><h2>Install LaborOps</h2><button className="chip-x" aria-label="Not now" onClick={() => close('android')}>✕</button></div>
        <p className="small muted">Put LaborOps on your home screen: it opens like an app, works with no signal, and can alert you about shifts.</p>
        <div className="row">
          {canInstall && <button className="btn primary" onClick={install}>Install</button>}
          <button type="button" className={canInstall ? 'btn' : 'btn primary'} onClick={() => setGuide(true)}>Show me how</button>
        </div>
        <IosInstallGuide open={guide} onClose={() => setGuide(false)} />
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
