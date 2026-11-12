import { expect, test } from '@playwright/test';
import { api, eventWithShift, newCompany, newCrew, signIn } from './helpers';

test('build quietly, fill a spot, publish, crew confirms, coordinator sees it', async ({ page, browser }) => {
  await newCompany(page);
  const sam = await newCrew(page, 'Sam Okafor');
  const { eventId } = await eventWithShift(page, { name: 'Quiet Build Show', startInMin: 24 * 60, quiet: true });

  await page.goto(`/events/${eventId}`);
  await expect(page.getByRole('heading', { name: 'Quiet Build Show' })).toBeVisible();
  await expect(page.getByText('Building quietly')).toBeVisible();

  // Fill the open spot from the picker; it stays a plan until published
  await page.getByRole('button', { name: /Fill an open spot on Stagehand/ }).click();
  await page.getByPlaceholder('Type a name…').fill('Sam');
  await page.getByRole('option', { name: /Sam Okafor/ }).click();
  // Every spot is now filled: the app asks whether to send the offers now
  await page.getByRole('button', { name: 'Request all crew' }).click();
  await expect(page.getByText(/Crew requested: 1 offer sent/)).toBeVisible();

  // Sam gets the offer and confirms it
  const crew = await signIn(browser, sam.email, true);
  await crew.page.goto('/my-shifts');
  await expect(crew.page.getByText('Quiet Build Show').first()).toBeVisible();
  await crew.page.getByRole('button', { name: 'Confirm' }).first().click();
  await expect(crew.page.getByRole('button', { name: 'Confirm' })).toHaveCount(0);
  await crew.ctx.close();

  await page.reload();
  const row = page.locator('.cs-row', { hasText: 'Sam Okafor' });
  await expect(row.locator('.cs-st')).toHaveText(/Confirmed/);
  await expect(page.locator('.evh-num b')).toHaveText('1');
});

test('right-click a crew member to set their pay on the event', async ({ page }) => {
  await newCompany(page);
  const sam = await newCrew(page, 'Sam Okafor');
  const { eventId, shiftId } = await eventWithShift(page, { name: 'Pay Show', startInMin: 24 * 60 });
  await api(page, 'POST', `/api/shifts/${shiftId}/assign`, { userId: sam.id, confirmed: true });

  await page.goto(`/events/${eventId}`);
  const row = page.locator('.cs-row', { hasText: 'Sam Okafor' });
  await row.locator('b', { hasText: 'Sam Okafor' }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Options for Sam Okafor' });
  await expect(menu).toBeVisible();
  await menu.getByRole('radio', { name: 'Day rate' }).click();
  await menu.getByLabel(/Day rate for Sam Okafor/).fill('320');
  await menu.getByRole('button', { name: 'Save' }).click();
  await expect(menu).toBeHidden();
  await expect(row.getByRole('button', { name: '$320.00/day' })).toBeVisible();
});

test('offer waves: best rated first, live progress, pause and carry on', async ({ page }) => {
  await newCompany(page, { quiet: false });
  for (const name of ['Ava Reyes', 'Ben Cole', 'Cara Diaz', 'Dev Shah']) await newCrew(page, name);
  const { eventId } = await eventWithShift(page, { name: 'Wave Show', headcount: 2, startInMin: 3 * 24 * 60 });

  await page.goto(`/events/${eventId}`);
  await page.getByRole('button', { name: 'Fill in waves' }).click();
  const dlg = page.getByRole('dialog', { name: 'Offer waves' });
  await expect(dlg.getByText('Who gets asked first')).toBeVisible();
  await expect(dlg.locator('.wave-list li')).toHaveCount(4);
  await dlg.getByRole('button', { name: 'Start waves' }).click();
  await expect(dlg.getByText(/Wave 1 · 2 offered/)).toBeVisible();
  await expect(dlg.locator('.wave-list .cs-st', { hasText: 'Waiting' })).toHaveCount(2);
  await dlg.getByRole('button', { name: 'Pause' }).click();
  await expect(dlg.getByText(/Paused/)).toBeVisible();
  await dlg.getByRole('button', { name: 'Carry on' }).click();
  await expect(dlg.locator('.wave-live p').first()).toContainText('Wave 1 ·');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /Waves running · wave 1/ })).toBeVisible();
});
