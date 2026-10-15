'use client';
import { AppFrame } from '@/components/Shell';

/** One frame (sidebar, top bar, tabs) for every app page; the pages of open tabs are kept alive inside it. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppFrame>{children}</AppFrame>;
}
