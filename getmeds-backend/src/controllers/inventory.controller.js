const db = require('../db/database');
const zoho = require('../integrations/zoho');
const syncJobs = require('../services/syncJobs');
const { getSyncState, setSyncState } = require('../services/syncState');

/**
 * GET /api/inventory/status
 *
 * Aug 27, 2026 (2): this used to call `zoho.listItems()` — a full,
 * multi-page live pull of the ENTIRE Zoho catalog — on every single page
 * view, and again automatically every 30 seconds (InventoryPage.jsx's
 * auto-refresh). That was the real cause of the reported lag: once a real
 * org has thousands of items, "just opening the page" meant waiting on a
 * dozen-plus sequential Zoho API round trips, repeated in the background
 * every 30 seconds even when nobody asked for a refresh.
 *
 * This is now a pure local read — zero calls to Zoho. It compares the
 * current local `stock` against `zoho_stock`/`zoho_price`, a snapshot
 * stored the last time `syncPullStock` (the "Pull from Zoho" button)
 * actually ran a live GET. That's the same tradeoff Zoho's own UI makes:
 * what you see is "as of the last sync," and pulling a fresh copy is an
 * explicit action, not something that happens silently on every page
 * load. `last_synced_at` (returned per product, plus the newest one as
 * `summary.last_synced_at`) tells you exactly how stale that snapshot is.
 */
async function getInventoryStatus(req, res) {
  try {
    // Sep 1, 2026 (7): inactive products are LISTED now, not filtered out.
    // `is_active` mirrors Zoho's own item status (see syncPullStock below),
    // and Zoho refuses an inactive item on a Sales Order — which is exactly
    // when you need to see it. Hiding those rows meant a product deactivated
    // in Zoho simply vanished from Inventory, so the only way to discover it
    // was a failed sync reading "Inactive items cannot be added to the sales
    // order". Active first, so the working catalogue still reads top-down.
    const localProducts = await db.prepare('SELECT * FROM products ORDER BY is_active DESC, name ASC').all();

    let syncedCount = 0;
    let mismatchCount = 0;
    let missingInZohoCount = 0;
    let lastSyncedAt = null;

    const products = localProducts.map((p) => {
      const hasZohoSnapshot = p.zoho_item_id != null && p.zoho_stock != null;

      let syncStatus = 'not_in_zoho';
      if (hasZohoSnapshot) {
        if (Number(p.zoho_stock) === Number(p.stock)) {
          syncStatus = 'in_sync';
          syncedCount++;
        } else {
          syncStatus = 'mismatch';
          mismatchCount++;
        }
      } else {
        missingInZohoCount++;
      }

      if (p.last_synced_at && (!lastSyncedAt || p.last_synced_at > lastSyncedAt)) {
        lastSyncedAt = p.last_synced_at;
      }

      return {
        id: p.id,
        name: p.name,
        sku: p.sku,
        unit_price: p.unit_price,
        zoho_price: p.zoho_price,
        unit: p.unit,
        local_stock: p.stock,
        zoho_stock: p.zoho_stock,
        zoho_item_id: p.zoho_item_id,
        last_synced_at: p.last_synced_at,
        sync_status: syncStatus,
        // Zoho's item status, mirrored locally by syncPullStock. 1 = Active.
        is_active: p.is_active === 1 || p.is_active === true ? 1 : 0
      };
    });

    res.json({
      success: true,
      data: {
        mode: zoho.mode,
        organization_id: process.env.ZOHO_ORG_ID || 'MOCK-ORG',
        summary: {
          total_products: products.length,
          in_sync: syncedCount,
          mismatches: mismatchCount,
          not_in_zoho: missingInZohoCount,
          last_synced_at: lastSyncedAt
        },
        products
      }
    });
  } catch (error) {
    console.error('Error fetching inventory status:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * POST /api/inventory/sync-pull
 * Pull stock levels from Zoho Inventory and reconcile the local database.
 *
 * Aug 27, 2026: previously this ONLY updated a product that already
 * existed locally with a matching SKU/name — a real Zoho item with no
 * local counterpart (i.e. every item not already in the 10-item demo
 * seed) was silently skipped, so "Pull from Zoho" against a real org
 * could report "0 updated" even with hundreds of real items in Zoho. Now
 * mirrors customers.controller.js's sync-from-zoho exactly: still a pure
 * READ from Zoho (zoho.listItems(), a GET — nothing is ever written back
 * to Zoho), but an item with no local match is INSERTED as a new local
 * product instead of being dropped, so it becomes selectable in the
 * MedRep order form. Matching, in priority order: an already-linked
 * zoho_item_id, then SKU, then name — same fields as before, just also
 * used to decide "was this already reconciled" rather than only "does an
 * update touch a row."
 */
/**
 * Shared reconciliation logic — INSERT new / UPDATE existing local
 * `products` rows from a list of Zoho items. Pure local DB writes; the Zoho
 * read that produced `zohoItems` already happened before this is called.
 * Used by both the original synchronous sync-pull endpoint below (unchanged
 * behavior/contract — tests/inventorySync.test.js asserts against it
 * directly) and the new background Quick Sync / Full Resync jobs
 * (startSyncJob), so the two can never quietly drift apart.
 */
async function reconcileItems(zohoItems, opts = {}) {
  const { onProgress } = opts;

  // Aug 27, 2026 (2): now also stamps zoho_stock/zoho_price — the
  // snapshot getInventoryStatus compares against without ever calling
  // Zoho itself. `stock` (Getmeds' own working count) is still set to
  // match Zoho at the moment of this explicit pull, same as before.
  //
  // Aug 31, 2026 (8): now also stamps is_active from Zoho's own item
  // `status` — this was never tracked before, so a product Zoho later
  // marked inactive (discontinued, whatever the reason) stayed selectable
  // in the order form forever, since `is_active` was set to 1 once at
  // insert and never touched again. Confirmed live: TestGM-20260831-0001
  // failed Zoho sync with "Inactive items cannot be added to the sales
  // order" for a product our local table still showed as active — Zoho's
  // own record for it had status: "inactive". Treat anything other than
  // the literal "inactive" (including a missing status, e.g. the test
  // fixtures in fixtures.js, which don't all set one) as active, so this
  // never flips a product off just because a field was absent.
  const updateStmt = db.prepare(`
    UPDATE products SET stock = ?, zoho_stock = ?, zoho_price = ?, zoho_item_id = ?, is_active = ?, last_synced_at = datetime('now') WHERE id = ?
  `);
  // Sep 3, 2026: ON CONFLICT DO NOTHING, rather than letting the insert throw
  // and catching it.
  //
  // This is a Postgres correctness fix, not a tidy-up. The SKU collision this
  // guards against was handled by a try/catch until today, which was correct
  // under SQLite: the failed statement was discarded and the loop carried on.
  // Postgres does not work that way — ANY error inside a transaction aborts
  // the whole transaction, and every statement after it fails with "current
  // transaction is aborted, commands ignored until end of transaction block".
  //
  // So on the first duplicate SKU in the live catalogue, the old code would
  // have caught the error, incremented skippedCount, kept looping happily
  // through the remaining items — and then failed at COMMIT, losing the entire
  // sync. `sku` is the only UNIQUE column on this table, so naming it as the
  // conflict target covers exactly the case the catch was written for.
  const insertStmt = db.prepare(`
    INSERT INTO products (name, sku, unit_price, unit, stock, zoho_stock, zoho_price, zoho_item_id, is_active, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT (sku) DO NOTHING
  `);

  let updatedCount = 0;
  let createdCount = 0;
  let skippedCount = 0;
  let deactivatedCount = 0;
  let processed = 0;

  const syncTx = db.transaction(async () => {
    // Sep 3, 2026: the three match lookups and the is_active re-read are done
    // ONCE, up front, instead of once per item.
    //
    // Same reasoning as customers.controller.js's reconcileContacts — see the
    // long comment on RECONCILE_BATCH_SIZE there. Under better-sqlite3 these
    // were in-process calls against a local file; against Supabase each is a
    // network round trip. The live catalogue is 3,446 items, so the old shape
    // was ~14,000 sequential round trips — around ten minutes of pure waiting,
    // during which the progress bar showed nothing at all.
    //
    // The whole products table is ~3,400 rows of six small columns, so holding
    // it in three maps costs a couple of megabytes and one query. The writes
    // below are still per-row (an item can match by zoho_item_id, SKU or name,
    // and an insert can collide on SKU, so they cannot be collapsed into one
    // statement the way the customer upsert can) — but one round trip per item
    // instead of four is a four-fold cut, and it is the lookups that dominated.
    const byZohoId = new Map();
    const bySku = new Map();
    const byName = new Map();
    for (const p of await db.prepare('SELECT id, name, sku, zoho_item_id, is_active FROM products').all()) {
      if (p.zoho_item_id != null) byZohoId.set(String(p.zoho_item_id), p);
      if (p.sku != null) bySku.set(p.sku, p);
      if (p.name != null) byName.set(p.name, p);
    }

    /**
     * Keep the maps in step with what this transaction has already written.
     *
     * This is not bookkeeping for its own sake. The old code re-queried the
     * database on every item, so a row this loop had just inserted or updated
     * was immediately visible to the next item — and two Zoho items sharing a
     * SKU relied on exactly that, the second one matching the first's new row
     * and updating it rather than colliding on the UNIQUE index. Preloading
     * without this would silently turn those into skips.
     */
    function remember(row) {
      if (row.zoho_item_id != null) byZohoId.set(String(row.zoho_item_id), row);
      if (row.sku != null) bySku.set(row.sku, row);
      if (row.name != null) byName.set(row.name, row);
    }

    for (const item of zohoItems) {
      processed++;
      if (onProgress && processed % 100 === 0) onProgress(processed);

      const zohoStock = item.stock_on_hand ?? item.actual_available_stock ?? item.initial_stock ?? 0;
      const zohoPrice = item.rate ?? item.price ?? null;
      const isActiveFromZoho = item.status === 'inactive' ? 0 : 1;

      // Sep 3, 2026: `stock` is clamped at zero; `zoho_stock` is not.
      //
      // Zoho reports a NEGATIVE stock_on_hand for an oversold or backordered
      // item, which is a normal thing for it to say. `products.stock` carries
      // CHECK(stock >= 0), so writing that figure through raises a constraint
      // violation — and because this whole reconcile runs in one transaction,
      // a single backordered item aborted the ENTIRE inventory sync and wrote
      // nothing at all, with an error naming only the constraint. Verified:
      // one item at -5 and 3,445 good ones produced zero rows.
      //
      // The two columns mean different things, which is what makes clamping
      // right rather than a fudge: `zoho_stock` is the snapshot of what Zoho
      // said, kept exactly so getInventoryStatus can show the real position
      // (it is DOUBLE PRECISION with no CHECK, so it holds the negative
      // happily), while `stock` is Getmeds' own working count, which the
      // schema has always insisted cannot go below zero.
      const localStock = Math.max(0, Number(zohoStock) || 0);

      let existing = item.item_id ? byZohoId.get(String(item.item_id)) : undefined;
      if (!existing && item.sku) existing = bySku.get(item.sku);
      if (!existing && item.name) existing = byName.get(item.name);

      if (existing) {
        // `existing.is_active` is the cached value, kept current by the write
        // below — so an item deactivated earlier in this same run is not
        // counted as newly deactivated a second time, exactly as the old
        // per-item re-read behaved.
        if (!isActiveFromZoho && existing.is_active) deactivatedCount++;
        await updateStmt.run(localStock, zohoStock, zohoPrice, item.item_id || null, isActiveFromZoho, existing.id);
        existing.is_active = isActiveFromZoho;
        if (item.item_id) {
          existing.zoho_item_id = item.item_id;
          byZohoId.set(String(item.item_id), existing);
        }
        updatedCount++;
        continue;
      }

      // No local match — a real Zoho item Getmeds has never seen before.
      // Create it LOCALLY ONLY (this is still just a database INSERT on
      // our own products table; nothing is sent to Zoho).
      const name = item.name;
      const sku = item.sku || (item.item_id ? `ZOHO-${item.item_id}` : null);
      if (!name || !sku) { skippedCount++; continue; }

      const unitPrice = Number(zohoPrice ?? 0) || 0;
      const unit = item.unit || 'pc';

      const ins = await insertStmt.run(
        name, sku, unitPrice, unit, localStock, zohoStock, zohoPrice, item.item_id || null, isActiveFromZoho
      );
      if (ins.changes > 0) {
        createdCount++;
        // Visible to the rest of this loop, same as the old per-item re-query
        // made it — see remember()'s comment above.
        remember({
          id: ins.lastInsertRowid,
          name,
          sku,
          zoho_item_id: item.item_id || null,
          is_active: isActiveFromZoho
        });
      } else {
        // A SKU collision (two Zoho items sharing a SKU, or a clash with an
        // existing local one under a different name) — skip that one row
        // rather than aborting the whole pull.
        skippedCount++;
      }
    }

    if (onProgress) onProgress(processed);
  });

  await syncTx();

  return { createdCount, updatedCount, skippedCount, deactivatedCount };
}

async function syncPullStock(req, res) {
  try {
    const zohoRes = await zoho.listItems();
    const zohoItems = zohoRes.items || [];

    const { createdCount, updatedCount, skippedCount, deactivatedCount } = await reconcileItems(zohoItems);

    // Aug 28, 2026: same safety-cap-truncation reporting added to
    // customers.controller.js's syncFromZoho — listItems shares the exact
    // same pagination helper, so it's just as capable of silently
    // stopping short of Zoho's real item count. See LiveZohoAdapter.js's
    // _paginatedList.
    const message = zohoRes.truncated
      ? `⚠️ Pulled ${zohoItems.length} item(s) from Zoho, but Zoho reported even MORE items exist beyond this ` +
        `pull's safety limit — this sync is INCOMPLETE (${createdCount} new, ${updatedCount} updated` +
        (skippedCount ? `, ${skippedCount} skipped` : '') + `). Nothing was written to Zoho. Contact whoever ` +
        'maintains this app so the safety cap can be raised further.'
      : `Pulled ${zohoItems.length} item(s) from Zoho — ${createdCount} new product(s), ${updatedCount} updated` +
        (skippedCount ? `, ${skippedCount} skipped` : '') +
        (deactivatedCount ? `, ${deactivatedCount} newly marked inactive (hidden from the order form)` : '') +
        '. Nothing was written to Zoho.';

    res.json({
      success: true,
      message,
      data: {
        total_from_zoho: zohoItems.length,
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        updated_count: updatedCount,
        deactivated: deactivatedCount,
        truncated: !!zohoRes.truncated
      }
    });
  } catch (error) {
    console.error('Error in syncPullStock:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

/**
 * POST /api/inventory/sync-pull/start?mode=quick|full
 *
 * Aug 28, 2026: added ALONGSIDE the plain POST /sync-pull above — that
 * endpoint is untouched (tests/inventorySync.test.js asserts its
 * synchronous, same-request contract directly), so this is purely
 * additive. Mirrors customers.controller.js's startSyncJob exactly — see
 * that function's comment for the mode semantics and job/progress design.
 * Still a pure READ (zoho.listItems()) — nothing here is ever written back
 * to Zoho.
 */
async function startSyncJob(req, res) {
  const mode = String(req.query.mode || '').toLowerCase();
  if (mode !== 'quick' && mode !== 'full') {
    return res.status(400).json({
      success: false,
      error: { code: 'INVALID_MODE', message: 'Query param "mode" must be "quick" or "full".' }
    });
  }

  const job = syncJobs.createJob({ type: 'inventory', mode });

  if (mode === 'full') {
    // Doubled: fetch is the first half of the bar, the database write the
    // second. See the same comment in customers.controller.js's startSyncJob.
    const priorTotal = parseInt(await getSyncState('inventory_last_full_total'), 10);
    if (priorTotal > 0) syncJobs.updateProgress(job.id, { total: priorTotal * 2 });
  }

  res.status(202).json({ success: true, data: { job_id: job.id, mode } });

  (async () => {
    try {
      const opts = {
        onPage: ({ processed }) => syncJobs.updateProgress(job.id, { processed })
      };
      if (mode === 'quick') {
        const watermark = await getSyncState('inventory_last_modified_watermark');
        if (watermark) opts.sinceWatermark = watermark;
      }

      const zohoRes = await zoho.listItems({}, opts);
      const zohoItems = zohoRes.items || [];

      const fetched = zohoItems.length;
      syncJobs.updateProgress(job.id, { processed: fetched, total: fetched * 2 });

      const { createdCount, updatedCount, skippedCount } = await reconcileItems(zohoItems, {
        onProgress: (written) => syncJobs.updateProgress(job.id, { processed: fetched + written })
      });

      if (zohoRes.newWatermark) await setSyncState('inventory_last_modified_watermark', zohoRes.newWatermark);
      if (mode === 'full') {
        await setSyncState('inventory_last_full_sync_at', new Date().toISOString());
        await setSyncState('inventory_last_full_total', zohoItems.length);
      }

      syncJobs.finishJob(job.id, {
        mode,
        total_from_zoho: zohoItems.length,
        created: createdCount,
        updated: updatedCount,
        skipped: skippedCount,
        truncated: !!zohoRes.truncated,
        stopped_early: !!zohoRes.stoppedEarly
      });
    } catch (err) {
      console.error('[INVENTORY] background sync job failed:', err);
      syncJobs.failJob(job.id, err);
    }
  })();
}

/**
 * POST /api/inventory/adjust
 * Adjust stock LOCALLY only (Getmeds' own tracking). As of Aug 27, 2026
 * this never touches Zoho — Zoho Inventory is read-only from this app
 * (see getInventoryStatus/syncPullStock above). If this local count needs
 * to be reflected in Zoho, that adjustment is made directly in Zoho by a
 * human, then picked up here next time syncPullStock runs.
 */
async function adjustStock(req, res) {
  try {
    const { product_id, delta, reason } = req.body;
    if (!product_id || delta === undefined || isNaN(delta)) {
      return res.status(400).json({ success: false, message: 'product_id and numeric delta are required' });
    }

    const product = await db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const newStock = product.stock + Number(delta);
    if (newStock < 0) {
      return res.status(400).json({ success: false, message: `Cannot reduce stock below 0 (current: ${product.stock}, delta: ${delta})` });
    }

    await db.prepare('UPDATE products SET stock = ?, last_synced_at = datetime(\'now\') WHERE id = ?').run(newStock, product.id);

    res.json({
      success: true,
      message: `Local stock updated: ${product.name} is now ${newStock} (${delta > 0 ? '+' : ''}${delta}). This was NOT sent to Zoho — adjust the Zoho-side count directly in Zoho if needed.`,
      data: {
        product_id: product.id,
        old_stock: product.stock,
        new_stock: newStock,
        delta: Number(delta)
      }
    });
  } catch (error) {
    console.error('Error in adjustStock:', error);
    res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = {
  getInventoryStatus,
  syncPullStock,
  startSyncJob,
  adjustStock,
  // See customers.controller.js's __test__ export for why this exists.
  __test__: { reconcileItems }
};
