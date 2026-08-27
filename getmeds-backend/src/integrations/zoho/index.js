/**
 * Zoho adapter factory — the single place ZOHO_MODE is read.
 *
 * Controllers do this, and nothing else:
 *   const zoho = require('../integrations/zoho');
 *   const result = await zoho.createSalesOrder(orderData);
 *
 * Modes (ZOHO_MODE env var):
 *   "mock"      (default, and the default if ZOHO_MODE is unset/unknown)
 *               Pure in-memory MockZohoAdapter. No network calls exist in
 *               this code path at all. Safe to run anywhere, anytime,
 *               including on a laptop with no internet.
 *
 *   "http-mock" LiveZohoAdapter pointed at ZOHO_API_BASE_URL, which should
 *               be the local mock-server/ (default http://127.0.0.1:4100).
 *               Exercises the real HTTP/OAuth code path end-to-end while
 *               still touching zero external services — useful right
 *               before a demo to prove the live wiring actually works.
 *
 *   "live"      LiveZohoAdapter pointed at the real Zoho API. Requires
 *               ZOHO_ORG_ID to be explicitly present in
 *               ZOHO_ALLOWED_ORG_IDS (comma-separated). If it isn't, this
 *               throws at startup instead of silently doing something
 *               else — fail closed, not fail open. This should only ever
 *               be pointed at an isolated test/sandbox Zoho organization
 *               until the company has explicitly signed off on production.
 *
 * Unknown/unset ZOHO_MODE -> falls back to "mock" and logs a warning,
 * rather than guessing at something riskier.
 */
const MockZohoAdapter = require('./MockZohoAdapter');
const LiveZohoAdapter = require('./LiveZohoAdapter');

let _instance = null;

function parseAllowlist(csv) {
  return (csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildAdapter(env = process.env) {
  const requestedMode = (env.ZOHO_MODE || 'mock').toLowerCase();

  if (requestedMode === 'mock') {
    console.log('[ZOHO] mode=mock — in-memory only, no network calls will be made.');
    return new MockZohoAdapter();
  }

  if (requestedMode === 'http-mock') {
    const baseUrl = env.ZOHO_API_BASE_URL || 'http://127.0.0.1:4100/inventory/v1';
    const organizationId = env.ZOHO_ORG_ID || 'MOCK-ORG-LOCAL';
    console.log(`[ZOHO] mode=http-mock — pointed at local mock server ${baseUrl} (org=${organizationId}).`);
    return new LiveZohoAdapter({
      baseUrl,
      organizationId,
      allowedOrgIds: [organizationId], // the local mock server is always "allowed" — it isn't real Zoho
      getAccessToken: async () => 'mock-access-token',
      modeLabel: 'http-mock'
    });
  }

  if (requestedMode === 'live') {
    const baseUrl = env.ZOHO_API_BASE_URL || 'https://www.zohoapis.com/inventory/v1';
    const organizationId = env.ZOHO_ORG_ID;
    const allowedOrgIds = parseAllowlist(env.ZOHO_ALLOWED_ORG_IDS);

    if (!organizationId) {
      throw new Error('[ZOHO] mode=live requires ZOHO_ORG_ID to be set. Refusing to start.');
    }
    if (allowedOrgIds.length === 0) {
      throw new Error(
        '[ZOHO] mode=live requires ZOHO_ALLOWED_ORG_IDS (comma-separated) to be set. This is a ' +
          'deliberate fail-closed check — an empty allowlist means every org id is rejected, including ' +
          'the real one, until someone consciously adds it. Refusing to start.'
      );
    }
    if (!allowedOrgIds.includes(organizationId)) {
      throw new Error(
        `[ZOHO] mode=live: ZOHO_ORG_ID "${organizationId}" is not in ZOHO_ALLOWED_ORG_IDS. Refusing to start.`
      );
    }

    console.warn(
      `[ZOHO] mode=live — this WILL make real API calls against organization_id=${organizationId}. ` +
        'Confirm this is the intended test/sandbox org, not production, before proceeding.'
    );

    return new LiveZohoAdapter({
      baseUrl,
      organizationId,
      allowedOrgIds,
      getAccessToken: buildOAuthTokenGetter(env),
      modeLabel: 'live'
    });
  }

  console.warn(`[ZOHO] Unknown ZOHO_MODE="${env.ZOHO_MODE}" — falling back to mock mode for safety.`);
  return new MockZohoAdapter();
}

/**
 * Stub OAuth refresh-token-grant flow. Deliberately left as a stub that
 * throws until real credentials + a token cache are wired up — this repo
 * should not silently "work" against a live org with half-finished auth.
 * Fill this in only once you're pointed at an approved test/sandbox org.
 */
function buildOAuthTokenGetter(env) {
  let cachedToken = null;
  let tokenExpiresAt = 0;

  return async () => {
    if (!env.ZOHO_CLIENT_ID || !env.ZOHO_CLIENT_SECRET || !env.ZOHO_REFRESH_TOKEN) {
      throw new Error(
        'ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN are not all set — cannot get a ' +
          'live Zoho access token. Get credentials from https://api-console.zoho.com/ scoped to ' +
          'your test/sandbox organization only.'
      );
    }

    const now = Date.now();
    // Return cached token if valid (with 60s safety buffer)
    if (cachedToken && now < tokenExpiresAt - 60000) {
      return cachedToken;
    }

    const accountsUrl = (env.ZOHO_ACCOUNTS_URL || 'https://accounts.zoho.com').replace(/\/+$/, '');
    const params = new URLSearchParams({
      refresh_token: env.ZOHO_REFRESH_TOKEN,
      client_id: env.ZOHO_CLIENT_ID,
      client_secret: env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token'
    });

    const res = await fetch(`${accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      body: params
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      throw new Error(`Failed to refresh Zoho access token: ${data.error || res.statusText}`);
    }

    cachedToken = data.access_token;
    tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
    return cachedToken;
  };
}

/**
 * Singleton getter — deliberately lazy. The adapter (and, for "live" mode,
 * the fail-closed allowlist check) is only constructed the first time it's
 * actually needed, not at `require()` time. That means merely importing
 * this module (e.g. from an unrelated test file) can never throw just
 * because ZOHO_MODE happens to be misconfigured in that environment.
 */
function getZohoAdapter() {
  if (!_instance) {
    _instance = buildAdapter();
  }
  return _instance;
}

/** For tests: build a fresh adapter from an arbitrary env object, bypassing the singleton. */
function _buildAdapterForTest(env) {
  return buildAdapter(env);
}

/** Reset the cached singleton — for tests only, so each test can set its own env. */
function _resetForTest() {
  _instance = null;
}

// Facade: every call delegates lazily to getZohoAdapter(), so construction
// (and any fail-closed throw) happens on first real use, not on require().
//
// Aug 27, 2026: trimmed to match the tightened ZohoAdapter contract —
// createSalesOrder is the ONLY write left (and it creates a plain Draft,
// never auto-confirmed); everything else here is a read. Methods that used
// to confirm/pack/ship a Sales Order, record a payment, add a comment, or
// create/edit/activate a Zoho Item or Contact have been removed from every
// layer (base contract, Live, Mock) — see ZohoAdapter.js for the rationale.
const facadeMethods = [
  'createSalesOrder',
  'getSalesOrder',
  'listSalesOrders',
  'listContacts',
  'listItems',
  'getContact',
  'setSimulatedOutage',
  'isSimulatedOutage'
];

const facade = {};
for (const method of facadeMethods) {
  facade[method] = (...args) => getZohoAdapter()[method](...args);
}
Object.defineProperty(facade, 'mode', { get: () => getZohoAdapter().mode });
facade.getZohoAdapter = getZohoAdapter;
facade._buildAdapterForTest = _buildAdapterForTest;
facade._resetForTest = _resetForTest;

module.exports = facade;
