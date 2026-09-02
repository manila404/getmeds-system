# Create New Order → Zoho Sales Order field mapping

Written Aug 30, 2026, alongside the "Create New Order" form redesign. This is a
reference for whoever wires up the real Zoho push later — **nothing on this
page has been implemented**. Today, `orders.controller.js`'s `zohoPayload`
(in both `create()` and `submit()`) still only ever sends
`customer/items/address/total` to `zoho.createSalesOrder()`, exactly as
before. Every new field the order form now collects is captured and stored
locally (`orders` / `order_items` tables — see `schema.sql`) and is sitting
there, correctly shaped, ready to be added to that payload when this work is
picked up.

Zoho's actual `Sales Order` create fields referenced below are Zoho
Inventory's own API shape (`POST /inventory/v1/salesorders`).

| Order form field | Local column | Zoho Sales Order field | Notes |
|---|---|---|---|
| Customer Name | `orders.customer_id` → `customers.zoho_contact_id` | `customer_id` | **Already wired.** Customer Name is populated from Zoho today (`customers.controller.js` `syncFromZoho` / the Clients Directory "Pull from Zoho" action), and `LiveZohoAdapter.createSalesOrder` already requires `zoho_customer_id`. Nothing to do here. |
| Sales Order Date | `orders.sales_order_date` | `date` | 1:1, not wired. Always server-set to "today" (`orders.controller.js`), matching "Automatic Today" — never take this from the client. |
| Delivery Method | `orders.intake_delivery_method` | `delivery_method` | 1:1, free text on both sides. Not wired — just add `delivery_method: order.intake_delivery_method` to the payload. |
| Sales Person | `orders.medrep_id` → `users.salesperson` (generated: `"<division> | <display name>"`) | `salesperson_name` | **Already wired** (Sep 2, 2026). Resolved by name, not by id — this org's Salespersons are already named in exactly that shape (e.g. `TEST | MEDREP`), so no `users.zoho_salesperson_id` column was needed after all. Sign-up collects First/Middle/Last, a Display name, and a Division + optional Sub-division (`auth.controller.js` `register`); `users.salesperson` is a GENERATED column deriving `"<division> | <display name>"` from the last two, so it can never drift. `orders.controller.js` sends `salesperson_name` from the ORDER's MedRep (not whoever submits it) in both `create()` and `submit()`, `zohoPayloadBuilder.js` does the same for retries, and `LiveZohoAdapter.createSalesOrder` puts it on `body.salesperson_name`. Zoho matches by name and does NOT create a missing one — it rejects the Sales Order — so the read-only `listSalespersons()` + `services/salespersonService.js` check the name first and the New Order page warns before anything is filled in. Fallback: a `TestGM-` order from an account with no mapping still gets the old `TEST | MEDREP` stand-in; a real order with none still sends nothing and is still rejected, which is deliberate — better a loud failure than attributing an order to the wrong rep. |
| Doctor Name | `orders.intake_doctor` | `custom_fields[]` (`customfield_id 2254168001890600053`, field `cf_doctor_name`) | **Already wired** (Aug 30, 2026). This org already had a `cf_doctor_name` custom field configured on Sales Orders — confirmed via a live `get_sales_order` call — so no new Zoho setup was needed. `orders.controller.js` now sends `doctor_name` in `zohoPayload` (both `create()` and `submit()`), and `LiveZohoAdapter.createSalesOrder` maps it into `body.custom_fields`. |
| Remarks | `orders.delivery_notes` | `notes` | Zoho's `notes` field is already used for `Getmeds Order: <id>` (and, for a `TestGM-` order, a `TEST — DO NOT FULFILL` prefix — see `LiveZohoAdapter.createSalesOrder`). Appending Remarks means concatenating, not overwriting, e.g. `` `${existingNotes}\nRemarks: ${order.delivery_notes}` ``. |
| Source | `orders.intake_source` | `custom_fields[]` (`customfield_id 2254168001929089177`, field `cf_source`) | **Already wired** (Aug 30, 2026). Same discovery as Doctor Name — this org already had `cf_source` configured, with dropdown options matching the app's own Source list 1:1. Wired the same way: `orders.controller.js` sends `order_source`, `LiveZohoAdapter.createSalesOrder` maps it into `body.custom_fields`. |
| Invoicing From | `orders.invoicing_from` | `custom_fields[]` (`customfield_id 2254168001900812580`, field `cf_invoicing_from`) | **Already wired** (Aug 30, 2026). Corrects the original assumption below — checked live via `ZohoInventory_get_sales_order` and confirmed this org already has a `cf_invoicing_from` dropdown custom field configured, with options `2mg Incorporated` / `Getmeds Philippines Inc.` matching this app's own dropdown 1:1. **It is not two separate Zoho organizations** — everything still writes to the single `714292728` org via the one `LiveZohoAdapter` singleton; "Invoicing From" is just recorded on the Sales Order like Doctor Name/Source. `orders.controller.js` now sends `invoicing_from` in `zohoPayload` (both `create()` and `submit()`), and `LiveZohoAdapter.createSalesOrder` maps it into `body.custom_fields`. |
| Item Details (name/SKU) | `order_items.product_id` → `products.zoho_item_id` | `line_items[].item_id`, `line_items[].name` | **Already wired** — `zoho_item_id` is included per line whenever the local product is already matched to a Zoho item (`LiveZohoAdapter.createSalesOrder`). |
| Quantity | `order_items.quantity` | `line_items[].quantity` | **Already wired.** |
| Rate | `order_items.unit_price` | `line_items[].rate` | **Already wired**, and now correctly reflects a per-line override (the form lets a MedRep edit the rate away from the product's catalog price) rather than always being `products.unit_price`. |
| Discount | `order_items.discount_amount` | `line_items[].discount` (with `discount_type: 'item_level'` set on the order body) | Not wired. `discount_amount` here is a flat currency amount per line, which matches Zoho's own per-line `discount` node when `discount_type` is `item_level`. |
| Tax | `order_items.tax_percent` / `tax_label` | `line_items[].tax_id`, `tax_percentage`, `tax_name` | Not wired, and the trickiest of the line-item fields — Zoho line items normally reference a `tax_id` that already exists in that organization's tax settings, not just a raw percentage. Needs a one-time lookup of this org's configured tax rates (via Zoho's Settings/Taxes API) to map "VAT 12%" / "Zero-Rated" / "VAT-Exempt" here to the matching `tax_id` there before this can be sent correctly. |
| Amount | *(derived, not stored as a separate "amount" column — see `line_total`)* | `line_items[].item_total` | Zoho computes this itself from rate/quantity/discount/tax — this is not normally something the caller sends. |
| Terms and Condition | `orders.intake_terms` | `terms` | 1:1, not wired. |
| Payment Terms | `orders.intake_payment_terms` | `payment_terms_label` (native — **correction, see below**) | Added Aug 30, 2026 after seeing the exact field/options live on Zoho's own Sales Order screen (Net 15, 30 days, 45 Day, BPO WALLET, 60 Day, DSWD/PCSO, or a custom typed value — captured here 1:1 as suggestions, not a locked enum). **Correction (Aug 30, 2026, later same day):** this row originally guessed Payment Terms was a custom field like Doctor Name/Source — checked live via `ZohoInventory_get_sales_order` on a real order and it's actually a **native top-level field**: `payment_terms` (Zoho's internal day-count integer), `payment_terms_label` (the human string, e.g. `"net "` — this is the one that matches what this form collects), and `payment_terms_id`. Still not wired — sending it just needs `payment_terms_label: order.intake_payment_terms` added to `zohoPayload` and a plain top-level field (not `custom_fields`) in `LiveZohoAdapter.createSalesOrder`, same pattern as Delivery Method/Terms. |
| Attach File(s) to Sales Order | *(not stored — UI only, see below)* | `documents[]` | Not built at all yet, on either side. Zoho's `documents` array only references files **already uploaded to Zoho** (each entry needs a `document_id` from a prior, separate upload call) — it isn't a place to upload raw file bytes inline. The order form today lets a MedRep pick files and lists them for review, but nothing is uploaded or persisted anywhere (a deliberate scope decision — see the form's own comment on `attachedFiles`). Building this for real needs, in order: (1) local storage for the uploaded files (e.g. a new `order_attachments` table + an upload endpoint), (2) a Zoho document-upload call per file at Sales-Order-creation time, (3) passing the resulting `document_id`s into this array. |

## The "only Test One can create a live Zoho Sales Order" question

This safety mechanism already exists and works today — it just isn't
pointed at anything yet. See `src/services/zohoTestFlags.js` and
`checkTestCustomerGate` in `orders.controller.js`:

- **`ZOHO_TEST_CUSTOMER_ID=<a Zoho contact id>`** (in `getmeds-backend/.env`) restricts *both* the MedRep's Customer dropdown (`GET /api/orders/meta/customers`) *and* the server-side create/submit endpoints to that one local customer (matched by `customers.zoho_contact_id`). This is enforced in the request handler itself, not just the UI, so a direct API call for any other customer is rejected with `403 TEST_CUSTOMER_ONLY`.
- **`ZOHO_DRY_RUN=true`** is the stronger tier — while it's on, *no* customer's order ever reaches Zoho (a fabricated `DryGM-...` Sales Order response is used instead), so the test-customer gate is bypassed as moot.
- As checked while writing this doc: the currently connected Zoho organization (`714292728`) has **no contact literally named "Test One"**, and this app's local database (95k+ Zoho-synced customers) has none either — only 5 purely local demo customers from `seed.js`, none named "Test One". So there's nothing hardcoded to it yet in either place.
- `.env` right now has `ZOHO_MODE=live`, `ZOHO_DRY_RUN=true`, `ZOHO_TEST_CUSTOMER_ID=` (blank). That means: **nothing can reach Zoho for any customer right now** (dry run), and the test-customer gate is currently off (moot while dry run is on).

To actually lock this down to one customer once dry run comes off:
1. Make sure "Test One" exists as a **Contact in Zoho** itself (create it there if it doesn't yet) and note its Contact ID.
2. Sync it into this app (Clients Directory → "Pull from Zoho", or `POST /api/customers/sync-from-zoho`) so the local `customers` row picks up that `zoho_contact_id`.
3. Set `ZOHO_TEST_CUSTOMER_ID=<that contact id>` in `getmeds-backend/.env`.
4. When ready to test a real write against Zoho (not just dry-run locally), set `ZOHO_DRY_RUN=false`. From that point, every create/submit call — from the form or any other API caller — is rejected for every customer except that one, both in the dropdown and server-side.

## "Edited directly in Zoho" showing up in this app's audit trail (Aug 30, 2026)

Added so a Finance/Admin edit made straight in Zoho's own Sales Order screen — Payment Terms, Invoicing From, Doctor Name, Source, Delivery Method, Terms and Condition — shows up in the order's trail in this app too, not just in Zoho.

**What was built (already on this machine):**
- `src/services/zohoEditDiffService.js` — compares a live-refetched Zoho Sales Order against the local `orders` row for those 6 fields and reports what changed.
- `webhook.controller.js` — when it receives a webhook with `event_type` exactly `"salesorder.edited"`, it re-fetches the Sales Order from Zoho (never trusts the webhook body's own field completeness), diffs it, updates the local `orders` row to match, and logs one `ZOHO_SO_EDITED` audit event summarizing the change (e.g. `Payment Terms: net → 30 days`). If nothing in those 6 fields changed (e.g. someone edited an address or a line item instead), it still logs that an edit happened, just without a field diff.

**What still needs doing in Zoho itself — this app cannot configure Zoho's automation from here:**
1. In Zoho Inventory: **Settings → Automation → Workflow Rules → New Workflow Rule**.
2. Module: **Sales Order**. Trigger: **On Edit** (not "Create or Edit" — that would also fire once right after this app creates the order, which isn't a real edit).
3. Action: **Webhooks → New Webhook**. Method: **POST**. URL: your backend's public URL + `/api/webhooks/zoho` (the same ngrok URL already used for the other Zoho webhooks this app relies on — see the `ngrok tunnel` notes in `orders.controller.js`/`orders.routes.js`).
4. Under the webhook's parameters, add exactly two key/value pairs (not "send all fields" — this app always re-fetches the full record itself, so the webhook body only needs to say *which* order and *that* it was an edit):
   - `event_type` → static value `salesorder.edited`
   - `salesorder_id` → merge field for the Sales Order's ID (Zoho's merge-field picker, under Sales Order fields)
5. Save and enable the rule.

**Reminder (already true for the other Zoho webhooks this app uses, not new):** this only works while the backend and its ngrok tunnel are both actually running and reachable at the moment the edit happens in Zoho — if either is down, the edit is simply missed (Zoho does not retry webhooks), and there is currently no manual "pull edits" button the way there is `sync-from-zoho` for status changes. If that gap matters in practice, say so and it can be added as a follow-up.

**Confirmed live (Aug 31, 2026):** end-to-end tested against SO-66824 — editing Invoicing From/Doctor Name/Delivery Method/Payment Terms in Zoho produced `ZOHO SO EDITED` entries in the app's Audit Timeline with a correct before/after summary.

### Zoho-side status changes (e.g. clicking "Confirm") — added Aug 31, 2026

Clicking **Confirm** on a Sales Order in Zoho changes its `status` field from `draft` to `confirmed` — which is itself just a field edit, so it fires the exact same Workflow Rule already set up above ("any field is updated"). No second Zoho Workflow Rule or webhook was needed for this.

On the backend side: `orders.zoho_so_status` (new column, added via `migrate.js`'s `ensureColumn`) stores the last-known Zoho-side status. `webhook.controller.js`'s edit handler now also re-checks `liveSalesOrder.status` (confirmed live shape: `"status": "draft"` / `"confirmed"` / etc. — top-level, not a custom field) against that column every time it re-fetches the order, and — deliberately only when there was already a stored value to compare against (never on the very first webhook after this shipped, which would otherwise falsely claim a change just from learning the baseline) — logs a distinct `ZOHO_SO_STATUS_CHANGED` event, e.g. "Sales Order confirmed in Zoho (draft → confirmed)", instead of lumping it in with the generic `ZOHO_SO_EDITED` field-diff message.

This is intentionally kept separate from `orders.status` (this app's own dispatch pipeline stage — submitted/ready_for_dispatch/dispatched/etc.) and from the older, currently-unused `isSalesOrderConfirmed` branch further up in the same file (that branch only ever matches a `rawEvent` of literally `salesorder.confirmed` or a `salesorder.status` field inside the webhook body — neither of which this Workflow Rule sends, since its webhook body is the static `{salesorder_id, salesorder_number}` pair and its `event_type` param is always the static `salesorder.edited`). If that older branch is ever wired up too (a second Workflow Rule sending a real `salesorder.confirmed` event type), be aware both paths would then independently react to the same confirm action.
