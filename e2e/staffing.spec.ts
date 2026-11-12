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

test('search everything: Ctrl+K finds an event and opens it', async ({ page }) => {
  await newCompany(page);
  const { eventId } = await eventWithShift(page, { name: 'Quasar Launch Party', startInMin: 24 * 60 });
  await page.goto('/dashboard');
  await expect(page.getByRole('heading', { name: /Welcome back/ })).toBeVisible();
  await page.keyboard.press('Control+k');
  const box = page.getByRole('dialog', { name: 'Search' });
  await box.getByRole('combobox', { name: 'Search' }).fill('quasar');
  await expect(box.getByRole('option', { name: /Quasar Launch Party/ })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/events/${eventId}`));
  await expect(page.getByRole('heading', { name: 'Quasar Launch Party' })).toBeVisible();
});

test('remove with Undo, then select several crew and move them to another shift', async ({ page }) => {
  await newCompany(page, { quiet: false });
  const a = await newCrew(page, 'Ava Reyes'), b = await newCrew(page, 'Ben Cole');
  const { eventId, shiftId } = await eventWithShift(page, { name: 'Bulk Show', headcount: 2, startInMin: 3 * 24 * 60 });
  const ev = await api<{ event: { start_date: string } }>(page, 'GET', `/api/events/${eventId}`);
  const st = new Date(Date.now() + 3 * 24 * 3600_000 + 10 * 3600_000);
  const s2 = (await api<{ shift: { id: string } }>(page, 'POST', `/api/events/${eventId}/shifts`, { roleName: 'Loader', startsAt: st.toISOString(), endsAt: new Date(st.getTime() + 4 * 3600_000).toISOString(), headcount: 2 })).shift.id;
  void ev;
  for (const p of [a, b]) await api(page, 'POST', `/api/shifts/${shiftId}/assign`, { userId: p.id, confirmed: true });

  await page.goto(`/events/${eventId}`);
  // Remove, then Undo: Ava stays on the shift and nothing was sent
  await page.locator('.cs-row', { hasText: 'Ava Reyes' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from this shift' }).click();
  await expect(page.locator('.cs-row', { hasText: 'Ava Reyes' })).toHaveCount(0);
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect(page.locator('.cs-row', { hasText: 'Ava Reyes' })).toBeVisible();
  await page.waitForTimeout(5500);
  const still = await api<{ shifts: { id: string; assignments: { user_id: string }[] }[] }>(page, 'GET', `/api/events/${eventId}`);
  expect(still.shifts.find((s) => s.id === shiftId)!.assignments.some((x) => x.user_id === a.id)).toBe(true);

  // Select both and move them to the Loader shift
  await page.getByRole('button', { name: 'Select crew' }).click();
  await page.getByLabel('Select Ava Reyes').check();
  await page.getByLabel('Select Ben Cole').check();
  const bar = page.getByRole('toolbar', { name: 'Selected crew' });
  await expect(bar).toContainText('2 selected');
  await bar.locator('select').selectOption(s2);
  await expect(page.getByText(/Moved: 2 people/)).toBeVisible();
  const after = await api<{ shifts: { id: string; assignments: { user_id: string; status: string }[] }[] }>(page, 'GET', `/api/events/${eventId}`);
  expect(after.shifts.find((s) => s.id === s2)!.assignments.map((x) => x.status)).toEqual(['accepted', 'accepted']);
  expect(after.shifts.find((s) => s.id === shiftId)!.assignments).toHaveLength(0);
});
