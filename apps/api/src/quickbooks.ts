import type { PoolClient } from 'pg';
import { encrypt, decrypt } from './crypto';

/**
 * QuickBooks Online (Intuit) client: OAuth 2.0 connect, automatic token refresh, and the few accounting calls LaborOps needs
 * (customers, items, accounts, invoices, employees, time activities). Credentials are stored encrypted per company.
 * Endpoints and payload shapes follow Intuit's v3 Accounting API; verified against the sandbox before production use.
 */
export const QBO_AUTHORIZE = 'https://appcenter.intuit.com/connect/oauth2';
export const QBO_TOKEN = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
export const QBO_REVOKE = 'https://developer.api.intuit.com/v2/oauth2/tokens/revoke';
export const QBO_SCOPE = 'com.intuit.quickbooks.accounting';
const MINOR = '75';

export type QboEnv = 'sandbox' | 'production';
export type QboConfig = {
  clientId: string;
  clientSecret: string;
  environment: QboEnv;
  realmId?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  connectedAt?: string;
  companyName?: string;
};

export class QboError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

export const apiBase = (env: QboEnv) => (env === 'production' ? 'https://quickbooks.api.intuit.com' : 'https://sandbox-quickbooks.api.intuit.com');
/** Link to open a transaction in the QuickBooks web app. */
export const appLink = (env: QboEnv, kind: 'invoice', id: string) =>
  `${env === 'production' ? 'https://app.qbo.intuit.com' : 'https://app.sandbox.qbo.intuit.com'}/app/${kind}?txnId=${encodeURIComponent(id)}`;

export async function loadQbo(c: PoolClient): Promise<QboConfig | null> {
  const r = (await c.query("SELECT config_enc FROM integration_settings WHERE provider = 'quickbooks'")).rows[0];
  if (!r) return null;
  try {
    return JSON.parse(decrypt(r.config_enc)) as QboConfig;
  } catch {
    return null;
  }
}

export async function saveQbo(c: PoolClient, tid: string, userId: string | null, patch: Partial<QboConfig>) {
  const cur = (await loadQbo(c)) ?? { clientId: '', clientSecret: '', environment: 'sandbox' as QboEnv };
  const next = { ...cur, ...patch };
  await c.query(
    `INSERT INTO integration_settings (tenant_id, provider, config_enc, updated_by) VALUES ($1,'quickbooks',$2,$3)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET config_enc = EXCLUDED.config_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [tid, encrypt(JSON.stringify(next)), userId],
  );
  return next;
}

export const qboConnected = (q: QboConfig | null): q is QboConfig & { realmId: string; refreshToken: string } => !!(q && q.realmId && q.refreshToken);

export const authorizeUrl = (q: QboConfig, redirectUri: string, state: string) =>
  `${QBO_AUTHORIZE}?` + new URLSearchParams({ client_id: q.clientId, response_type: 'code', scope: QBO_SCOPE, redirect_uri: redirectUri, state }).toString();

async function tokenRequest(q: QboConfig, form: Record<string, string>) {
  const res = await fetch(QBO_TOKEN, {
    method: 'POST',
    headers: {
      authorization: 'Basic ' + Buffer.from(`${q.clientId}:${q.clientSecret}`).toString('base64'),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new QboError(`QuickBooks sign-in failed (${res.status}): ${j.error_description ?? j.error ?? 'no token returned'}`, res.status === 400 || res.status === 401 ? 400 : 502);
  return {
    accessToken: String(j.access_token),
    refreshToken: String(j.refresh_token ?? form.refresh_token ?? ''),
    expiresAt: Date.now() + (Number(j.expires_in) || 3600) * 1000,
    refreshExpiresAt: Date.now() + (Number(j.x_refresh_token_expires_in) || 100 * 86400) * 1000,
  };
}

export const exchangeCode = (q: QboConfig, code: string, redirectUri: string) => tokenRequest(q, { grant_type: 'authorization_code', code, redirect_uri: redirectUri });

/** A QuickBooks session for one company: refreshes the access token when needed (Intuit rotates refresh tokens, so each refresh is saved). */
export class Qbo {
  constructor(private q: QboConfig & { realmId: string }, private persist: (p: Partial<QboConfig>) => Promise<void>) {}
  get env() {
    return this.q.environment;
  }

  private async token(force = false) {
    if (!force && this.q.accessToken && (this.q.expiresAt ?? 0) - 60_000 > Date.now()) return this.q.accessToken;
    if (!this.q.refreshToken) throw new QboError('QuickBooks is not connected. Connect it again from Accounting settings.', 400);
    const t = await tokenRequest(this.q, { grant_type: 'refresh_token', refresh_token: this.q.refreshToken });
    Object.assign(this.q, t);
    await this.persist(t);
    return t.accessToken;
  }

  async call(method: 'GET' | 'POST', path: string, body?: unknown, retried = false): Promise<any> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${apiBase(this.q.environment)}/v3/company/${encodeURIComponent(this.q.realmId)}/${path}${sep}minorversion=${MINOR}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${await this.token(retried)}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 401 && !retried) return this.call(method, path, body, true);
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || j?.Fault) {
      const f = j?.Fault?.Error?.[0];
      const msg = f ? `${f.Message}${f.Detail ? `: ${f.Detail}` : ''}` : `HTTP ${res.status}`;
      throw new QboError(`QuickBooks: ${String(msg).slice(0, 300)}`, res.status >= 400 && res.status < 500 ? 400 : 502);
    }
    return j;
  }

  async query<T = any>(entity: string, where = '', max = 1000): Promise<T[]> {
    const sql = `select * from ${entity}${where ? ` where ${where}` : ''} maxresults ${max}`;
    const j = await this.call('GET', `query?query=${encodeURIComponent(sql)}`);
    return (j?.QueryResponse?.[entity] ?? []) as T[];
  }

  companyName = async () => (await this.call('GET', `companyinfo/${encodeURIComponent(this.q.realmId)}`))?.CompanyInfo?.CompanyName as string | undefined;

  /** Find a customer by display name, or create one. QuickBooks display names are unique per company. */
  async ensureCustomer(c: { name: string; email?: string | null; phone?: string | null }): Promise<string> {
    const name = c.name.replace(/[:\t\n]/g, ' ').trim().slice(0, 100);
    const found = await this.query<{ Id: string }>('Customer', `DisplayName = '${name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`, 1);
    if (found[0]) return found[0].Id;
    const j = await this.call('POST', 'customer', {
      DisplayName: name,
      CompanyName: name,
      ...(c.email ? { PrimaryEmailAddr: { Address: c.email } } : {}),
      ...(c.phone ? { PrimaryPhone: { FreeFormNumber: c.phone } } : {}),
    });
    return String(j.Customer.Id);
  }

  items = () => this.query<{ Id: string; Name: string; Type: string; Active: boolean }>('Item', "Type = 'Service'");
  incomeAccounts = () => this.query<{ Id: string; Name: string }>('Account', "AccountType = 'Income'");
  employees = () => this.query<{ Id: string; DisplayName: string; GivenName?: string; FamilyName?: string; PrimaryEmailAddr?: { Address: string } }>('Employee');

  async createItem(name: string, incomeAccountId: string): Promise<string> {
    const j = await this.call('POST', 'item', { Name: name.slice(0, 100), Type: 'Service', IncomeAccountRef: { value: incomeAccountId } });
    return String(j.Item.Id);
  }

  async createInvoice(inv: { customerId: string; txnDate: string; memo: string; note: string; lines: { itemId: string; description: string; qty: number; rate: number; amount: number; date: string }[] }) {
    const j = await this.call('POST', 'invoice', {
      CustomerRef: { value: inv.customerId },
      TxnDate: inv.txnDate,
      PrivateNote: inv.note.slice(0, 4000),
      CustomerMemo: { value: inv.memo.slice(0, 1000) },
      Line: inv.lines.map((l) => ({
        DetailType: 'SalesItemLineDetail',
        Amount: Math.round(l.amount * 100) / 100,
        Description: l.description.slice(0, 4000),
        SalesItemLineDetail: { ItemRef: { value: l.itemId }, Qty: l.qty, UnitPrice: l.rate, ServiceDate: l.date },
      })),
    });
    return { id: String(j.Invoice.Id), docNumber: j.Invoice.DocNumber ? String(j.Invoice.DocNumber) : null, total: Number(j.Invoice.TotalAmt ?? 0) };
  }

  async createTimeActivity(t: { employeeId: string; date: string; hours: number; description: string; customerId?: string | null; itemId?: string | null }) {
    const whole = Math.floor(t.hours);
    const minutes = Math.round((t.hours - whole) * 60);
    const j = await this.call('POST', 'timeactivity', {
      NameOf: 'Employee',
      EmployeeRef: { value: t.employeeId },
      TxnDate: t.date,
      Hours: minutes === 60 ? whole + 1 : whole,
      Minutes: minutes === 60 ? 0 : minutes,
      Description: t.description.slice(0, 4000),
      ...(t.customerId ? { CustomerRef: { value: t.customerId } } : {}),
      ...(t.itemId ? { ItemRef: { value: t.itemId } } : {}),
      BillableStatus: 'NotBillable',
    });
    return String(j.TimeActivity.Id);
  }
}

/** A ready QuickBooks session for this company, or an error explaining what is missing. */
export async function qboSession(c: PoolClient, tid: string): Promise<Qbo> {
  const q = await loadQbo(c);
  if (!qboConnected(q)) throw new QboError('QuickBooks Online is not connected. An admin can connect it under Accounting.', 400);
  if (q.refreshExpiresAt && q.refreshExpiresAt < Date.now()) throw new QboError('The QuickBooks connection has expired. Connect it again under Accounting.', 400);
  return new Qbo(q, async (p) => {
    await saveQbo(c, tid, null, p);
  });
}
