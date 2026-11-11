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
- Roles: Admin, Labor Coordinator, HR, Crew, and Client (a customer's portal login). Only admins add admins and HR accounts. **HR** handles invoicing and payroll: pipeline, events (read-only) with their invoice, timesheets (view and export), payroll and reports; no scheduling. Field permissions: an *On-site Labor Coordinator* checks crew in and out and rates them for the whole event; *leads* (chosen per event, one lead role per department) do the same for their own team.
- Roles & rates (pay, day and bill rates), certificates with expiry, crew groups, trainings and an academy, crew reviews and star ratings.

**Scheduling**
- Events with one phase per day (pre-made from the event dates), shifts with headcount, minimum call (4 / 5 h), lead shifts linked to the crew shifts they lead. Moving an event moves its phases and shifts.
- **Auto-fill:** one button proposes the best available people for every open seat on an event (lists the position, stars, past work for the customer, fewest hours; never booked, on time off, missing a certificate, breaking rest rules or tagged Do not rehire), with the reasons. The coordinator unticks anyone and sends the offers; nothing goes out before that.
- **Event templates and quick start:** save a whole event (days, named groups, positions with times and people needed) as an event template, then start a new event from a template or a copy of a past event in the Add New Event window.
- **Fast position entry:** *Quick add* on each day takes a grid (Tab through, Enter adds a row) or typed text like "10 stagehands 8a-4p, 4 riggers 7a-3p". *Duplicate* repeats a position, *Copy day* copies a day's groups and positions to other days, and each role can carry default people needed and times (Roles & rates → Position defaults).
- **Honest staffing numbers:** events show confirmed, waiting, not sent and open seats separately; only people who said yes count as staffed. *Needs attention* on each event lists offers nobody has answered (with Remind, once an hour, by push and text), declines to replace and open seats starting within 3 days, with one-tap Replace and Fill that work on a phone.
- **Who's free?:** ask a crew group, everyone in a role or picked people which event days they can work; they answer per day on My shifts. *Book the free people* opens auto-fill with only them, on the days they said.
- **Build quietly:** pick crew (by hand, crew groups or auto-fill) without telling anyone; picks are kept as a plan and *Publish* sends every offer at once.
- Crew picker with type-ahead, star ratings, and people who are booked, unavailable or missing a certificate tucked away. Double-booking, rest and daily-hour rules need an override.
- Pipeline: when an event is moved to Completed, admins and HR get a "Ready to invoice" message (in-app and email). Once its invoice is sent (QuickBooks Online or the Desktop file), or when it is canceled, the event leaves the pipeline for the **Archive**, where it can be restored or booked again next year. Archived events are deleted automatically after 4 years (canceled ones after 2); admins can delete one sooner.
- Open shifts, swaps, availability, schedule and calendar views, customers, quotes (PDF) and a pipeline board, Rentman sync.
- **Rentman projects in the pipeline** (Integrations → Rentman → Pipeline, off by default): every 30 minutes and on each sync, new Rentman projects ending on or after a chosen date become events with their customer, venue and dates, in the column their Rentman status matches (read from the subprojects' status names: concept/inquiry → New, option → Quote, confirmed/prepped/returned → Confirmed; projects already canceled are skipped). Linked events move forward when Rentman's status does. Canceled in Rentman cancels the event only when nobody is booked, and new Rentman dates are copied only while the event has no days or shifts; otherwise admins and coordinators are told once. A deleted event is not created again. Pipeline cards show the Rentman project and status.
- **Rentman quotes and quoted vs invoiced:** on an event linked to a Rentman project, the Invoice tab pulls the project's quotes in as read-only quotes (crew part only: one line per crew function on the financial documents, with Rentman's amount to the cent; fixed costs such as travel on their own line; equipment and transport totals kept for reference). Pull again after Rentman makes a new version. The Invoice tab compares the invoice with the event's quote (accepted, else newest; or one you pick), position by position: quoted and invoiced hours and dollars, difference and status (matches within $1 or 2%, over, under, not on the quote, not on the invoice). An invoice over the quote needs a second confirmation, for QuickBooks Online and the Desktop file alike, and each invoice records the quoted total it was checked against.

**Time and pay**
- Crew clock in and out on their phone, with optional GPS geofence, or a coordinator checks them in on site.
- **Breaks and lunch:** while clocked in, *Break* asks "Break or lunch?". A break keeps the person on the clock (paid) until *End break*. Lunch clocks them out (unpaid); *Back from lunch* clocks them in again on the same shift, with the same location check, or *Done for the day* ends it. A push and text reminds them to clock back in after 45 minutes (Labor rules → Lunch reminder, 0 = off). Breaks need a signal.
- **Works offline:** with no signal, a clock-in/out is saved on the phone (with the time it was tapped, GPS accuracy and a random id) and sent automatically when there is signal again, by Background Sync on Android or when the app is next opened. The server accepts it once, keeps the phone's time (up to 12 hours old) and marks it *Offline* on the timesheet.
- Timesheets inside the scheduled hours are approved automatically; coordinators, admins and leads (during the shift + 2 h) can fix times, with the original kept.
- **Late and no-show alerts:** crew who haven't clocked in a few minutes after the start get a nudge, and coordinators and the event's leads are told; after a set time they are flagged as no-shows (cleared if they turn up). A clock-out forgotten for some hours is closed at the shift end and left for a manager to check. All three are set under Labor rules.
- Overtime (weekly, daily, per state), double time, night / Saturday / Sunday / holiday premiums, day rates and minimum calls, priced the same in estimates, payroll and reports.
- **Work-rule sets** (Labor rules page) for a union local or a client contract: overtime and double-time thresholds, premiums, a default minimum call, punch rounding, **meal penalties** (escalating dollar amounts), **turnaround** (hours inside the rest paid at a multiplier) and **cancellation pay** (a confirmed call cut at short notice is paid automatically; the coordinator can say not to). One set is the company default; a customer or an event can use another. Penalties and cancellation pay show on payroll and go to ADP (earnings code `PEN`), Gusto (Penalty Pay) and the detail CSV. Manual pay adjustments (bonus, reimbursement, correction) can be added and voided on the Payroll page.
- Payroll exports for ADP (RUN and Workforce Now, with rate codes per role), Gusto and QuickBooks, plus QuickBooks Online time activities.

**Reports**
- **Client portal** (`/client`, **not public yet**: off unless `CLIENT_PORTAL=true`; while off, client logins are refused, the portal settings are hidden and invoices never wait for a client sign-off): a customer's people sign in to see their events, the schedule, who's confirmed and who's on site (refreshing), approved timesheets and invoices; they **approve or question timesheets** and **request crew** (a pending event with open positions, and staff are told). They never see pay, phone numbers or anything outside their customer and its divisions. Logins are added on the customer's page, where a switch makes invoicing wait for the client's sign-off (a change to the time after sign-off needs a new one).
- Per event for any period: fill rate, scheduled vs worked hours, overtime and double time, labor cost (approved time, as paid), billed (accepted quote, or hours × billing rates), margin, labor budget vs actual, no-shows and late arrivals. CSV download.

**Messages and the app**
- In-app notifications, email (Amazon SES), text messages (Zernio or Podium) and browser push. Chat with files, groups and event channels.
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

## Website and public demo

- **laborops.app** is the public website: static pages in `infra/site` (home, `/subscribe` pricing, `/signup`), served by Caddy. New companies can't sign up yet (`SIGNUP_OPEN` is off in production; the app's sign-up page and API say so), so every "Try the demo" button opens a window with the demo sign-ins and a link to the demo.
- **demoapp.laborops.app** is the public demo. Caddy sends it to the **demo gate** (`infra/demo-gate`), a small always-on service that:
  - starts the demo stack (`demo-db`, `demo-api`, `demo-web`, compose profile `demo`) when someone opens it, showing a spinning logo and an estimated percentage while it boots (about 10–40 s);
  - seeds a big sample company (`DEMO_BIG`): 45 crew, a dozen customers, ~40 events with phases, shifts, approved time, ratings, quotes, invoices and an archive, plus Admin, HR, Labor Coordinator and Crew sign-ins (password `LaborOps-Demo-1`);
  - shows a countdown banner in the app and wipes and restarts the demo every 2 hours (the demo database lives in memory);
  - shuts the demo down after an hour with nobody using it.
  The demo never sends email or texts and has its own database and secrets. The gate controls Docker through the Docker socket, so it only runs those fixed commands for the three demo services.
- DNS: `laborops.app`, `www.laborops.app` and `demoapp.laborops.app` point at the server (DNS only, so Caddy can get certificates). Change the names with `SITE_DOMAIN` and `DEMO_DOMAIN` in `.env`.

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
