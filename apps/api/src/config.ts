const isProd = process.env.NODE_ENV === 'production';

function jwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (s && s.length >= 32) return s;
  if (isProd) throw new Error('JWT_SECRET must be set to at least 32 characters in production');
  return 'dev-only-secret-change-me-dev-only-secret';
}

export const config = {
  isProd,
  port: Number(process.env.PORT ?? 4000),
  // Runtime connection: the restricted role. Row-Level Security applies to it.
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://laborops_app:laborops_app@localhost:5432/laborops',
  // Migrations only: database owner.
  adminDatabaseUrl: process.env.DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@localhost:5432/laborops',
  appDbPassword: process.env.APP_DB_PASSWORD ?? 'laborops_app',
  jwtSecret: jwtSecret(),
  cookieSecure: process.env.COOKIE_SECURE === 'true',
  seedDemo: process.env.SEED_DEMO === 'true',
  demoPassword: process.env.DEMO_PASSWORD ?? 'LaborOps-Demo-1',
};
