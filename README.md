# LaborOps

Crew scheduling and time tracking for production and event companies. Multi-tenant SaaS.
This repository is a **monorepo**: the web app, the API and the server setup all live here and are versioned together.

```
apps/api      Node API (Fastify + PostgreSQL). Migrations in apps/api/migrations. Tests in apps/api/test.
apps/web      Web app (Next.js + React). Works on desktop and phones.
infra         Caddy (HTTPS) config and the Lightsail first-boot script.
docker-compose.yml   The whole stack on one server: Postgres, API, web, Caddy.
.github/workflows    CI (tests + build) and automatic deploy to the demo server.
```

## What the demo does

- Companies sign up; each company's data is isolated by PostgreSQL Row-Level Security (enforced by the database, not just app code).
- Roles: Admin, Manager, Crew.
- Managers: add crew, create events, add shifts, assign crew (double-booking and over-filling are blocked), approve timesheets, export approved hours as CSV.
- Crew: see their shifts on a phone, accept/decline, clock in/out (clock-in opens 1 hour before a shift).

Not built yet (see the spec, phases 2-6): native mobile apps, push notifications, geofencing, chat, payroll/accounting integrations, billing, MFA, refresh-token rotation.

## Run it on your own computer

Needs Node 22 and PostgreSQL 16.

```bash
createdb laborops
npm install
# API on :4000 (creates tables, adds demo data)
SEED_DEMO=true DATABASE_ADMIN_URL=postgres://postgres:postgres@localhost:5432/laborops \
  npm run dev:api
# web on :3000 (in a second terminal)
npm run dev:web
```

Open http://localhost:3000. Demo sign-ins appear on the login page.

Tests (they need the same local Postgres): `npm test`

## How tenant isolation works

Every tenant-owned table has a `tenant_id`. The API connects as `laborops_app`, a database role that cannot bypass security policies.
Each request runs in a transaction that sets `app.tenant_id`; policies then only allow rows for that tenant.
Tests in `apps/api/test/api.test.ts` try to read and write across tenants and must fail.
Migrations run as the database owner; the API never does.

## Deploying (Lightsail)

See `infra/lightsail-launch.sh` and the workflow in `.github/workflows/ci.yml`.
On every push to `main`: tests run, then the code is copied to the server and `docker compose up -d --build` runs there.
Server secrets live only in `/opt/laborops/.env` on the server (generated on first boot, never committed).

Required GitHub repository secrets: `DEPLOY_HOST` (server IP), `DEPLOY_USER` (`ubuntu`), `DEPLOY_SSH_KEY` (private key).

Useful commands on the server (`cd /opt/laborops`):

```bash
docker compose ps                     # what is running
docker compose logs -f api            # API logs
docker compose exec api node dist/seed.js --reset   # rebuild the sample company (fresh dates)
```

## Known limits of this demo build

- Session = one 12-hour login cookie. The spec's 15-minute tokens with refresh rotation, MFA and lockout come next.
- No email yet: new crew get a temporary password shown once to the manager who adds them.
- `SEED_DEMO=true` publishes demo sign-in buttons and anyone can create a company. Fine for a demo address; turn it off (`SEED_DEMO=false`) before real customers.
- Clock-in is time-window only (no GPS/geofence yet). Times are shown in the viewer's timezone; the CSV is in UTC.
- Single server, no automated database backups yet: turn on Lightsail snapshots.

## File storage and backups (RustFS / S3)

Uploads go to S3-compatible object storage, one bucket per kind of file, all private (the API checks access and streams files):

| Bucket (default name) | Holds |
|---|---|
| `laborops-chat` | photos and files sent in chat |
| `laborops-documents` | certificate scans and academy certificate PDFs |
| `laborops-backups` | nightly `pg_dump` of the database (`postgres/…`) and a copy of every upload (`files/…`) |

Turn it on in `.env` on the server, then deploy:

```
COMPOSE_PROFILES=storage
S3_ACCESS_KEY=<openssl rand -hex 12>
S3_SECRET_KEY=<openssl rand -hex 24>
PLATFORM_ADMINS=you@example.com
```

This starts RustFS next to the app; the buckets are created on start and files already in Postgres are moved over. Without these
settings files stay in Postgres and backups are off. For backups that survive losing the server, set `BACKUP_S3_ENDPOINT`,
`BACKUP_S3_ACCESS_KEY` and `BACKUP_S3_SECRET_KEY` to a second S3 server (RustFS elsewhere, AWS S3, Backblaze B2, Wasabi).

Backups run every night after `BACKUP_HOUR_UTC` and are kept daily for 14 days, weekly for 8 weeks and monthly for 12 months.
Status, "Back up now" and downloads are under Integrations → Storage & backups (only for `PLATFORM_ADMINS`).
The RustFS console listens on the server's localhost only: `ssh -L 9001:localhost:9001 <server>` and open http://localhost:9001.

Restore (on the server):

```
docker compose exec api node dist/restore.js list
docker compose exec api node dist/restore.js database latest   # replaces the current data
docker compose exec api node dist/restore.js files             # copies uploads back into their buckets
docker compose restart api
```
