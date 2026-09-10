const service = require('../services/salespersonMappingService');

/**
 * Sep 10, 2026: the review queue that decides who owns the Sales Orders
 * imported from Zoho. See services/salespersonMappingService.js for why this
 * is a human decision rather than a join.
 *
 * Admin AND management, not admin-only: the people who actually know which rep
 * is which are the sales leads, and making them ask an admin to click for them
 * is how a 171-row review never gets done.
 */

/** GET /api/salesperson-mappings — the review list, with suggestions. */
exports.list = async (req, res, next) => {
  try {
    res.json({ success: true, data: await service.listForReview() });
  } catch (err) { next(err); }
};

/**
 * PATCH /api/salesperson-mappings — record one decision.
 *
 * Deliberately does NOT apply it. Deciding and moving 30,000 orders are
 * separate actions with separate risks, and a reviewer working down a list of
 * 171 names should be able to change their mind on row 40 before anything has
 * been written to an order.
 */
exports.set = async (req, res, next) => {
  try {
    const { zoho_salesperson, user_id, kind, notes } = req.body || {};
    if (!zoho_salesperson || typeof zoho_salesperson !== 'string') {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'zoho_salesperson is required.' }
      });
    }

    const mapping = await service.setMapping({
      zohoSalesperson: zoho_salesperson,
      userId: user_id ?? null,
      kind: kind || 'undecided',
      notes: notes ?? null,
      actorId: req.user.id
    });

    res.json({ success: true, data: { mapping } });
  } catch (err) {
    if (err.code === 'VALIDATION_ERROR') {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: err.message } });
    }
    next(err);
  }
};

/**
 * POST /api/salesperson-mappings/apply — hand the orders over.
 *
 * Dry run by DEFAULT. `?confirm=true` is what actually writes. Reassigning
 * tens of thousands of orders is not something to trigger by loading a URL, so
 * the safe interpretation of a missing parameter is "show me, don't do it".
 */
exports.apply = async (req, res, next) => {
  try {
    const confirm = String(req.query.confirm || '').toLowerCase() === 'true';
    const result = await service.applyMappings({
      dryRun: !confirm,
      actorId: req.user.id,
      actorName: `${req.user.name || 'Admin'} (order assignment)`
    });
    res.json({ success: true, data: result });
  } catch (err) { next(err); }
};
