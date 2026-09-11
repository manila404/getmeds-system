const db = require('../db/database');
const salespersonService = require('./salespersonService');

/**
 * Who owns the Sales Orders that came in from Zoho.
 *
 * Sep 10, 2026. The import (services/zohoOrderImportService.js) brought in
 * 60,817 Sales Orders. Every one is owned by the admin account that ran the
 * import, because orders.medrep_id is NOT NULL and nobody in this app raised
 * them. This service is how they get handed to the reps they belong to.
 *
 * ── WHY THIS IS NOT AN AUTOMATIC JOIN ───────────────────────────────────────
 *
 * The obvious implementation is `UPDATE orders SET medrep_id = u.id FROM users
 * u WHERE orders.salesperson = u.salesperson`. Measured against the live data,
 * that matches almost nothing, and what it does match cannot be trusted:
 *
 *   * 30,854 of the 60,817 orders have NO salesperson in Zoho at all —
 *     verified against the live API, not inferred. Sales Orders from before
 *     Zoho made the field mandatory. Nothing recovers a name never recorded.
 *   * The 29,963 that carry one use 171 distinct strings, of which only ~107
 *     are people. 51 are territories ('HOS | LAGUNA', 'B&B | EAST AVE') and
 *     13 are channels ('WEB', 'Shopee', 'Lazada').
 *   * The strings are dirty in ways that defeat exact matching: 'MSA I WENDY
 *     MAE' separates with a capital I, 'MSA GILBERT DELA CRUZ' has no
 *     separator, 'B2C | Fhaye Norella ' has a trailing space, and
 *     'MSA | Dona Mae Lebumfacil' / 'B2B |  DONA MAE LEBUMFACIL' are one
 *     person under two divisions.
 *   * Normalise hard enough to catch those and 'HOS | MANILA VACANT' starts
 *     resembling 'HOS | Aaron Manila' — which would hand one rep another's
 *     entire history. If that history ever feeds commission or quota, a false
 *     match is a payroll dispute, not a display bug.
 *
 * So the system SUGGESTS and a person DECIDES. Decisions live in
 * salesperson_mappings, which makes them reusable for later imports,
 * reversible, and attributable.
 */

/** Rows per batched statement. Same reasoning as the customers reconcile. */
const BATCH_SIZE = 500;

/** Only orders the import created are ever reassigned. */
const IMPORTED_PREFIX = 'ZOHO-%';

/**
 * Reduce a Zoho salesperson string to something comparable.
 *
 * Aggressive about FORM (case, spacing, separator) and silent about MEANING —
 * it never drops a word or guesses at a nickname. That line is where a
 * normaliser stops helping and starts inventing matches: fold two people's
 * names together once and the whole table becomes untrustworthy.
 *
 *   'B2B |  DONA MAE LEBUMFACIL'  -> 'b2b | dona mae lebumfacil'
 *   'MSA I WENDY MAE'             -> 'msa | wendy mae'
 *   'B2C | Fhaye Norella '        -> 'b2c | fhaye norella'
 */
function normalise(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    // ' I ' as a separator — a real and common typo for '|' in this org.
    .replace(/\s+i\s+/g, ' | ')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Everything before the separator, or null when there is none. */
function divisionPart(value) {
  const n = normalise(value);
  const i = n.indexOf(' | ');
  return i === -1 ? null : n.slice(0, i).trim();
}

/** Everything after the separator — the person, when there is one. */
function namePart(value) {
  const n = normalise(value);
  const i = n.indexOf(' | ');
  return i === -1 ? n : n.slice(i + 3).trim();
}

// Territory and channel names observed in the live org. These only pre-sort
// the review list — a wrong guess costs a reviewer one extra click and never a
// misattributed order, because nothing is ever applied from a guess.
const TERRITORY_WORDS =
  /\b(east ave|taft|rodriguez|ncl|south luzon|north cebu|south cebu|cebu|davao|kalaw|commonwealth|ortigas|camanava|cabanatuan|laguna|bicol|tuguegarao|iloilo|baguio|quezon province|zamboanga|pasay|cavite|pampanga|marikina|cdo|las pinas|palawan|gensan|paranaque|antipolo|mindanao|visayas|manila|mmc|cardinal|tmc|north & central luzon)\b/;
const CHANNEL_NAMES =
  /^(web|shopee|lazada|tiktok|grabmart|pharmacy|inhouse|dswd|pcso|office of the president|getmeds hr|telesales anesthesia|b2c \| web)$/;
const VACANT = /\bvacant\b/;

/**
 * A first guess at what a string IS, to order the review queue.
 *
 * Never authoritative — the reviewer's answer is. Returns 'undecided' rather
 * than 'person' for anything unrecognised, because "the system thinks this is
 * a person" is a claim worth making only once a human has agreed.
 */
function guessKind(value) {
  const n = normalise(value);
  if (!n) return 'undecided';
  if (VACANT.test(n)) return 'vacant';
  if (CHANNEL_NAMES.test(n)) return 'channel';
  if (TERRITORY_WORDS.test(namePart(n))) return 'territory';
  return 'undecided';
}

/**
 * The best candidate account for a Zoho string, or null.
 *
 * Two tiers, and the tier is reported so a reviewer knows how far to trust it.
 * Anything weaker than "the names match once case and spacing are ignored" is
 * not offered at all: a plausible-looking bad suggestion is worse than none,
 * because it turns a careful review into a row of Accept clicks.
 */
function suggestUser(zohoSalesperson, users) {
  const full = normalise(zohoSalesperson);
  const name = namePart(zohoSalesperson);
  if (!full) return null;

  // Sep 11, 2026: against EVERY Salesperson an account holds, not just its
  // primary — a rep covering four regions is an exact match for all four.
  // Exactly one account, or no suggestion: two people can share a Zoho
  // Salesperson, and choosing between them is a human's call.
  const holds = (u) => (u.salespersons && u.salespersons.length ? u.salespersons : [u.salesperson]).filter(Boolean);
  const exact = users.filter((u) => holds(u).some((sp) => normalise(sp) === full));
  if (exact.length === 1) {
    return { user: exact[0], confidence: 'exact', reason: 'This account holds exactly this Zoho Salesperson.' };
  }
  if (exact.length > 1) return null;

  if (!name) return null;

  const byName = users.filter((u) =>
    [u.display_name, u.name].filter(Boolean).map(normalise).includes(name)
  );
  // Exactly one, or it is not a suggestion — two accounts sharing a display
  // name is precisely the case a human has to resolve.
  if (byName.length !== 1) return null;

  const user = byName[0];
  const div = divisionPart(zohoSalesperson);
  const sameDivision = div && user.division && normalise(user.division) === div;

  return {
    user,
    confidence: sameDivision ? 'exact' : 'name-only',
    reason: sameDivision
      ? 'Division and name both match this account.'
      : `Name matches, but Zoho says "${div || 'no division'}" and the account says "${user.division || 'no division'}".`
  };
}

/**
 * Make sure every salesperson string present on an imported order has a row in
 * salesperson_mappings, so the review list is complete.
 *
 * Idempotent, and never overwrites a decision — ON CONFLICT DO NOTHING. A
 * reviewer who has already classified 'HOS | LAGUNA' as a territory does not
 * get their answer reset to the guess the next time this runs.
 */
async function discover() {
  const rows = await db
    .prepare(
      `SELECT DISTINCT salesperson FROM orders
        WHERE getmeds_order_id LIKE ?
          AND salesperson IS NOT NULL AND TRIM(salesperson) <> ''`
    )
    .all(IMPORTED_PREFIX);

  let added = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    const params = [];
    const tuples = batch.map((r) => {
      params.push(r.salesperson, guessKind(r.salesperson));
      return '(?, ?)';
    });
    const res = await db
      .prepare(
        `INSERT INTO salesperson_mappings (zoho_salesperson, kind)
         VALUES ${tuples.join(', ')}
         ON CONFLICT (zoho_salesperson) DO NOTHING`
      )
      .run(...params);
    added += res.changes || 0;
  }

  return { discovered: rows.length, added };
}

/**
 * The review list: every distinct Zoho salesperson, its order count, the
 * decision so far, and a suggestion where one is safe to make.
 *
 * Ordered by order count descending, because the volume curve is steep — 13 of
 * the 171 names cover half the attributed orders and 40 cover 80%. A reviewer
 * working top-down gets most of the value from a short session.
 */
async function listForReview() {
  await discover();

  const counts = await db
    .prepare(
      `SELECT salesperson, COUNT(*) AS order_count
         FROM orders
        WHERE getmeds_order_id LIKE ?
          AND salesperson IS NOT NULL AND TRIM(salesperson) <> ''
        GROUP BY salesperson`
    )
    .all(IMPORTED_PREFIX);
  const countBy = new Map(counts.map((c) => [c.salesperson, c.order_count]));

  const mappings = await db
    .prepare(
      `SELECT m.*, u.name AS user_name, u.display_name AS user_display_name,
              u.division AS user_division, u.salesperson AS user_salesperson,
              u.is_active AS user_is_active
         FROM salesperson_mappings m
         LEFT JOIN users u ON m.user_id = u.id`
    )
    .all();

  const userRows = await db
    .prepare(
      `SELECT id, name, display_name, division, salesperson
         FROM users
        WHERE LOWER(role) = 'medrep' AND is_active = 1 AND approval_status = 'approved'
        ORDER BY COALESCE(NULLIF(TRIM(display_name), ''), name)`
    )
    .all();
  // Sep 11, 2026: each rep's full Salesperson list, for suggestUser.
  const lists = await salespersonService.listsByUser();
  const users = userRows.map((u) => ({
    ...u,
    salespersons: salespersonService.salespersonsOf(lists, u).map((s) => s.salesperson)
  }));

  const rows = mappings.map((m) => {
    const suggestion = m.user_id ? null : suggestUser(m.zoho_salesperson, users);
    return {
      id: m.id,
      zoho_salesperson: m.zoho_salesperson,
      order_count: countBy.get(m.zoho_salesperson) || 0,
      kind: m.kind,
      notes: m.notes,
      user_id: m.user_id,
      user_name: m.user_display_name || m.user_name || null,
      mapped_at: m.mapped_at,
      suggestion: suggestion
        ? {
            user_id: suggestion.user.id,
            user_name: suggestion.user.display_name || suggestion.user.name,
            confidence: suggestion.confidence,
            reason: suggestion.reason
          }
        : null
    };
  });

  rows.sort((a, b) => b.order_count - a.order_count);

  const unattributed = await db
    .prepare(
      `SELECT COUNT(*) AS c FROM orders
        WHERE getmeds_order_id LIKE ?
          AND (salesperson IS NULL OR TRIM(salesperson) = '')`
    )
    .get(IMPORTED_PREFIX);

  return {
    rows,
    users,
    summary: {
      distinct_salespersons: rows.length,
      // Orders Zoho never attributed to anyone. Left owned by Management by
      // decision — see applyMappings. Reported so the number is visible rather
      // than quietly missing from the totals.
      orders_with_no_salesperson: unattributed?.c || 0,
      undecided: rows.filter((r) => r.kind === 'undecided').length,
      mapped_to_person: rows.filter((r) => r.kind === 'person' && r.user_id).length
    }
  };
}

/** Record one decision. */
async function setMapping({ zohoSalesperson, userId = null, kind, notes = null, actorId }) {
  const VALID = ['undecided', 'person', 'territory', 'channel', 'vacant'];
  if (!VALID.includes(kind)) {
    throw Object.assign(new Error(`kind must be one of: ${VALID.join(', ')}`), { code: 'VALIDATION_ERROR' });
  }
  // Only a person owns orders. Attaching an account to a territory would make
  // 'HOS | LAGUNA' one rep's personal history, which is the opposite of what
  // classifying it as a territory means.
  const effectiveUserId = kind === 'person' ? userId : null;

  await db
    .prepare(
      `INSERT INTO salesperson_mappings (zoho_salesperson, user_id, kind, notes, mapped_by, mapped_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (zoho_salesperson) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         kind = EXCLUDED.kind,
         notes = EXCLUDED.notes,
         mapped_by = EXCLUDED.mapped_by,
         mapped_at = EXCLUDED.mapped_at`
    )
    .run(zohoSalesperson, effectiveUserId, kind, notes, actorId, new Date().toISOString());

  return db.prepare('SELECT * FROM salesperson_mappings WHERE zoho_salesperson = ?').get(zohoSalesperson);
}

/**
 * Hand the orders over.
 *
 * Only ever touches ZOHO- orders whose salesperson maps to kind='person' with
 * an account attached. Everything else is left exactly where it is:
 *
 *   * Orders raised in this app keep their real MedRep — the LIKE 'ZOHO-%'
 *     guard is what stops a mapping decision from rewriting live ownership.
 *   * Territories, channels and vacant slots stay Management-owned, by
 *     decision. 10,506 orders fall here.
 *   * Orders with no salesperson in Zoho (30,854) stay Management-owned. There
 *     is nothing to map them by, and guessing from customer history would be
 *     inventing a fact.
 *
 * `dryRun` reports what would move without writing, because 30,000 rows
 * changing owner is not something anyone should trigger blind.
 */
async function applyMappings({ dryRun = true, actorId = null, actorName = 'Admin' } = {}) {
  const mappings = await db
    .prepare(
      `SELECT m.zoho_salesperson, m.user_id,
              COALESCE(NULLIF(TRIM(u.display_name), ''), u.name) AS user_name
         FROM salesperson_mappings m
         JOIN users u ON m.user_id = u.id
        WHERE m.kind = 'person' AND m.user_id IS NOT NULL`
    )
    .all();

  const plan = [];
  let total = 0;

  for (const m of mappings) {
    // Count only what would actually CHANGE. Re-applying after one new
    // decision should report that one decision's effect, not restate the
    // entire history as if it were about to happen again.
    const row = await db
      .prepare(
        `SELECT COUNT(*) AS c FROM orders
          WHERE getmeds_order_id LIKE ?
            AND salesperson = ?
            AND (medrep_id IS DISTINCT FROM ?)`
      )
      .get(IMPORTED_PREFIX, m.zoho_salesperson, m.user_id);
    const c = row?.c || 0;
    if (!c) continue;
    plan.push({ zoho_salesperson: m.zoho_salesperson, user_id: m.user_id, user_name: m.user_name, orders: c });
    total += c;
  }

  plan.sort((a, b) => b.orders - a.orders);
  if (dryRun) return { dry_run: true, total_orders: total, plan };

  const now = new Date().toISOString();
  let moved = 0;

  for (const step of plan) {
    // The audit entry is written BEFORE the update, while the rows can still
    // be found by their old owner — and it names the old owner, so "who had
    // this before" survives the change.
    await db
      .prepare(
        `INSERT INTO order_events (order_id, event_type, old_status, new_status, actor_id, actor_name, notes, metadata, created_at)
         SELECT o.id, 'ORDER_REASSIGNED', o.status, o.status, ?, ?,
                'Assigned to ' || ? || ' from the Zoho Salesperson "' || o.salesperson || '".',
                NULL, ?
           FROM orders o
          WHERE o.getmeds_order_id LIKE ?
            AND o.salesperson = ?
            AND (o.medrep_id IS DISTINCT FROM ?)`
      )
      .run(actorId, actorName, step.user_name, now, IMPORTED_PREFIX, step.zoho_salesperson, step.user_id);

    const res = await db
      .prepare(
        `UPDATE orders SET medrep_id = ?, updated_at = ?
          WHERE getmeds_order_id LIKE ?
            AND salesperson = ?
            AND (medrep_id IS DISTINCT FROM ?)`
      )
      .run(step.user_id, now, IMPORTED_PREFIX, step.zoho_salesperson, step.user_id);
    moved += res.changes || 0;
  }

  return { dry_run: false, total_orders: moved, plan };
}

module.exports = {
  normalise,
  namePart,
  divisionPart,
  guessKind,
  suggestUser,
  discover,
  listForReview,
  setMapping,
  applyMappings
};
