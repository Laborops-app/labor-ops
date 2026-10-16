'use client';
import Shell from '@/components/Shell';
import AvailabilityPanel from '@/components/AvailabilityPanel';

export default function Page() {
  return <Shell roles={['crew']}>{() => <AvailabilityPanel />}</Shell>;
}
