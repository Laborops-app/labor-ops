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

## What it does

**Companies and people**
- Companies sign up and get a free trial; each company's data is isolated by PostgreSQL Row-Level Security (enforced by the database, not just app code).
- Roles: Admin, Labor Coordinator, Crew. Only admins add admins. Field permissions: an *On-site Labor Coordinator* checks crew in and out and rates them for the whole event; *leads* (chosen per event, one lead role per department) do the same for their own team.
- Roles & rates (pay, day and bill rates), certificates with expiry, crew groups, trainings and an academy, crew reviews and star ratings.

**Scheduling**
- Events with one phase per day (pre-made from the event dates), shifts with headcount, minimum call (4 / 5 h), lead shifts linked to the crew shifts they lead. Moving an event moves its phases and shifts.
- Crew picker with type-ahead, star ratings, and people who are booked, unavailable or missing a certificate tucked away. Double-booking, rest and daily-hour rules need an override.
- Open shifts, swaps, availability, schedule and calendar views, customers, quotes (PDF) and a pipeline board, Rentman sync.

**Time and pay**
- Crew clock in and out on their phone, with optional GPS geofence, or a coordinator checks them in on site.
- **Works offline:** with no signal, a clock-in/out is saved on the phone (with the time it was tapped, GPS accuracy and a random id) and sent automatically when there is signal again, by Background Sync on Android or when the app is next opened. The server accepts it once, keeps the phone's time (up to 12 hours old) and marks it *Offline* on the timesheet.
- Timesheets inside the scheduled hours are approved automatically; coordinators, admins and leads (during the shift + 2 h) can fix times, with the original kept.
- **Late and no-show alerts:** crew who haven't clocked in a few minutes after the start get a nudge, and coordinators and the event's leads are told; after a set time they are flagged as no-shows (cleared if they turn up). A clock-out forgotten for some hours is closed at the shift end and left for a manager to check. All three are set under Labor rules.
- Overtime (weekly, daily, per state), double time, night / Sunday / holiday premiums, day rates and minimum calls, priced the same in estimates, payroll and reports.
- Payroll exports for ADP (RUN and Workforce Now, with rate codes per role), Gusto and QuickBooks, plus QuickBooks Online time activities.

**Reports**
- Per event for any period: fill rate, scheduled vs worked hours, overtime and double time, labor cost (approved time, as paid), billed (accepted quote, or hours × billing rates), margin, labor budget vs actual, no-shows and late arrivals. CSV download.

**Messages and the app**
- In-app notifications, email (Amazon SES), text messages (Twilio, Amazon SNS or Podium) and browser push. Chat with files, groups and event channels.
- Installable web app (no native apps to maintain): an iPhone guide for *Add to Home Screen* (required there for notifications), an install button on Android, then a prompt to turn on alerts.
- Push messages use **Declarative Web Push** (shown by Safari even if the service worker isn't running) and set the app badge. For people with push on, the text message for the same alert is held back 10 minutes and only sent if the push wasn't opened (`SMS_ESCALATE_MIN`).
- Password-free sign-in for crew: a **one-time sign-in link** by email (and text, for people who agreed to texts), and **passkeys** (Face ID / fingerprint) added on the Profile page.

**Billing (Stripe)**
- Plans by active crew (labor coordinators and admins are free), each with a monthly text allowance; extra text packs are bought once and used after the allowance. Checkout, the Stripe customer portal and webhooks keep the plan in step.
- The Stripe secret key, webhook secret, plan limits, prices and Stripe price ids are entered on the Platform console → Billing (saved encrypted). **Never put Stripe keys in code, `.env` or a chat.** Until a key is saved, billing is off and no limits apply.
- Webhook endpoint: `https://<your domain>/api/billing/webhook` with the events `checkout.session.completed`, `customer.subscription.created/updated/deleted` and `invoice.payment_failed`.
- Companies that existed before billing were moved to the *Internal* plan (no limits); change a company's plan on the Platform console when it should start paying.

Not built yet: native mobile apps (not planned), MFA, refresh-token rotation, time-off requests.

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

## Known limits

- Session = one 12-hour login cookie. Short tokens with refresh rotation, MFA and lockout come next.
- `SEED_DEMO=true` keeps a sample company with demo sign-in buttons on the login page. Signup is always open (new companies start on a trial). Turn `SEED_DEMO` off on a server real customers use, once nobody relies on the demo accounts.
- Times are shown in the viewer's time zone; payroll and reports use the company's time zone.
- Offline clock-in needs the app to have been opened once with signal on that phone (to save the app and the shift list).

## File storage and backups (RustFS / S3)

Uploads go to S3-compatible object storage, one private bucket per kind of file (the API checks access and streams files):

| Bucket (default name) | Holds |
|---|---|
| `laborops-chat` | photos and files sent in chat |
| `laborops-documents` | certificate scans and academy certificate PDFs |
| `laborops-backups` | nightly `pg_dump` of the database (`postgres/…`) and a copy of every upload (`files/…`) |

Nothing to configure: `docker compose up` starts RustFS next to the app, generates its keys into a private volume the api can
read, creates the buckets and moves any files still in Postgres. Storage, bucket names, a separate backup server and the backup
schedule are changed on the **Platform** page (settings are saved encrypted in the database). `S3_*` / `BACKUP_S3_*` in `.env`
still work as a fallback when nothing is saved on the page.

## Platform console

The platform console runs on its own address (`PLATFORM_DOMAIN`, default `sysadmin.laborops.app`; point its DNS at the same
server). It is for the people who run LaborOps itself and has its own accounts, separate from every company: a SaaS dashboard
(growth, usage, health), every company (plan, notes, suspend / lift), storage, backups, platform admins and an activity log.
The company app does not serve it, and `/platform` on the main address redirects there.

Create the first platform admin on the server; it prints a one-time link (valid 72 hours) to choose a name and password:

```
docker compose exec api node dist/platformCli.js invite you@example.com
```

Add more admins from the console. The same command (or "New link" in the console) resets a forgotten password.

Restore (on the server):

```
docker compose exec api node dist/restore.js list
docker compose exec api node dist/restore.js database latest   # replaces the current data
docker compose exec api node dist/restore.js files             # copies uploads back into their buckets
docker compose restart api
```
