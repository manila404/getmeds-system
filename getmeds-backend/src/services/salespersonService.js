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

/** Convenience for the order form: the caller's mapping plus its status. */
async function statusForUser(userId, opts = {}) {
  const salesperson = await forUser(userId);
  const verification = await verify(salesperson, opts);
  return { salesperson, ...verification };
}

// Sep 5, 2026 (4): exported so orders.controller.js's GET /api/orders/meta/medreps
// can hand the raw Zoho Salesperson list to the frontend — Management can now
// type a Salesperson manually (instead of picking a MedRep) when creating an
// order, and the only safe way to let them type one is a suggestions list
// drawn from names Zoho already recognizes (see this file's top comment and
// verify() above). create() still independently re-verifies whatever is
// actually submitted — this export only feeds the UI's suggestions, it is
// not itself a trust boundary.
module.exports = { forUser, profileForUser, verify, statusForUser, loadNames, clearCache, _normalize: normalize };
