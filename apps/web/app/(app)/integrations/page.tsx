'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import Shell from '@/components/Shell';
import { api } from '@/lib/api';

type Status = { text: string; tone: 'on' | 'off' | 'warn' } | null;
type Card = { slug: string; title: string; blurb: string; icon: React.ReactNode; group: 'apps' | 'money' | 'comms' };

const I = (d: string) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);
export const INTEGRATIONS: Card[] = [
  { slug: 'rentman', title: 'Rentman', group: 'apps', blurb: 'Projects into the pipeline, crew needs into shifts, quotes, invoices; hours and time off back.', icon: I('M3 7h18M3 12h18M3 17h12M17 15l2 2 4-4') },
  { slug: 'academy', title: 'Upstage Academy', group: 'apps', blurb: 'Certificates students earn are added to their crew profile.', icon: I('M22 10 12 5 2 10l10 5 10-5ZM6 12v5c3 2 9 2 12 0v-5') },
  { slug: 'quickbooks', title: 'QuickBooks Online', group: 'money', blurb: 'Send event invoices and crew hours to QuickBooks.', icon: I('M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM9 8v8m6-8v8M9 12h6') },
  { slug: 'quickbooks-desktop', title: 'QuickBooks Desktop', group: 'money', blurb: 'Settings for the .IIF invoice import file.', icon: I('M4 5h16v11H4zM8 20h8M12 16v4') },
  { slug: 'payroll', title: 'Payroll', group: 'money', blurb: 'ADP, Gusto and QuickBooks Payroll exports.', icon: I('M3 7h18v10H3zM7 12h.01M17 12h.01M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z') },
  { slug: 'messaging', title: 'Email & texting', group: 'comms', blurb: 'Email (Amazon SES) and texts (Zernio or Podium) to crew; send a test.', icon: I('M4 6h16v12H4zM4 7l8 6 8-6') },
];
const GROUPS: [Card['group'], string][] = [['apps', 'Apps'], ['money', 'Accounting & payroll'], ['comms', 'Messages to crew']];

/** Integrations: one card per connection with where it stands; each opens its own page. */
function Body() {
  const [st, setSt] = useState<Record<string, Status>>({});
  useEffect(() => {
    // Returning from a QuickBooks or Podium sign-in that still points here.
    const q = new URLSearchParams(window.location.search);
    if (q.get('qbo')) { window.location.replace(`/integrations/quickbooks?qbo=${q.get('qbo')}`); return; }
    if (q.get('podium')) { window.location.replace(`/integrations/messaging?podium=${q.get('podium')}`); return; }
    const set = (k: string, v: Status) => setSt((x) => ({ ...x, [k]: v }));
    api<{ connected: boolean; projects: number; pipeline?: { autoEvents: boolean } }>('/api/rentman/settings')
      .then((r) => set('rentman', r.connected ? { text: `Connected · ${r.projects} projects`, tone: 'on' } : { text: 'Not connected', tone: 'off' })).catch(() => set('rentman', null));
    api<{ secretSet: boolean; stats: { applied: number; total: number } }>('/api/integrations/academy')
      .then((r) => set('academy', r.secretSet ? { text: `Set up · ${r.stats.applied} certificates added`, tone: 'on' } : { text: 'Not set up', tone: 'off' })).catch(() => set('academy', null));
    api<{ quickbooks: { connected: boolean; expired: boolean; companyName?: string | null }; settings: { payroll: { enabled: string[] } } }>('/api/accounting')
      .then((r) => {
        const q2 = r.quickbooks;
        set('quickbooks', q2.connected && !q2.expired ? { text: `Connected${q2.companyName ? ` · ${q2.companyName}` : ''}`, tone: 'on' } : q2.expired ? { text: 'Connection expired', tone: 'warn' } : { text: 'Not connected', tone: 'off' });
        set('quickbooks-desktop', { text: 'File export', tone: 'on' });
        const names: Record<string, string> = { adp: 'ADP', gusto: 'Gusto', qbo: 'QuickBooks Payroll', quickbooks: 'QuickBooks Payroll' };
        set('payroll', { text: r.settings.payroll.enabled.map((p) => names[p] ?? p).join(', ') || 'None', tone: 'on' });
      }).catch(() => { set('quickbooks', null); set('payroll', null); });
    api<{ email: { live: boolean }; sms: { live: boolean; provider: string } }>('/api/messaging')
      .then((r) => set('messaging', { text: `Email ${r.email.live ? 'on' : 'off'} · Texts ${r.sms.live ? `via ${r.sms.provider === 'podium' ? 'Podium' : 'Zernio'}` : 'off'}`, tone: r.email.live && r.sms.live ? 'on' : r.email.live || r.sms.live ? 'warn' : 'off' }))
      .catch(() => set('messaging', null));
  }, []);
  return (
    <>
      <h1>Integrations</h1>
      <p className="muted">Connect LaborOps to the tools you already use. Open one to set it up.</p>
      {GROUPS.map(([g, label]) => (
        <section key={g} className="int-group">
          <h2 className="panel-group-title">{label}</h2>
          <div className="int-grid">
            {INTEGRATIONS.filter((c) => c.group === g).map((c) => {
              const s = st[c.slug];
              return (
                <Link key={c.slug} href={`/integrations/${c.slug}`} className="int-card">
                  <span className="int-ico">{c.icon}</span>
                  <span className="int-txt">
                    <b>{c.title}</b>
                    <span className="muted small">{c.blurb}</span>
                  </span>
                  <span className={`int-status ${s?.tone ?? ''}`}>{s === undefined ? '…' : s ? s.text : 'Open to check'}</span>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </>
  );
}

export default function Page() {
  return <Shell roles={['admin']}>{() => <Body />}</Shell>;
}
