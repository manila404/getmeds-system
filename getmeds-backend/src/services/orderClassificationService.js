'use strict';

const { isKnownCspProductName } = require('../constants/cspCatalog');

const ENTITY_KEY_BY_INVOICING_FROM = Object.freeze({
  '2mg incorporated': '2MG',
  '2mg': '2MG',
  'getmeds philippines inc.': 'GPI',
  'getmeds philippines inc': 'GPI',
  gpi: 'GPI'
});

const PAP_SOURCES = new Set(['pcso', 'iapf', 'dswd', 'office of the president']);
const HOSPITAL_B2B_SOURCES = new Set(['hospital po', 'distributor order', 'bidding order']);
const HOSPITAL_B2B_DIVISIONS = new Set(['b2b', 'bid', 'clidp', 'hos']);
const PAP_GL_REGEX = /\b(pcso|gl|guarantee\s*letter|dswd|iapf|office\s+of\s+the\s+president)\b/i;

/**
 * Normalize an entity label ("2mg Incorporated", "Getmeds Philippines Inc.") to its
 * short ledger/invoice prefix ("2MG" | "GPI"), or null if unrecognized.
 */
function normalizeEntityKey(invoicingFrom) {
  const raw = String(invoicingFrom || '').trim().toLowerCase();
  if (!raw) return null;
  return ENTITY_KEY_BY_INVOICING_FROM[raw] || null;
}

/**
 * Format an Oojeema SI suffix (e.g. "SI000004987" or "4987") into Zoho's
 * observed invoice_number format: "<ENTITY>-SI..." (e.g. "2MG-SI000004987").
 */
function formatEntitySiNumber(entityKey, rawSi) {
  const ent = normalizeEntityKey(entityKey);
  if (!ent) {
    throw new Error(`Invalid entityKey "${entityKey}" — expected 2MG or GPI.`);
  }
  const cleaned = String(rawSi || '').trim();
  if (!cleaned) {
    throw new Error('Oojeema SI number cannot be empty.');
  }
  const prefixRe = new RegExp(`^${ent}\\s*-\\s*`, 'i');
  const stripped = cleaned.replace(prefixRe, '').trim();
  if (!stripped) {
    throw new Error('Oojeema SI number is missing the SI value after entity prefix.');
  }
  return `${ent}-${stripped}`;
}

/**
 * Determine which entities ("2MG" / "GPI") an order bills across when split
 * invoicing is active or when a single entity applies.
 */
function getOrderEntityKeys({ order = {}, items = [], splits = [] } = {}) {
  const keys = new Set();
  const primary = normalizeEntityKey(order.invoicing_from);
  if (primary) keys.add(primary);
  for (const s of splits) {
    const k = normalizeEntityKey(s.invoicing_from);
    if (k) keys.add(k);
  }
  for (const it of items) {
    const k = normalizeEntityKey(it.invoicing_from);
    if (k) keys.add(k);
  }
  return Array.from(keys);
}

/**
 * Classify a single order using operational dispatch rules:
 *  - Doctors: No SI, No DR
 *  - Standard Patients: No SI, No DR (keep Zoho auto invoice) unless GL/PCSO/Office of the President/override
 *  - PAP / GL / PCSO / Office of the President: Requires SI + DR
 *  - B2B / Hospitals / Distributors / Bidding: Requires SI + DR
 *  - CSP (product-driven): Sales Order still syncs Hub -> Zoho, Dispatch skips printing SO
 */
function classifyOrder({ order = {}, customer = {}, items = [], paymentProofs = [], splits = [] } = {}) {
  const cspItems = items
    .filter((it) => Number(it.is_csp) === 1 || it.is_csp === true || isKnownCspProductName(it.product_name || it.name))
    .map((it) => ({
      order_item_id: it.id || null,
      product_id: it.product_id || null,
      name: it.product_name || it.name || ''
    }));

  const isCsp = Number(order.is_csp) === 1 || order.is_csp === true || cspItems.length > 0;
  const skipSoPrint = isCsp;
  const primaryEntity = normalizeEntityKey(order.invoicing_from);
  const entityKeys = getOrderEntityKeys({ order, items, splits });

  const source = String(order.intake_source || '').trim().toLowerCase();
  const division = String(order.division || '').trim().toLowerCase();
  const custCat = String(customer?.category || order.customer_category || '').trim().toLowerCase();
  const hasGlNumber = Boolean(String(order.intake_gl_number || '').trim());
  const hasGlProof = paymentProofs.some((p) => String(p.file_type || '').toLowerCase() === 'gl');
  const glInText = PAP_GL_REGEX.test(`${order.intake_payment_terms || ''} ${order.delivery_notes || ''}`);

  let transactionKind = 'patient';
  let defaultRequiresSi = false;
  let classificationReason = 'Standard patient order (keeps Zoho auto-invoice; no DR required)';

  if (PAP_SOURCES.has(source) || division === 'pap' || hasGlNumber || hasGlProof || glInText) {
    transactionKind = 'pap_gl';
    defaultRequiresSi = true;
    classificationReason = 'PAP / PCSO / Guarantee Letter / Office of the President order requires Oojeema SI + DR';
  } else if (custCat === 'hospital' || source === 'hospital po' || division === 'hos') {
    transactionKind = 'hospital';
    defaultRequiresSi = true;
    classificationReason = 'Hospital order requires Oojeema SI + DR';
  } else if (
    custCat === 'distributor' ||
    HOSPITAL_B2B_SOURCES.has(source) ||
    HOSPITAL_B2B_DIVISIONS.has(division)
  ) {
    transactionKind = 'b2b';
    defaultRequiresSi = true;
    classificationReason = 'B2B / Distributor / Bidding order requires Oojeema SI + DR';
  } else if (
    custCat === 'doctor' ||
    Number(order.intake_is_doctor) === 1 ||
    source === 'doctor order' ||
    division === 'md telesales'
  ) {
    transactionKind = 'doctor';
    defaultRequiresSi = false;
    classificationReason = 'Doctor order does not require Oojeema SI or DR';
  }

  const hasExplicitOverride = order.requires_si !== null && order.requires_si !== undefined;
  const requiresSi = hasExplicitOverride
    ? (order.requires_si === true || Number(order.requires_si) === 1)
    : defaultRequiresSi;

  const hasDrOverride = order.requires_dr !== null && order.requires_dr !== undefined;
  const requiresDr = hasDrOverride
    ? (order.requires_dr === true || Number(order.requires_dr) === 1)
    : requiresSi;

  return {
    transaction_kind: transactionKind,
    requires_si: requiresSi,
    requires_dr: requiresDr,
    has_override: hasExplicitOverride,
    override_reason: order.si_override_reason || null,
    classification_reason: hasExplicitOverride
      ? (order.si_override_reason || (requiresSi ? 'Marked as SI + DR required' : 'Marked as No SI / Auto Zoho Invoice'))
      : classificationReason,
    is_csp: isCsp,
    skip_so_print: skipSoPrint,
    csp_items: cspItems,
    primary_entity: primaryEntity,
    entity_keys: entityKeys
  };
}

module.exports = {
  normalizeEntityKey,
  formatEntitySiNumber,
  getOrderEntityKeys,
  classifyOrder
};
