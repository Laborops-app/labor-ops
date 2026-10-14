'use client';
import { useEffect } from 'react';

/** Accounting settings moved to Integrations. Old links (and older QuickBooks sign-in returns) land there. */
export default function Page() {
  useEffect(() => {
    window.location.replace(`/integrations${window.location.search}`);
  }, []);
  return <div className="muted">Moved to Integrations…</div>;
}
