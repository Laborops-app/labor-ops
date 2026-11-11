'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Banner } from '@/components/ui';

type Opts = {
  webhooks: boolean; crew_link: boolean; rates_source: boolean; quoted_bill_rates: boolean; push_hours: boolean; push_time_off: boolean;
  show_invoices: boolean; show_files: boolean; show_contacts: boolean; show_vehicles: boolean; show_equipment_leads: boolean;
  filesFolder: string | null; webhookUrl: string | null; hasWebhookToken: boolean; webhookLastAt: string | null;
  ratesLastAt: string | null; ratesLastResult: { rates: number; roles: number; unmatched: string[] } | null;
};
type Crew = { id: number; name: string; email: string | null; phone: string | null; active: boolean; user_id: string | null; linked_by: string | null; user_name: string | null };
type Push = { hours: { sent: number; waiting: number; failed: number; missingCrew: { id: string; name: string }[]; lastError: string | null }; timeOff: { sent: number; failed: number; lastError: string | null } };

function Toggle({ on, label, help, disabled, onChange }: { on: boolean; label: string; help: string; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="rm-opt">
      <label className="check">
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span><b>{label}</b></span>
      </label>
      <p className="muted small">{help}</p>
    </div>
  );
}

/** Integrations › Rentman: every optional feature, each with its own switch. */
export default function RentmanOptions() {
  const [o, setO] = useState<Opts | null>(null);
  const [crew, setCrew] = useState<{ crew: Crew[]; notInRentman: { id: string; name: string; email: string }[]; people: { id: string; name: string }[] } | null>(null);
  const [push, setPush] = useState<Push | null>(null);
  const [token, setToken] = useState('');
  const [folder, setFolder] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api<{ options: Opts }>('/api/rentman/options').then((r) => { setO(r.options); setFolder(r.options.filesFolder ?? ''); }).catch((e) => setErr(e.message));
  const loadCrew = () => api<NonNullable<typeof crew>>('/api/rentman/crew').then(setCrew).catch(() => {});
  const loadPush = () => api<Push>('/api/rentman/push-status').then(setPush).catch(() => {});
  useEffect(() => { load(); }, []);
  useEffect(() => { if (o?.crew_link) loadCrew(); if (o?.push_hours || o?.push_time_off) loadPush(); }, [o?.crew_link, o?.push_hours, o?.push_time_off]);
  if (!o) return err ? <Banner>{err}</Banner> : null;

  const save = async (patch: Partial<Opts> & { webhookToken?: string | null }, done?: string) => {
    setBusy('save'); setErr(''); setMsg('');
    try {
      const r = await api<{ options: Opts; ran: { crew?: { linked: number; unlinked: number; crew: number }; rates?: { roles: number; unmatched: string[] } } }>('/api/rentman/options', { method: 'PUT', body: patch });
      setO(r.options);
      const extra = [
        r.ran.crew ? `${r.ran.crew.crew} Rentman crew read, ${r.ran.crew.linked} linked automatically, ${r.ran.crew.unlinked} to link by hand.` : '',
        r.ran.rates ? `Rates copied to ${r.ran.rates.roles} role${r.ran.rates.roles === 1 ? '' : 's'}${r.ran.rates.unmatched.length ? `; not matched: ${r.ran.rates.unmatched.join(', ')} (map them under Role names)` : ''}.` : '',
      ].filter(Boolean).join(' ');
      setMsg([done ?? 'Saved.', extra].filter(Boolean).join(' '));
      if (patch.crew_link || r.ran.crew) loadCrew();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const t = (k: keyof Opts, label: string, help: string) => <Toggle on={!!o[k]} label={label} help={help} disabled={!!busy} onChange={(v) => save({ [k]: v } as Partial<Opts>, `${label}: ${v ? 'on' : 'off'}.`)} />;
  const linked = crew?.crew.filter((c) => c.user_id).length ?? 0;

  return (
    <div className="rm-options">
      <h3>More from Rentman</h3>
      <p className="muted small">Each part is off until you switch it on.</p>
      {err && <Banner onClose={() => setErr('')}>{err}</Banner>}
      {msg && <Banner kind="ok" onClose={() => setMsg('')}>{msg}</Banner>}

      <h4>Updates</h4>
      {t('webhooks', 'Instant updates from Rentman (webhooks)', 'Rentman tells LaborOps the moment a project, crew need, status, crew member or rate changes, instead of waiting for the 30-minute check (which keeps running as a backup).')}
      {o.webhooks && (
        <div className="rm-sub">
          <ol className="small">
            <li>In Rentman, open Configuration › Integrations › Webhooks and click Connect.</li>
            <li>Paste this address: <code className="rm-url">{o.webhookUrl}</code> <button type="button" className="btn ghost small" onClick={() => navigator.clipboard?.writeText(o.webhookUrl ?? '').then(() => setMsg('Address copied.'))}>Copy</button></li>
            <li>Rentman shows a token. Paste it here so LaborOps can check each call really comes from Rentman:</li>
          </ol>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={o.hasWebhookToken ? '•••••••• (saved; paste to replace)' : 'Rentman webhook token'} autoComplete="new-password" style={{ maxWidth: 360 }} />
            <button type="button" className="btn small primary" disabled={!!busy || token.trim().length < 8} onClick={() => save({ webhookToken: token.trim() }, 'Webhook token saved.').then(() => setToken(''))}>Save token</button>
          </div>
          <p className="small">{!o.hasWebhookToken ? 'Waiting for the token: calls are refused until it is saved.' : o.webhookLastAt ? `Last update from Rentman ${new Date(o.webhookLastAt).toLocaleString()}.` : 'Token saved. No update from Rentman yet: change something in Rentman to test.'}</p>
        </div>
      )}

      <h4>Crew and rates</h4>
      {t('crew_link', 'Link Rentman crew to LaborOps crew', 'Matches Rentman’s crew list to LaborOps people by email, then phone, then exact name. LaborOps stays the master for profiles, certificates and ratings. Needed to send hours or time off to Rentman.')}
      {o.crew_link && crew && (
        <div className="rm-sub">
          <div className="row space" style={{ flexWrap: 'wrap', gap: 8 }}>
            <span className="small">{linked} of {crew.crew.length} Rentman crew linked.</span>
            <button type="button" className="btn small" disabled={!!busy} onClick={async () => { setBusy('crew'); try { const r = await api<{ linked: number; unlinked: number }>('/api/rentman/crew/sync', { body: {} }); setMsg(`Crew read again: ${r.linked} newly linked, ${r.unlinked} to link by hand.`); loadCrew(); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); } }}>
              {busy === 'crew' ? 'Reading…' : 'Read crew again'}
            </button>
          </div>
          <div className="table-wrap rm-crew">
            <table className="table">
              <thead><tr><th>Rentman crew</th><th>LaborOps person</th><th /></tr></thead>
              <tbody>
                {crew.crew.filter((c) => c.active || c.user_id).map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}<span className="sub">{[c.email, c.phone].filter(Boolean).join(' · ')}</span></td>
                    <td>
                      <select value={c.user_id ?? ''} onChange={async (e) => { await api(`/api/rentman/crew/${c.id}/link`, { method: 'PUT', body: { userId: e.target.value || null } }); loadCrew(); }} aria-label={`LaborOps person for ${c.name}`}>
                        <option value="">Not linked</option>
                        {crew.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      {c.linked_by && c.linked_by !== 'manual' && <span className="sub">matched by {c.linked_by}</span>}
                    </td>
                    <td>
                      {!c.user_id && c.email && (
                        <button type="button" className="btn small" disabled={!!busy} title="Add them to LaborOps as crew and link them" onClick={async () => {
                          setBusy(`inv${c.id}`); setErr('');
                          try {
                            const r = await api<{ member: { id: string }; tempPassword?: string }>("/api/crew", { body: { name: c.name, email: c.email, phone: c.phone, role: "crew" } });
                            await api(`/api/rentman/crew/${c.id}/link`, { method: 'PUT', body: { userId: r.member.id } });
                            setMsg(`${c.name} added to LaborOps and linked.${r.tempPassword ? ` Temporary password: ${r.tempPassword}` : ''}`);
                            loadCrew();
                          } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
                        }}>Add to LaborOps</button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {crew.notInRentman.length > 0 && (
            <p className="small">Not in Rentman’s crew list ({crew.notInRentman.length}): {crew.notInRentman.slice(0, 12).map((u) => u.name).join(', ')}{crew.notInRentman.length > 12 ? '…' : ''}. Rentman’s API can’t create crew members: add them in Rentman (Crew members), then they link on the next read.</p>
          )}
        </div>
      )}
      {t('rates_source', 'Rentman sets pay and bill rates', 'Copies Rentman’s crew rates onto LaborOps roles by name: price rates become bill rates, cost rates become pay rates, and a flat amount for the first hours becomes the day rate. Those roles show “from Rentman” and are locked here. Overtime stays under LaborOps labor rules. New rates apply to shifts from then on.')}
      {o.rates_source && (
        <div className="rm-sub">
          <p className="small">
            {o.ratesLastAt && o.ratesLastResult ? `Last copied ${new Date(o.ratesLastAt).toLocaleString()}: ${o.ratesLastResult.rates} Rentman rates onto ${o.ratesLastResult.roles} roles.${o.ratesLastResult.unmatched?.length ? ` Not matched: ${o.ratesLastResult.unmatched.join(', ')} (map them under Role names).` : ''}` : 'Not copied yet.'}
          </p>
          <button type="button" className="btn small" disabled={!!busy} onClick={async () => { setBusy('rates'); try { const r = await api<{ roles: number; unmatched: string[] }>('/api/rentman/rates/sync', { body: {} }); setMsg(`Rates copied to ${r.roles} roles.`); load(); } catch (e) { setErr((e as Error).message); } finally { setBusy(''); } }}>
            {busy === 'rates' ? 'Copying…' : 'Copy rates now'}
          </button>
        </div>
      )}
      {t('quoted_bill_rates', 'Bill Rentman shifts at the quoted rate', 'Shifts built from a Rentman project bill at the hourly price quoted on their crew function (overtime on top), so the invoice matches the quote unless hours change. Other events keep the role bill rates.')}

      <h4>Back to Rentman</h4>
      {t('push_hours', 'Send approved hours to Rentman', 'Each approved time entry on a Rentman event becomes a time registration for that crew member in Rentman, and is updated if the time is edited. People not linked to Rentman crew are listed and wait.')}
      {o.push_hours && push && (
        <p className="small rm-sub">
          {push.hours.sent} sent{push.hours.waiting ? `, ${push.hours.waiting} waiting` : ''}{push.hours.failed ? `, ${push.hours.failed} failed (${push.hours.lastError})` : ''}.
          {push.hours.missingCrew.length > 0 && ` Waiting for a Rentman link: ${push.hours.missingCrew.map((m) => m.name).join(', ')}.`}
        </p>
      )}
      {t('push_time_off', 'Send time off to Rentman', 'Time off entered in LaborOps shows in Rentman’s planner as unavailable (approved), and is removed there when it’s deleted here. Needs crew linked.')}
      {o.push_time_off && push && <p className="small rm-sub">{push.timeOff.sent} sent{push.timeOff.failed ? `, ${push.timeOff.failed} failed (${push.timeOff.lastError})` : ''}.</p>}

      <h4>On events</h4>
      {t('show_invoices', 'Show Rentman invoices', 'The event’s Invoice tab and the pipeline show the Rentman project’s invoices and whether they’re paid, so labor isn’t billed twice.')}
      {t('show_files', 'Share Rentman project files with crew', 'Files on the Rentman project (stage plots, call sheets, site maps) appear on the event for the crew on it.')}
      {o.show_files && (
        <div className="row rm-sub" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Only this Rentman folder (blank = all files)" style={{ maxWidth: 320 }} aria-label="Rentman folder" />
          {folder !== (o.filesFolder ?? '') && <button type="button" className="btn small" onClick={() => save({ filesFolder: folder || null } as Partial<Opts>, 'Folder saved.')}>Save</button>}
        </div>
      )}
      {t('show_contacts', 'Show site contacts to leads', 'The Rentman project’s customer and location contact people (name and phone) show to the event’s leads and on-site coordinator.')}
      {t('show_vehicles', 'Vehicle details on driver shifts', 'Driver shifts built from Rentman transport show the vehicle, its plate and the pickup and return times.')}
      {t('show_equipment_leads', 'Equipment list for leads', 'Each department lead sees the Rentman equipment for their department (Audio sees audio gear) to check the load.')}
    </div>
  );
}
