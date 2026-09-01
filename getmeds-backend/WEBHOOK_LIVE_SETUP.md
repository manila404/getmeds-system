# Wiring the Zoho Webhook Live

The receiver is built and tested (`src/routes/webhook.routes.js`, `src/controllers/webhook.controller.js`,
`tests/webhook.test.js` — 10/10 suites passing). Right now it only works if something POSTs to it manually.
This is the last mile: get Zoho itself to call it.

Do the steps in order — each one de-risks the next.

## 0. What's already done for you

- `ZOHO_WEBHOOK_SECRET` has been generated and added to `.env`. Zoho will send this back as a header on every
  webhook call so you can reject anything that isn't really Zoho.
- `.env.example` now documents the variable for anyone setting up the project fresh.
- `scripts/simulate-zoho-webhook.js` fires the exact payload shapes the controller expects — use it to prove
  the receiver works before touching ngrok or Zoho's UI at all.

## 0.5. Finance verification now happens IN ZOHO, not in this app (2026-08-26)

The Finance Queue page used to have its own "Verify Payment" button that wrote status locally and then
**pushed** that status out to Zoho. That's backwards from how the company actually works: Finance's real
actions all happen inside Zoho itself, and this app is supposed to just reflect that. The flow is now:

1. MedRep submits an order here → it syncs to Zoho as a Sales Order.
2. Finance confirms the Sales Order in Zoho → this app receives the confirmation via the webhook built in
   §3a below and moves the order to `waiting_for_payment`.
3. Finance clicks **Convert to Invoice** in Zoho, prefilling it from the Sales Order → this app needs a new
   webhook rule (**§3b-i** below) to hear about that and move the order to a new status, `invoice_drafted`.
   This is a visibility checkpoint only — nothing to action here, it just means "Zoho has an Invoice now."
4. Finance records the **Customer Payment** against that Invoice in Zoho → the existing Invoice
   Paid/Payment Received rules (§3b table) fire, and the order advances to `ready_for_dispatch`.

What changed in code to support this:

- `finance.controller.js` / `finance.routes.js` — the `verify-payment` and `sync-payment` endpoints (and the
  Finance Queue page's verify form / "Force Zoho Sync" button) are gone. `GET /api/finance/queue` and
  `GET /api/finance/orders/:id/payment` are now **read-only** — they just show what the webhooks already
  wrote. Finance staff act in Zoho, not in this app.
- `webhook.controller.js` — new `isInvoiceDrafted` event category, checked after `isPaymentEvent` so a
  paid invoice never gets mistaken for a merely-drafted one. Stores `zoho_invoice_id` / `zoho_invoice_number`
  on the order.
- `stateMachine.js` / `schema.sql` — new `invoice_drafted` status between `waiting_for_payment` and
  `ready_for_dispatch`. `database.js` auto-migrates an existing dev database's `orders` table (SQLite can't
  `ALTER` a `CHECK` constraint in place, so it does the standard rebuild-and-copy) — no manual DB step needed,
  it runs the next time the backend starts.
- Frontend — Finance Queue (now labeled **"Zoho Finance Status"** in the sidebar) and Payment History are
  both read-only views with an `invoice_drafted` badge/status added throughout.

## 0.6. Dispatch status now also comes FROM ZOHO, not this app (2026-08-26)

Same architectural fix as §0.5, applied to Dispatch. The Dispatch Queue page used to have "Start Picking" /
"Mark Packing" / "Dispatch" buttons and an "Enter Tracking" form that wrote status locally and then **pushed**
it out to Zoho (`packSalesOrder`, `shipSalesOrder`). That's backwards for the same reason the old Finance
verify button was — picking, packing and shipping are things Pharmacy/Dispatch actually do **in Zoho
Inventory**, not in this app. The flow is now:

1. Order reaches `ready_for_dispatch` (Zoho payment confirmed — see §0.5).
2. Pharmacy picks & packs the order and creates a **Package** in Zoho Inventory → this app hears about it via
   a new webhook rule (**§3b-ii** below) and moves the order to `picking_packing`. Visibility checkpoint only,
   same pattern as `invoice_drafted`.
3. Pharmacy hands the package to a courier and creates a **Shipment** in Zoho Inventory (courier + tracking
   number) → this app hears about it via another new webhook rule and moves the order to `dispatched`. Since
   Zoho's "Create Shipment" step normally captures the tracking number in the same action, the order
   auto-advances all the way through `tracking_shared` to `completed` right there — the same one-step cascade
   the old local "Enter Tracking" button used to do, just triggered by Zoho instead of a local form.

What changed in code to support this:

- `dispatch.controller.js` / `dispatch.routes.js` — `updateStatus` and `enterTracking` (and their POST
  routes) are gone. `GET /api/dispatch/queue` is now the **only** dispatch endpoint, and it's read-only.
- `webhook.controller.js` — the old combined `isDispatchEvent` category (which conflated "package" and
  "shipment" into one outcome) is split into two: `isPackageEvent` → `ZOHO_PACKAGE_CREATED` (→
  `picking_packing`) and `isShipmentEvent` → `ZOHO_DISPATCHED` (→ `dispatched`, cascading to `completed` once
  tracking is present). `shipment` and `package` are now parsed as two separate objects from the webhook
  payload instead of one merged blob.
- `orders.controller.js`'s `syncFromZoho` (the manual "Sync from Zoho" fallback button — see §4) now also
  reconciles dispatch state: it reads the Sales Order's `packages[]` array straight from Zoho's API (each
  entry can carry a nested `shipment_order` with tracking info once shipped) and idempotently backfills
  `ZOHO_PACKAGE_CREATED` / `ZOHO_DISPATCHED` the same way it already did for SO confirm/cancel.
- No new DB schema/status was needed — `picking_packing` / `dispatched` / `tracking_shared` / `completed`
  already existed; `dispatch_records.status` already allowed `'packing'` / `'dispatched'`.
- Frontend — Dispatch Queue (now labeled **"Zoho Dispatch Status"** in the sidebar) is a read-only view like
  Finance Queue: no buttons, no tracking modal, no Test Mode "Auto-Generate Tracking." The order detail page's
  Dispatch tab dropped the (always-null, since Zoho drives this now) "Dispatched By" field and added a note
  pointing at Zoho Inventory. Also cleaned up in this pass: a dead "Force Zoho Payment Sync" button on the
  order detail page's Payment tab that called the `sync-payment` route removed in §0.5 — it would have 404'd
  on click; the corresponding logic was already fully removed everywhere else in §0.5, this was a leftover.

## 1. Prove the receiver works locally (2 min, no ngrok needed)

```powershell
cd getmeds-backend
npm run dev
```

In a second terminal, create any order in the app (any status, not completed/cancelled), then:

```powershell
npm run simulate:webhook -- GM-20260826-0001 all
```

You should see three `200 ✓` responses and the order's status should visibly move forward
(`waiting_for_payment`/`ready_for_dispatch` → `ready_for_dispatch` → `dispatched`) — check the order detail
page or the audit trail. If this doesn't work, nothing past this point will either — fix it here first.

Run a single scenario with `npm run simulate:webhook -- GM-20260826-0001 payment` (or `confirmed` / `package`
/ `shipment` / `cancelled`).

## 2. Expose your local server (5 min)

```powershell
npx ngrok http 4000
```

Copy the `https://...ngrok-free.app` URL it prints. Leave this terminal running — closing it kills the
tunnel and Zoho's calls will start failing.

## 3. Register the webhook in Zoho (15–20 min)

Zoho doesn't have one global "list of events" screen — a webhook is an **action** you attach to a
**Workflow Rule**, and each rule watches one module (Sales Orders, Invoices, Packages, etc.) for a specific
change. That means we need one rule per event category the controller handles.

**Two apps, not one.** Zoho Inventory and Zoho Books share the same organization's data, but each app keeps
its *own* Settings → Automation → Workflow Rules screen, with its own module list:

- **Zoho Inventory** (`inventory.zoho.com`) owns **Sales Orders** and **Packages/Shipments**. If you're in
  Zoho Books, "Sales Orders" will never appear in the Module dropdown, no matter where you look in Books —
  it isn't a Books module when Inventory is enabled on the org. Switch apps via the app-switcher (grid icon,
  top-left) or the direct URL.
- **Zoho Books** owns **Invoices** and **Customer Payments**.

A webhook action you create is scoped to the app you created it in — it does **not** carry over from
Inventory to Books or back. So you'll create the `Getmeds Order Receiver` webhook definition **twice**: once
the first time you build a rule in Inventory, once the first time you build a rule in Books. Within the same
app, every later rule reuses it via the Name dropdown.

**Which org to point this at:** your Zoho Developer Sandbox, not the company's live org — same rule as
everywhere else in this build. Switch orgs (top-right account icon) before starting, and confirm `ZOHO_ORG_ID`
in `.env` matches it. Switching orgs and switching apps (Inventory vs Books) are two different controls —
double check both.

### 3a. Verified recipe — `Getmeds — SO Confirmed` (Zoho Inventory)

This exact sequence was built, broken, and fixed live against the sandbox — every step below reflects what
Zoho's UI *actually* does, not what its labels imply. Follow it precisely; the gotchas are called out because
each one silently produced a "successful" 200 response that did nothing.

1. `inventory.zoho.com` → **Settings → Automation → Workflow Rules** → **+ New Workflow Rule**.
2. Name: `Getmeds — SO Confirmed`, Module: **Sales Order** (singular — that's how it's labeled) → **Next**.
3. Workflow Type: **Event Based**. Action Type: **Edited** — there is no dedicated "Confirmed" action type,
   the full list is Created / Edited / Created or Edited / Deleted / Submitted / Approved / Rejected /
   Approved and Forwarded. Confirming a Sales Order counts as an edit.
4. **Execute the workflow when**: leave on **"Any field is updated."** There's a "selected fields" variant
   that lets you scope to one field, but **Status isn't in that field-picker's list** even though it *is*
   available in criteria (next step) — don't waste time hunting for it there.
5. **Execute when the record is**: **Edited each time** — NOT "Edited for the first time." That option only
   fires once per record, ever, on whatever edit happens first; if anything touches the record before it's
   confirmed, the one-time trigger is burned and it will never fire on the actual confirmation.
6. **Next** → Criteria: field **Status**, condition **is**, value — ⚠️ **`Open`, not `Confirmed`.** The blue
   "CONFIRMED" badge on a Sales Order's detail page is a *display label*; Zoho's actual stored status value
   for that state is `Open` (visible in the criteria value picklist: Draft, Pending Approval, Approved,
   **Open**, Invoiced, Partially Invoiced, Void, ...). Typing "Confirmed" here returns no results.
7. Under **Actions**, click **+ Immediate Actions** (not Time Based). Type: **Webhooks**. Name → **+ New
   Webhook** (first time only — every later rule in this same app reuses it via this dropdown):
   - **Name**: `Getmeds Order Receiver`
   - **URL**: `https://<your-current-ngrok-id>.ngrok-free.app/api/webhooks/zoho` — the full path.
     ⚠️ Easy to paste just the bare domain here and get a 404 on every call; double-check it every time you
     restart ngrok, since free-tier ngrok hands out a new random domain on every restart.
   - **Headers**: `X-Zoho-Webhook-Token` = *(the `ZOHO_WEBHOOK_SECRET` value from `.env`)*
   - **Body**: select **x-www-form-urlencoded**, not "Default Payload." ⚠️ The Body radio buttons' JSON
     preview is misleading — Workflow Rule webhook actions send flat form fields regardless of what you pick
     here, so build for that reality directly rather than fighting it. Add these parameters (Key → Value):
     | Key | Value |
     |---|---|
     | `event_type` | typed literally: `salesorder.confirmed` (no placeholder — this rule only ever fires for one event, so just say so directly rather than trying to infer it from field values) |
     | `reference_number` | Insert Placeholder → **Ref#** (this is what carries your `GM-YYYYMMDD-XXXX` order id through to the receiver — the single most important field) |
     | `salesorder_id` | Insert Placeholder → **Salesorder ID** |
     | `salesorder_number` | Insert Placeholder → **Sales Order#** |

     Use the **Insert Placeholder** control after clicking into each Value box — typing a guessed token name
     (`${JSONString}`, `${SALESORDER.SALESORDER_ID}`, etc.) does not work; only tokens actually inserted
     through that picker resolve to real values.
8. **Save** → **Associate**.
9. ⚠️ **This step silently failed the first time through** — after Associate, the rule can appear to be done
   while nothing was actually persisted. Go back to **Settings → Automation → Workflow Rules** and confirm
   `Getmeds — SO Confirmed` is actually listed there with **Status: Active**. If the list says "There are no
   workflows," nothing saved — redo from step 1. Don't trust the builder UI alone; trust this list.

### 3b. Repeat for the other six event categories

Same recipe, new rule each time — Action Type **Edited** (or **Created** for the rules noted below),
**Edited each time**, criteria on the real status value (check the picklist, don't assume the display label),
`event_type` hardcoded per rule, `reference_number` always included as the identifier field:

| Rule name | App | Module | Trigger / Criteria | `event_type` to hardcode |
|---|---|---|---|---|
| `Getmeds — SO Confirmed` | **Inventory** | Sales Order | Edited each time; Status is `Open` | `salesorder.confirmed` ✅ verified live |
| `Getmeds — SO Cancelled` | **Inventory** | Sales Order | Edited each time; Status is `Void` (check picklist — may also be `Cancelled`) | `salesorder.cancelled` |
| `Getmeds — SO Deleted` | **Inventory** | Sales Order | Action Type **Deleted** (no status criteria) | `salesorder.deleted` — see §3b-iv |
| `Getmeds — Package Created` | **Inventory** | Package | **Created** (picking & packing done) | `package.created` — see §3b-ii |
| `Getmeds — Shipment Created` | **Inventory** | Shipment | **Created** (courier + tracking assigned) | `shipment.created` — see §3b-ii |
| `Getmeds — Invoice Drafted` | **Books** | Invoice | **Created** (fires the moment Finance clicks Convert to Invoice) | `invoice.created` — see §3b-i |
| `Getmeds — Invoice Sent` | **Books** | Invoice | Edited each time; Status is `Sent` | `invoice.sent` — see §3b-iii |
| `Getmeds — Invoice Paid` | **Books** | Invoice | Edited each time; Status is `Paid` | `invoice.paid` |
| `Getmeds — Payment Received` | **Books** | Customer Payment | on record creation (no status criteria needed) | `payment.created` |

The four Inventory rules reuse the `Getmeds Order Receiver` webhook built in 3a. The three Books rules need
their **own** `+ New Webhook` the first time — Books and Inventory keep separate automation config even
though they share the org's data — same name, same URL, same header, same body parameters; after that first
one, later Books rules reuse it too.

For Invoice/Customer Payment placeholders, the exact field names will differ from Sales Order's (check each
module's own **Insert Placeholder** list) — look for whatever field carries the reference number back to
`GM-YYYYMMDD-XXXX` (an Invoice's own Reference# field, or its linked Sales Order's reference, depending on
what's available), since that's what `findOrder()` in the controller ultimately matches on.

### 3b-i. `Getmeds — Invoice Drafted` in detail

This is the rule that makes §0.5's new step 3 real — it's what tells this app "Finance just converted the
Sales Order to an Invoice in Zoho," before any payment exists. Build it the same way as §3a, with these
specifics:

1. **Zoho Books** (not Inventory) → Settings → Automation → Workflow Rules → **+ New Workflow Rule**.
2. Name: `Getmeds — Invoice Drafted`, Module: **Invoice** → **Next**.
3. Action Type: **Created** — this is the one rule in the set that should fire on creation, not on edit,
   since "an Invoice now exists" is exactly what creation means here. No status criteria needed — every new
   Invoice counts, whatever its initial status (Draft/Sent).
4. **+ Immediate Actions** → Webhooks → Name → if this is the first Books rule you're building, **+ New
   Webhook** with the same Name/URL/Header as §3a; otherwise reuse it. **Body**: x-www-form-urlencoded, same
   as §3a, with:

   | Key | Value |
   |---|---|
   | `event_type` | typed literally: `invoice.created` |
   | `reference_number` | Insert Placeholder → whichever Invoice field carries the SO's Ref#/GM order id (check the Invoice module's own placeholder list — it may be under Reference# or a Sales Order-linked field) |
   | `salesorder_id` | Insert Placeholder → the Invoice's linked Sales Order ID field, if the placeholder list has one — this is what lets `zohoSoId` in the controller match the order even before `reference_number` resolves |
   | `invoice_id` | Insert Placeholder → Invoice ID |
   | `invoice_number` | Insert Placeholder → Invoice# |

5. Save → Associate → then **go back to the Workflow Rules list and confirm it shows Active** — same
   mandatory check as §3a step 9, it can silently fail to persist.
6. Test it by confirming a Sales Order (§3a's flow) and then clicking **Convert to Invoice** on it in Zoho
   Books. Check the ngrok inspector for the new request, and confirm the order's status becomes
   `invoice_drafted` in the app (Order Detail page / Zoho Finance Status page).

### 3b-iv. `Getmeds — SO Deleted` in detail (added Sep 1, 2026)

Deleting a Sales Order and voiding one are **not the same event** and no longer produce the same result
here. Voiding leaves the Zoho record in place with a changed status; deleting removes it entirely, and
there is no way back short of recreating it. Since Sep 1, 2026 a deletion puts the order at its own
`deleted` status, so the badge and every status filter tell the two apart — previously both read
`cancelled` and only the audit trail knew the difference.

1. **Zoho Inventory** → Settings → Automation → Workflow Rules → **+ New Workflow Rule**.
2. Name: `Getmeds — SO Deleted`, Module: **Sales Order** → **Next**.
3. Action Type: **Deleted**. No status criteria — a deletion is a deletion.
4. **+ Immediate Actions** → Webhooks → reuse `Getmeds Order Receiver`. **Body**: x-www-form-urlencoded:

   | Key | Value |
   |---|---|
   | `event_type` | typed literally: `salesorder.deleted` |
   | `salesorder_id` | Insert Placeholder → Sales Order ID |
   | `reference_number` | Insert Placeholder → Reference# (the GM/TestGM order id) |

5. Save → Associate → **confirm it shows Active**.

> **Send both identifiers if the placeholder list allows it.** This is the one rule where the record is
> gone by the time you might go looking for it, so if the webhook arrives without an identifier the app
> can match, there is nothing to reconcile against later — `Sync from Zoho` can still detect it (the API
> fetch fails with "does not exist" and the same `deleted` status is backfilled), but only for an order
> you already know to go and check.

**An order that had already completed is not reopened.** If the Sales Order is deleted long after the
order shipped and was paid, the status stays `completed` and the deletion is recorded on the timeline
with wording that says so. Removing the Zoho record does not un-ship or un-pay a real order.

### 3b-iii. `Getmeds — Invoice Sent` in detail (added Sep 1, 2026)

This is the rule behind the `invoice_sent` order status — "Finance has actually issued this invoice to
the customer," as distinct from "an invoice exists as a draft." Until Sep 1, 2026 the app had no way to
tell those apart: an invoice whose status was `Sent` was matched by the same check as a draft one, so
marking it as Sent produced a second, duplicate *"Invoice drafted in Zoho"* entry and no status change.
Both the code branch and this rule were added together; **building this rule against an older build of
the app will reproduce that duplicate entry**, so make sure the backend is on the Sep 1 changes first.

1. **Zoho Books** → Settings → Automation → Workflow Rules → **+ New Workflow Rule**.
2. Name: `Getmeds — Invoice Sent`, Module: **Invoice** → **Next**.
3. Action Type: **Edited each time**, with criteria **Status is `Sent`**. Check the picklist for the real
   stored value rather than assuming the display label, same caution as every other rule here.
4. **+ Immediate Actions** → Webhooks → reuse the Books webhook built in §3b-i. **Body**:
   x-www-form-urlencoded, with:

   | Key | Value |
   |---|---|
   | `event_type` | typed literally: `invoice.sent` |
   | `salesorder_id` | Insert Placeholder → the Invoice's linked Sales Order ID |
   | `reference_number` | Insert Placeholder → whichever Invoice field carries the SO's Ref#/GM order id |
   | `invoice_id` | Insert Placeholder → Invoice ID |
   | `invoice_number` | Insert Placeholder → Invoice# |

5. Save → Associate → **confirm it shows Active in the rules list**.
6. Test: convert a Sales Order to an Invoice, then click **Mark as Sent**. The order should move
   `invoice_drafted` → `invoice_sent` and the timeline should show one `ZOHO_INVOICE_SENT` entry — *not*
   a second "Invoice drafted".

> The app also accepts `invoice_sent`, `invoice.mark_sent` and `invoice.marked_sent` as the event type, and
> falls back to reading the invoice's own `status` field if the event type is missing entirely. Prefer the
> literal `invoice.sent` — the event type always wins over the status field, so an `invoice.created` webhook
> for an auto-sent invoice is still correctly recorded as the creation.

### 3b-ii. `Getmeds — Package Created` / `Getmeds — Shipment Created` in detail

These two make §0.6's dispatch flow real. Neither has been built/verified against the live Workflow Rules UI
yet (same status as `SO Cancelled` / `Invoice Paid` / `Payment Received` above — only `SO Confirmed` and
`Invoice Drafted` are ✅ verified live) — the field names below come from reading a real confirmed → shipped
Sales Order's JSON via the Zoho Inventory API directly (`GET /salesorders/{id}`), not from the Workflow Rule
builder's placeholder picker, so double-check each Insert Placeholder list matches once you're in there.

**What the API data actually looks like** (useful context before building these): a Sales Order's `packages`
array holds one entry per package, each with its own `status` (`draft` → ... → `shipped`), `package_id`,
`package_number`, and — once a shipment exists for it — `shipment_id`, `carrier`, `tracking_number` (or a
nested `shipment_order` object with the same fields plus `tracking_url`, `shipment_date`, etc.). In other
words, Zoho does **not** appear to model "Shipment" as an independent module the way "Package" is one — a
package's own `status` field turning to `Shipped` is likely what "a shipment was created" looks like from the
Workflow Rules side. Confirm this against the Module dropdown before building rule 2 below; if Zoho *does*
offer a standalone "Shipment" module, prefer that instead (Action Type **Created**) and skip the status
criteria.

1. **`Getmeds — Package Created`** — `inventory.zoho.com` → Settings → Automation → Workflow Rules →
   **+ New Workflow Rule**. Name: `Getmeds — Package Created`, Module: **Package** → **Next**. Action Type:
   **Created** — no status criteria needed, every new package counts. **+ Immediate Actions** → Webhooks →
   reuse `Getmeds Order Receiver` (built in §3a) → **Body**: x-www-form-urlencoded, same as §3a, with:

   | Key | Value |
   |---|---|
   | `event_type` | typed literally: `package.created` |
   | `reference_number` | Insert Placeholder → whichever Package field carries the SO's Ref#/GM order id (check the Package module's own placeholder list — it may only expose the linked Sales Order's fields) |
   | `salesorder_id` | Insert Placeholder → the Package's linked Sales Order ID field |
   | `package_id` | Insert Placeholder → Package ID |
   | `package_number` | Insert Placeholder → Package# |

2. **`Getmeds — Shipment Created`** — Name: `Getmeds — Shipment Created`, Module: **Package** (per the note
   above — use the standalone **Shipment** module instead if the dropdown actually offers one, with Action
   Type **Created** and no criteria needed in that case). If using Package: Action Type **Edited**, **Edited
   each time**, Criteria: field **Status**, condition **is**, value `Shipped` (check the picklist — the exact
   label may differ). **Body**:

   | Key | Value |
   |---|---|
   | `event_type` | typed literally: `shipment.created` |
   | `reference_number` | Insert Placeholder → same field as rule 1 |
   | `salesorder_id` | Insert Placeholder → same field as rule 1 |
   | `shipment_id` | Insert Placeholder → Shipment ID, if the placeholder list has one under this module |
   | `tracking_number` | Insert Placeholder → Tracking Number |
   | `carrier` | Insert Placeholder → Carrier (also called Delivery Method in some Zoho screens) |

   If the Package module's placeholder list doesn't expose shipment-nested fields (`shipment_id`,
   `tracking_number`, `carrier`) directly, that's a sign the standalone **Shipment** module route (if
   available) is the one to use instead — it should expose these as first-class fields.

3. Save → Associate → **go back to the Workflow Rules list and confirm both show Active** — same mandatory
   check as §3a step 9.
4. Test by creating a Package (should move the order to `picking_packing`) then a Shipment with tracking
   (should move it to `dispatched` and, moments later in the same request, all the way to `completed`). Check
   the ngrok inspector for both requests and the order's Audit Timeline / Zoho Dispatch Status page in the app.
5. If live testing shows the field names above don't match what Zoho actually sends (very possible — these
   are inferred from the read API, not confirmed against the Workflow Rule webhook body), the fallback is the
   same one used everywhere else in this doc: open the ngrok inspector (§4), see what Zoho actually sent, and
   adjust `parseWebhookPayload()` in `webhook.controller.js` to match — it already accepts several shapes per
   field (see `zohoPackage` / `shipment` extraction) precisely because Zoho's actual wire format tends to
   differ from what the UI implies.

### 3c. Alternative: Raw JSON body (untested — use for *new* webhooks, not the working one)

Zoho's webhook editor also offers **Body → Raw → JSON**, with a real code editor for a JSON payload (its own
**Insert Placeholder** control, top-right of that editor) — different from the "Default Payload" JSON *radio
button* that turned out to actually send x-www-form-urlencoded (see 3a's gotcha). This Raw/JSON mode may
genuinely send `Content-Type: application/json` with a real JSON body — it hasn't been tested against the
ngrok inspector yet, so treat it as unverified until you do.

⚠️ **Don't switch the already-working `Getmeds Order Receiver` webhook to this.** It's shared by every rule
that reuses it (currently the live SO Confirmed rule), so an untested change here risks breaking the one thing
that's proven. If you want to try it, build it as a **separate webhook** (e.g. `Getmeds Order Receiver — JSON`)
scoped to one test rule first, and confirm it in the ngrok inspector before pointing any real rule at it.

If you do try it, type this into the JSON Payload editor (with empty `""` pairs as placeholder targets):

```json
{
  "event_type": "salesorder.confirmed",
  "salesorder": {
    "salesorder_id": "",
    "salesorder_number": "",
    "reference_number": "",
    "status": "Open"
  }
}
```

Then, for each empty pair, click the cursor **between the two quotes** and use **Insert Placeholder** (not
typed text — same rule as everywhere else in this doc) to fill it in:

| Field | Insert Placeholder → |
|---|---|
| `salesorder_id` | Salesorder ID |
| `salesorder_number` | Sales Order# |
| `reference_number` | Ref# |

`status` stays hardcoded as `"Open"` — the rule's own criteria already guarantees it's only ever `Open` when
this fires, so there's no need to place a token there. `event_type` also stays a typed literal, same as 3a.

Once Zoho resolves the placeholders, the wire body should look like:

```json
{
  "event_type": "salesorder.confirmed",
  "salesorder": {
    "salesorder_id": "1918392000000123456",
    "salesorder_number": "SO-00046",
    "reference_number": "GM-20260826-0001",
    "status": "Open"
  }
}
```

The backend already accepts this shape without any code changes — `parseWebhookPayload()` in
`webhook.controller.js` reads a nested `body.salesorder` object as its first choice, falling back to the flat
x-www-form-urlencoded shape only if that's absent. So this is a pure "which is nicer to maintain" decision,
not a functional requirement — the flat form-encoded version from 3a already works end-to-end.

## 4. Trigger a real event and confirm it lands

In Zoho's sandbox, manually confirm a test sales order (or record a test payment). Watch the backend
terminal — you should see the request hit `/api/webhooks/zoho` and the corresponding order update in the app
within a few seconds.

**Best debugging tool for this step:** while `ngrok http 4000` is running, open **http://127.0.0.1:4040** in
a browser. That's ngrok's own inspector — every request it forwards shows up there with the exact headers and
JSON body Zoho actually sent. This is the fastest way to see the real payload shape and confirm whether it
matches what `webhook.controller.js` expects, without adding a single `console.log`.

If nothing arrives:

- Nothing shows up in the ngrok inspector at all → Zoho-side config issue (wrong URL, rule criteria never
  matched, or the rule/webhook wasn't actually associated — go back and confirm step 3a's last click).
- Request shows up in the inspector but the backend logs a `401` → the header name Zoho sent doesn't match
  one of `X-Zoho-Webhook-Token` / `X-Zoho-Secret` / `X-Webhook-Token` / `Authorization: Bearer ...` / `?token=`;
  the inspector will show you the exact header name Zoho used — add it to `verifyWebhookAuth` in
  `webhook.controller.js`, or simplest fix, add `?token=<secret>` directly to the webhook URL instead of using
  a header.
- Request arrives with `200` but the order doesn't move → check the response body in the inspector; a
  `"processed": false` means the identifier in the payload didn't match any local order — compare the field
  names in the inspector against `findOrder()` / `parseWebhookPayload()` in the controller.

**If the confirmation already happened in Zoho and got missed** (backend or ngrok wasn't running at that exact
moment — this is the single most common gap during dev, since both have to be running *at the same instant*
Finance clicks Confirm) — Zoho does not retry a failed/unreachable webhook, so the order's Audit Timeline will
just stop at "ORDER SUBMITTED" even though Zoho itself shows Confirmed. Rather than needing to re-trigger
anything in Zoho, there's a **"Sync from Zoho"** button next to the Zoho Integration pills on the order detail
page (`POST /api/orders/:id/sync-from-zoho`) — it asks Zoho directly for that order's current Sales Order
status (including its `packages[]`/shipment data) and backfills the same audit trail entries + notifications
the webhooks would have written — SO confirm/cancel, Package Created, and Shipment Created/tracking are all
covered — timestamped to when you clicked it (Zoho's API only reports current state, not history, so that's
the closest available timestamp). Safe to click repeatedly — each checkpoint only ever gets logged once.

## 5. Before this touches the company's live Zoho org

- ngrok's free-tier URL changes every restart — fine for testing, not for anything real. A real deployment
  needs a stable URL (a small always-on host, or ngrok's paid static domain).
- Re-check `ZOHO_ALLOWED_ORG_IDS` — it should list the sandbox org only until the company has explicitly
  signed off on pointing this at production (see the Master Development Plan's Zoho Account Strategy).
