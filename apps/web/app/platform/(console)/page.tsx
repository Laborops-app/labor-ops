'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Banner } from '@/components/ui';
import { mb } from '@/components/PlatformStorage';
import { ago, CoAvatar, Head, num, papi, planLabel } from '@/components/platform/Console';
import { ShareBars, TimeChart } from '@/components/platform/Charts';
import { feedText } from '@/components/platform/feed';

type Dash = {
  days: number; unit: 'day' | 'week' | 'month';
  kpis: Record<string, number>;
  series: { at: string; signups: number; companies: number; logins: number; hours: number }[];
  plans: { plan: string; n: number }[];
  top: { id: string; name: string; plan: string; people: number; logins: number; events: number; last_active: string | null }[];
  quiet: { id: string; name: string; plan: string; people: number; last_active: string | null; created_at: string }[];
  feed: { action: string; at: string; tenant_id: string | null; company: string | null; actor: string | null; detail: any }[];
  health: {
    dbBytes: number; fileBytes: number; files: number; failedDay: number; stuck: number; storage: { source: string; enabled: boolean };
    lastBackup: { status: string; started_at: string; size: number | null; error: string | null } | null;
    email: boolean; sms: boolean; demo: boolean; uptime: number; version: string | null;
  };
};

const RANGES = [[7, '7 days'], [30, '30 days'], [90, '90 days'], [365, '12 months']] as const;

function Delta({ now, prev, days }: { now: number; prev: number; days: number }) {
  if (!prev && !now) return <span className="muted small">No change</span>;
  if (!prev) return <span className="cs-delta up small">New this period</span>;
  const p = Math.round(((now - prev) / prev) * 100);
  const range = days === 365 ? '12 months' : `${days} days`;
  return (
    <span className={`cs-delta small ${p > 0 ? 'up' : p < 0 ? 'down' : ''}`}>
      <span aria-hidden="true">{p > 0 ? '▲' : p < 0 ? '▼' : '•'}</span> {Math.abs(p)}% <span className="muted">vs previous {range}</span>
    </span>
  );
}

function Tile({ label, value, children }: { label: string; value: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="cs-tile">
      <span className="muted small">{label}</span>
      <b>{value}</b>
      {children}
    </div>
  );
}

export default function Dashboard() {
  const [days, setDays] = useState<number>(30);
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem('lo_pf_days'));
      if ([7, 30, 90, 365].includes(v)) setDays(v);
    } catch {
      /* storage blocked */
    }
  }, []);
  useEffect(() => {
    setErr('');
    papi<Dash>(`/api/platform/dashboard?days=${days}`).then(setD).catch((e) => setErr(e.message));
  }, [days]);
  const pick = (v: number) => {
    setDays(v);
    try {
      localStorage.setItem('lo_pf_days', String(v));
    } catch {
      /* storage blocked */
    }
  };

  const k = d?.kpis;
  const h = d?.health;
  const backupOld = h?.lastBackup ? Date.now() - new Date(h.lastBackup.started_at).getTime() > 36 * 3600_000 : true;
  const range = days === 365 ? '12 months' : `${days} days`;
  return (
    <>
      <Head title="Dashboard" sub="How LaborOps is doing across every company.">
        <div className="phase-tabs cs-range" role="tablist" aria-label="Time range">
          {RANGES.map(([v, l]) => (
            <button key={v} role="tab" aria-selected={days === v} className={days === v ? 'tab on' : 'tab'} onClick={() => pick(v)}>{l}</button>
          ))}
        </div>
      </Head>
      {err && <Banner>{err}</Banner>}
      {!d || !k || !h ? (
        !err && <div className="muted">Loading…</div>
      ) : (
        <>
          <div className="cs-tiles">
            <Tile label="Companies" value={num(k.companies)}>
              <span className="small">{num(k.new_companies)} new in {range}</span>
              <Delta now={k.new_companies} prev={k.new_companies_prev} days={days} />
            </Tile>
            <Tile label="Active companies" value={num(k.active_companies)}>
              <span className="small">used LaborOps in the last 7 days</span>
              <span className="muted small">{k.companies ? Math.round((k.active_companies / k.companies) * 100) : 0}% of all companies{k.suspended ? ` · ${k.suspended} suspended` : ''}</span>
            </Tile>
            <Tile label="People" value={num(k.people)}>
              <span className="small">{num(k.crew)} crew · {num(k.people - k.crew)} office</span>
              <span className="muted small">{num(k.active_week)} active this week · {num(k.active_today)} today</span>
            </Tile>
            <Tile label="Hours clocked" value={num(k.hours)}>
              <span className="small">in {range}</span>
              <Delta now={k.hours} prev={k.hours_prev} days={days} />
            </Tile>
          </div>
          <div className="cs-minis">
            <div><span className="muted small">Sign-ins</span><b>{num(k.logins)}</b><Delta now={k.logins} prev={k.logins_prev} days={days} /></div>
            <div><span className="muted small">Events created</span><b>{num(k.events)}</b><Delta now={k.events} prev={k.events_prev} days={days} /></div>
            <div><span className="muted small">Emails and texts sent</span><b>{num(k.messages)}</b><span className="muted small">in {range}</span></div>
            <div><span className="muted small">Stored files</span><b>{mb(h.fileBytes)}</b><span className="muted small">{num(h.files)} files</span></div>
          </div>

          <div className="cs-grid2">
            <section className="card cs-card">
              <h2>New companies</h2>
              <TimeChart label="New companies" data={d.series.map((s) => ({ at: s.at, value: s.signups }))} unit={d.unit} />
            </section>
            <section className="card cs-card">
              <h2>Total companies</h2>
              <TimeChart label="Total companies" kind="line" data={d.series.map((s) => ({ at: s.at, value: s.companies }))} unit={d.unit} />
            </section>
            <section className="card cs-card">
              <h2>Sign-ins</h2>
              <TimeChart label="Sign-ins" data={d.series.map((s) => ({ at: s.at, value: s.logins }))} unit={d.unit} />
            </section>
            <section className="card cs-card">
              <h2>Hours clocked by crews</h2>
              <TimeChart label="Hours clocked" data={d.series.map((s) => ({ at: s.at, value: s.hours }))} unit={d.unit} format={(n) => `${n.toLocaleString()} h`} />
            </section>
          </div>

          <div className="cs-grid-main">
            <section className="card cs-card">
              <div className="cs-card-head">
                <h2>Most active companies</h2>
                <Link href="/platform/companies" className="btn ghost small">All companies</Link>
              </div>
              <div className="table-wrap">
                <table className="cs-table">
                  <thead><tr><th>Company</th><th>People</th><th>Sign-ins</th><th>Events</th><th>Last active</th></tr></thead>
                  <tbody>
                    {d.top.map((c) => (
                      <tr key={c.id}>
                        <td><Link href={`/platform/companies/${c.id}`} className="cs-co"><CoAvatar name={c.name} size={30} /><span><b>{c.name}</b><span className="muted small">{planLabel(c.plan)}</span></span></Link></td>
                        <td>{num(c.people)}</td>
                        <td>{num(c.logins)}</td>
                        <td>{num(c.events)}</td>
                        <td className="small">{ago(c.last_active)}</td>
                      </tr>
                    ))}
                    {!d.top.length && <tr><td colSpan={5} className="muted small">No companies yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
            <div className="cs-stack">
              <section className="card cs-card">
                <h2>Plans</h2>
                {d.plans.length ? <ShareBars rows={d.plans.map((p) => ({ label: planLabel(p.plan), value: p.n }))} /> : <p className="muted small">No active companies.</p>}
              </section>
              <section className="card cs-card">
                <h2>Gone quiet</h2>
                <p className="muted small" style={{ marginTop: -4 }}>No one has used LaborOps in 14+ days. Worth a check-in.</p>
                <ul className="cs-list">
                  {d.quiet.map((c) => (
                    <li key={c.id}>
                      <Link href={`/platform/companies/${c.id}`} className="cs-co"><CoAvatar name={c.name} size={28} /><span><b>{c.name}</b><span className="muted small">{c.people} people · last active {ago(c.last_active).toLowerCase()}</span></span></Link>
                    </li>
                  ))}
                  {!d.quiet.length && <li className="muted small">Every company has been active recently.</li>}
                </ul>
              </section>
            </div>
          </div>

          <div className="cs-grid2">
            <section className="card cs-card">
              <div className="cs-card-head">
                <h2>Recent activity</h2>
                <Link href="/platform/activity" className="btn ghost small">Activity log</Link>
              </div>
              <ul className="cs-feed">
                {d.feed.map((f, i) => (
                  <li key={i}>
                    <span className={`cs-feed-dot ${f.action === 'signup' ? 'new' : f.action === 'company.suspend' ? 'bad' : ''}`} aria-hidden="true" />
                    <span className="cs-feed-main">
                      <span>{feedText(f)}{f.company && <> · {f.tenant_id ? <Link href={`/platform/companies/${f.tenant_id}`}>{f.company}</Link> : f.company}</>}</span>
                      <span className="muted small">{ago(f.at)}{f.actor ? ` · by ${f.actor}` : ''}</span>
                    </span>
                  </li>
                ))}
                {!d.feed.length && <li className="muted small">Nothing yet.</li>}
              </ul>
            </section>
            <section className="card cs-card">
              <h2>System health</h2>
              <ul className="pf-health cs-health">
                <li className={h.storage.enabled ? 'ok' : 'warn'}>
                  <b>File storage</b>
                  <span>{h.storage.enabled ? (h.storage.source === 'local' ? 'Built-in RustFS' : 'Your S3 server') : 'Off: files are kept in the database'}</span>
                  <Link href="/platform/storage" className="btn ghost small">Settings</Link>
                </li>
                <li className={h.lastBackup?.status === 'done' && !backupOld ? 'ok' : 'bad'}>
                  <b>Backups</b>
                  <span>{h.lastBackup ? `${h.lastBackup.status === 'done' ? 'Last backup' : 'Last backup failed'} ${ago(h.lastBackup.started_at).toLowerCase()}${h.lastBackup.size ? ` · ${mb(h.lastBackup.size)}` : ''}` : 'No backup yet'}</span>
                  <Link href="/platform/backups" className="btn ghost small">Backups</Link>
                </li>
                <li className={!h.email ? 'warn' : h.failedDay || h.stuck ? 'warn' : 'ok'}>
                  <b>Email</b>
                  <span>{!h.email ? 'Log-only: no email is sent. Set SES SMTP on the server.' : h.failedDay || h.stuck ? `${h.failedDay} failed today${h.stuck ? `, ${h.stuck} waiting over 15 min` : ''}` : 'Sending through Amazon SES'}</span>
                </li>
                <li className={h.sms ? 'ok' : 'warn'}>
                  <b>Text messages</b>
                  <span>{h.sms ? 'Connected' : 'Log-only: no texts are sent (companies can still connect Podium)'}</span>
                </li>
                <li className="ok">
                  <b>Database</b>
                  <span>{mb(h.dbBytes)} · API up {h.uptime > 86400 ? `${Math.floor(h.uptime / 86400)} d` : h.uptime > 3600 ? `${Math.floor(h.uptime / 3600)} h` : `${Math.max(1, Math.floor(h.uptime / 60))} min`}{h.version ? ` · ${h.version}` : ''}</span>
                </li>
                {h.demo && (
                  <li className="warn">
                    <b>Demo mode</b>
                    <span>The main sign-in page shows demo quick-logins (SEED_DEMO=true). Turn this off before real customers sign up.</span>
                  </li>
                )}
              </ul>
            </section>
          </div>
        </>
      )}
    </>
  );
}
