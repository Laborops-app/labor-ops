'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import Shell from '@/components/Shell';
import { OnsiteRatings } from '@/components/Rating';
import { useTabTitle } from '@/lib/tabs';

/** Crew rate page for crew leads and on-site labor coordinators (their own ratings only, no averages). */
function Body() {
  const { id } = useParams<{ id: string }>();
  const [name, setName] = useState<string | null>(null);
  useTabTitle(name ? `Rate · ${name}` : null);
  return (
    <>
      <div className="row space" style={{ alignItems: 'flex-start' }}>
        <h1>Rate crew{name ? ` · ${name}` : ''}</h1>
        <Link className="btn ghost" href={`/onsite/${id}`}>Back to check-in</Link>
      </div>
      <section className="card" style={{ padding: 0 }}>
        <OnsiteRatings eventId={id} onLoaded={(d) => setName(d.event.name)} />
      </section>
    </>
  );
}

export default function Page() {
  return <Shell roles={['crew']}>{() => <Body />}</Shell>;
}
