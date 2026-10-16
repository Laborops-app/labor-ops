import { config } from './config';
import { migrateWithRetry } from './migrate';
import { buildApp } from './app';
import { refreshDemoPayroll, seedDemo } from './seed';
import { seedBigDemo } from './seedBig';
import { startWorkers } from './notify/worker';
import { startStorageJobs } from './backup';

async function main() {
  await migrateWithRetry();
  if (config.seedDemo) await seedDemo();
  if (config.seedDemo && config.demoBig) await seedBigDemo();
  const app = await buildApp();
  await app.listen({ host: '0.0.0.0', port: config.port });
  if (config.workers) {
    startWorkers();
    startStorageJobs();
  }
  // Demo: keep a full week of approved hours in "last week" for the Payroll page, and today's on-site sample event.
  if (config.seedDemo) setInterval(() => refreshDemoPayroll().catch((e) => console.error('demo payroll:', e?.message ?? e)), 3600_000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
