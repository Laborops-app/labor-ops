'use client';
import Shell from '@/components/Shell';
import TrainingsPanel from '@/components/TrainingsPanel';

export default function Page() {
  return <Shell roles={['admin', 'manager', 'crew']}>{(me) => <TrainingsPanel me={me} />}</Shell>;
}
