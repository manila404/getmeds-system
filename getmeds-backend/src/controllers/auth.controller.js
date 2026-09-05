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
        `INSERT INTO users
           (name, email, password_hash, role, first_name, middle_name, last_name, display_name, division, sub_division)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
                display_name, division, sub_division, salesperson
         FROM users WHERE id = ?`
      )
      .get(result.lastInsertRowid);

    const token = issueToken(user);
    res.status(201).json({ success: true, data: { token, user } });
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

// Exported for the tests and for anything that needs to describe the policy
// without duplicating how it is parsed.
exports._signupPolicy = { isSignupEnabled, allowedEmailDomains, SIGNUP_ROLE, MIN_PASSWORD_LENGTH };
