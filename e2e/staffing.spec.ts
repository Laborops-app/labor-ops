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

test('event page shows and saves times in the venue time zone', async ({ page }) => {
  await newCompany(page);
  const day = new Date(Date.now() + 5 * 86400_000).toISOString().slice(0, 10);
  const ev = (await api<{ event: { id: string } }>(page, 'POST', '/api/events', { name: 'Zone Show', startDate: day, endDate: day })).event.id;
  await api(page, 'PATCH', `/api/events/${ev}`, { timezone: 'America/Phoenix' });
  // 9:00 in Phoenix (UTC-7 all year) = 16:00Z
  await api(page, 'POST', `/api/events/${ev}/shifts`, { roleName: 'Rigger', startsAt: `${day}T16:00:00.000Z`, endsAt: `${day}T22:00:00.000Z`, headcount: 1 });
  await page.goto(`/events/${ev}`);
  await expect(page.getByText(/Times in Phoenix time/)).toBeVisible();
  await expect(page.locator('.cs-card').first()).toContainText('9:00 AM');
  // Edit the start to 10:00 in place: saved as 17:00Z
  await page.locator('.cs-card').first().getByRole('button', { name: /^Edit/ }).click();
  const start = page.locator('.cs-card input[type="datetime-local"]').first();
  await start.fill(`${day}T10:00`);
  await page.getByRole('button', { name: 'Save shift' }).click();
  await expect(page.locator('.cs-card').first()).toContainText('10:00 AM');
  const saved = await api<{ shifts: { starts_at: string }[] }>(page, 'GET', `/api/events/${ev}`);
  // (read outside the event page, so not converted)
  expect(new Date(saved.shifts[0]!.starts_at).toISOString()).toBe(`${day}T17:00:00.000Z`);
});

test('schedule: event cards by day, needs-crew strip, filters, month grid and day panel', async ({ page }) => {
  await newCompany(page);
  const sam = await newCrew(page, 'Sam Okafor');
  // Two events tomorrow: one fully staffed, one with nobody yet
  const full = await eventWithShift(page, { name: 'Staffed Show', startInMin: 24 * 60 });
  await api(page, 'POST', `/api/shifts/${full.shiftId}/assign`, { userId: sam.id, confirmed: true });
  await eventWithShift(page, { name: 'Empty Show', startInMin: 24 * 60 + 60 });

  await page.goto('/schedule');
  await page.evaluate(() => localStorage.removeItem('lo-sched'));
  await page.goto('/schedule');
  await page.getByRole('tab', { name: 'Week' }).click();
  const staffed = page.locator('.bd-card', { hasText: 'Staffed Show' });
  const empty = page.locator('.bd-card', { hasText: 'Empty Show' });
  // Cards near the end of a week can land in the next one
  if (!(await staffed.count())) await page.getByRole('button', { name: 'Next week' }).click();
  await expect(staffed).toHaveClass(/good/);
  await expect(empty).toHaveClass(/bad/);
  await expect(staffed.getByRole('img', { name: 'Fully staffed' })).toBeVisible();
  // Open shifts are listed up top
  await expect(page.locator('.bd-needs', { hasText: 'Empty Show' })).toBeVisible();

  // Filters: only events with nobody yet; search
  if (!(await page.locator('.bd-rail').count())) await page.getByRole('button', { name: /^Filters/ }).click();
  await page.locator('.bd-rail').getByLabel('No crew yet').check();
  await expect(staffed).toHaveCount(0);
  await expect(empty).toHaveCount(1);
  await page.locator('.bd-rail').getByLabel('No crew yet').uncheck();
  await page.getByLabel('Find event, client or job number').fill('staffed');
  await expect(empty).toHaveCount(0);
  await page.getByLabel('Find event, client or job number').fill('');

  // Month: the day panel lists that day's events; "Open that week" goes back to the week
  await page.getByRole('tab', { name: 'Month' }).click();
  const cell = page.locator('.bd-mc:not(.out)', { hasText: 'Staffed Show' });
  if (!(await cell.count())) await page.getByRole('button', { name: 'Next month' }).click();
  await cell.click();
  const panel = page.locator('.bd-panel');
  await expect(panel.locator('.bd-card', { hasText: 'Staffed Show' })).toBeVisible();
  await expect(panel.locator('.bd-card', { hasText: 'Empty Show' })).toBeVisible();
  await panel.getByRole('button', { name: 'Open that week' }).click();
  await expect(page.getByRole('tab', { name: 'Week' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.bd-card', { hasText: 'Staffed Show' })).toBeVisible();
});

test('event: crew instructions with a uniform, decline for a crew member, and the History log', async ({ page }) => {
  await newCompany(page);
  const sam = await newCrew(page, 'Sam Okafor');
  const { eventId, shiftId } = await eventWithShift(page, { name: 'Log Show', startInMin: 24 * 60 });
  await api(page, 'POST', `/api/shifts/${shiftId}/assign`, { userId: sam.id, confirmed: true });
  await api(page, 'POST', '/api/uniforms', { name: 'Show blacks', description: 'All black, closed-toe shoes' });

  await page.goto(`/events/${eventId}`);
  // Instructions + uniform
  const card = page.locator('.ev-instr');
  await card.getByRole('button', { name: 'Add' }).click();
  await card.getByLabel('Instructions for the crew').fill('Park in Lot C. Ask for Dana.');
  await card.getByLabel('Uniform', { exact: true }).selectOption({ label: 'Show blacks' });
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(card.getByText('Park in Lot C. Ask for Dana.')).toBeVisible();
  await expect(card.getByText('Show blacks')).toBeVisible();

  // Decline for Sam from his row menu
  const row = page.locator('.cs-row', { hasText: 'Sam Okafor' });
  await row.locator('b', { hasText: 'Sam Okafor' }).click({ button: 'right' });
  await page.getByRole('menu', { name: 'Options for Sam Okafor' }).getByRole('menuitem', { name: /Decline for them/ }).click();
  const dlg = page.getByRole('dialog', { name: 'Decline for Sam Okafor' });
  await dlg.getByLabel('Sick').check();
  await dlg.getByRole('button', { name: 'Decline for them' }).click();
  await expect(dlg).toBeHidden();
  await expect(row.getByText(/declined for them by .* · Sick/)).toBeVisible();

  // He's not offered in this shift's crew picker any more
  await page.getByRole('button', { name: /Fill an open spot on Stagehand/ }).click();
  await page.getByPlaceholder('Type a name…').fill('Sam');
  await expect(page.getByRole('option', { name: /Sam Okafor/ })).toHaveCount(0);
  await page.keyboard.press('Escape');

  // History shows who did what
  await page.getByRole('button', { name: 'More', exact: true }).first().click();
  await page.getByRole('menuitem', { name: /^History/ }).click();
  const hist = page.getByRole('dialog', { name: 'History' });
  await expect(hist.getByText(/declined for Sam Okafor: Sick/)).toBeVisible();
  await expect(hist.getByText(/updated the crew instructions \(uniform: Show blacks\)/)).toBeVisible();
  await expect(hist.getByText(/added Sam Okafor to Stagehand/)).toBeVisible();
});
