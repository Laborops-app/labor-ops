import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'LaborOps · Platform console',
  robots: { index: false, follow: false },
};

export default function PlatformLayout({ children }: { children: React.ReactNode }) {
  return children;
}
