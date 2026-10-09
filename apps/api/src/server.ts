import { config } from './config';
import { migrateWithRetry } from './migrate';
import { buildApp } from './app';
import { seedDemo } from './seed';

async function main() {
  await migrateWithRetry();
  if (config.seedDemo) await seedDemo();
  const app = await buildApp();
  await app.listen({ host: '0.0.0.0', port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
