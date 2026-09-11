const db = require('../db/database');
const zoho = require('../integrations/zoho');
const { normalize, findSalesperson } = require('../integrations/zoho/salespersonName');

/**
 * The MedRep -> Zoho Salesperson mapping, and the check that it is real.
 *
 * Sep 2, 2026. "Salesperson" is a MANDATORY field on every Sales Order in
 * this Zoho org, and `createSalesOrder` sends it by NAME. The name comes from
 * `users.salesperson`, a generated column reading "<division> | <display
 * name>" — collected on the sign-up form (see auth.controller.js's register).
 *
 * Zoho matches that name against its own Salesperson list. A name it does not
 * recognise is not created — the Sales Order is rejected. Which is the right
 * behaviour (nothing here should be inventing Salespersons in the company's
 * Zoho org) but a miserable way to find out: the MedRep has filled in a whole
 * order by then. So `verify` reads the list and the order form warns first.
 *
 * Everything here is READ-only towards Zoho. There is no method on the
 * adapter that could create a Salesperson, deliberately — a missing one is
 * added by a human in Zoho, exactly like a missing contact or item.
 */

// The salesperson list changes when somebody edits it in Zoho, which is
// rarely, and the order form asks on every open. Cache it briefly so a
// MedRep opening the form ten times in a minute costs one Zoho read, not ten
// — the same reasoning as the auto-sync open cooldown. In-memory and
// per-process, like services/syncJobs.js.
//
// Sep 6, 2026: dropped from 5 minutes to 30 seconds. With Division/
// Salesperson now manually typed by Management (see orders.controller.js),
// someone can add a Salesperson in Zoho and expect to pick it here within
// the same minute, not wait out a 5-minute window. 30s still collapses a
// burst of form-opens into effectively one Zoho read while keeping the
// window short enough nobody notices it. Still overridable via
// ZOHO_SALESPERSON_CACHE_MS for an environment that wants it longer/shorter.
const CACHE_TTL_MS = Number(process.env.ZOHO_SALESPERSON_CACHE_MS) || 30 * 1000;
let cache = { names: null, fetchedAt: 0 };

/** The Salesperson string for a user id, or null if they have no mapping. */
async function forUser(userId) {
  if (!userId) return null;
  const row = await db.prepare('SELECT salesperson FROM users WHERE id = ?').get(userId);
  return (row && row.salesperson) || null;
}

/**
 * The three fields that travel together onto a Sales Order: the generated
 * Salesperson string plus the Division and Sub-division it is built from.
 *
 * Sep 2, 2026. This org's Sales Order screen has Division and Sub-division
 * as their own custom fields (cf_division / cf_sub_division) sitting right
 * under Salesperson, so all three describe the same person and are read from
 * the same row in one query — reading them separately is how they would
 * eventually disagree.
 *
 * Every field is null when unset; nothing here invents a value.
 */
async function profileForUser(userId) {
  const empty = { salesperson: null, division: null, sub_division: null };
  if (!userId) return empty;
  const row = await db
    .prepare('SELECT salesperson, division, sub_division FROM users WHERE id = ?')
    .get(userId);
  if (!row) return empty;
  return {
    salesperson: row.salesperson || null,
    division: row.division || null,
    sub_division: row.sub_division || null
  };
}

function clearCache() {
  cache = { names: null, fetchedAt: 0 };
}

async function loadNames({ force = false } = {}) {
  const fresh = cache.names && Date.now() - cache.fetchedAt < CACHE_TTL_MS;
  if (fresh && !force) return cache.names;

  const result = await zoho.listSalespersons();
  // Sep 2, 2026 (2): the whole record is kept, not just the name. The
  // Sales Order now carries salesperson_id, so the order form's check has
  // to answer "which one" rather than merely "is it there" — a check that
  // reported a name as present while the adapter could not resolve its id
  // would be worse than no check.
  const names = (result.salespersons || []).filter((s) => s && (s.salesperson_name || '').trim());

  cache = { names, fetchedAt: Date.now() };
  return names;
}

/**
 * Does `name` exist as a Salesperson in Zoho?
 *
 * Never throws. Zoho being unreachable is not the same answer as the name
 * being absent, and conflating the two would put a scary, wrong warning on
 * the order form every time the network hiccuped. Three outcomes:
 *
 *   { checked: true,  exists: true  }  — Zoho has it
 *   { checked: true,  exists: false }  — Zoho answered, and it is not there
 *   { checked: false, exists: null  }  — could not ask; `reason` says why
 *
 * Comparison is case-insensitive and whitespace-tolerant, because "TEST |
 * Aaron Manila" and "TEST  |  aaron manila" are the same person to everyone
 * except a strict string compare — but the value SENT is always the user's
 * own, untouched.
 */
async function verify(name, { force = false } = {}) {
  if (!name) {
    return { checked: false, exists: null, reason: 'NO_SALESPERSON', name: null };
  }
  try {
    const names = await loadNames({ force });
    const match = findSalesperson(names, name);
    return {
      checked: true,
      exists: !!match,
      name,
      matchedName: match ? match.salesperson_name : null,
      matchedId: match ? match.salesperson_id : null,
      knownCount: names.length
    };
  } catch (err) {
    return { checked: false, exists: null, reason: 'ZOHO_UNREACHABLE', name, error: err.message };
  }
}

// ── Sep 11, 2026: one account, several Salespersons ─────────────────────────
//
// See user_salespersons in schema.pg.sql. users.salesperson is the PRIMARY of
// that list (kept in step by a trigger), so forUser/profileForUser above still
// answer "this account's default" correctly; the functions below deal with the
// whole list.

/**
 * Every Zoho Salesperson an account handles, primary first:
 * [{ salesperson, is_primary }].
 *
 * Falls back to users.salesperson for an account with no rows — one written
 * directly to the column by an older path or a script — so it still has the
 * one it always had.
 */
async function listForUser(userId) {
  if (!userId) return [];
  const rows = await db
    .prepare(
      `SELECT salesperson, is_primary FROM user_salespersons
        WHERE user_id = ?
        ORDER BY is_primary DESC, id`
    )
    .all(userId);
  if (rows.length) return rows.map((r) => ({ salesperson: r.salesperson, is_primary: !!r.is_primary }));
  const legacy = await forUser(userId);
  return legacy ? [{ salesperson: legacy, is_primary: true }] : [];
}

/** Every account's list in one query: Map(user_id -> [{ salesperson, is_primary }]). */
async function listsByUser() {
  const rows = await db
    .prepare('SELECT user_id, salesperson, is_primary FROM user_salespersons ORDER BY user_id, is_primary DESC, id')
    .all();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.user_id)) map.set(r.user_id, []);
    map.get(r.user_id).push({ salesperson: r.salesperson, is_primary: !!r.is_primary });
  }
  return map;
}

/** One account's list out of listsByUser(), with the same legacy fallback as listForUser. */
function salespersonsOf(map, user) {
  const rows = map.get(user.id);
  if (rows && rows.length) return rows;
  return user.salesperson ? [{ salesperson: user.salesperson, is_primary: true }] : [];
}

/**
 * Replace an account's whole list, atomically — orders never go out under a
 * half-edited list.
 *
 * `names` must already be Zoho's own spellings; the caller checks them against
 * the live list (admin.controller.js), because this layer cannot tell a real
 * Salesperson from a typo. The first name is primary unless `primary` names
 * another one in the list. An empty list clears the account.
 */
const setForUser = db.transaction(async (userId, names, { primary = null, actorId = null } = {}) => {
  const list = [];
  for (const raw of names || []) {
    const n = String(raw == null ? '' : raw).trim();
    if (n && !list.some((x) => normalize(x) === normalize(n))) list.push(n);
  }
  const wantedPrimary = primary ? list.find((n) => normalize(n) === normalize(primary)) : null;
  const primaryName = wantedPrimary || list[0] || null;

  await db.prepare('DELETE FROM user_salespersons WHERE user_id = ?').run(userId);
  const now = new Date().toISOString();
  for (const n of list) {
    await db
      .prepare(
        `INSERT INTO user_salespersons (user_id, salesperson, is_primary, assigned_by, assigned_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(userId, n, n === primaryName ? 1 : 0, actorId, now);
  }
  // The trigger already does this; stated explicitly so the account is right
  // even when the DELETE above touched no rows (a legacy account being cleared).
  await db.prepare('UPDATE users SET salesperson = ? WHERE id = ?').run(primaryName, userId);

  return listForUser(userId);
});

/**
 * Which of an account's Salespersons an order goes out under.
 *
 * Blank asks for the primary. Anything else must be one of the account's OWN
 * (case- and spacing-insensitive), and the stored spelling is returned. A name
 * that is not theirs is refused, never sent: it would file this rep's order
 * under somebody else in Zoho.
 */
async function resolveForUser(userId, requested) {
  const list = await listForUser(userId);
  const primary = (list.find((s) => s.is_primary) || list[0] || {}).salesperson || null;
  const want = typeof requested === 'string' ? requested.trim() : '';
  if (!want) return { salesperson: primary, list };

  const hit = list.find((s) => normalize(s.salesperson) === normalize(want));
  if (!hit) {
    const mine = list.map((s) => s.salesperson).join(', ') || 'none assigned';
    return { error: `"${want}" is not one of this account's Salespersons (${mine}).`, list };
  }
  return { salesperson: hit.salesperson, list };
}

/**
 * Convenience for the order form: the caller's primary Salesperson and its
 * status, plus — Sep 11, 2026 — every Salesperson on the account, each checked,
 * so the form can offer the list and warn about any Zoho does not have.
 */
async function statusForUser(userId, opts = {}) {
  const list = await listForUser(userId);
  const salesperson = (list.find((s) => s.is_primary) || list[0] || {}).salesperson || null;
  const verification = await verify(salesperson, opts);

  const salespersons = [];
  for (const s of list) {
    // Cached list after the first call, so this is one Zoho read at most.
    const v = s.salesperson === salesperson ? verification : await verify(s.salesperson);
    salespersons.push({
      salesperson: s.salesperson,
      is_primary: s.is_primary,
      checked: v.checked,
      exists: v.exists,
      matchedName: v.matchedName || null
    });
  }
  return { salesperson, ...verification, salespersons };
}

// Sep 5, 2026 (4): exported so orders.controller.js's GET /api/orders/meta/medreps
// can hand the raw Zoho Salesperson list to the frontend — Management can now
// type a Salesperson manually (instead of picking a MedRep) when creating an
// order, and the only safe way to let them type one is a suggestions list
// drawn from names Zoho already recognizes (see this file's top comment and
// verify() above). create() still independently re-verifies whatever is
// actually submitted — this export only feeds the UI's suggestions, it is
// not itself a trust boundary.
module.exports = {
  forUser,
  profileForUser,
  verify,
  statusForUser,
  loadNames,
  clearCache,
  // Sep 11, 2026: several Salespersons per account.
  listForUser,
  listsByUser,
  salespersonsOf,
  setForUser,
  resolveForUser,
  _normalize: normalize
};
