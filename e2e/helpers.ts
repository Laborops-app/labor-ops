import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import pg from 'pg';

export const run = Date.now().toString(36);
let n = 0;
const uniq = (tag: string) => `${tag}-${run}-${++n}`;

/** Read straight from the test database (for things a person would see on another screen, like a QR code). */
export async function db<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: process.env.E2E_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/laborops_e2e' });
  await c.connect();
  try { return (await c.query(sql, params)).rows as T[]; } finally { await c.end(); }
}

/** A new company with its admin signed in on `page`. */
export async function newCompany(page: Page, opts: { quiet?: boolean } = {}) {
  const email = `${uniq('admin')}@e2e.example`;
  const r = await page.request.post('/api/auth/register', { data: { company: `E2E Crew ${n}`, name: 'Alex Admin', email, password: 'password123' } });
  expect(r.ok(), await r.text()).toBe(true);
  if (opts.quiet === false) await api(page, 'PUT', '/api/staffing/settings', { quietByDefault: false });
  return { email };
}

/** Call the API as whoever is signed in on `page`. */
export async function api<T = any>(page: Page, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown): Promise<T> {
  const r = await page.request.fetch(url, { method, data: data as object | undefined });
  const body = await r.text();
  if (!r.ok()) throw new Error(`${method} ${url} -> ${r.status()} ${body}`);
  return (body ? JSON.parse(body) : null) as T;
}

export async function newCrew(page: Page, name: string, skills: string[] = []) {
  const email = `${uniq(name.split(' ')[0]!.toLowerCase())}@e2e.example`;
  const m = await api<{ member: { id: string } }>(page, 'POST', '/api/crew', { name, email, password: 'password123', skills });
  return { id: m.member.id, name, email };
}

/** Sign in through the login page in a fresh browser context (optionally phone-sized). */
export async function signIn(browser: Browser, email: string, phone = false): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill('password123');
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => !u.pathname.startsWith('/login'));
  return { ctx, page };
}

/** An event today (or `daysAhead` from now) with one shift starting `startInMin` minutes from now. */
export async function eventWithShift(page: Page, o: { name?: string; role?: string; headcount?: number; startInMin?: number; hours?: number; quiet?: boolean } = {}) {
  const st = new Date(Date.now() + (o.startInMin ?? 30) * 60_000);
  const day = st.toISOString().slice(0, 10);
  const ev = await api<{ event: { id: string } }>(page, 'POST', '/api/events', { name: o.name ?? `Show ${n}`, venue: 'Main Stage', startDate: day, endDate: day });
  await api(page, 'PUT', `/api/events/${ev.event.id}/build-quietly`, { on: o.quiet ?? false });
  const sh = await api<{ shift: { id: string } }>(page, 'POST', `/api/events/${ev.event.id}/shifts`, {
    roleName: o.role ?? 'Stagehand', startsAt: st.toISOString(), endsAt: new Date(st.getTime() + (o.hours ?? 8) * 3600_000).toISOString(), headcount: o.headcount ?? 1,
  });
  return { eventId: ev.event.id, shiftId: sh.shift.id };
}

/** Draw a short scribble in a signature pad. */
export async function scribble(page: Page, canvas: ReturnType<Page['locator']>) {
  await canvas.scrollIntoViewIfNeeded();
  const b = (await canvas.boundingBox())!;
  await page.mouse.move(b.x + 20, b.y + b.height * 0.6);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++) await page.mouse.move(b.x + 20 + i * (b.width - 40) / 16, b.y + b.height * (0.5 + 0.3 * Math.sin(i / 2)), { steps: 2 });
  await page.mouse.up();
}
