const db = require('../db/database');
const zoho = require('../integrations/zoho');

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
    const localProducts = db.prepare('SELECT * FROM products WHERE is_active = 1 ORDER BY name ASC').all();

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
        sync_status: syncStatus
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
async function syncPullStock(req, res) {
  try {
    const zohoRes = await zoho.listItems();
    const zohoItems = zohoRes.items || [];

    const findByZohoId = db.prepare('SELECT id FROM products WHERE zoho_item_id = ?');
    const findBySku = db.prepare('SELECT id FROM products WHERE sku = ?');
    const findByName = db.prepare('SELECT id FROM products WHERE name = ?');
    // Aug 27, 2026 (2): now also stamps zoho_stock/zoho_price — the
    // snapshot getInventoryStatus compares against without ever calling
    // Zoho itself. `stock` (Getmeds' own working count) is still set to
    // match Zoho at the moment of this explicit pull, same as before.
    const updateStmt = db.prepare(`
      UPDATE products SET stock = ?, zoho_stock = ?, zoho_price = ?, zoho_item_id = ?, last_synced_at = datetime('now') WHERE id = ?
    `);
    const insertStmt = db.prepare(`
      INSERT INTO products (name, sku, unit_price, unit, stock, zoho_stock, zoho_price, zoho_item_id, last_synced_at, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), 1)
    `);

    let updatedCount = 0;
    let createdCount = 0;
    let skippedCount = 0;

    const syncTx = db.transaction(() => {
      for (const item of zohoItems) {
        const zohoStock = item.stock_on_hand ?? item.actual_available_stock ?? item.initial_stock ?? 0;
        const zohoPrice = item.rate ?? item.price ?? null;

        let existing = item.item_id ? findByZohoId.get(item.item_id) : undefined;
        if (!existing && item.sku) existing = findBySku.get(item.sku);
        if (!existing && item.name) existing = findByName.get(item.name);

        if (existing) {
          updateStmt.run(zohoStock, zohoStock, zohoPrice, item.item_id || null, existing.id);
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

        try {
          insertStmt.run(name, sku, unitPrice, unit, zohoStock, zohoStock, zohoPrice, item.item_id || null);
          createdCount++;
        } catch (e) {
          // Most likely a SKU collision (two Zoho items sharing a SKU, or a
          // clash with an existing local one under a different name) — skip
          // that one row rather than aborting the whole pull.
          skippedCount++;
        }
      }
    });

    syncTx();

    res.json({
      success: true,
      message: `Pulled ${zohoItems.length} item(s) from Zoho — ${createdCount} new product(s), ${updatedCount} updated` +
        (skippedCount ? `, ${skippedCount} skipped` : '') + '. Nothing was written to Zoho.',
      data: { total_from_zoho: zohoItems.length, created: createdCount, updated: updatedCount, skipped: skippedCount, updated_count: updatedCount }
    });
  } catch (error) {
    console.error('Error in syncPullStock:', error);
    res.status(500).json({ success: false, message: error.message });
  }
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

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(product_id);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    const newStock = product.stock + Number(delta);
    if (newStock < 0) {
      return res.status(400).json({ success: false, message: `Cannot reduce stock below 0 (current: ${product.stock}, delta: ${delta})` });
    }

    db.prepare('UPDATE products SET stock = ?, last_synced_at = datetime(\'now\') WHERE id = ?').run(newStock, product.id);

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
  adjustStock
};
