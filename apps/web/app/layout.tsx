import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LaborOps · Run every shift with precision',
  description: 'Crew scheduling and time tracking for production and event companies.',
  icons: { icon: '/brand/icon-192.png', apple: '/brand/icon-192.png' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0a2351' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
