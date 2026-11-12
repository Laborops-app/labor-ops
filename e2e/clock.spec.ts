import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { api, db, eventWithShift, newCompany, newCrew, signIn } from './helpers';

const liveCode = (secret: string, eventId: string) => createHmac('sha256', secret).update(`${eventId}:${Math.floor(Date.now() / 30_000)}`).digest('base64url').slice(0, 12);

test('QR clock-in: turn it on, show the venue screen, crew scan to clock in and out', async ({ page, browser }) => {
  await newCompany(page);
  const sam = await newCrew(page, 'Sam Okafor');
  const { eventId, shiftId } = await eventWithShift(page, { name: 'QR Show', startInMin: 20 });
  await api(page, 'POST', `/api/shifts/${shiftId}/assign`, { userId: sam.id, confirmed: true });

  await page.goto(`/events/${eventId}`);
  await page.getByRole('button', { name: /^More$/ }).click();
  await page.getByRole('menuitem', { name: /QR clock-in/ }).click();
  await page.getByLabel(/Use a QR code at this event/).check();
  const screenLink = await page.getByRole('link', { name: 'Open the venue screen' }).getAttribute('href');
  expect(screenLink).toContain('/qr-screen?t=');

  // The venue screen shows a code and who is expected
  const screen = await page.context().newPage();
  await screen.goto(new URL(screenLink!).pathname + new URL(screenLink!).search);
  await expect(screen.locator('.qrs-code svg')).toBeVisible();
  await expect(screen.getByText('still to arrive')).toBeVisible();

  // Scanning the code opens /clock on the crew member's phone
  const secret = (await db<{ qr_secret: string }>('SELECT qr_secret FROM events WHERE id = $1', [eventId]))[0]!.qr_secret;
  const crew = await signIn(browser, sam.email, true);
  await crew.page.goto(`/clock?e=${eventId}&c=${liveCode(secret, eventId)}`);
  await expect(crew.page.getByRole('heading', { name: 'You’re clocked in' })).toBeVisible();
  await expect(screen.locator('.qrs-counts .ok')).toHaveText('1', { timeout: 15_000 });

  // An old code is refused
  await crew.page.goto(`/clock?e=${eventId}&c=AAAAAAAAAAAA`);
  await expect(crew.page.getByRole('alert').filter({ hasText: 'expired' })).toBeVisible();

  await crew.ctx.close();
});

test('QR clock-in held up by a required safety check: fill it in, then one tap clocks in', async ({ page, browser }) => {
  await newCompany(page);
  const lee = await newCrew(page, 'Lee Park');
  const { eventId, shiftId } = await eventWithShift(page, { name: 'Safety Show', startInMin: 20 });
  await api(page, 'POST', `/api/shifts/${shiftId}/assign`, { userId: lee.id, confirmed: true });
  await api(page, 'PUT', '/api/docs/settings', { formsOn: true });
  await api(page, 'POST', '/api/docs/templates', { name: 'Load-in safety check', kind: 'form', purpose: 'shift', settings: { who: 'everyone', when: 'clock_in', blockClockIn: true }, fields: [{ id: 'q1', type: 'checkbox', label: 'Boots and gloves on' }, { id: 'q2', type: 'signature', label: 'Signature' }] });
  await api(page, 'PUT', `/api/events/${eventId}/qr`, { on: true });
  const secret = (await db<{ qr_secret: string }>('SELECT qr_secret FROM events WHERE id = $1', [eventId]))[0]!.qr_secret;

  const crew = await signIn(browser, lee.email, true);
  await crew.page.goto(`/clock?e=${eventId}&c=${liveCode(secret, eventId)}`);
  await expect(crew.page.getByRole('heading', { name: 'One step first' })).toBeVisible();
  await crew.page.getByRole('link', { name: 'Fill in Load-in safety check' }).click();
  await crew.page.getByLabel('Boots and gloves on').check();
  await crew.page.getByRole('radio', { name: 'Type my name' }).click();
  await crew.page.getByLabel(/I agree that this is my electronic signature/).check();
  await crew.page.getByRole('button', { name: 'Sign and finish' }).click();
  await crew.page.getByRole('link', { name: 'Clock in now' }).click();
  await expect(crew.page.getByRole('heading', { name: 'You’re clocked in' })).toBeVisible();
  await crew.ctx.close();
});

test('QR clock-in: scanning again later clocks out', async ({ page, browser }) => {
  await newCompany(page);
  const sam = await newCrew(page, 'Sam Okafor');
  const { eventId, shiftId } = await eventWithShift(page, { name: 'Out Show', startInMin: 20 });
  await api(page, 'POST', `/api/shifts/${shiftId}/assign`, { userId: sam.id, confirmed: true });
  await api(page, 'PUT', `/api/events/${eventId}/qr`, { on: true });
  const secret = (await db<{ qr_secret: string }>('SELECT qr_secret FROM events WHERE id = $1', [eventId]))[0]!.qr_secret;
  const crew = await signIn(browser, sam.email, true);
  await crew.page.goto(`/clock?e=${eventId}&c=${liveCode(secret, eventId)}`);
  await expect(crew.page.getByRole('heading', { name: 'You’re clocked in' })).toBeVisible();
  // Scanning again later clocks out
  await db("UPDATE time_entries SET clock_in = now() - interval '4 hours' WHERE user_id = $1", [sam.id]);
  await crew.page.goto(`/clock?e=${eventId}&c=${liveCode(secret, eventId)}`);
  await expect(crew.page.getByRole('heading', { name: 'You’re clocked out' })).toBeVisible();
  await crew.ctx.close();
});
