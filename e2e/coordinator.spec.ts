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

test('first sign-in on an iPhone shows the picture guide to add LaborOps to the Home Screen, once', async ({ browser, page }) => {
  await newCompany(page);
  const sam = await newCrew(page, 'Sam Okafor');
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  });
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.getByLabel(/email/i).fill(sam.email);
  await p.getByLabel(/password/i).fill('password123');
  await p.keyboard.press('Enter');
  const guide = p.getByRole('dialog', { name: 'Add LaborOps to your Home Screen' });
  await expect(guide).toBeVisible();
  await expect(guide.getByRole('heading', { name: 'Tap ••• then Share' })).toBeVisible();
  await expect(guide.getByRole('img', { name: /three-dot button/ })).toBeVisible();
  for (const t of ['Tap Add to Home Screen', 'Tap Add', 'Open it from your Home Screen']) {
    await guide.getByRole('button', { name: 'Next' }).click();
    await expect(guide.getByRole('heading', { name: t })).toBeVisible();
  }
  await guide.getByRole('button', { name: 'Got it' }).click();
  await expect(guide).toBeHidden();
  // Not again on this phone, but it can be opened from My shifts
  await p.reload();
  await expect(p.locator('.iosg')).toHaveCount(0);
  await p.goto('/my-shifts');
  await p.getByRole('button', { name: 'Show me how' }).click();
  await expect(p.getByRole('dialog', { name: 'Add LaborOps to your Home Screen' })).toBeVisible();
  await ctx.close();
});

test('first sign-in on an Android phone: the home screen guide, then one tap to turn on shift alerts', async ({ browser, page }) => {
  await newCompany(page);
  const ari = await newCrew(page, 'Ari Dawson');
  const ctx = await browser.newContext({
    viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  });
  // A phone that hasn't been asked about notifications yet (headless Chromium reports "denied")
  await ctx.addInitScript(() => { Object.defineProperty(Notification, 'permission', { get: () => 'default' }); });
  const p = await ctx.newPage();
  await p.goto('/login');
  await p.getByLabel(/email/i).fill(ari.email);
  await p.getByLabel(/password/i).fill('password123');
  await p.keyboard.press('Enter');
  const guide = p.getByRole('dialog', { name: 'Add LaborOps to your Home Screen' });
  await expect(guide.getByRole('heading', { name: 'Tap ⋮ at the top right' })).toBeVisible();
  await expect(guide.getByRole('img', { name: /three-dot menu button at the top right/ })).toBeVisible();
  // The alerts question waits until the guide is closed
  await expect(p.getByRole('dialog', { name: 'Turn on shift alerts' })).toHaveCount(0);
  await guide.getByRole('button', { name: 'Not now' }).click();
  const alerts = p.getByRole('dialog', { name: 'Turn on shift alerts' });
  await expect(alerts.getByRole('button', { name: 'Turn on alerts' })).toBeVisible();
  await alerts.getByRole('button', { name: 'Not now' }).click();
  await expect(alerts).toBeHidden();
  await p.reload();
  await expect(p.locator('.iosg')).toHaveCount(0);
  await ctx.close();
});
