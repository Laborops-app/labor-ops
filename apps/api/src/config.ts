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
  // The public demo (demoapp.laborops.app): a much bigger sample company, and all four logins shown on the sign-in page.
  demoBig: process.env.DEMO_BIG === 'true',
  // New companies may sign up. Off in production unless SIGNUP_OPEN=true (always on when developing and testing).
  signupOpen: process.env.SIGNUP_OPEN === 'true' || (process.env.NODE_ENV !== 'production' && process.env.SIGNUP_OPEN !== 'false'),
  demoPassword: process.env.DEMO_PASSWORD ?? 'LaborOps-Demo-1',
  // Public base URL, used for links in emails and text messages.
  appUrl: (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  // Where the platform console is served (its own subdomain in production; the same server when developing).
  platformUrl: (process.env.PLATFORM_URL ?? process.env.APP_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  // Email through Amazon SES SMTP. Unset = log-only mode (messages are recorded, nothing is sent).
  email: {
    host: process.env.SES_SMTP_HOST ?? '',
    port: Number(process.env.SES_SMTP_PORT ?? 587),
    user: process.env.SES_SMTP_USER ?? '',
    pass: process.env.SES_SMTP_PASS ?? '',
    from: process.env.EMAIL_FROM ?? 'LaborOps <no-reply@laborops.app>',
  },
  // Text messages through Zernio (zernio.com). A company can also save its own Zernio key in the app, or use Podium.
  // Not configured = log-only mode (texts are recorded, nothing is sent).
  sms: {
    provider: 'zernio' as const,
    zernio: {
      apiKey: process.env.ZERNIO_API_KEY ?? '',
      // The SMS-enabled number (E.164) or approved branded sender ID to send from.
      from: process.env.ZERNIO_FROM ?? '',
    },
  },
  workers: process.env.NOTIFY_WORKERS !== 'false',
  // S3-compatible object storage (RustFS on the same server by default). Unset = files stay in Postgres.
  storage: {
    endpoint: process.env.S3_ENDPOINT ?? '',
    region: process.env.S3_REGION ?? 'us-east-1',
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== 'false',
    buckets: {
      chat: process.env.S3_BUCKET_CHAT ?? 'laborops-chat',
      documents: process.env.S3_BUCKET_DOCUMENTS ?? 'laborops-documents',
      backups: process.env.S3_BUCKET_BACKUPS ?? 'laborops-backups',
    },
    // Backups can go to a different S3 server (another host or provider) so they survive losing this one.
    backupEndpoint: process.env.BACKUP_S3_ENDPOINT ?? '',
    backupAccessKey: process.env.BACKUP_S3_ACCESS_KEY ?? '',
    backupSecretKey: process.env.BACKUP_S3_SECRET_KEY ?? '',
    backupRegion: process.env.BACKUP_S3_REGION ?? '',
  },
  backups: {
    enabled: process.env.BACKUPS_ENABLED !== 'false',
    hourUtc: Number(process.env.BACKUP_HOUR_UTC ?? 9), // 9:00 UTC = 3 AM in Denver (2 AM in summer)
    keepDaily: Number(process.env.BACKUP_KEEP_DAILY ?? 14),
    keepWeekly: Number(process.env.BACKUP_KEEP_WEEKLY ?? 8),
    keepMonthly: Number(process.env.BACKUP_KEEP_MONTHLY ?? 12),
    pgDump: process.env.PG_DUMP_PATH ?? 'pg_dump',
  },
  // People who run the platform itself (not a company admin): they see storage and backup status.
};
