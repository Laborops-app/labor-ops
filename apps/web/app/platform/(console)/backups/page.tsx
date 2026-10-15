'use client';
import { Banner } from '@/components/ui';
import { Backups, useStorage } from '@/components/PlatformStorage';
import { Head } from '@/components/platform/Console';

export default function BackupsPage() {
  const s = useStorage();
  return (
    <>
      <Head title="Backups" sub="Nightly copies of the database and every uploaded file, with how long they are kept." />
      {s.d ? <Backups key={JSON.stringify(s.d.settings.backups)} d={s.d} reload={s.load} /> : s.err ? <Banner>{s.err}</Banner> : <div className="muted">Loading…</div>}
    </>
  );
}
