'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Messaging moved into Integrations › Email & texting (links and sign-in returns land here first). */
export default function Page() {
  const router = useRouter();
  useEffect(() => { router.replace(`/integrations/messaging${window.location.search}`); }, [router]);
  return <div className="muted">Opening Email &amp; texting…</div>;
}
