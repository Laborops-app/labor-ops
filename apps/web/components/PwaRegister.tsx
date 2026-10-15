'use client';
import { useEffect } from 'react';

/** Registers the service worker on every page so the app is installable and push works (not in the platform console). */
export default function PwaRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator && !location.pathname.startsWith('/platform')) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  }, []);
  return null;
}
