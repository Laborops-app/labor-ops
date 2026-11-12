import { expect, test } from '@playwright/test';
import { api, eventWithShift, newCompany, newCrew, signIn } from './helpers';

test('coordinator on a phone: what needs them is on top; remind, QR and auto-fill are one tap away', async ({ page, browser }) => {
  const admin = await newCompany(page, { quiet: false });
  const sam = await newCrew(page, 'Sam Okafor', ['Stagehand']);
  await newCrew(page, 'Lane Torres', ['Stagehand']);
  const { eventId, shiftId } = await eventWithShift(page, { name: 'Phone Show', headcount: 2, startInMin: 24 * 60 });
  await api(page, 'POST', `/api/shifts/${shiftId}/assign`, { userId: sam.id });

  const phone = await signIn(browser, admin.email, true);
  const p = phone.page;
  await p.goto(`/events/${eventId}`);
  await expect(p.getByRole('heading', { name: 'Phone Show' })).toBeVisible();

  // Needs attention sits above the shift cards, not at the bottom of the page
  const att = p.getByRole('region', { name: 'Needs attention' });
  await expect(att).toBeVisible();
  const attY = (await att.boundingBox())!.y;
  const cardY = (await p.locator('.cs-card').first().boundingBox())!.y;
  expect(attY).toBeLessThan(cardY);

  // The thumb bar: remind everyone who has not answered
  const bar = p.getByRole('navigation', { name: 'Quick actions' });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: /Remind/ }).click();
  await expect(p.getByText(/Reminded 1 person to answer/)).toBeVisible();

  // The QR clock-in window, without opening a menu
  await bar.getByRole('button', { name: /QR clock-in/ }).click();
  const qr = p.getByRole('dialog', { name: /QR clock-in/ });
  await expect(qr.getByText('Use a QR code at this event')).toBeVisible();
  await qr.getByRole('button', { name: /close/i }).click();

  // Auto-fill: the proposal and its send button fit the first screen
  await bar.getByRole('button', { name: /Auto-fill/ }).click();
  const send = p.getByRole('button', { name: /Send offers? to 1 person/ }).first();
  await expect(send).toBeVisible();
  await expect(send).toBeInViewport();
  await send.click();
  await expect(p.locator('.evh-legend .lg-wait')).toHaveText(/2 waiting/);
  await phone.ctx.close();
});

test('dashboard shows staffing the same way as the event page; crew list has a row menu', async ({ page }) => {
  await newCompany(page, { quiet: false });
  const sam = await newCrew(page, 'Sam Okafor', ['Stagehand']);
  const { shiftId } = await eventWithShift(page, { name: 'Dash Show', headcount: 2, startInMin: 60 });
  await api(page, 'POST', `/api/shifts/${shiftId}/assign`, { userId: sam.id, confirmed: true });

  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /Welcome back, Alex/ })).toBeVisible();
  await expect(page.locator('.db-staff .evh-num')).toHaveText(/1\s*\/ 2 confirmed\s*50%/);
  await expect(page.locator('.db-staff .evh-legend')).toHaveText(/1 confirmed.*1 open/);
  const next = page.locator('.db-shift', { hasText: 'Dash Show' });
  await expect(next).toContainText('Stagehand');
  await expect(next).toContainText('1 / 2 confirmed');
  await expect(page.locator('.db-event', { hasText: 'Dash Show' })).toContainText('1 to fill');

  await page.goto('/crew');
  const row = page.locator('table.dlist tbody tr', { hasText: 'Sam Okafor' });
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Options for Sam Okafor' });
  await expect(menu.getByRole('menuitem', { name: 'Open profile' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Deactivate' }).click();
  await expect(page.getByRole('tab', { name: 'Inactive (1)' })).toBeVisible();
  // Nothing in the table is cut off to the right
  const wrap = page.locator('.table-wrap');
  expect(await wrap.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
});
