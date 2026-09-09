require('dotenv').config();
const db = require('../db/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'getmeds_secret_change_in_production';

// Sign-up policy (Sep 2, 2026). Both are env-driven so the rules can be
// changed for a deployment without touching this file.
const SIGNUP_DEFAULT_DOMAINS = 'getmeds.ph';
const MIN_PASSWORD_LENGTH = 8;

// The role a sign-up gets. Deliberately a constant and NOT read from the
// request body: a public endpoint that let the caller name their own role
// would let anyone who reaches the page mint themselves an admin account.
// Finance, Dispatch, Management and Admin accounts are created by an admin
// through POST /api/admin/users (see admin.controller.js) — that path is
// behind requireAuth + isAdmin and is where role is a real choice.
const SIGNUP_ROLE = 'medrep';

// Sep 5, 2026: the fixed list of Divisions this org actually uses, given by
// the user. `division` feeds `users.salesperson` — a GENERATED column
// reading "<division> | <display name>" that LiveZohoAdapter puts on every
// Sales Order — and a free-typed division created junk Salespersons in the
// live Zoho org before this (see working-agreements.md's "Design defaults"
// section: "Enums over free text ... division taught this on Sep 2").
// Kept in the exact order given, and mirrored on SignupPage.jsx and
// ProfilePage.jsx (both render it as a dropdown) and scripts/create-user.js
// — enforced here AND in each of those, same pattern as
// INVOICING_FROM_OPTIONS in orders.controller.js/OrderForm.jsx.
//
// Deliberately NOT a DB CHECK constraint: existing rows already hold values
// outside this list (the seeded accounts' division is 'TEST', and
// create-user.js's own docstring example was 'NCR') and a hard constraint
// would refuse to migrate against them. This is enforced only at the point
// a human TYPES A NEW value — see register() and updateProfile() below.
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
// Mirrored on SignupPage.jsx and ProfilePage.jsx (both render it as a
// dropdown, keyed off whichever Division is currently selected, falling
// back to free text for a Division not in this map) — same duplication
// pattern as DIVISIONS above.
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

function isSignupEnabled() {
  return (process.env.SIGNUP_ENABLED || 'true').trim().toLowerCase() !== 'false';
}

// Comma-separated, '@' optional, case-insensitive: "getmeds.ph, example.com".
// An empty value means "no domain restriction" — has to be set deliberately.
function allowedEmailDomains() {
  const raw = process.env.SIGNUP_ALLOWED_EMAIL_DOMAINS;
  const value = raw === undefined ? SIGNUP_DEFAULT_DOMAINS : raw;
  return value
    .split(',')
    .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
}

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

/**
 * POST /api/auth/register — public self-service sign-up.
 *
 * Sep 2, 2026. Added so MedReps can create their own accounts instead of
 * everyone sharing the seeded demo logins (which all carry the password
 * `demo123` and were never meant to leave a dev machine).
 *
 * Three properties this endpoint holds on purpose:
 *
 *  1. The new account is ALWAYS a medrep. `req.body.role` is ignored
 *     entirely — see SIGNUP_ROLE above.
 *  2. The email domain must be on the allow-list (default: getmeds.ph), so a
 *     stray address that happens to find the page cannot create an account.
 *  3. It is active immediately and gets a token straight back, so signing up
 *     logs you in — same response shape as /login, so the frontend reuses
 *     exactly the same handling.
 *
 * SIGNUP_ENABLED=false turns the whole thing off (403) without a deploy —
 * worth doing if accounts are ever created some other way.
 *
 * Sep 2, 2026 (2) — name parts, division, and the Salesperson string:
 *   The form collects first/middle/last, a display name, and a division +
 *   optional sub-division. `users.salesperson` is NOT written here: it is a
 *   GENERATED column in schema.sql that always reads
 *   "<division> | <display name>" (e.g. "TEST | Aaron Manila"). Writing it
 *   would be the start of it drifting, so it is computed by the database and
 *   only ever read back.
 *
 *   That string exists because this Zoho org has "Salesperson" configured as
 *   a MANDATORY field on every Sales Order — see the long note in
 *   LiveZohoAdapter.createSalesOrder, which currently stamps a single
 *   stand-in ("TEST | MEDREP") on TestGM- orders because no per-MedRep
 *   mapping existed yet. This is that mapping's local half. Wiring it into
 *   the outgoing Sales Order payload is a separate, deliberate change.
 *
 *   `name` is set from the display name rather than retired, because the
 *   whole frontend already renders user.name.
 *
 * Nothing here touches Zoho. A user is a purely local record; the Zoho
 * adapter has no concept of one and no method that could create it.
 */
exports.register = async (req, res, next) => {
  try {
    if (!isSignupEnabled()) {
      return res.status(403).json({
        success: false,
        error: { code: 'SIGNUP_DISABLED', message: 'Sign-up is currently disabled. Ask an administrator to create your account.' }
      });
    }

    const str = (v) => (typeof v === 'string' ? v.trim() : '');

    const firstName = str(req.body.first_name);
    const middleName = str(req.body.middle_name);
    const lastName = str(req.body.last_name);
    const division = str(req.body.division);
    const subDivision = str(req.body.sub_division);
    const email = str(req.body.email).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    // The form pre-fills this from first + last but lets it be edited (a rep
    // known as "Bong" should not have to sign up as "Rogelio"), so fall back
    // to first + last rather than refusing when the client omits it.
    const displayName = str(req.body.display_name) || [firstName, lastName].filter(Boolean).join(' ');

    const missing = [];
    if (!firstName) missing.push('first name');
    if (!lastName) missing.push('last name');
    if (!displayName) missing.push('display name');
    if (!division) missing.push('division');
    if (!email) missing.push('email');
    if (!password) missing.push('password');

    if (missing.length) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: `Required: ${missing.join(', ')}.`,
          fields: missing
        }
      });
    }

    // Deliberately loose: one @, no spaces, a dot in the domain. The domain
    // allow-list below is the real gate; this only catches obvious typos.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'That does not look like a valid email address' }
      });
    }

    // Sep 5, 2026: division must be one of the fixed list — see DIVISIONS
    // above for why this is an enum now rather than free text.
    if (!DIVISIONS.includes(division)) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Division must be one of: ${DIVISIONS.join(', ')}` }
      });
    }

    // Sep 5, 2026 (2): sub-division is only constrained for the four
    // Divisions that have a fixed list (SUB_DIVISIONS_BY_DIVISION above).
    // Every other Division has no list, so any non-blank value is accepted
    // there, same as before this change. Still optional everywhere — a
    // blank sub-division is never rejected.
    // Sep 9, 2026: sub-division is FREE TEXT, and may name more than one.
    //
    // It used to be checked against SUB_DIVISIONS_BY_DIVISION, which turned
    // the field into a closed dropdown for the four Divisions that have a
    // list — worst for HOS, whose list is the longest and least complete. Real
    // reps cover several sub-divisions and the lists were never exhaustive, so
    // the validation was rejecting true answers.
    //
    // Those lists survive as SUGGESTIONS in the UI (a datalist, not a
    // <select>), which keeps the convenience without the refusal. Nothing
    // downstream parses this value: it reaches Zoho's cf_sub_division as typed
    // (a plain text custom field), so "GENSAN, BAGUIO" is as valid there as
    // "GENSAN".

    const domains = allowedEmailDomains();
    if (domains.length) {
      const domain = email.split('@')[1];
      if (!domains.includes(domain)) {
        return res.status(403).json({
          success: false,
          error: {
            code: 'EMAIL_DOMAIN_NOT_ALLOWED',
            message: `Sign-up is limited to ${domains.map((d) => `@${d}`).join(', ')} email addresses.`
          }
        });
      }
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }
      });
    }

    const existing = await db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_IN_USE', message: 'An account with that email already exists. Try signing in instead.' }
      });
    }

    const hash = bcrypt.hashSync(password, 10);
    // `salesperson` is absent from this INSERT on purpose — it is a GENERATED
    // column and SQLite refuses to be told what it should contain.
    const result = await db
      .prepare(
        // Sep 9, 2026: `approval_status` is written EXPLICITLY as 'pending'.
        // The column DEFAULTS to 'approved' so that adding it to a live
        // database does not lock every existing account out (see
        // schema.pg.sql) — which means this is the one place that has to say
        // otherwise, and relying on the default here would silently approve
        // every self-service sign-up.
        `INSERT INTO users
           (name, email, password_hash, role, first_name, middle_name, last_name, display_name, division, sub_division, approval_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
      )
      .run(
        displayName, // keeps user.name, which the whole frontend renders, meaningful
        email,
        hash,
        SIGNUP_ROLE,
        firstName,
        middleName || null,
        lastName,
        displayName,
        division,
        subDivision || null
      );

    const user = await db
      .prepare(
        `SELECT id, name, email, role, first_name, middle_name, last_name,
                display_name, division, sub_division, salesperson, approval_status
         FROM users WHERE id = ?`
      )
      .get(result.lastInsertRowid);

    // Sep 9, 2026: NO TOKEN is issued here any more.
    //
    // This endpoint used to sign the applicant straight in, which is exactly
    // what admin approval exists to prevent: an account able to raise orders
    // the moment it is created, before anyone has confirmed the person is real
    // or that the Division and Salesperson they typed are right — and that
    // Salesperson is what every one of their orders sends to Zoho.
    //
    // They are told what happens next instead. `token` is absent rather than
    // null: a client that reads it and stores whatever it finds would
    // otherwise end up with a session of `null`.
    res.status(201).json({
      success: true,
      data: {
        user,
        approval_status: user.approval_status,
        message:
          'Your account has been created and is waiting for an administrator to approve it. ' +
          'You will be able to sign in once it has been approved.'
      }
    });
  } catch (err) {
    // A UNIQUE violation can still land here if two sign-ups race between the
    // SELECT above and the INSERT. Report it as the conflict it is rather
    // than as a 500.
    if (err && /UNIQUE constraint failed: users\.email/i.test(err.message || '')) {
      return res.status(409).json({
        success: false,
        error: { code: 'EMAIL_IN_USE', message: 'An account with that email already exists. Try signing in instead.' }
      });
    }
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
 * just the two fields that actually drive something else in the system:
 * `salesperson` is a GENERATED column ("<division> | <display name>", the
 * value LiveZohoAdapter puts on every Sales Order — see the long note on
 * register() above) and recomputes itself the instant either of these
 * changes, with no extra code needed here. `name` is written alongside
 * `display_name` for the same reason register() does it — most of the
 * frontend renders `user.name`, not `display_name`.
 *
 * First/middle/last name (the legal name parts sign-up collects) are
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

    // Sep 9, 2026: sub-division is free text here too — see register() above
    // for why. The "keep a legacy value, refuse a new off-list one" carve-out
    // that used to live here is gone with the restriction it was working
    // around: when every value is accepted, there is no such thing as a legacy
    // one to protect.

    await db
      .prepare('UPDATE users SET name = ?, display_name = ?, division = ?, sub_division = ? WHERE id = ?')
      .run(displayName, displayName, division, subDivision || null, req.user.id);

    // Same projection register() returns, so the frontend can drop this
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
 * MIN_PASSWORD_LENGTH as sign-up. Does not re-issue a token — the JWT only
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

// Exported for the tests and for anything that needs to describe the policy
// without duplicating how it is parsed.
exports._signupPolicy = { isSignupEnabled, allowedEmailDomains, SIGNUP_ROLE, MIN_PASSWORD_LENGTH };
exports.DIVISIONS = DIVISIONS;
exports.SUB_DIVISIONS_BY_DIVISION = SUB_DIVISIONS_BY_DIVISION;
