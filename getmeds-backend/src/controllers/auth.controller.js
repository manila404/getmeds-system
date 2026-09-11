require('dotenv').config();
const db = require('../db/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'getmeds_secret_change_in_production';

// Sep 11, 2026: public self-service sign-up (POST /api/auth/register) is gone.
// Every account is now created by an admin through POST /api/admin/users (see
// admin.controller.js), which is behind requireAuth + isAdmin, and the admin
// hands the login to the person. There is no unauthenticated write endpoint in
// this API any more.
//
// Shared by changePassword() below and admin.controller.js's create().
const MIN_PASSWORD_LENGTH = 8;

// Sep 5, 2026: the fixed list of Divisions this org actually uses, given by
// the user.
//
// Sep 11, 2026: `division` no longer feeds `users.salesperson`. That column
// used to be GENERATED as "<division> | <display name>", and the enum here
// existed partly to keep the generated value clean. The Salesperson is now
// assigned by an admin from Zoho's own list instead — see the column comment
// in schema.pg.sql for why a formula could never get it right.
//
// The enum stays, for its own sake: division is a real attribute of an
// account, it is reported on, and free text would give "B2B", "b2b" and
// "B2B " as three divisions.
// Kept in the exact order given, and mirrored in the frontend's
// src/constants/divisions.js (Profile Settings and the admin's Create account
// form render it as a dropdown); scripts/create-user.js imports it. Enforced
// here AND in each of those, same pattern as
// INVOICING_FROM_OPTIONS in orders.controller.js/OrderForm.jsx.
//
// Deliberately NOT a DB CHECK constraint: existing rows already hold values
// outside this list (the seeded accounts' division is 'TEST', and
// create-user.js's own docstring example was 'NCR') and a hard constraint
// would refuse to migrate against them. This is enforced only at the point
// a human TYPES A NEW value — see updateProfile() below and
// admin.controller.js's create().
// Sep 9, 2026: '2MG Incorporated', 'Office of the President', 'PCSO', 'DSWD'
// and 'GrabMart' removed at the user's request. Verified against the live
// database first: no user and no order carried any of the five, so nothing
// existing is stranded on a value this list no longer accepts.
//
// That check matters because `division` has no CHECK constraint — the column
// keeps whatever was written to it, and validation happens only on the way in
// (auth.controller.js at sign-up/profile, orders.controller.js at create and
// at PATCH /:id/details). A row already holding a removed value would keep
// working everywhere except the next save, which would then refuse it with
// "division must be one of ..." for a value the account already has.
// Sep 10, 2026: 'TeleSales', 'MD Telesales' and 'PS' added.
//
// Not new business units — they were already in use in Zoho and always had
// been. Found while auditing the 171 distinct Salesperson strings on the
// 60,817 imported Sales Orders: 'TeleSales | ...' accounts for 1,041 of them,
// 'MD Telesales l ...' for 26 and 'PS | ...' for 6. Reps in those divisions
// could sign up under no Division at all, or under a wrong one, which would
// then be the Division their orders carried to Zoho.
//
// Ordered after the ten that were already here rather than alphabetically, so
// the diff reads as "three added" rather than a reshuffle.
const DIVISIONS = [
  'B&B',
  'B2B',
  'B2C',
  'BID',
  'CLIDP',
  'HOS',
  'MSA',
  'STC',
  'TeleSales Anesthesia',
  'URO',
  'TeleSales',
  'MD Telesales',
  'PS',
];

// Sep 5, 2026 (2): fixed Sub-division lists, given by the user, for the only
// four Divisions that actually have named branches/sub-divisions. Every
// other Division in DIVISIONS above has no such list — sub_division stays
// free text there, exactly as it was before this change, since there is
// nothing to validate it against.
//
// Unlike Division, sub_division does NOT feed `users.salesperson` — it is
// its own plain-text custom field on the Zoho Sales Order
// (LiveZohoAdapter.createSalesOrder's cf_sub_division, customfield_id
// 2254168002003349006), so a typo here does not create a junk Salesperson.
// It's still made an enum for the same underlying reason Division is one:
// consistent values per branch instead of "NCL" / "N.C.L." / "ncl" all
// meaning the same thing in Zoho's reports.
//
// Mirrored in the frontend's src/constants/divisions.js — same duplication
// pattern as DIVISIONS above.
//
// Sep 9, 2026: SUGGESTIONS only, never validated against. Checking the value
// turned the field into a closed dropdown for these four Divisions — worst for
// HOS, whose list is the longest and least complete. Real reps cover several
// sub-divisions and the lists were never exhaustive, so the check was
// rejecting true answers. The UI offers them in a datalist instead, and
// nothing downstream parses the value: it reaches Zoho's cf_sub_division as
// typed, so "GENSAN, BAGUIO" is as valid there as "GENSAN".
const SUB_DIVISIONS_BY_DIVISION = {
  'B&B': ['CEBU', 'DAVAO', 'E. RODRIGUEZ', 'EAST AVE', 'NCL', 'SOUTH LUZON', 'TAFT'],
  HOS: [
    'GENSAN',
    'PALAWAN',
    'BAGUIO',
    'BICOL',
    'CABANATUAN',
    'CAMANAVA',
    'CAVITE',
    'CDO',
    'COMMONWEALTH',
    'DAVAO NORTH',
    'DAVAO SOUTH',
    'ILOILO',
    'LAGUNA',
    'LAS PINAS',
    'MANILA VACANT',
    'MARIKINA',
    'NORTH CEBU',
    'PAMPANGA',
    'PARANAQUE',
    'PASAY',
    'QUEZON PROVINCE',
    'SOUTH CEBU',
    'TUGUEGARAO',
    'ZAMBOANGA',
  ],
  STC: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
  URO: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
};

function issueToken(user) {
  return jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '8h' });
}

exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Email and password required' } });
    }
    // Sep 5, 2026: case-insensitive match on both sides. seed.js/create-user.js/
    // register() all lowercase the email before INSERT, but POST /api/admin/users
    // does not (see admin.controller.js) — so a mixed-case stored email is a real
    // possibility, not just a hypothetical. Postgres `=` on text is
    // case-sensitive (this app ran on SQLite until Sep 2-3, where the same exact
    // mismatch could already occur depending on collation), so a login typed
    // with different casing than what's stored silently failed as
    // INVALID_CREDENTIALS for a perfectly real account. LOWER() on both sides
    // is correct regardless of which side (or neither) happens to be normalized.
    const user = await db.prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?) AND is_active = 1').get((email || '').trim());
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ success: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } });
    }

    // Sep 9, 2026: the approval gate.
    //
    // Checked AFTER the password, deliberately. Checking it first would turn
    // this endpoint into a way to discover which email addresses have signed
    // up — "waiting for approval" and "invalid email or password" are
    // different answers, and only a correct password should earn the specific
    // one.
    //
    // Sep 11, 2026: sign-up is gone, so no new account arrives pending — an
    // admin creates it approved. This stays for the sign-ups that were still
    // pending (or rejected) when it was removed.
    if (user.approval_status && user.approval_status !== 'approved') {
      const pending = user.approval_status === 'pending';
      return res.status(403).json({
        success: false,
        error: {
          code: pending ? 'PENDING_APPROVAL' : 'SIGNUP_REJECTED',
          message: pending
            ? 'Your account is waiting for an administrator to approve it. You will be able to sign in once it has been approved.'
            : 'This sign-up was not approved. Please contact your administrator.'
        }
      });
    }

    const token = issueToken(user);
    res.json({
      success: true,
      data: {
        token,
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          // Sep 2, 2026: same set requireAuth attaches, so a session started
          // by logging in and one restored from /api/auth/me carry the same
          // fields. Without this the New Order form's Salesperson would be
          // blank until the next page reload.
          salesperson: user.salesperson || null,
          division: user.division || null,
          sub_division: user.sub_division || null
        }
      }
    });
  } catch (err) {
    next(err);
  }
};

exports.me = (req, res) => {
  res.json({ success: true, data: { user: req.user } });
};

/**
 * PATCH /api/auth/profile — a signed-in user edits their own account.
 *
 * Sep 5, 2026. First piece of "Profile Settings". Deliberately scoped to
 * just the two fields that actually drive something else in the system.
 *
 * Sep 11, 2026: editing these NO LONGER changes the Salesperson. It used to:
 * `salesperson` was GENERATED from division and display name, so renaming
 * yourself here silently changed the name on every Sales Order you sent to
 * Zoho — and, since Zoho creates an unknown Salesperson rather than rejecting
 * it, could mint a new one in the company's org from a profile edit. It is now
 * set by an admin from Zoho's list and is untouched by this endpoint.
 *
 * `name` is written alongside `display_name` for the same reason
 * admin.controller.js's create() does it — most of the frontend renders
 * `user.name`, not `display_name`.
 *
 * First/middle/last name (the legal name parts set when the account is
 * created) are
 * deliberately NOT editable here — only the display name that's actually
 * shown and that feeds the Salesperson string. Email is not editable here
 * either: it's the login identifier and changing it safely needs its own
 * verification step, which is out of scope for this first pass.
 */
exports.updateProfile = async (req, res, next) => {
  try {
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const displayName = str(req.body.display_name);
    const division = str(req.body.division);
    const subDivision = str(req.body.sub_division);

    const missing = [];
    if (!displayName) missing.push('display name');
    if (!division) missing.push('division');
    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Required: ${missing.join(', ')}.`, fields: missing }
      });
    }

    // Sep 5, 2026: division must be one of the fixed list (see DIVISIONS
    // above) UNLESS it's exactly what this account already had — an account
    // with a legacy off-list value (e.g. the seeded accounts' 'TEST') can
    // still save the rest of this form without being forced to pick a new
    // division it doesn't actually have, but cannot be moved to a NEW
    // off-list value.
    //
    // Sep 5, 2026 (2): one lazily-fetched row, shared with the sub-division
    // check right below — both checks only need it when they've already
    // found a problem, so a well-formed save (the common case) never queries
    // for it at all.
    let currentRow = null;
    const getCurrentRow = async () => {
      if (!currentRow) {
        currentRow = (await db.prepare('SELECT division, sub_division FROM users WHERE id = ?').get(req.user.id)) || {};
      }
      return currentRow;
    };

    if (!DIVISIONS.includes(division)) {
      const current = await getCurrentRow();
      if (division !== (current.division || '')) {
        return res.status(400).json({
          success: false,
          error: { code: 'VALIDATION_ERROR', message: `Division must be one of: ${DIVISIONS.join(', ')}` }
        });
      }
    }

    // Sep 9, 2026: sub-division is free text here too — see
    // SUB_DIVISIONS_BY_DIVISION above for why. The "keep a legacy value, refuse a new off-list one" carve-out
    // that used to live here is gone with the restriction it was working
    // around: when every value is accepted, there is no such thing as a legacy
    // one to protect.

    await db
      .prepare('UPDATE users SET name = ?, display_name = ?, division = ?, sub_division = ? WHERE id = ?')
      .run(displayName, displayName, division, subDivision || null, req.user.id);

    // Returned so the frontend can drop this
    // straight into its user state without a separate /me round trip if it
    // ever wants to.
    const user = await db
      .prepare(
        `SELECT id, name, email, role, first_name, middle_name, last_name,
                display_name, division, sub_division, salesperson
           FROM users WHERE id = ?`
      )
      .get(req.user.id);

    res.json({ success: true, data: { user } });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/auth/password — a signed-in user changes their own password.
 *
 * Requires the current password, checked against the stored hash, so a
 * hijacked-but-still-logged-in session cannot silently lock the real owner
 * out by changing it to something only the attacker knows. Same
 * MIN_PASSWORD_LENGTH as account creation. Does not re-issue a token — the JWT only
 * carries id/role, neither of which this touches, so the current session
 * stays valid exactly as it was.
 */
exports.changePassword = async (req, res, next) => {
  try {
    const currentPassword = typeof req.body.current_password === 'string' ? req.body.current_password : '';
    const newPassword = typeof req.body.new_password === 'string' ? req.body.new_password : '';

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'Current password and new password are required.' }
      });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` }
      });
    }

    // req.user (from requireAuth) never carries password_hash — fetched
    // fresh here rather than widening what every authenticated request
    // pulls back just for this one, rarely-used endpoint.
    const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!row || !bcrypt.compareSync(currentPassword, row.password_hash)) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_CREDENTIALS', message: 'Current password is incorrect.' }
      });
    }
    if (bcrypt.compareSync(newPassword, row.password_hash)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'New password must be different from your current password.' }
      });
    }

    const hash = bcrypt.hashSync(newPassword, 10);
    await db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);

    res.json({ success: true, data: { message: 'Password updated.' } });
  } catch (err) {
    next(err);
  }
};

// Sep 11, 2026: admin.controller.js's create() enforces the same minimum.
exports.MIN_PASSWORD_LENGTH = MIN_PASSWORD_LENGTH;
exports.DIVISIONS = DIVISIONS;
exports.SUB_DIVISIONS_BY_DIVISION = SUB_DIVISIONS_BY_DIVISION;
