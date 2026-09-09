import client from './client';

/**
 * Sep 3, 2026: the trailing slash is stripped, and it is not cosmetic.
 *
 * The two functions below build their URL by string concatenation —
 * `${API_BASE_URL}${path}` — where every `path` starts with '/'. So a
 * VITE_API_URL ending in '/' produced:
 *
 *   https://getmeds-system-backend.vercel.app//api/orders/meta/customers
 *                                           ^^ two slashes
 *
 * Vercel 308-redirects that to the single-slash form, and a browser refuses to
 * follow a redirect on a CORS preflight — "Redirect is not allowed for a
 * preflight request". The MedRep order form's customer and product lookups
 * both died this way in production while every other endpoint worked, because
 * everything else goes through the axios client in ./client.js, whose
 * combineURLs collapses the double slash. Locally VITE_API_URL is unset, the
 * default below has no trailing slash, and nothing breaks — which is exactly
 * why this only ever appeared on the deployed site.
 *
 * Normalising here rather than relying on whoever sets the environment
 * variable to omit the slash: both spellings are reasonable to type, and a URL
 * that works everywhere except two endpoints in production is not a mistake
 * anyone should have to make twice.
 */
const API_BASE_URL = (import.meta.env.VITE_API_URL || 'http://localhost:4000').replace(/\/+$/, '');

/**
 * Run a raw-fetch call, falling back to the axios client if it fails.
 *
 * The two callers below predate the rest of this file's use of `client` and
 * were written with a fallback for exactly the situation above. It never ran.
 * The guard was `if (!response.ok)`, but a CORS or network failure makes
 * fetch() REJECT rather than resolve with a not-ok response — so the fallback
 * was unreachable precisely when it was needed, and the failure surfaced in
 * the order form as "No registered customer matches", which reads as "this
 * client is not in the system" rather than "the lookup could not run".
 *
 * Catching the throw as well as the not-ok response is what makes the fallback
 * real. It also means a future base-URL mistake degrades to a slower request
 * through axios instead of an empty dropdown.
 */
async function fetchWithClientFallback(path, { token } = {}) {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (response.ok) return response.json();
  } catch (err) {
    // Network-level failure (CORS, DNS, offline). Fall through to axios.
  }
  return (await client.get(path)).data;
}

/**
 * Fetch all active pharmaceutical products from database
 */
export const fetchProducts = async () => {
  const token = sessionStorage.getItem('token');
  return fetchWithClientFallback('/api/products', { token });
};

/**
 * Fetch customers for the MedRep order-creation dropdown.
 *
 * Aug 27, 2026: switched from /api/customers (the admin overview — always
 * shows every active customer, no matter what) to /api/orders/meta/customers,
 * which is the endpoint that actually applies the two Zoho testing safety
 * flags: while ZOHO_TEST_CUSTOMER_ID is set (and ZOHO_DRY_RUN is not), this
 * narrows the list to just the one designated TEST customer, so a MedRep
 * physically cannot pick anyone else in this form — not just get rejected
 * after submitting. While ZOHO_DRY_RUN is on, every customer is shown again
 * (nothing can reach Zoho either way). Response shape is the same
 * ({ data: { customers: [...] } }), so this is a drop-in swap.
 */
/**
 * Sep 2, 2026: takes an options object.
 *  - `search`         server-side LIKE over name/contact person/number
 *  - `includeInactive` also return clients Zoho has deactivated (each
 *                      carrying is_active so the caller can label them)
 *  - `limit`          server caps at 100, defaults to 25
 *  - `category`       e.g. 'doctor', for the Doctor Name suggestions
 *
 * Searching is server-side because this endpoint used to return EVERY
 * customer — ~95,000 rows once the real org synced — which the order form
 * then re-filtered on every keystroke. See orders.controller.js's
 * getCustomers.
 */
export const fetchCustomers = async ({ search = '', includeInactive = false, limit, category } = {}) => {
  const qs = new URLSearchParams();
  if (search) qs.set('search', search);
  if (includeInactive) qs.set('include_inactive', 'true');
  if (limit) qs.set('limit', String(limit));
  if (category) qs.set('category', category);
  const query = qs.toString();
  const path = `/api/orders/meta/customers${query ? `?${query}` : ''}`;

  const token = sessionStorage.getItem('token');
  return fetchWithClientFallback(path, { token });
};

/**
 * Fetch live inventory synchronization status
 */
export const fetchInventoryStatus = async () => {
  const res = await client.get('/api/inventory/status');
  return res.data;
};

/**
 * Pull live stock levels from Zoho Inventory
 */
export const syncPullStock = async () => {
  const res = await client.post('/api/inventory/sync-pull');
  return res.data;
};

/**
 * Adjust product stock in both GetMeds and Zoho
 */
export const adjustProductStock = async ({ product_id, delta, reason }) => {
  const res = await client.post('/api/inventory/adjust', { product_id, delta, reason });
  return res.data;
};

/**
 * Aug 27, 2026: fetch a single customer's full address (and refreshed
 * contact person/number) straight from Zoho's "Get a Contact" detail call.
 * Needed because Zoho's List Contacts response (what the bulk customer
 * sync pulls) never includes billing_address — only this per-contact
 * detail call does — so a synced customer's address never auto-filled on
 * the order form until this existed. Called once, at the moment a MedRep
 * selects a customer — read-only, nothing is ever sent to Zoho.
 */
export const fetchCustomerZohoAddress = async (customerId) => {
  const res = await client.get(`/api/customers/${customerId}/address-from-zoho`);
  return res.data;
};

/**
 * Aug 27, 2026: Clients Directory (Management) — paginated, filterable list
 * of every local customer (source: zoho or local), each tagged with its
 * Credit/Direct payment type plus the new, purely-local `category`
 * classification (doctor/hospital/distributor/pwd). Admin/management only.
 * `params` may include { page, limit, search, category, type }.
 */
export const fetchClients = async (params = {}) => {
  const res = await client.get('/api/customers', { params });
  return res.data;
};

/**
 * Aug 27, 2026 (2): the four Clients Directory KPI cards (Total/Credit/
 * Direct/Uncategorized) used to be four separate `fetchClients({limit:1})`
 * calls — four HTTP round trips just to read a count each. This is one
 * grouped local query on the backend, one round trip here.
 */
export const fetchClientStats = async () => {
  const res = await client.get('/api/customers/stats');
  return res.data;
};

/**
 * Pulls ALL contacts from Zoho (paginated on the backend, no 200-record
 * cap) into the local customers table. Read-only towards Zoho — nothing is
 * ever written back. Mirrors the Inventory page's "Pull from Zoho" action.
 */
export const syncCustomersFromZoho = async () => {
  const res = await client.post('/api/customers/sync-from-zoho');
  return res.data;
};

/**
 * Sets (or clears, with category: null) a customer's local classification
 * tag. Pure local write — never touches Zoho, never touches `type`
 * (credit/direct), which keeps driving payment-workflow routing unchanged.
 */
export const updateCustomerCategory = async (customerId, category) => {
  const res = await client.patch(`/api/customers/${customerId}/category`, { category });
  return res.data;
};

/**
 * Sep 8, 2026: sets a customer's TIN (Tax Identification Number — a
 * Philippines BIR requirement Zoho needs before it will create a Sales
 * Order for a "business" sub-type contact). Saves locally first, always;
 * the backend also best-effort pushes it to Zoho's cf_tin custom field —
 * the response's `zoho_pushed` says whether that part actually landed.
 * See customers.controller.js's updateCustomerTin for the full rationale.
 */
export const updateCustomerTin = async (customerId, tin) => {
  const res = await client.patch(`/api/customers/${customerId}/tin`, { tin });
  return res.data;
};

/**
 * Aug 28, 2026: background Quick Sync ("only contacts changed since last
 * time" — fast) / Full Resync ("everyone, registered here or not,
 * guaranteed") for the Clients Directory. Starts a job and returns
 * immediately (202 + job_id) instead of blocking on however long a full
 * pull of a large Zoho org takes — poll progress with
 * fetchSyncJobStatus(jobId). Still read-only towards Zoho.
 * @param {'quick'|'full'} mode
 */
export const startCustomersSyncJob = async (mode) => {
  const res = await client.post(`/api/customers/sync-from-zoho/start?mode=${mode}`);
  return res.data;
};

/** Same as startCustomersSyncJob, for the Inventory page's stock pull. */
export const startInventorySyncJob = async (mode) => {
  const res = await client.post(`/api/inventory/sync-pull/start?mode=${mode}`);
  return res.data;
};

/**
 * Sep 9, 2026: the same background-job shape again, for pulling Sales Orders
 * that exist in Zoho into this app — including the ones raised directly in
 * Zoho, which until now the Orders list never showed at all. Each imported
 * order also gets Zoho's own Comments & History mirrored into its trail.
 *
 * 'full'  — walk the org's Sales Orders and adopt whatever isn't here yet.
 * 'quick' — only what has been created or edited in Zoho since the last run.
 *
 * Read-only towards Zoho, like every other sync here. Admin/management only,
 * since it creates orders (and, where a Sales Order names a contact this app
 * has never seen, customers) in bulk.
 * @param {'quick'|'full'} mode
 */
export const startSalesOrdersImportJob = async (mode) => {
  const res = await client.post(`/api/orders/import-from-zoho/start?mode=${mode}`);
  return res.data;
};

/**
 * How much of the Orders list came from Zoho, and when the last full import
 * ran. A purely local read on the backend — no Zoho calls — so it is cheap to
 * keep on screen next to the import buttons.
 */
export const fetchZohoImportStatus = async () => {
  const res = await client.get('/api/orders/import-from-zoho/status');
  return res.data;
};

/**
 * Poll a background sync job's status/progress. Shared by both the
 * Clients Directory and Inventory pages — one job registry on the backend
 * (services/syncJobs.js), one status shape.
 */
export const fetchSyncJobStatus = async (jobId) => {
  const res = await client.get(`/api/sync-jobs/${jobId}`);
  return res.data;
};
