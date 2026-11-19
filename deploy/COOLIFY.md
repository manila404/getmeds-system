# Deploying Getmeds on Coolify (bishnoi-one-server)

Two Coolify **Applications** from this one repo. Both use the **Dockerfile**
build pack. Deploy the backend first, because the frontend needs the
backend's URL at build time.

Why two apps and not one Docker Compose resource: an app built with a
Dockerfile gets **every** env var you add in Coolify. A compose file only
gets the vars it lists by name, and the backend reads about 60 of them. One
missing var means a feature quietly breaks.

---

## 1. Backend: `getmeds-api`

Coolify → Project → **+ New** → Application → (GitHub app / public repo) →
`manila404/getmeds-system`, branch `main`.

| Setting | Value |
|---|---|
| Build Pack | **Dockerfile** |
| Base Directory | `/getmeds-backend` |
| Dockerfile Location | `/Dockerfile` |
| Ports Exposes | `4000` |
| Domain | e.g. `https://api.getmeds.ph` (Coolify gets the TLS certificate) |
| Health check | path `/api/health`, port `4000` |
| Replicas | **1**. Never more: the Zoho auto-sync guard runs inside one process |

**Environment variables** (Developer view → paste the contents of
`getmeds-backend/.env.coolify`), then fix these values:

| Var | Value |
|---|---|
| `NODE_ENV` | `production`. The current `.env.coolify` says `development` |
| `PGPOOL_MAX` | **delete it**. `=1` is a Vercel-only workaround; the default of 10 is right for one long-lived process |
| `DATABASE_URL` | see **Database** below |
| `CORS_ALLOWED_ORIGINS` | the frontend's exact URL, e.g. `https://hub.getmeds.ph` (no trailing slash) |
| `APP_BASE_URL` | the same frontend URL |
| `JWT_SECRET`, `ZOHO_WEBHOOK_SECRET`, `CRON_SECRET` | keep the current values. A new `JWT_SECRET` logs everyone out; a new webhook secret means updating Zoho at the same time |
| `ZOHO_AUTO_SYNC_ENABLED` | `true`, or leave it unset (true is the default). It now really runs every 5 min, which it never did on Vercel |

Also copy over any of these if production uses them:
`SMTP_*`, `GOOGLE_CHAT_WEBHOOK_URL`, `DR_2MG_*`, `DR_GPI_*`,
`SUPABASE_SECRET_KEY`, `SUPABASE_PROOF_BUCKET`, `GETMEDS_*` flags.

Do **not** mark any of these as "Build Variable". The backend reads them at
runtime.

Every boot runs `migrate:pg` first, then `server.js`. Migrations are
idempotent, so redeploys are safe.

Check it: `https://api.getmeds.ph/api/health?deep=1` should return
`"database":{"ok":true,...}`.

### Database

* **Until the data is moved:** keep pointing at Supabase, but use the
  **session pooler**, port `:5432`, *not* `:6543`. That is the same host as
  today's `.env` with the port changed. `:6543` is for serverless only.
* **After the data is moved into the Coolify Postgres:** use its *internal*
  URL (`postgres://postgres:…@kqs86libp31tqky3eks2idrz:5432/hubgetmeds`).
  That hostname resolves only inside Coolify's network. That's fine, because
  the app runs there too, but you can't reach it from a laptop.
  `src/db/pg.js` turns on SSL for every non-localhost host. So if SSL is
  **off** on the Coolify Postgres, add `?sslmode=disable` to the end of the
  URL, or the connection fails.

## 2. Frontend: `getmeds-hub`

| Setting | Value |
|---|---|
| Build Pack | **Dockerfile** |
| Base Directory | `/getmeds-frontend` |
| Dockerfile Location | `/Dockerfile` |
| Ports Exposes | `80` |
| Domain | e.g. `https://hub.getmeds.ph` |
| Health check | path `/healthz`, port `80` |

**Environment variables.** Tick **"Build Variable"** on every one of these.
Vite bakes them into the JS at build time:

| Var | Value |
|---|---|
| `VITE_API_URL` | backend URL, e.g. `https://api.getmeds.ph` (required; the build fails without it) |
| `VITE_TEST_MODE` | `false` |
| `VITE_DEBUG` | `false` |
| `VITE_DR_WORKFLOW` | whatever production uses today (`true`/`false`) |
| `VITE_KPI_SCORECARD` | same |
| `VITE_ADMIN_OVERVIEW_MOCK` | `false` |

If you change any of these later, click **Redeploy**. A restart is not
enough.

nginx serves the build with SPA fallback and the same security headers as
`vercel.json`.

## 3. DNS

Add `A` records for both domains pointing at bishnoi-one-server's public
IP, then deploy. Coolify's proxy issues the Let's Encrypt certificates.

## 4. Cutover checklist (things still pointing at Vercel)

1. **Zoho Workflow Rules**: change the webhook URL to
   `https://api.getmeds.ph/api/webhooks/zoho`. Keep the same
   `X-Zoho-Webhook-Token`.
2. **Supabase pg_cron job `zoho-invoice-copy`**: it calls
   `https://getmeds-system-backend.vercel.app/...` every 15 min. Repoint it
   at the new API URL, or drop it after the DB moves (the Coolify Postgres
   has no pg_cron).
3. **GitHub Actions `getmeds-cron.yml`**: set the repo secret
   `GETMEDS_API_URL` to the new API URL. With a long-lived process this
   becomes a safety net, not the main trigger (cronLock.js stops it from
   double-running).
4. **GitHub Actions `getmeds-backup.yml`**: still dumps Supabase. Once the
   DB is on Coolify, use Coolify's own scheduled backups for that Postgres
   instead.
5. Keep the Vercel deployments for a few days as a fallback, then remove
   them.
