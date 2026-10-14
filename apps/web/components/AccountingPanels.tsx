'use client';
import { useEffect, useState } from 'react';
import Panel from '@/components/Panel';
import { Banner } from '@/components/ui';
import { api, money } from '@/lib/api';

type Provider = 'adp' | 'gusto' | 'quickbooks';
type Settings = {
  qbo: { defaultItemId: string | null };
  desktop: { arAccount: string; incomeAccount: string; itemMode: 'single' | 'role'; itemName: string };
  payroll: { enabled: Provider[]; primary: Provider; adp: { companyCode: string; batchId: string; dtCode: string; dayCode: string } };
};
type Data = {
  settings: Settings;
  quickbooks: { clientId: string; clientSecretSet: boolean; environment: 'sandbox' | 'production'; connected: boolean; companyName: string | null; connectedAt: string | null; expired: boolean; redirectUri: string };
  roles: { id: string; name: string; billRate: number; dayBillRate: number; qboItemId: string | null }[];
};
type Lookups = { items: { id: string; name: string }[]; accounts: { id: string; name: string }[]; employees: { id: string; name: string }[] };
const PROVIDERS: [Provider, string][] = [['adp', 'ADP'], ['gusto', 'Gusto'], ['quickbooks', 'QuickBooks Payroll']];

/** QuickBooks (Online and Desktop) and payroll settings, shown as collapsible panels on the Integrations page. */
export default function AccountingPanels({ qbo }: { qbo: string | null }) {
  const [d, setD] = useState<Data | null>(null);
  const [s, setS] = useState<Settings | null>(null);
  const [keys, setKeys] = useState({ clientId: '', clientSecret: '', environment: 'sandbox' as 'sandbox' | 'production' });
  const [look, setLook] = useState<Lookups | null>(null);
  const [roleItems, setRoleItems] = useState<Record<string, string | null>>({});
  const [newItem, setNewItem] = useState({ name: 'Labor', accountId: '' });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [busy, setBusy] = useState('');

  const load = () =>
    api<Data>('/api/accounting')
      .then((r) => {
        setD(r);
        setS(r.settings);
        setKeys({ clientId: r.quickbooks.clientId, clientSecret: '', environment: r.quickbooks.environment });
        setRoleItems(Object.fromEntries(r.roles.map((x) => [x.id, x.qboItemId])));
        if (r.quickbooks.connected && !r.quickbooks.expired)
          api<Lookups>('/api/quickbooks/lookups')
            .then((l) => {
              setLook(l);
              setNewItem((x) => ({ ...x, accountId: x.accountId || l.accounts[0]?.id || '' }));
            })
            .catch((e) => setError(e.message));
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    const q = qbo;
    if (q === 'connected') setOk('QuickBooks is connected.');
    else if (q) setError(q === 'denied' ? 'QuickBooks access was not approved.' : 'Could not connect QuickBooks. Check the client ID, secret and redirect URI, then try again.');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = async (key: string, fn: () => Promise<string | void>) => {
    setError('');
    setOk('');
    setBusy(key);
    try {
      const m = await fn();
      if (m) setOk(m);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  if (!d || !s) return error ? <Banner>{error}</Banner> : null;
  const q = d.quickbooks;
  const saveSettings = (msg: string) => run('settings', async () => { setS((await api<{ settings: Settings }>('/api/accounting/settings', { method: 'PUT', body: s })).settings); return msg; });
  const toggleProvider = (p: Provider, on: boolean) => {
    const enabled = on ? [...new Set([...s.payroll.enabled, p])] : s.payroll.enabled.filter((x) => x !== p);
    if (!enabled.length) return setError('Keep at least one payroll provider turned on.');
    setS({ ...s, payroll: { ...s.payroll, enabled, primary: enabled.includes(s.payroll.primary) ? s.payroll.primary : enabled[0] } });
  };

  return (
    <>
      <h2 className="panel-group-title">Accounting &amp; payroll</h2>
      <p className="muted small">LaborOps sends billing to QuickBooks and hours to your payroll provider. Invoices are created from an event (the <b>Invoice</b> button), and pay periods are exported on the <b>Payroll</b> page.</p>
      {error && <Banner onClose={() => setError('')}>{error}</Banner>}
      {ok && <Banner kind="ok" onClose={() => setOk('')}>{ok}</Banner>}

      <Panel
        id="quickbooks"
        title="QuickBooks Online"
        summary="Send event invoices and crew hours to QuickBooks"
        forceOpen={!!qbo}
        status={q.connected && !q.expired ? <span className="chip open">Connected{q.companyName ? ` · ${q.companyName}` : ''}</span> : q.expired ? <span className="chip bad">Connection expired</span> : <span className="chip">Not connected</span>}
      >
        <p className="muted small">
          Create an app at developer.intuit.com, add this redirect URI to it, then paste its keys below. Use <b>Sandbox</b> keys with a sandbox company while testing.
        </p>
        <div className="copy-row" style={{ marginBottom: 10 }}>
          <code className="mono">{q.redirectUri}</code>
          <button type="button" className="btn ghost small" onClick={() => navigator.clipboard?.writeText(q.redirectUri)}>Copy</button>
        </div>
        <form
          className="settings-grid"
          onSubmit={(e) => {
            e.preventDefault();
            run('keys', async () => {
              await api('/api/accounting/quickbooks', { method: 'PUT', body: { clientId: keys.clientId, environment: keys.environment, ...(keys.clientSecret ? { clientSecret: keys.clientSecret } : {}) } });
              await load();
              return 'QuickBooks keys saved.';
            });
          }}
        >
          <label>
            Environment
            <select value={keys.environment} onChange={(e) => setKeys({ ...keys, environment: e.target.value as 'sandbox' | 'production' })}>
              <option value="sandbox">Sandbox (testing)</option>
              <option value="production">Production (live books)</option>
            </select>
          </label>
          <label>
            Client ID
            <input value={keys.clientId} onChange={(e) => setKeys({ ...keys, clientId: e.target.value })} autoComplete="off" required />
          </label>
          <label>
            Client secret {q.clientSecretSet && <span className="muted small">(saved — leave blank to keep)</span>}
            <input type="password" value={keys.clientSecret} onChange={(e) => setKeys({ ...keys, clientSecret: e.target.value })} autoComplete="new-password" placeholder={q.clientSecretSet ? '••••••••' : ''} required={!q.clientSecretSet} />
          </label>
          <div className="form-actions">
            <button className="btn primary" disabled={!!busy}>Save keys</button>
            <button type="button" className="btn" disabled={!!busy || !q.clientId || !q.clientSecretSet} onClick={() => run('connect', async () => { window.location.href = (await api<{ url: string }>('/api/quickbooks/connect')).url; })}>
              {q.connected ? 'Reconnect' : 'Connect to QuickBooks'}
            </button>
            {q.connected && (
              <button type="button" className="btn ghost" disabled={!!busy} onClick={() => confirm('Disconnect QuickBooks? Invoices already created stay in QuickBooks.') && run('disc', async () => { await api('/api/quickbooks/disconnect', { body: {} }); setLook(null); await load(); return 'QuickBooks disconnected.'; })}>
                Disconnect
              </button>
            )}
          </div>
        </form>
        {q.environment === 'sandbox' && q.connected && <p className="small muted">Connected to a <b>sandbox</b> company. Switch to Production and reconnect when you are ready to bill for real.</p>}
      </Panel>

      {q.connected && look && (
        <Panel id="qbo-items" title="QuickBooks billing items" summary="What each position is billed as on invoices" status={<span className="chip">{d.roles.filter((r) => roleItems[r.id]).length} of {d.roles.length} mapped</span>}>
          <p className="muted small">Invoice lines use a QuickBooks service item. Pick a default, and a different item for any position that needs its own.</p>
          <label style={{ display: 'grid', gap: 6, maxWidth: 360 }}>
            Default item
            <select value={s.qbo.defaultItemId ?? ''} onChange={(e) => setS({ ...s, qbo: { defaultItemId: e.target.value || null } })}>
              <option value="">None (every position needs its own)</option>
              {look.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
            </select>
          </label>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead><tr><th>Position</th><th>Bill rate</th><th>Day bill rate</th><th>QuickBooks item</th></tr></thead>
              <tbody>
                {d.roles.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.billRate ? `${money(r.billRate)}/hr` : <span className="muted">not set</span>}</td>
                    <td>{r.dayBillRate ? money(r.dayBillRate) : <span className="muted">—</span>}</td>
                    <td>
                      <select value={roleItems[r.id] ?? ''} onChange={(e) => setRoleItems({ ...roleItems, [r.id]: e.target.value || null })} aria-label={`QuickBooks item for ${r.name}`}>
                        <option value="">Use the default</option>
                        {look.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn primary" disabled={!!busy} onClick={() => run('items', async () => { await api('/api/accounting/role-items', { method: 'PUT', body: { items: roleItems } }); await api('/api/accounting/settings', { method: 'PUT', body: s }); return 'Billing items saved.'; })}>
              Save billing items
            </button>
          </div>
          <details style={{ marginTop: 12 }}>
            <summary className="small">Create a new service item in QuickBooks</summary>
            <div className="row" style={{ marginTop: 8 }}>
              <input value={newItem.name} onChange={(e) => setNewItem({ ...newItem, name: e.target.value })} placeholder="Item name, e.g. Labor - Audio" aria-label="New item name" />
              <select value={newItem.accountId} onChange={(e) => setNewItem({ ...newItem, accountId: e.target.value })} aria-label="Income account">
                {look.accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
              <button className="btn small" disabled={!newItem.name.trim() || !newItem.accountId || !!busy} onClick={() => run('newitem', async () => { const it = await api<{ id: string; name: string }>('/api/quickbooks/items', { body: { name: newItem.name.trim(), incomeAccountId: newItem.accountId } }); setLook({ ...look, items: [...look.items, it].sort((a, b) => a.name.localeCompare(b.name)) }); return `Created “${it.name}” in QuickBooks.`; })}>
                Create item
              </button>
            </div>
          </details>
        </Panel>
      )}

      <Panel id="qb-desktop" title="QuickBooks Desktop" summary="Settings for the .IIF invoice import file">
        <p className="muted small">On an event, <b>Download for QuickBooks Desktop</b> gives an .IIF file. In QuickBooks Desktop use File › Utilities › Import › IIF Files. The customer, accounts and items must already exist there with these exact names.</p>
        <div className="settings-grid">
          <label>
            Accounts receivable account
            <input value={s.desktop.arAccount} onChange={(e) => setS({ ...s, desktop: { ...s.desktop, arAccount: e.target.value } })} />
          </label>
          <label>
            Income account
            <input value={s.desktop.incomeAccount} onChange={(e) => setS({ ...s, desktop: { ...s.desktop, incomeAccount: e.target.value } })} />
          </label>
          <label>
            Item on each line
            <select value={s.desktop.itemMode} onChange={(e) => setS({ ...s, desktop: { ...s.desktop, itemMode: e.target.value as 'single' | 'role' } })}>
              <option value="role">The position name (e.g. Audio)</option>
              <option value="single">One item for everything</option>
            </select>
          </label>
          {s.desktop.itemMode === 'single' && (
            <label>
              Item name
              <input value={s.desktop.itemName} onChange={(e) => setS({ ...s, desktop: { ...s.desktop, itemName: e.target.value } })} />
            </label>
          )}
        </div>
        <button className="btn primary" disabled={!!busy} onClick={() => saveSettings('Desktop file settings saved.')}>Save</button>
      </Panel>

      <Panel
        id="payroll"
        title="Payroll"
        summary="ADP, Gusto and QuickBooks Payroll exports"
        status={<span className="chip">{PROVIDERS.filter(([k]) => s.payroll.enabled.includes(k)).map(([, l]) => l).join(', ')}</span>}
      >
        <p className="muted small">Turn on the payroll systems you use. Each one gets its own export on the Payroll page; enter each person&apos;s ID there (ADP File #, Gusto employee ID, QuickBooks employee).</p>
        <div className="row" style={{ gap: '1.2rem', flexWrap: 'wrap' }}>
          {PROVIDERS.map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={s.payroll.enabled.includes(k)} onChange={(e) => toggleProvider(k, e.target.checked)} />
              {label}
            </label>
          ))}
        </div>
        <label style={{ display: 'grid', gap: 6, maxWidth: 320, marginTop: 10 }}>
          Main payroll provider
          <select value={s.payroll.primary} onChange={(e) => setS({ ...s, payroll: { ...s.payroll, primary: e.target.value as Provider } })}>
            {PROVIDERS.filter(([k]) => s.payroll.enabled.includes(k)).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </label>
        {s.payroll.enabled.includes('adp') && (
          <>
            <h3 style={{ marginTop: 14 }}>ADP pay data import</h3>
            <p className="muted small">Match these to the pay data import set up in your ADP Workforce Now account.</p>
            <div className="settings-grid">
              <label>
                Company code
                <input value={s.payroll.adp.companyCode} maxLength={10} onChange={(e) => setS({ ...s, payroll: { ...s.payroll, adp: { ...s.payroll.adp, companyCode: e.target.value } } })} />
              </label>
              <label>
                Batch ID
                <input value={s.payroll.adp.batchId} maxLength={20} onChange={(e) => setS({ ...s, payroll: { ...s.payroll, adp: { ...s.payroll.adp, batchId: e.target.value } } })} />
              </label>
              <label>
                Double-time hours code
                <input value={s.payroll.adp.dtCode} maxLength={10} onChange={(e) => setS({ ...s, payroll: { ...s.payroll, adp: { ...s.payroll.adp, dtCode: e.target.value } } })} />
              </label>
              <label>
                Day-rate earnings code
                <input value={s.payroll.adp.dayCode} maxLength={10} onChange={(e) => setS({ ...s, payroll: { ...s.payroll, adp: { ...s.payroll.adp, dayCode: e.target.value } } })} />
              </label>
            </div>
          </>
        )}
        {s.payroll.enabled.includes('quickbooks') && !q.connected && <p className="small muted">QuickBooks Payroll can take hours straight from LaborOps once QuickBooks Online is connected above; until then use its file.</p>}
        <button className="btn primary" disabled={!!busy} onClick={() => saveSettings('Payroll settings saved.')}>Save payroll settings</button>
      </Panel>
    </>
  );
}
