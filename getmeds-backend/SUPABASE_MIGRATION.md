# Supabase Postgres — data layer and the applied port (Sep 2–3, 2026)

Decision: **Supabase Postgres free tier**, chosen over Neon. Both are Postgres,
`schema.pg.sql` runs unchanged on either, and moving between them later is a
`pg_dump` plus a connection-string change — so this is a reversible choice and
not worth agonising over.

Rejected on the way here: **Sanity**. Not a matter of taste — the free plan caps
a dataset at **10,000 documents** and this system holds **94,985 customers plus
3,446 products**, ~98,400 documents before a single order exists. The paid
Growth tier is 25k–50k. Nothing below Enterprise fits. Separately it has no
`UNIQUE` or `CHECK` constraints (the two that caught three real bugs on Sep 2),
a 25 mutations/sec cap, and GROQ rather than SQL — which would mean rewriting
all 188 query sites by hand rather than mechanically.

---

## Phase 2 is done and verified

`src/db/pg.js` + `src/db/sqlToPg.js` replace `src/db/database.js`. The call
shape is preserved, so the port stays mechanical:

```js
const row = await db.prepare(SQL).get(a, b);   // was: db.prepare(SQL).get(a, b)
```

**27/27 assertions pass against a real PostgreSQL 16** with `schema.pg.sql`
applied (`node tests/pgLayer.verify.js`). What is actually proven, rather than
assumed:

| | |
|---|---|
| `?` → `$1..$n` | including `?` inside string literals, `''` escapes, and `--` comments |
| `LIKE` → `ILIKE` | lowercase `lukes` finds `St. Lukes Medical Center`; the untranslated form returns **0 rows**, confirming the trap |
| `run().lastInsertRowid` | via auto-appended `RETURNING id`, only for tables that have an `id` column |
| `sync_state` / `order_id_sequences` | tables with no `id` — `ON CONFLICT` upsert works, no `RETURNING` appended |
| `db.transaction()` | commit, rollback on throw, rollback on CHECK violation, **concurrent transactions do not bleed**, nested joins the outer |
| `UNIQUE` / `CHECK` / FK | all still reject — the safety nets survive the port |
| `salesperson` generated column | computes and trims; NULL when division is missing |
| booleans | still come back as `1`, not `true` — 420 tests assert `toBe(1)` |
| `iso_now()` | matches `Date.toISOString()` exactly, to the millisecond and the `Z` |

### The load-bearing trick: AsyncLocalStorage

better-sqlite3's `db.transaction()` was synchronous, so every statement inside
implicitly ran on the one connection. With a pool that stops being true, and a
naive port would put `BEGIN` on one pooled connection and the `INSERT`s on
another — **no error, no rollback, just a silently lost guarantee** on exactly
the paths whose correctness is the point of this system (order creation, webhook
status transitions).

`pg.js` carries the checked-out client in an `AsyncLocalStorage`, so
`db.prepare(...).run(...)` inside a transaction callback finds it without any
call site passing it. That is what lets all 28 transaction blocks keep their
shape. The "concurrent transactions do not bleed" test exists specifically to
prove this, because the failure mode is invisible.

---

## Two findings the migration plan did not have

### 1. `datetime('now')` — 11 sites, and a bug that already exists in SQLite

`datetime('now')` **does not exist in Postgres**; those sites would throw
`function datetime(unknown) does not exist`. Loud, at least.

The quieter problem is that they are already wrong. SQLite's `datetime('now')`
returns `2026-09-02 08:47:34` — space separated, no `T`, no milliseconds, no
`Z`. Everywhere else the app writes `new Date().toISOString()` →
`2026-09-02T08:47:34.376Z`, and the column defaults produce that too. **The code
sorts and compares these as strings**, and space (`0x20`) sorts before `T`
(`0x54`) — so a row stamped by `datetime('now')` always sorts before an
ISO-stamped row regardless of actual time. Affected today:
`products.last_synced_at`, `customers.last_synced_at`, `orders.updated_at`,
`sync_state.updated_at`, and the `created_at` on `payments` and
`dispatch_records` (both override their own correct default).

`sqlToPg.js` maps `datetime('now')` and
`strftime('%Y-%m-%dT%H:%M:%fZ','now')` to `iso_now()`, which fixes both at once.
Any *other* SQLite date function is reported as `UNTRANSLATED` at boot rather
than left to fail at 2am.

### 2. `idx_customers_name_lower` does not work

`schema.pg.sql` says the index means the case-insensitive search "does not
become a sequential scan". Measured against a real PostgreSQL 16 loaded with
**95,002 customers**, that is not what happens — a B-tree index cannot serve a
*leading*-wildcard match, and the autocomplete searches `'%term%'`:

| query | plan | time |
|---|---|---|
| `name ILIKE '%zamboanga%'` | Seq Scan | **77.9 ms** |
| `LOWER(name) LIKE '%zamboanga%'` | Seq Scan | 53.3 ms |
| same, with `enable_seqscan = off` | still Seq Scan | — |
| `name ILIKE '%zamboanga%'` + GIN `pg_trgm` | Bitmap Index Scan | **0.16 ms** |

`pg_stat_user_indexes` confirms it: `idx_customers_name_lower` had
`idx_scan = 0` after every one of those queries. It is 5.6 MB of a 500 MB
free-tier budget doing nothing.

78 ms per keystroke over 95k rows on a warm **local socket**. On Supabase free —
shared compute plus a network round trip from the function — worse, and paid on
every keystroke by every MedRep. `src/db/schema.pg.trgm.sql` adds the GIN
indexes that actually answer the query (~480x faster, 1 MB more than the index
they replace). Supabase supports `pg_trgm`.

---

## Phase 3: the port is applied

`node scripts/portcheck.js src` — **CLEAN, nothing outstanding.**

```
      (skipping @sqlite-only: db/database.sqlite.js, db/migrate.js)
   0  db calls still missing await
   0  db.transaction() callbacks still sync
   0  SQLite-only date fns not handled by sqlToPg
   0  sqlite_master references
 179  db calls correctly awaited
```

**507 edits across 24 files**, applied by `scripts/propagate-async.js` — an AST
codemod, not hand edits, because both failure modes here are silent: a missed
`await` yields a Promise where a row was expected, and the code reads `undefined`
off it and carries on.

`src/db/database.js` is now a one-line re-export of `pg.js`, so none of the 24
files needed an import change. The diff is `await`/`async` and nothing else. The
original SQLite layer is kept as `database.sqlite.js`, marked `@sqlite-only` so
portcheck ignores it.

### Two bugs the codemod had, both found by testing rather than reading

Recorded because both produced a *clean-looking* result:

1. **`require('...')` parses as `Literal`, not `StringLiteral`.** Matching only
   `StringLiteral` made import resolution return an empty map for every file, so
   cross-file propagation never ran — `logEvent` went async while all 40-odd of
   its call sites stayed synchronous. The audit reported "no unawaited calls
   remain" because *it shared the same helper* and was blind in the same way.
   There is now a `checkImportResolutionWorks()` guard that hard-fails if a file
   plainly has relative requires but resolved zero bindings. An audit that shares
   code with the thing it audits validates its own blind spot.

2. **The migration's constraint query matched two constraints.** `orders` has
   both `orders_status_check` and `orders_zoho_sync_status_check`, and
   `pg_get_constraintdef(...) ILIKE '%status%'` matched both — so it merged their
   allowed values and would have **dropped the zoho_sync_status constraint**.
   Now matched on `conkey` (the actual column list), verified against a database
   holding both.

### What became async — this is the real API change

`logEvent`, `resolveActor` (auditService) · `notify`, `getUserIdsByRole`
(notificationService) · `setOrderStatus`, `advanceTo` (orderStatusService) ·
`generateOrderId` · `evaluateCompletion`, `isPaid`, `isShipped` ·
`forUser`, `profileForUser` (salespersonService) · `getSyncState`,
`setSyncState` · `requireAuth` (middleware) · plus every Express handler.

`requireAuth` becoming async was checked specifically: Express 4 does not catch
rejected promises from async middleware, so a throw would hang the request
forever with no response. It has a try/catch returning 401, so it is safe — and
every async route handler was confirmed to have a `try/catch { next(err) }`.

### `migrate.js` is replaced, not ported

SQLite cannot alter a CHECK constraint, so `migrate.js` renames the orders table,
re-runs the schema, copies columns, and re-creates every index — guarded by an
index-count assertion because an earlier version silently produced an orders
table with zero indexes. Postgres just does `ALTER TABLE ... DROP/ADD CONSTRAINT`.

`src/db/migrate.pg.js` (`npm run migrate:pg`) applies `schema.pg.sql` and
`schema.pg.trgm.sql`, then reconciles the status CHECK. Verified against a
deliberately stale database: it widened `orders_status_check`, left
`orders_zoho_sync_status_check` intact, accepted `ready_for_finance_verified`,
still rejected `waiting_for_payment` and a bogus `zoho_sync_status`, and was
idempotent on re-run. `migrate.js` stays working for SQLite copies.

### Phase 5: the tests — 420/420 passing

```
Test Suites: 24 passed, 24 total
Tests:       420 passed, 420 total
Time:        25.5 s
```

Against a real PostgreSQL 16 with `schema.pg.sql`. `tests/globalSetup.js` drops
and recreates a scratch database, runs `migrate.pg.js` and `seed.js`, and seeds
the fixture floor. It **refuses** to run against a URL that looks hosted or
whose database name does not contain "test" — under SQLite a mistake there cost
a local file, and it now costs the live database.

Running the suite found four real defects that everything else had missed.

#### 1. The order page's hang protection was silently deleted

The worst one, and invisible to every check except the test written for it.
`orders.controller.js` had:

```js
const reconcile = reconcileOrderFully({...});          // deliberately NOT awaited
const outcome   = await Promise.race([reconcile, timeout]);
```

The codemod added an `await` to the first line. That awaits the Zoho call
*before* the race, so the 150 ms timeout can never fire and a Zoho call that
never returns hangs the order page forever — precisely the production incident
that code was written after. `scripts/propagate-async.js` now detects a call
whose result is used as a promise (`.then`/`.catch`, or an element of
`Promise.race`/`all`/`allSettled`/`any`), leaves it alone, and reports it.

#### 2. Zoho auto-sync switched itself off

`zohoAutoSyncService` checks for its column with
`db.prepare('PRAGMA table_info(orders)').all()`, inside a `try/catch` that sets
`_hasColumn = false` on error. Postgres rejects the PRAGMA, the catch swallows
it, and `pickBatch()` returned `[]` forever. No crash, no failed request — the
entire reconcile feature just stopped. `pg.js` now translates PRAGMA sent
through `prepare()`, not only through `pragma()`.

#### 3. Every count came back as a string

`COUNT(*)` is bigint, and node-postgres returns bigint as a **string**: the
management dashboard would have served `total_orders: "8"`. `SUM(CASE WHEN ...)`
too, so every customer statistic. Arithmetic coerces, so it would have shipped
quietly. `pg.js` parses int8 as a number, restoring SQLite's behaviour.
(`SUM`/`AVG` over `DOUBLE PRECISION` already return numbers — a direct payoff
from schema.pg.sql choosing DOUBLE PRECISION over NUMERIC.)

#### 4. JULIANDAY, which portcheck had reported as clean

The management dashboard computes average processing time with
`AVG((JULIANDAY(a) - JULIANDAY(b)) * 24)`. Postgres has no `julianday()`.
`scripts/portcheck.js` searched lowercase only and reported zero problems.
It now runs every `db.prepare()` string through the real `translate()` and
reports what that cannot handle, so the check cannot drift from the data layer.
`sqlToPg.js` maps `JULIANDAY(x)` to `EXTRACT(EPOCH FROM x::timestamptz)/86400.0`
— a different absolute number, but the expression only takes differences, where
the offset cancels exactly.

### Three more codemod limits, now reported instead of produced

- **Top-level await.** Wrapping a module-scope call produces a CommonJS
  SyntaxError; one case became `(await main()).catch(...)`, which awaits the
  promise and then calls `.catch` on the resolved value.
- **`db` matched by name.** The migration suites do `const db = openDb()` — a
  raw better-sqlite3 handle whose `.run()` is synchronous. Awaiting those turned
  `expect(...).toThrow()` into an assertion that never fires while its rejection
  killed the jest process. The transform now resolves `db` to a require of
  `src/db/database`.
- **Export aliases.** `admin.controller.js` has
  `module.exports = { getAllUsers, getAll: getAllUsers }`. Registering only the
  first alias meant `adminController.getAllUsers(...)` was never awaited.

### What is NOT done

- **Nothing has run against a live Supabase project.** Everything above is a
  local PostgreSQL 16 with the same schema.
- **The signup rate limiter is still in-memory** — per-instance, so effectively
  no limit across serverless instances.
- **`.github/workflows/*.yml` must be added by hand** — the bridge refuses to
  write into that directory.

### Reviewing and reverting

The repo is git-tracked and pushed, so:

```
git diff --stat            # 24 files, +507 await/async
git diff src/services/auditService.js    # smallest, good place to start
git checkout -- src/       # revert everything if it looks wrong
```

---

## Supabase setup

1. **Create the project.** supabase.com → New project. No card. Save the
   database password — it is shown once.
2. **Apply the schema.** SQL Editor → paste `src/db/schema.pg.sql`, run. Then
   `src/db/schema.pg.trgm.sql`. Both are idempotent; re-running is safe.
3. **Connection string.** Project Settings → Database → Connection string.

   Supabase offers three, and picking the wrong one fails in a way that does
   not say so:

   | Use | Which | Host / port |
   |---|---|---|
   | `migrate:pg`, `pg_dump` | **Session pooler** | `aws-<region>.pooler.supabase.com:5432` |
   | Vercel (`DATABASE_URL`) | **Transaction pooler** | `aws-<region>.pooler.supabase.com:6543` |
   | — | Direct | `db.<ref>.supabase.co:5432` |

   - **The direct connection is IPv6-only** unless the project has the paid
     IPv4 add-on. On an IPv4 network it does not error usefully — it hangs and
     then times out. The **session pooler** is IPv4 on all tiers and behaves
     like a direct connection, so DDL works: that is what migrations should use.
   - **Transaction mode (6543) is for serverless only.** Each function instance
     opens its own connection, which is exactly what it is for, but it does not
     support every statement type — `migrate.pg.js` warns if it sees `:6543`.
   - The pooler username is `postgres.<project-ref>`, not plain `postgres`.
     Plain `postgres` is only correct on the direct connection.
   - URL-encode `@ # / :` if they appear in the password.
4. **Environment variables** (Vercel → Settings → Environment Variables):
   ```
   DATABASE_URL=postgresql://postgres.<ref>:<password>@<region>.pooler.supabase.com:6543/postgres
   JWT_SECRET=<a real random 32+ byte secret, NOT the dev default>
   ZOHO_WEBHOOK_SECRET=<real secret, also pasted into Zoho's X-Zoho-Webhook-Token>
   NODE_ENV=production
   PGPOOL_MAX=1
   ```
5. **Create the first real user** — this is what actually unblocks login. Do not
   run `npm run seed`; it creates six accounts with the password `demo123`,
   including admin. Insert one real account with a bcrypt hash instead, then use
   the app's own admin screens.
6. **Rebuild the Zoho cache.** Full Resync brings back the 94,985 customers and
   3,446 products. ~475 sequential Zoho reads — run it once from a laptop
   against the hosted database rather than inside a 300s function.

### Two Supabase-specific things to set up now, not later

- **Backups.** Supabase free has none. The ~120 genuinely local rows —
  `users`, `order_events`, `dispatch_records`, `notifications`, and the
  `intake_*` fields — are the only part Zoho cannot give back. A nightly
  `pg_dump` from a GitHub Action against the **session pooler** (5432) is
  enough — not the transaction pooler, and not the direct connection unless the
  runner has IPv6.
- **The 1-week pause.** A free project pauses after 7 days of inactivity and
  needs a manual restore. Daily MedRep use prevents it on its own; a daily cron
  covers the quiet weeks. Worth knowing that "paused" means down, not slow.

---

## Phase 4: serverless entry point and the scheduled jobs

Written and committed. `tests/cronLock.verify.js` — **9/9 passing** against real
PostgreSQL.

| file | what it does |
|---|---|
| `api/index.js` | Vercel handler. Wraps `src/app.js` in an outer app that awaits `db.init()` before the first request. |
| `vercel.json` | Catch-all rewrite to the handler, `sin1` region, 60s max duration, daily crons. |
| `server.js` | `await db.init()` **before** `app.listen()`; exits with an explanation if the database is unreachable. |
| `src/services/cronLock.js` | Database-backed lease, replacing the in-memory overlap guard. |
| `src/controllers/cron.controller.js` | `/api/cron/auto-sync`, `/api/cron/zoho-retry`, `/api/cron/health`. |
| `.github/workflows/*.yml` | 15-minute reconcile and nightly `pg_dump`. **Must be added by hand** — the bridge refuses to write into `.github/workflows/`. |

### Why the cron lock is not a boolean

`zohoAutoSyncService` guards overlapping runs with a module-level
`let running = false`. That was correct because there was one process. On
serverless every firing may be a different instance with its own fresh copy of
that variable, so the guard silently protects nothing and two reconciles can hit
Zoho's rate limit or double-write the audit trail.

Two decisions in `cronLock.js` that are not incidental:

- **It is a lease, not a flag.** A flag set by a function that then times out or
  is killed stays set forever and the job never runs again, with no error
  anywhere. A lease expires on its own. Tested: a 1ms lease is reclaimable.
- **Acquisition is one atomic statement** — an `INSERT ... ON CONFLICT DO UPDATE`
  whose `WHERE` only overwrites an expired lease. Read-then-write loses exactly
  the race it exists to prevent. Tested with ten simultaneous acquires: exactly
  one wins.

Also tested: the lock is released when the job *throws* (otherwise one failed
Zoho call blocks every subsequent run until the lease expires), and two
overlapping `withLock` calls never run the job concurrently.

### `init()` is memoised as a promise, not a boolean

In `api/index.js`. Memoising a boolean means N concurrent cold-start requests all
see `false` and all call `init()` — on a free-tier connection limit that turns a
cold start into a burst of connection failures. A *failed* init is deliberately
not cached either: if the first request arrives while a paused Supabase project
is waking, caching that rejection would poison the instance for its whole
lifetime.

### Hobby cron would have failed the deployment

An hourly `0 * * * *` is rejected at deploy time with "Hobby accounts are
limited to daily cron jobs". `vercel.json` therefore ships daily schedules,
which is honest but nearly useless for a reconcile loop.

The free workaround is `.github/workflows/getmeds-cron.yml`: GitHub Actions on a
15-minute schedule hitting the same endpoints. Not the original 5 minutes, and
GitHub delays scheduled runs under load — but 96x better than daily, at no cost.
The endpoints are safe to call concurrently because of the lease above.

For Pro, change `vercel.json` to `*/5 * * * *` and delete the workflow.

### Backups

`.github/workflows/getmeds-backup.yml` runs a nightly `pg_dump` against the
**direct** (5432) connection and keeps 30 days of artifacts. It asserts that
`users`, `order_events`, `dispatch_records` and `orders` actually appear in the
dump's table of contents and that `users` is non-empty — a backup job that
silently produces an empty file is worse than none, because it looks green.

---

## What is still not solved by any of this

Unchanged from the Sep 1 assessment, restated so it stays a choice:

1. **Vercel Hobby cron runs once per day.** Auto-sync effectively dies at that
   cadence. Webhooks still work; refresh-on-open still works (it is DB-backed,
   so it survives serverless). But with **four of the seven Zoho Workflow Rules
   still missing** — Package Created, Shipment Created, Invoice Sent, Invoice
   Paid — steps 5–7 have no live trigger, and orders can sit until someone
   opens them.
2. **Vercel Hobby is non-commercial** per their fair-use terms. This is company
   software.
3. **In-memory state**: the auto-sync overlap guard is now handled by
   `cronLock.js`. Still outstanding: the signup rate limiter (per-instance, so
   effectively no limit across instances) and the salesperson cache (harmless —
   just a cache miss).
4. **The 420 tests are still unported and unrun.** This is now the single
   largest piece of unverified work: the port parses and the data layer has 27
   passing assertions, but nothing has confirmed the order pipeline still
   behaves. Blocked earlier only because the machine went offline mid-transfer.

And the alternative that stays open: `render.yaml` is already in the repo. $7/mo,
zero code changes, deploys the app exactly as tested. This entire migration
exists to work around the absence of a payment method — not because the
architecture calls for it.
