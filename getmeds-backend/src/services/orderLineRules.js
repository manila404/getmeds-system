'use strict';

/**
 * Line rules for orders raised or edited by a salesperson (MedRep / Team Lead). Nov 14, 2026 (Aaron).
 *
 * 1. One line per medicine: adding the same medicine again raises its quantity (the order form and
 *    Edit items do this). A second paid line of the same product is refused here too, so an old
 *    browser tab or a hand-made request cannot add one.
 * 2. No ₱0 prices: free goods come only from a Buy 1 Take 1 promo, whose free line the system adds
 *    (services/promoService.js). A ₱0 line is accepted only as that free line: the product is on an
 *    open promo (or already had its free line on this order) and the order has a paid line of it.
 *
 * Management / Admin are not checked: they may split a medicine across lines (e.g. warehouses) or
 * price a line at ₱0.
 */

const SALES_ROLES = new Set(['medrep', 'team_lead']);

function isSalespersonRole(role) {
  return SALES_ROLES.has(String(role || '').toLowerCase());
}

/**
 * Pure. `lines`: [{ product_id, name, unit_price }]. `freeAllowedIds`: product ids whose ₱0 line is
 * a promo free line. Returns a message to show, or null when the lines are fine.
 */
function salespersonLineProblem(lines, freeAllowedIds = new Set()) {
  const paid = new Map();
  const free = new Map();
  for (const l of lines) {
    const pid = Number(l.product_id);
    const bucket = Number(l.unit_price) > 0 ? paid : free;
    bucket.set(pid, { count: (bucket.get(pid)?.count || 0) + 1, name: l.name || `Product ${pid}` });
  }
  for (const { count, name } of paid.values()) {
    if (count > 1) return `${name} is on the order more than once. Put the whole quantity on one line.`;
  }
  for (const [pid, { count, name }] of free) {
    if (!freeAllowedIds.has(pid) || !paid.has(pid) || count > 1) {
      return `The price of ${name} cannot be ₱0. Only Management can give an item for free; Buy 1 Take 1 free lines are added automatically.`;
    }
  }
  return null;
}

module.exports = { isSalespersonRole, salespersonLineProblem };
