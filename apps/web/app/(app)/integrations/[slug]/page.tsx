'use client';
import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import Shell from '@/components/Shell';
import AccountingPanels from '@/components/AccountingPanels';
import MessagingSettings from '@/components/MessagingSettings';
import { AcademySettings, RentmanSettings, RENTMAN_TABS, type RentmanTab } from '@/components/IntegrationSettings';
import Skeleton from '@/components/Skeleton';

function RentmanPage() {
  const [tab, setTab] = useState<RentmanTab>('connection');
  // The tab lives in the address (?tab=crew) so it survives a reload and can be linked to.
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get('tab') as RentmanTab | null;
    if (t && RENTMAN_TABS.some(([k]) => k === t)) setTab(t);
  }, []);
  const pick = (t: RentmanTab) => {
    setTab(t);
    const u = new URL(window.location.href);
    u.searchParams.set('tab', t);
    window.history.replaceState(null, '', u.toString());
  };
  return <RentmanSettings tab={tab} setTab={pick} />;
}

function Detail() {
  const { slug } = useParams<{ slug: string }>();
  const params = useSearchParams();
  const body =
    slug === 'rentman' ? <RentmanPage /> :
    slug === 'academy' ? <AcademySettings /> :
    slug === 'quickbooks' ? <AccountingPanels qbo={params.get('qbo')} only="quickbooks" /> :
    slug === 'quickbooks-desktop' ? <AccountingPanels qbo={null} only="desktop" /> :
    slug === 'payroll' ? <AccountingPanels qbo={null} only="payroll" /> :
    slug === 'messaging' ? (<><div className="int-head"><div><h2 style={{ margin: 0 }}>Email &amp; texting</h2><p className="muted small" style={{ margin: '4px 0 0' }}>How LaborOps emails and texts your crew.</p></div></div><MessagingSettings /></>) :
    <p className="muted">That integration doesn’t exist.</p>;
  return (
    <>
      <Link href="/integrations" className="btn ghost small int-back">← All integrations</Link>
      {body}
    </>
  );
}

export default function Page() {
  return (
    <Shell roles={['admin']}>
      {() => (
        <Suspense fallback={<Skeleton />}>
          <Detail />
        </Suspense>
      )}
    </Shell>
  );
}
