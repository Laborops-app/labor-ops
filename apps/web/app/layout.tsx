import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LaborOps · Run every shift with precision',
  description: 'Crew scheduling and time tracking for production and event companies.',
  icons: { icon: '/brand/icon-192.png', apple: '/brand/icon-192.png' },
};
export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: [{ media: '(prefers-color-scheme: light)', color: '#f5f7fb' }, { media: '(prefers-color-scheme: dark)', color: '#0b1220' }] };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sets the theme before first paint so there is no light/dark flash. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('lo-theme');if(t!=='light'&&t!=='dark'){t=matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='light'}})()",
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
