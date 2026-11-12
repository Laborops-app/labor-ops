import { expect, test } from '@playwright/test';
import { api, eventWithShift, newCompany, newCrew, scribble, signIn } from './helpers';

test('onboarding: add the starter packet, crew fill in and sign on a phone, progress updates', async ({ page, browser }) => {
  await newCompany(page);
  const ari = await newCrew(page, 'Ari Dawson');

  await page.goto('/forms');
  await page.getByLabel(/Use an onboarding packet/).check();
  await page.getByRole('button', { name: '+ Add the starter packet' }).click();
  await expect(page.getByText(/Added 5 documents/)).toBeVisible();
  await expect(page.locator('.doc-list li', { hasText: 'Workplace policies' }).first()).toBeVisible();

  const crew = await signIn(browser, ari.email, true);
  await crew.page.goto('/my-shifts');
  await expect(crew.page.getByText(/Finish your onboarding/)).toBeVisible();
  await crew.page.goto('/my-documents');
  await crew.page.locator('.doc-list li', { hasText: 'Workplace policies' }).getByRole('link').click();
  await expect(crew.page.locator('.pdfp-page canvas').first()).toBeVisible();
  // On a phone the tick boxes are also listed below the document at a normal size
  await expect(crew.page.getByRole('heading', { name: 'Fill in' })).toBeVisible();

  // Signing without ticking every box is refused, then accepted once they are ticked
  await crew.page.getByRole('radio', { name: 'Type my name' }).click();
  await crew.page.getByLabel(/I agree that this is my electronic signature/).check();
  await crew.page.getByRole('button', { name: 'Sign and finish' }).click();
  await expect(crew.page.getByRole('alert').filter({ hasText: 'Tick' })).toBeVisible();
  for (const box of await crew.page.locator('.docfill-list input[type=checkbox]').all()) await box.check();
  await crew.page.getByRole('button', { name: 'Sign and finish' }).click();
  await expect(crew.page.getByRole('heading', { name: 'Workplace policies is done' })).toBeVisible();
  await crew.page.getByRole('button', { name: 'Open the signed PDF' }).click();
  await expect(crew.page.locator('.modal .pdfp-page canvas').first()).toBeVisible();
  await crew.ctx.close();

  await page.reload();
  await expect(page.locator('.doc-list li', { hasText: 'Ari Dawson' }).locator('.cs-st')).toHaveText('1 of 5');
});

test('incident report: filed from a shift with a witness signing on the same phone', async ({ page, browser }) => {
  await newCompany(page);
  const ari = await newCrew(page, 'Ari Dawson');
  const { eventId, shiftId } = await eventWithShift(page, { name: 'Incident Show', startInMin: 20 });
  await api(page, 'POST', `/api/shifts/${shiftId}/assign`, { userId: ari.id, confirmed: true });

  await page.goto('/forms');
  await page.getByRole('tab', { name: /Shift forms/ }).click();
  await page.getByLabel(/Use forms and checklists on shifts/).check();
  await page.getByRole('button', { name: /Add the incident report/ }).click();
  await expect(page.locator('.doc-list li', { hasText: 'Incident report' })).toBeVisible();

  const crew = await signIn(browser, ari.email, true);
  const asg = (await api<{ shifts: { assignment_id: string }[] }>(crew.page, 'GET', '/api/my/shifts')).shifts[0]!.assignment_id;
  await crew.page.goto(`/my-shifts/${asg}`);
  const card = crew.page.locator('section', { hasText: 'Forms for this shift' });
  await expect(card.getByText('Only if you need it')).toBeVisible();
  await card.getByRole('link', { name: 'Fill in' }).click();
  await expect(crew.page.locator('.pdfp-page canvas').first()).toBeVisible();
  // On a phone, the boxes on the page are filled in from the list below it
  const list = crew.page.locator('.docfill-list');
  for (const f of await list.locator('.docfill-field:not(:has(.muted)) input, .docfill-field:not(:has(.muted)) textarea').all()) await f.fill('Dock B ramp, road case tipped');
  await crew.page.locator('#in-t_injury').check();
  await crew.page.locator('#in-w1_name').fill('Wendy Witness');
  await scribble(crew.page, crew.page.locator('.docfill-other').first().locator('canvas'));
  await scribble(crew.page, crew.page.locator('#docfill-sign canvas'));
  await crew.page.getByLabel(/I agree that this is my electronic signature/).check();
  await crew.page.getByRole('button', { name: 'Sign and finish' }).click();
  await expect(crew.page.getByRole('heading', { name: 'Incident report is done' })).toBeVisible();
  await crew.ctx.close();

  await page.goto(`/events/${eventId}`);
  const forms = page.locator('.ev-aside section', { has: page.getByRole('heading', { name: 'Forms', exact: true }) });
  await expect(forms.getByText('Incident report')).toBeVisible();
  await expect(page.locator('.notif-badge, [aria-label*="notification" i]').first()).toBeVisible();
});

test('call sheet: open the window and get a PDF', async ({ page }) => {
  await newCompany(page);
  const { eventId } = await eventWithShift(page, { name: 'Sheet Show', startInMin: 24 * 60 });
  await page.goto(`/events/${eventId}`);
  await page.getByRole('button', { name: /^More$/ }).click();
  await page.getByRole('menuitem', { name: /Call sheet & wrap report/ }).click();
  const dl = page.getByRole('link', { name: 'Download PDF' });
  await expect(dl).toBeVisible();
  const r = await page.request.get((await dl.getAttribute('href'))!);
  expect(r.status()).toBe(200);
  expect((await r.body()).subarray(0, 4).toString()).toBe('%PDF');
});
