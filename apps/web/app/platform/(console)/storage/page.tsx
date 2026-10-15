'use client';
import { Banner } from '@/components/ui';
import { StorageSettings, useStorage } from '@/components/PlatformStorage';
import { Head } from '@/components/platform/Console';

export default function StoragePage() {
  const s = useStorage();
  return (
    <>
      <Head title="Storage" sub="Where uploaded files (chat attachments, certificates, documents) are kept, and the bucket for each." />
      {s.d ? <StorageSettings key={JSON.stringify(s.d.settings)} d={s.d} reload={s.load} /> : s.err ? <Banner>{s.err}</Banner> : <div className="muted">Loading…</div>}
    </>
  );
}
