import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests for the main flows. They start their own API (on a fresh database) and web app, and every test makes
 * its own company, so they never touch demo data and can run in any order.
 *   npm run e2e            (uses `next dev`; set E2E_WEB=start to test a production build made with API_URL set)
 */
const API_PORT = Number(process.env.E2E_API_PORT ?? 4500);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 3500);
const ADMIN = process.env.E2E_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/laborops_e2e';
const APP = process.env.E2E_DATABASE_URL ?? 'postgres://laborops_app:laborops_app@localhost:5432/laborops_e2e';
export const BASE = `http://localhost:${WEB_PORT}`;

export default defineConfig({
  testDir: '.',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: '../e2e-report' }]] : 'list',
  outputDir: '../test-results',
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: 'node e2e/prepare-db.mjs && npm run dev -w apps/api',
      cwd: '..',
      url: `http://localhost:${API_PORT}/api/auth/me`,
      // The API answers 401 when it's up; Playwright only needs a response.
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { PORT: String(API_PORT), DATABASE_ADMIN_URL: ADMIN, DATABASE_URL: APP, NOTIFY_WORKERS: 'false', SEED_DEMO: 'false', AUTH_RATE_MAX: '1000', APP_URL: `http://localhost:${WEB_PORT}` },
    },
    {
      command: process.env.E2E_WEB === 'start' ? `npx next start -p ${WEB_PORT}` : `npx next dev -p ${WEB_PORT}`,
      cwd: '../apps/web',
      url: `${BASE}/login`,
      reuseExistingServer: !process.env.CI,
      timeout: 240_000,
      env: { API_URL: `http://localhost:${API_PORT}`, NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
