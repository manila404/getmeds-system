const jwt = require('jsonwebtoken');
const db = require('../db/database');

const SECRET = process.env.JWT_SECRET || 'getmeds_secret_change_in_production';

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'No token provided' } });
  }
  const token = header.split(' ')[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    // Refresh user from DB to pick up role/active changes
    // Sep 2, 2026: `salesperson` joins the set every authenticated request
    // carries. It is the generated "<division> | <display name>" from
    // sign-up, and it is what LiveZohoAdapter puts on the Sales Order — so
    // the New Order form showing it needs no extra round trip, and what a
    // MedRep reads on screen is the value that actually reaches Zoho.
    // Division and sub_division come along for the same reason: this org's
    // Sales Order screen has them as their own fields beside Salesperson, so
    // the order form shows all three, and all three come from one row.
    // NULL for accounts created before sign-up collected a division.
    const user = await db
      .prepare('SELECT id, name, email, role, is_active, approval_status, salesperson, division, sub_division FROM users WHERE id = ?')
      .get(decoded.id);
    // Sep 9, 2026: approval_status is re-read on EVERY request rather than
    // trusted from the token. A token is good for 8 hours; an admin who
    // rejects an account should not have to wait out the rest of that window
    // for it to stop working.
    if (!user || !user.is_active || (user.approval_status && user.approval_status !== 'approved')) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'User not found or inactive' } });
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token' } });
  }
}

/**
 * Sep 10, 2026: a MedRep may LOOK at an order imported from Zoho, but not
 * touch it.
 *
 * The Zoho import handed reps their historical Sales Orders so they can see
 * their own record — 60,817 orders, some going back to 2024. Those are
 * finished business that lives in Zoho, and this app is not where they get
 * edited. Without this guard an imported order sitting at 'so_created' would
 * be as editable to its owner as one they raised this morning, and an edit
 * here would silently diverge from the Zoho record everyone else works from.
 *
 * Scoped as narrowly as it can be:
 *   * MedReps only. Management and admin still act on these orders — they run
 *     the process, and someone has to be able to fix a bad import.
 *   * Imported orders only (getmeds_order_id LIKE 'ZOHO-%'). An order a rep
 *     raised in this app is untouched by this.
 *   * Mutating routes only. Every GET stays open, which is the entire point —
 *     they can see everything and change nothing.
 *
 * 403 rather than 404: pretending the order does not exist would be a lie to
 * the one person it belongs to, and they can see it on the very next screen.
 */
async function blockMedrepWritesOnImported(req, res, next) {
  try {
    if ((req.user?.role || '').toLowerCase() !== 'medrep') return next();

    const order = await db
      .prepare('SELECT getmeds_order_id FROM orders WHERE id = ?')
      .get(req.params.id);
    if (!order) return next(); // let the controller answer 404 in its own words

    if (String(order.getmeds_order_id || '').startsWith('ZOHO-')) {
      return res.status(403).json({
        success: false,
        error: {
          code: 'IMPORTED_ORDER_READ_ONLY',
          message:
            'This order was imported from Zoho and is read-only here. It can be viewed but not changed — ' +
            'make changes in Zoho, or ask Management if something looks wrong.'
        }
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

// Middleware to check if the authenticated user is an Admin
const isAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ 
      success: false, 
      message: 'Authentication required. No active session found.' 
    });
  }

  const role = (req.user.role || req.user.role_name || '').toLowerCase();
  if (role !== 'admin') {
    return res.status(403).json({ 
      success: false, 
      message: 'Access denied. Admin privileges required.' 
    });
  }

  next();
};

const { isTestModeEnabled } = require('./testMode');

function requireRole(...roles) {
  const normalized = roles.map(r => r.toLowerCase());
  return (req, res, next) => {
    const userRole = (req.user?.role || req.user?.role_name || '').toLowerCase();
    
    // When TEST_MODE=true, allow Admin users to access and execute any role action
    if (isTestModeEnabled() && userRole === 'admin') {
      return next();
    }

    if (!req.user || !normalized.includes(userRole)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: `Access restricted to: ${roles.join(', ')}` }
      });
    }
    next();
  };
}

module.exports = { 
  requireAuth, 
  verifyToken: requireAuth, 
  requireRole, 
  isAdmin,
  // Sep 10, 2026: MedReps can view imported Zoho orders, not edit them.
  blockMedrepWritesOnImported,
};

