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
  // Public base URL, used for links in emails/SMS and for verifying Twilio webhooks.
  appUrl: (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  // Email through Amazon SES SMTP. Unset = log-only mode (messages are recorded, nothing is sent).
  email: {
    host: process.env.SES_SMTP_HOST ?? '',
    port: Number(process.env.SES_SMTP_PORT ?? 587),
    user: process.env.SES_SMTP_USER ?? '',
    pass: process.env.SES_SMTP_PASS ?? '',
    from: process.env.EMAIL_FROM ?? 'LaborOps <no-reply@laborops.app>',
  },
  // SMS through Twilio. Unset = log-only mode.
  sms: {
    sid: process.env.TWILIO_ACCOUNT_SID ?? '',
    token: process.env.TWILIO_AUTH_TOKEN ?? '',
    from: process.env.TWILIO_FROM_NUMBER ?? '',
  },
  workers: process.env.NOTIFY_WORKERS !== 'false',
};
