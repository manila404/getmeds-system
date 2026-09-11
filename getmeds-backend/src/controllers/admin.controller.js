const db = require('../db/database');
const bcrypt = require('bcryptjs');
const zohoRetryService = require('../services/zohoRetryService');
// Sep 11, 2026: the Salesperson list an admin assigns from. Read-only.
const zoho = require('../integrations/zoho');
// Sep 11, 2026: an account's full Salesperson list (user_salespersons).
const salespersonService = require('../services/salespersonService');
// Sep 11, 2026: the live copy of Zoho's Salesperson list, keyed by Zoho's id.
const zohoSalespersonSync = require('../services/zohoSalespersonSync');
// Sep 9, 2026: reuse the same Division/Sub-division enums Profile Settings
// enforces — see auth.controller.js's DIVISIONS comment for why this is an
// enum (a free-typed division created junk Salespersons in the live Zoho org
// before Sep 5).
const { DIVISIONS, SUB_DIVISIONS_BY_DIVISION, MIN_PASSWORD_LENGTH } = require('./auth.controller');

// Get all users with their roles
const getAllUsers = async (req, res, next) => {
  try {
    // Sep 9, 2026: approval_status comes back too, and pending accounts sort
    // FIRST. A list that buries three people waiting for approval among eighty
    // alphabetised names is a queue nobody works.
    const users = await db
      .prepare(
        `SELECT id, name, email, role, is_active, created_at,
                approval_status, approved_at, approved_by,
                display_name, division, sub_division, salesperson
           FROM users
          ORDER BY (approval_status = 'pending') DESC, name`
      )
      .all();
    // Sep 11, 2026: every Zoho Salesperson on each account, primary first.
    const lists = await salespersonService.listsByUser();
    const enriched = users.map(u => ({
      ...u,
      salespersons: salespersonService.salespersonsOf(lists, u),
      username: u.email ? u.email.split('@')[0] : `user_${u.id}`,
      role_name: u.role ? (u.role.charAt(0).toUpperCase() + u.role.slice(1)) : 'User',
      first_name: u.name ? u.name.split(' ')[0] : '',
      last_name: u.name ? u.name.split(' ').slice(1).join(' ') : ''
    }));
    res.status(200).json({ success: true, data: enriched });
  } catch (err) {
    if (next) return next(err);
    res.status(500).json({ success: false, message: 'Failed to retrieve users', error: err.message });
  }
};

// Deactivate a user (Soft Delete)
/**
 * Sep 11, 2026: an admin account cannot be switched off.
 *
 * The database enforces this too (see the protect_admin_accounts trigger in
 * schema.pg.sql), and that is the enforcement that actually matters — it
 * covers the repair scripts and any SQL console, not just this controller.
 * What this adds is a readable answer: without it the trigger surfaces as a
 * 500 with a Postgres exception in it, which tells an admin they broke
 * something rather than that they were prevented from doing something.
 *
 * Three routes reach the same row, and the third is the one that gets missed:
 * demoting an admin to another role removes exactly the same access as
 * deactivating them, while looking like an edit rather than a removal.
 */
function adminProtection(target, { role, is_active: isActive } = {}) {
  if (target.role !== 'admin') return null;

  if (isActive !== undefined && !isActive) return 'deactivated';
  if (role !== undefined && String(role).toLowerCase() !== 'admin') return 'changed to another role';
  return null;
}

function refuseAdminChange(res, what) {
  return res.status(403).json({
    success: false,
    error: {
      code: 'ADMIN_PROTECTED',
      message:
        `Admin accounts cannot be ${what}. This is deliberate — it is what stops the system ` +
        'being locked out of its own administration. To offboard a departing admin, a database ' +
        'session has to set app.allow_admin_change explicitly.'
    }
  });
}

const deactivateUser = async (req, res, next) => {
  try {
    const userId = req.params.id;
    const user = await db.prepare('SELECT id, name, is_active FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const user_full = await db.prepare('SELECT role FROM users WHERE id = ?').get(userId);
    if (adminProtection({ role: user_full.role }, { is_active: false })) {
      return refuseAdminChange(res, 'deactivated');
    }

    await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    res.status(200).json({ 
      success: true, 
      message: `User ${userId} deactivated successfully.` 
    });
  } catch (err) {
    if (next) return next(err);
    res.status(500).json({ success: false, message: 'Failed to deactivate user', error: err.message });
  }
};

// Create a new user
//
// Sep 9, 2026: this used to insert only (name, email, password_hash, role) —
// no Division/Sub-division/Salesperson mapping at all. `users.salesperson`
// is a GENERATED column ("<division> | <display name>", see
// auth.controller.js), so an admin-created medrep account had no Salesperson
// and Zoho rejected their very first order at submit. Takes the same fields
// (first/middle/last name, display name, division, sub-division) Profile
// Settings works with, rather than inventing a second set of rules for the
// same data.
//
// Sep 11, 2026: this is now the ONLY way an account is created. Self-service
// sign-up (POST /api/auth/register) was removed; an admin creates each account
// on the Users page and hands the login to the person. So the checks sign-up
// used to make live here now — email format and minimum password length. Not
// the email-domain allow-list: that stood in for "someone decided this person
// should have an account", which is exactly what an admin creating it is.
//
// No approval step either. approval_status defaults to 'approved', and an
// account an admin made is approved by the act of making it.
const create = async (req, res, next) => {
  try {
    const str = (v) => (typeof v === 'string' ? v.trim() : '');

    const { name, email, password, role } = req.body;
    const firstName = str(req.body.first_name);
    const middleName = str(req.body.middle_name);
    const lastName = str(req.body.last_name);
    const division = str(req.body.division);
    const subDivision = str(req.body.sub_division);
    // May be sent a single `name`, or first/last as the Create account form
    // does — support both rather than forcing one shape on every caller.
    const displayName = str(req.body.display_name) || str(name) || [firstName, lastName].filter(Boolean).join(' ');

    if (!displayName || !email || !password || !role) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name, email, password, role required' } });
    }
    const valid_roles = ['medrep', 'finance', 'dispatch', 'management', 'admin'];
    const normalizedRole = role.toLowerCase();
    if (!valid_roles.includes(normalizedRole)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `role must be one of: ${valid_roles.join(', ')}` } });
    }

    // Deliberately loose: one @, no spaces, a dot in the domain. Only catches
    // obvious typos — the admin typing it is the real check.
    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'That does not look like a valid email address' } });
    }
    if (String(password).length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` } });
    }

    // A medrep needs a Division — it is sent as cf_division on every Sales
    // Order they raise. Other roles never raise an order as themselves
    // (Management orders on someone else's behalf — see orders.controller.js's
    // gmLeadId note — Finance/Dispatch/Admin never do), so Division stays
    // optional for them; validated below if given, but not required.
    if (normalizedRole === 'medrep' && !division) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'division is required for a medrep account' } });
    }

    // Same fixed-list validation Profile Settings applies — see DIVISIONS'
    // comment in auth.controller.js. Only checked when a division was
    // actually given, so non-medrep accounts created without one aren't
    // refused for omitting a field they don't need.
    if (division && !DIVISIONS.includes(division)) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `Division must be one of: ${DIVISIONS.join(', ')}` } });
    }
    // Sep 9, 2026: sub-division is NOT validated — it is free text and may
    // name more than one, matching Profile Settings and the order form. See
    // SUB_DIVISIONS_BY_DIVISION in auth.controller.js for why.

    // Sep 5, 2026: normalize to lowercase before storing — seed.js,
    // create-user.js and the public sign-up endpoint all already do this;
    // this was the one path that didn't, so an admin-created account could
    // carry a mixed-case email that then could never log in (see the fix in
    // auth.controller.js's login — LOWER() there covers accounts already
    // created with mixed case, but new ones should just be stored correctly).
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(normalizedEmail);
    if (existing) return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'Email already in use' } });

    const hash = bcrypt.hashSync(password, 10);
    // `salesperson` is absent from this INSERT on purpose. It must be a name
    // from Zoho's own list, and an admin picks it from that list on the Users
    // page afterwards (see update() below) — never guessed at creation, since
    // a name Zoho does not know is created there on the first order.
    const result = await db
      .prepare(
        `INSERT INTO users
           (name, email, password_hash, role, first_name, middle_name, last_name, display_name, division, sub_division)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        displayName,
        normalizedEmail,
        hash,
        normalizedRole,
        firstName || null,
        middleName || null,
        lastName || null,
        displayName,
        division || null,
        subDivision || null
      );
    const user = await db
      .prepare(
        `SELECT id, name, email, role, is_active, approval_status, created_at, first_name, middle_name,
                last_name, display_name, division, sub_division, salesperson
         FROM users WHERE id = ?`
      )
      .get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: { user } });
  } catch (err) {
    if (next) next(err);
    else res.status(500).json({ success: false, error: err.message });
  }
};

// Update an existing user
/**
 * The Salesperson names Zoho actually has, lowercased for comparison.
 *
 * Cached briefly because assigning Salespersons is a burst activity — an admin
 * works through a handful of new accounts in one sitting, and that should not
 * be one Zoho round trip per keystroke. Short enough that a Salesperson added
 * in Zoho shows up without a restart.
 *
 * Returns null when Zoho cannot be reached, so callers can tell "not on the
 * list" apart from "could not check" — those deserve different answers.
 */
let salespersonCache = { at: 0, names: null, list: [] };
// Sep 11, 2026: 30 seconds, down from 5 minutes, so a Salesperson added or
// renamed in Zoho reaches this picker within the minute. `force` (the
// Refresh button) skips the cache entirely.
const SALESPERSON_CACHE_MS = 30 * 1000;

async function loadZohoSalespersons({ force = false } = {}) {
  const now = Date.now();
  if (!force && salespersonCache.names && now - salespersonCache.at < SALESPERSON_CACHE_MS) {
    return salespersonCache;
  }
  try {
    const res = await zoho.listSalespersons();
    const list = (res?.salespersons || [])
      .map((s) => ({
        name: String(s.salesperson_name || s.name || '').trim(),
        // Zoho marks a Salesperson inactive when the person leaves. Half this
        // org's list is in that state (101 active, 97 inactive), so it is the
        // difference between a picker of 101 current colleagues and one of 198
        // mostly-former ones.
        //
        // `!== false` rather than truthiness: the mock adapter's fixtures carry
        // no is_active at all, and an absent flag means "no opinion", not
        // "inactive".
        is_active: s.is_active !== false
      }))
      .filter((s) => s.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    salespersonCache = { at: now, names: new Set(list.map((n) => n.name.toLowerCase())), list };

    // Sep 11, 2026: keep the live copy (and any renames it carries) in step
    // with what this picker is about to show. Best-effort, like the order
    // form's read in salespersonService.
    try {
      await zohoSalespersonSync.syncFromList(res?.salespersons || []);
    } catch (syncErr) {
      console.warn('[ADMIN] could not refresh the Zoho Salesperson copy:', syncErr.message);
    }
  } catch (err) {
    console.error('[ADMIN] could not read Zoho salespersons:', err.message);
    // Deliberately not cached: a failure should be retried on the next
    // request, not remembered for five minutes.
    return { at: 0, names: null, list: [] };
  }
  return salespersonCache;
}

/**
 * Check a list of Salesperson names against Zoho's live list and return Zoho's
 * own spellings — or the error to answer with.
 *
 * All or nothing: one unknown name refuses the whole list. Saving the rest
 * would leave the account with a list the admin never asked for, and an
 * unknown name is not rejected by Zoho later — it is CREATED there on the
 * first order, so it has to stop here.
 */
async function checkSalespersons(names) {
  const wanted = [];
  for (const raw of names || []) {
    const n = raw == null ? '' : String(raw).trim();
    if (n && !wanted.some((w) => w.toLowerCase() === n.toLowerCase())) wanted.push(n);
  }
  if (!wanted.length) return { names: [] };

  const { names: known, list } = await loadZohoSalespersons();
  // A null list means Zoho was unreachable. Refusing is the safe answer: the
  // cost of waiting is a retry, the cost of guessing is permanent.
  if (!known) {
    return {
      status: 503,
      error: { code: 'ZOHO_UNAVAILABLE', message: 'Could not reach Zoho to check those Salespersons. Try again in a moment.' }
    };
  }

  const spelling = new Map(list.map((s) => [s.name.toLowerCase(), s.name]));
  const unknown = wanted.filter((n) => !spelling.has(n.toLowerCase()));
  if (unknown.length) {
    return {
      status: 400,
      error: {
        code: 'UNKNOWN_SALESPERSON',
        message:
          `${unknown.map((n) => `"${n}"`).join(', ')} ${unknown.length === 1 ? 'is not a Salesperson' : 'are not Salespersons'} in Zoho. ` +
          'Pick from the list — a name Zoho does not know would be created there as a new Salesperson on their first order.'
      }
    };
  }
  return { names: wanted.map((n) => spelling.get(n.toLowerCase())) };
}

/**
 * GET /api/admin/salespersons — the list an admin picks from.
 *
 * Read-only towards Zoho. Exists so the choice is a picker rather than a text
 * box: a typed name that Zoho does not recognise is not rejected by Zoho, it
 * is CREATED there.
 */
const getSalespersons = async (req, res, next) => {
  try {
    // ?refresh=true is the Users page's "Refresh from Zoho" button.
    const { names, list } = await loadZohoSalespersons({ force: req.query.refresh === 'true' });
    if (!names) {
      return res.status(503).json({
        success: false,
        error: { code: 'ZOHO_UNAVAILABLE', message: 'Could not reach Zoho to load the Salesperson list.' }
      });
    }

    // Which ones are already spoken for, so an admin can see at a glance who
    // else holds a name before giving it to someone.
    //
    // Sep 11, 2026: a list of holders per name. An account can hold several
    // Salespersons and two accounts can share one, so "taken by" is no longer
    // one person. The UNION's second half covers an account whose single
    // Salesperson was written straight to users.salesperson with no rows.
    const taken = await db
      .prepare(
        `SELECT s.salesperson, u.name, u.email
           FROM user_salespersons s JOIN users u ON u.id = s.user_id
         UNION
         SELECT u.salesperson, u.name, u.email
           FROM users u
          WHERE u.salesperson IS NOT NULL AND u.salesperson <> ''
            AND NOT EXISTS (SELECT 1 FROM user_salespersons s WHERE s.user_id = u.id)`
      )
      .all();
    const byName = new Map();
    for (const t of taken) {
      const key = String(t.salesperson).toLowerCase();
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push({ name: t.name, email: t.email });
    }

    res.json({
      success: true,
      data: {
        salespersons: list.map((sp) => ({
          name: sp.name,
          is_active: sp.is_active,
          // Every account holding this name; empty when nobody does.
          assigned_to: byName.get(sp.name.toLowerCase()) || []
        })),
        // So the screen can say "and 97 more who have left" rather than making
        // someone count what the filter removed.
        active_count: list.filter((sp) => sp.is_active).length,
        inactive_count: list.filter((sp) => !sp.is_active).length,
        // Sep 11, 2026: when the list was last synced from Zoho, and what has
        // changed in it lately (added / renamed / deactivated / removed).
        sync: await zohoSalespersonSync.status().catch(() => null)
      }
    });
  } catch (err) {
    next(err);
  }
};

const update = async (req, res, next) => {
  try {
    const { role, is_active, salesperson } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });

    const blocked = adminProtection(user, { role, is_active });
    if (blocked) return refuseAdminChange(res, blocked);

    // Sep 11, 2026: the Salespersons an admin picked from Zoho's list.
    //
    // Not derived from division and display name any more — see the column
    // comment in schema.pg.sql. Checked against Zoho's actual list rather than
    // accepted as free text, because an unknown name does not fail on the
    // first order: LiveZohoAdapter.createSalesOrder CREATES the Salesperson,
    // so a typo becomes a permanent junk record in the company's org.
    //
    // Sep 11, 2026 (2): an account can hold SEVERAL (user_salespersons).
    //   salespersons: [...]         replaces the whole list
    //   primary_salesperson: 'X'    which of them is primary (default: first)
    //   salesperson: 'X' | null     the older single-value form — the list
    //                               becomes just X, or empty ("not decided yet")
    //
    // Checked BEFORE anything is written, so a bad name cannot leave the role
    // or active flag changed and the Salespersons not.
    let salespersonPlan = null;
    if (req.body.salespersons !== undefined) {
      if (!Array.isArray(req.body.salespersons)) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: 'salespersons must be a list of Zoho Salesperson names.' }
        });
      }
      salespersonPlan = { names: req.body.salespersons, primary: req.body.primary_salesperson ?? null };
    } else if (salesperson !== undefined) {
      salespersonPlan = { names: salesperson === null ? [] : [salesperson], primary: null };
    }

    let canonical = null;
    if (salespersonPlan) {
      const checked = await checkSalespersons(salespersonPlan.names);
      if (checked.error) return res.status(checked.status).json({ success: false, error: checked.error });
      canonical = checked.names;

      const primary = salespersonPlan.primary == null ? '' : String(salespersonPlan.primary).trim();
      if (primary && !canonical.some((n) => n.toLowerCase() === primary.toLowerCase())) {
        return res.status(400).json({
          success: false,
          error: {
            code: 'PRIMARY_NOT_IN_LIST',
            message: `The primary Salesperson "${primary}" has to be one of the account's Salespersons.`
          }
        });
      }
    }

    if (role !== undefined) await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role.toLowerCase(), user.id);
    if (is_active !== undefined) await db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, user.id);
    if (canonical) {
      await salespersonService.setForUser(user.id, canonical, {
        primary: salespersonPlan.primary,
        actorId: req.user.id
      });
    }

    const updated = await db.prepare('SELECT id, name, email, role, is_active, approval_status, created_at, salesperson FROM users WHERE id = ?').get(user.id);
    const salespersons = await salespersonService.listForUser(user.id);
    res.json({ success: true, data: { user: { ...updated, salespersons } } });
  } catch (err) {
    if (next) next(err);
    else res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/admin/zoho/queue — view the Zoho sync retry outbox
const getZohoQueue = async (req, res, next) => {
  try {
    const queue = await zohoRetryService.listQueue();
    res.json({
      success: true,
      data: {
        queue,
        summary: {
          pending: queue.filter((q) => q.status === 'pending').length,
          succeeded: queue.filter((q) => q.status === 'succeeded').length,
          failed_permanent: queue.filter((q) => q.status === 'failed_permanent').length
        }
      }
    });
  } catch (err) {
    if (next) return next(err);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
};

// POST /api/admin/zoho/queue/retry — trigger an immediate retry pass (ignores backoff window)
const retryZohoQueue = async (req, res, next) => {
  try {
    const results = await zohoRetryService.processQueue({ force: true });
    res.json({ success: true, data: { processed: results.length, results } });
  } catch (err) {
    if (next) return next(err);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
};

/**
 * POST /api/admin/users/:id/approve — let a self-service sign-up in.
 *
 * Sep 9, 2026. POST /api/auth/register created an account with
 * approval_status 'pending' and issued no token, so nobody who signed up could
 * do anything until this ran. See schema.pg.sql for why approval_status is its
 * own column rather than a reuse of is_active.
 *
 * Sep 11, 2026: sign-up has been removed, so nothing creates a pending account
 * any more. This and rejectUser stay for the ones already waiting.
 *
 * Idempotent: approving an already-approved account is a reported no-op, not a
 * 409. An admin double-clicking a button is not an error, and the outcome they
 * wanted is already true.
 */
const approveUser = async (req, res, next) => {
  try {
    const user = await db
      .prepare('SELECT id, name, email, approval_status FROM users WHERE id = ?')
      .get(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    if (user.approval_status === 'approved') {
      return res.json({ success: true, data: { user, changed: false } });
    }

    await db
      .prepare("UPDATE users SET approval_status = 'approved', approved_at = ?, approved_by = ? WHERE id = ?")
      .run(new Date().toISOString(), req.user.id, user.id);

    const updated = await db
      .prepare('SELECT id, name, email, role, is_active, approval_status, approved_at, approved_by FROM users WHERE id = ?')
      .get(user.id);

    res.json({ success: true, data: { user: updated, changed: true } });
  } catch (err) { next(err); }
};

/**
 * POST /api/admin/users/:id/reject — refuse a sign-up.
 *
 * Sep 9, 2026. Distinct from Deactivate, which switches off an account that
 * WAS approved. Both block the login; only this one records that the sign-up
 * was never accepted, which is what an admin reading the list a month later
 * needs to be able to tell.
 *
 * The row is kept rather than deleted, on purpose. The email stays taken, so
 * the same person signing up again gets "an account with that email already
 * exists" rather than quietly creating a second pending account — and the
 * decision stays on the record.
 *
 * Refuses to reject an ALREADY-APPROVED account: that is a Deactivate, and
 * doing something adjacent to what was asked is how an admin ends up surprised
 * by their own user list.
 */
const rejectUser = async (req, res, next) => {
  try {
    const user = await db
      .prepare('SELECT id, name, email, approval_status FROM users WHERE id = ?')
      .get(req.params.id);
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });
    }

    if (user.approval_status === 'approved') {
      return res.status(409).json({
        success: false,
        error: {
          code: 'ALREADY_APPROVED',
          message: 'This account has already been approved — use Deactivate to switch it off instead.'
        }
      });
    }

    await db
      .prepare("UPDATE users SET approval_status = 'rejected', approved_at = ?, approved_by = ? WHERE id = ?")
      .run(new Date().toISOString(), req.user.id, user.id);

    const updated = await db
      .prepare('SELECT id, name, email, role, is_active, approval_status, approved_at, approved_by FROM users WHERE id = ?')
      .get(user.id);

    res.json({ success: true, data: { user: updated } });
  } catch (err) { next(err); }
};

module.exports = {
  getAllUsers,
  getAll: getAllUsers,
  deactivateUser,
  // Sep 9, 2026: the sign-up approval queue — see the handlers above.
  approveUser,
  rejectUser,
  create,
  update,
  getSalespersons,
  getZohoQueue,
  retryZohoQueue
};

