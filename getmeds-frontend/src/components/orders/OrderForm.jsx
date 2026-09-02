import React, { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import client from '../../api/client';
import Modal from '../ui/Modal';
import ProductAutocomplete from './ProductAutocomplete';
import CustomerAutocomplete from './CustomerAutocomplete';
import {
  Trash2,
  ShoppingCart,
  CheckCircle,
  AlertCircle,
  ArrowLeft,
  Sparkles,
  Package,
  ClipboardList,
  FileText,
  Paperclip,
  Loader2,
  X,
  CalendarDays,
  UserRound,
  FlaskConical,
  Building2
} from 'lucide-react';
import { useDebug } from '../../context/DebugContext';
import { useAuth } from '../../hooks/useAuth';

import { useProducts, useCustomers } from '../../hooks/useOrderData';
import { fetchCustomerZohoAddress, fetchCustomers } from '../../api/queries';

// Aug 30, 2026: "Create New Order" form redesign. Replaces the old
// paper/spreadsheet-styled "Order Intake Details" block (label-left rows,
// alternating green/white bars, a live-ticking Timestamp header) with a
// cleaner, card-based layout, and swaps the old free-form intake fields
// (Courier, Hospital, Patient, MOP, "Pls Give") for a set that lines up
// with an actual Zoho Inventory Sales Order — see
// getmeds-backend/ZOHO_SALES_ORDER_FIELD_MAPPING.md for exactly which
// field here is meant to land on which Zoho field once the real Zoho push
// (deliberately NOT done yet — see that doc) is wired up.
//
// Delivery Address / Receiver Name / Contact No. are kept (not in the
// field list this was redesigned from) because Dispatch still depends on
// delivery_address being present to actually ship an order — dropping it
// would strand every credit order with nowhere to deliver to.

// Source options — exactly the dropdown Zoho already shows on its own
// Sales Order "Source" field (matched 1:1 so the value picked here is
// already valid the day this gets wired into a real Zoho payload).
const SOURCE_OPTIONS = [
  'Doctor order',
  'Patient order referred by doctor',
  'Patient order referred by patient',
  'Emergency purchase',
  'Hospital PO',
  'Distributor order'
];

// Exactly the two legal entities orders may be invoiced under — enforced
// here AND server-side (orders.controller.js create()).
const INVOICING_FROM_OPTIONS = ['2mg Incorporated', 'Getmeds Philippines Inc.'];

// Common delivery methods — offered as suggestions via a native <datalist>,
// not a locked dropdown, since Zoho's own delivery_method field is free
// text (see the mapping doc).
const DELIVERY_METHOD_SUGGESTIONS = [
  'Own Rider / Company Vehicle',
  'LBC Express',
  'Grab Express',
  'J&T Express',
  'Lalamove',
  'Customer Pick-up',
  'Distributor Delivery'
];

// Payment Terms — mirrors the exact list configured on Zoho's own Sales
// Order screen (pulled directly from Zoho's Payment Terms dropdown, Aug 30,
// 2026). Same pattern as Delivery Method above: suggestions via a native
// <datalist>, not a locked dropdown, since Zoho's own field accepts a
// custom typed value too (not just one of these presets).
const PAYMENT_TERMS_SUGGESTIONS = [
  'Net 15',
  '30 days',
  '45 Day',
  'BPO WALLET',
  '60 Day',
  'DSWD/PCSO'
];

// Simple flat-rate tax presets for the per-line Tax column. Zero-Rated and
// VAT-Exempt both compute to ₱0 tax but are kept as distinct choices since
// they mean different things for Finance's own records — which one applies
// isn't something this form should guess, so nothing is pre-selected.
const TAX_OPTIONS = [
  { value: 'none', label: 'No Tax', percent: 0 },
  { value: 'vat12', label: 'VAT 12%', percent: 12 },
  { value: 'zero_rated', label: 'Zero-Rated (0%)', percent: 0 },
  { value: 'vat_exempt', label: 'VAT-Exempt', percent: 0 }
];
const getTaxOption = (value) => TAX_OPTIONS.find((t) => t.value === value) || TAX_OPTIONS[0];

const computeLineAmounts = (item) => {
  const qty = Number(item.quantity) || 0;
  const rate = Number(item.rate) || 0;
  const discount = Math.min(qty * rate, Math.max(0, Number(item.discount) || 0));
  const subtotal = qty * rate;
  const taxableBase = subtotal - discount;
  const taxPercent = getTaxOption(item.taxOption).percent;
  const taxAmount = taxableBase * (taxPercent / 100);
  const amount = taxableBase + taxAmount;
  return { subtotal, discount, taxAmount, amount };
};

// Shared field wrapper — label on top, optional required marker and helper
// text underneath. Used throughout the redesigned "Order Details" card so
// every field reads the same way instead of the old spreadsheet grid.
const Field = ({ label, required, help, className = '', children }) => (
  <div className={className}>
    <label className="block text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">
      {label} {required && <span className="text-state-error">*</span>}
    </label>
    {children}
    {help && <p className="text-[11px] text-ink-secondary mt-1">{help}</p>}
  </div>
);

const inputClass =
  'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue shadow-2xs transition-colors disabled:bg-surface disabled:text-ink-secondary';
const readOnlyPillClass =
  'w-full bg-surface border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-ink-primary flex items-center gap-2';

/**
 * OrderForm Component
 *
 * Implements:
 * - Step 1: React Query cached master data from useOrderData
 * - Step 2: Autocomplete integration via <CustomerAutocomplete /> and <ProductAutocomplete />
 * - Step 3: Cart state, per-line discount/tax, .reduce() totals, useMutation to /api/orders, and fast-track debug button.
 */
const OrderForm = ({ onCancel, onSuccess }) => {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { isDebug } = useDebug();
  const { user } = useAuth();

  // Form State
  const [customerId, setCustomerId] = useState('');
  const [customerType, setCustomerType] = useState('credit');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [deliveryNotes, setDeliveryNotes] = useState(''); // "Remarks"
  const [receiverName, setReceiverName] = useState('');
  const [receiverContactNo, setReceiverContactNo] = useState('');

  // New, Zoho-aligned order-level fields (Aug 30, 2026 redesign)
  const [deliveryMethod, setDeliveryMethod] = useState('');
  const [doctorName, setDoctorName] = useState('');
  const [orderSource, setOrderSource] = useState('');
  const [invoicingFrom, setInvoicingFrom] = useState('');
  const [termsAndConditions, setTermsAndConditions] = useState('');
  const [paymentTerms, setPaymentTerms] = useState('');
  // UI-only for now — files are listed here but never uploaded anywhere
  // (see the mapping doc: Zoho's `documents` field needs each file already
  // uploaded to Zoho first, which isn't built yet). Kept purely so the form
  // matches the field list and the UX is ready for that later.
  const [attachedFiles, setAttachedFiles] = useState([]);

  // "Sales Order Date (Automatic Today)" — fixed to today, never editable.
  // The server independently stamps this the same way on save, so this is
  // display-only and never sent with the request.
  const todayLabel = new Date().toLocaleDateString('en-PH', {
    year: 'numeric', month: 'long', day: 'numeric'
  });

  // Cart State: [{ productId, name, sku, quantity, rate, discount, taxOption }]
  const [items, setItems] = useState([]);

  // Post-submission success state
  const [submittedOrder, setSubmittedOrder] = useState(null);
  const [isReviewOpen, setIsReviewOpen] = useState(false);

  // Step 1: Query hooks
  //
  // Sep 2, 2026: the dropdown lists ACTIVE clients by default. Inactive ones
  // (deactivated in Zoho — mirrored into is_active by the customer sync) are
  // fetched only when the MedRep asks, and even then are shown greyed out and
  // unselectable, because Zoho rejects a Sales Order raised against an
  // inactive contact. Showing them beats hiding them: "this client exists and
  // is inactive" is a real answer, where a silently missing row just reads as
  // a typo. Same treatment inactive products already get.
  const [showInactiveCustomers, setShowInactiveCustomers] = useState(false);
  const { data: customersData, isLoading: loadingCustomers } = useCustomers(showInactiveCustomers);
  // Sep 2, 2026 (2): this list is now a small, server-capped sample (25),
  // NOT every customer. The searchable dropdown queries the server itself —
  // see CustomerAutocomplete. What is left here is only what still needs a
  // handful of rows: the Test Mode auto-fill buttons, and the gate flag.
  const customers = customersData?.customers || [];
  const inactiveCustomerCount = customersData?.inactiveCount ?? 0;
  const testCustomerGateEnabled = !!customersData?.testCustomerGateEnabled;
  const { data: products = [], isLoading: loadingProducts } = useProducts();

  // Held as an object rather than looked up by id, because there is no
  // longer a full list to look it up in.
  const [selectedCustomer, setSelectedCustomer] = useState(null);

  // Sep 2, 2026: "raise this order as…" — TEST_MODE + admin only.
  //
  // In Test Mode an admin passes every role gate, so they can reach this
  // form; until now their order was silently attributed to the one seeded
  // medrep@getmeds.ph account (auditService's resolveActor). That was
  // harmless when nothing was per-MedRep and is not any more: each MedRep
  // now carries their own Zoho Salesperson, and testing one means being able
  // to order AS them without logging out and back in.
  //
  // Whether the picker appears is the SERVER's decision, not
  // VITE_TEST_MODE's — /api/orders/meta/medreps returns enabled:false for
  // everyone else, and create() independently ignores `medrep_id` unless the
  // same four conditions hold. Two places would drift; the server's is the
  // one that counts.
  const [actingMedrepId, setActingMedrepId] = useState('');
  const { data: medrepPicker } = useQuery({
    queryKey: ['order-medreps'],
    queryFn: async () => (await client.get('/api/orders/meta/medreps')).data.data,
    staleTime: 1000 * 60 * 5
  });
  const canPickMedrep = !!medrepPicker?.enabled;
  const medrepOptions = medrepPicker?.medreps || [];
  const actingMedrep = canPickMedrep
    ? medrepOptions.find(m => String(m.id) === String(actingMedrepId)) || null
    : null;

  // Aug 30, 2026: the backend stamps every live Zoho Sales Order created
  // while the TEST-customer gate is on with a fixed "TEST | MEDREP"
  // Salesperson (see LiveZohoAdapter.createSalesOrder — this Zoho org
  // requires a Salesperson on every Sales Order). Show that same value here
  // instead of the logged-in user's name whenever a TEST customer is
  // selected, so what's on screen matches what actually reaches Zoho.
  //
  // Aug 31, 2026 (7): generalized from a single hardcoded TEST-CUSTOMER_1
  // id/name check. The backend's getCustomers already filters this very
  // dropdown down to only the designated TEST customers whenever the gate
  // is on (see orders.controller.js's checkTestCustomerGate, now backed by
  // ZOHO_TEST_CUSTOMER_IDS — a list, not a single id) — so if the gate is
  // on, ANY customer selectable here already IS a test customer.
  //
  // Sep 2, 2026: the per-MedRep mapping that was deferred above now exists.
  // `user.salesperson` is the generated "<division> | <display name>" from
  // sign-up (e.g. "TEST | Aaron Manila"), carried on every authenticated
  // request by requireAuth. The precedence below mirrors
  // LiveZohoAdapter.createSalesOrder EXACTLY, and that is the whole point of
  // this line — it is a read-only mirror of what will be sent, so it has to
  // agree with it in every branch:
  //
  //   1. the rep's own Salesperson, when their account has one — it wins
  //      even on a TEST order, same as in the adapter;
  //   2. otherwise the TEST | MEDREP stand-in, but only on a TEST order;
  //   3. otherwise nothing, and the field says so rather than falling back
  //      to user.name — showing a name that will NOT be sent is worse than
  //      showing none, because it reads like a working mapping.
  //
  // When an admin has picked a MedRep to raise the order as (above), it is
  // THAT rep's Salesperson that goes to Zoho — same row the backend reads —
  // so it is theirs that belongs on screen.
  const isTestCustomerSelected = !!selectedCustomer && testCustomerGateEnabled;
  const mySalesperson = ((actingMedrep ? actingMedrep.salesperson : user?.salesperson) || '').trim();
  const displaySalesPerson =
    mySalesperson || (isTestCustomerSelected ? 'TEST | MEDREP' : 'Not set');

  // Sep 2, 2026: Division and Sub-division are their own custom fields on
  // this org's Sales Order (cf_division / cf_sub_division) and are sent with
  // every order, so they are shown rather than left invisible. Read from the
  // SAME source as the Salesperson above — the acting MedRep when an admin
  // has picked one, otherwise the logged-in account — because the backend
  // reads all three from one user row and the screen must not imply
  // otherwise.
  const myDivision = ((actingMedrep ? actingMedrep.division : user?.division) || '').trim();
  const mySubDivision = ((actingMedrep ? actingMedrep.sub_division : user?.sub_division) || '').trim();

  // Doctor Name is manual free text, but pre-filled with suggestions drawn
  // from customers already tagged category='doctor' (populated by
  // Management in the Clients Directory, itself sourced from the Zoho
  // contacts sync) — "manual, but if there's a doctor from Zoho, get it."
  // Sep 2, 2026 (2): its own bounded query. This used to filter the full
  // customer array for category='doctor' — which only worked while the whole
  // table was in the browser, and was a large part of why it was.
  const { data: doctorData } = useQuery({
    queryKey: ['customers-doctors'],
    queryFn: () => fetchCustomers({ category: 'doctor', limit: 100 }),
    staleTime: 1000 * 60 * 5
  });
  const doctorSuggestions = Array.from(
    new Set((doctorData?.data?.customers || []).map(c => c.name).filter(Boolean))
  );

  // Aug 27, 2026: fetching the live address from Zoho (see below) — shown
  // as a small inline spinner next to the Address field so a MedRep knows
  // why it might still be blank for a second right after picking someone.
  const [isFetchingZohoAddress, setIsFetchingZohoAddress] = useState(false);
  // Tracks which customer is *currently* selected, read synchronously
  // inside the async fetch below — a ref rather than reading `customerId`
  // from closure, so a fast second selection can't have its own result
  // clobbered by an earlier request that resolves late.
  const selectedCustomerIdRef = useRef('');

  // Customer change handler
  const handleCustomerChange = (c) => {
    if (!c) return;
    selectedCustomerIdRef.current = String(c.id);
    setCustomerId(c.id);
    setSelectedCustomer(c);
    setCustomerType(c.type || 'credit');
    // Fill in whatever's already cached locally immediately (instant, no
    // network wait) — this is what's usually already there from a
    // previous sync/selection.
    setDeliveryAddress(c.address || '');
    setReceiverName(c.contact_person || '');
    setReceiverContactNo(c.contact_number || '');

    // Aug 27, 2026: Zoho's bulk contact sync (customers.controller.js's
    // syncFromZoho) never receives billing_address — Zoho's List Contacts
    // response doesn't carry it, only the single "Get a Contact" detail
    // call does. So the moment a MedRep actually picks this customer, ask
    // for that detail once (read-only — GET /api/customers/:id/address-from-zoho)
    // and fill the Address/Receiver/Contact No. fields in with the real
    // thing once it comes back. Race-guarded via the ref above: if the
    // MedRep has already moved on to a different customer by the time this
    // resolves, its result is discarded rather than overwriting the screen.
    setIsFetchingZohoAddress(true);
    fetchCustomerZohoAddress(c.id)
      .then((res) => {
        if (selectedCustomerIdRef.current !== String(c.id)) return; // moved on already — discard
        const d = res?.data;
        if (d) {
          if (d.address) setDeliveryAddress(d.address);
          if (d.contact_person) setReceiverName(d.contact_person);
          if (d.contact_number) setReceiverContactNo(d.contact_number);
        }
      })
      .catch((err) => {
        // Non-fatal — the locally-cached values set above still stand.
        console.warn('Could not fetch live address from Zoho for this customer:', err);
      })
      .finally(() => {
        if (selectedCustomerIdRef.current === String(c.id)) setIsFetchingZohoAddress(false);
      });
  };

  const handleCustomerClear = () => {
    selectedCustomerIdRef.current = '';
    setCustomerId('');
    setSelectedCustomer(null);
    setIsFetchingZohoAddress(false);
  };

  // Step 2: Autocomplete item selection
  const handleProductSelect = (product) => {
    const existingIndex = items.findIndex(i => String(i.productId) === String(product.id));
    if (existingIndex > -1) {
      const updated = [...items];
      updated[existingIndex].quantity += 1;
      setItems(updated);
      toast.success(`Incremented quantity for ${product.name}`);
    } else {
      setItems([
        ...items,
        {
          productId: product.id,
          name: product.name,
          sku: product.sku,
          rate: Number(product.unit_price || 0),
          unit: product.unit || 'unit',
          quantity: 1,
          discount: 0,
          taxOption: 'none'
        }
      ]);
      toast.success(`Added ${product.name} to order`);
    }
  };

  // Generic per-line field updater — used by Quantity, Rate, Discount, and
  // Tax so all four share the exact same update/validation path.
  const handleUpdateItemField = (index, field, value) => {
    const updated = [...items];
    if (field === 'quantity') {
      const qty = parseInt(value, 10);
      if (isNaN(qty) || qty < 1) return;
      updated[index].quantity = qty;
    } else if (field === 'rate' || field === 'discount') {
      const num = value === '' ? 0 : Number(value);
      if (isNaN(num) || num < 0) return;
      updated[index][field] = num;
    } else if (field === 'taxOption') {
      updated[index].taxOption = value;
    }
    setItems(updated);
  };

  const handleRemoveItem = (index) => {
    setItems(items.filter((_, idx) => idx !== index));
  };

  const handleFilesSelected = (e) => {
    const newFiles = Array.from(e.target.files || []);
    if (newFiles.length) setAttachedFiles([...attachedFiles, ...newFiles]);
    e.target.value = ''; // allow re-selecting the same file name later
  };
  const handleRemoveFile = (index) => {
    setAttachedFiles(attachedFiles.filter((_, idx) => idx !== index));
  };

  // Step 3: Dynamic totals — Subtotal / Discount / Tax / Grand Total, each
  // summed from the per-line computation so the breakdown footer and the
  // Grand Total always agree with what each line actually shows.
  const lineAmounts = items.map(computeLineAmounts);
  const totals = lineAmounts.reduce(
    (acc, l) => ({
      subtotal: acc.subtotal + l.subtotal,
      discount: acc.discount + l.discount,
      tax: acc.tax + l.taxAmount,
      grandTotal: acc.grandTotal + l.amount
    }),
    { subtotal: 0, discount: 0, tax: 0, grandTotal: 0 }
  );
  const grandTotal = totals.grandTotal;

  const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  // Form Validation — Source and Invoicing From are required on this form
  // (matching Zoho's own "Source *" field and the two-entity requirement)
  // but deliberately NOT enforced server-side beyond "must be a valid
  // value if present", so this stays a client-side UX guarantee rather
  // than breaking any other caller of POST /api/orders.
  const isFormValid = Boolean(
    customerId &&
    deliveryAddress.trim() &&
    orderSource &&
    invoicingFrom &&
    items.length > 0 &&
    items.every(i => i.productId && Number(i.quantity) > 0 && Number(i.rate) >= 0)
  );

  // Step 3: [TEST MODE: Auto-Fill] Logic
  //
  // Aug 30, 2026: with the dropdown (and the server-side gate) currently
  // restricted to TEST-CUSTOMER_1 only, `customers.find(c => c.type ===
  // 'credit')` always resolves to that one customer — so this button now
  // reproduces the exact configuration that's been verified end-to-end to
  // reach Zoho as a real Draft Sales Order (see LiveZohoAdapter's
  // TEST | MEDREP salesperson stamp): Lalamove delivery, Dr. Test,
  // "Patient order referred by doctor" source, invoiced from 2mg
  // Incorporated, one line of HydroxyGet 500 at the same qty/rate used in
  // that verified test. Receiver Name/Contact No. are left to
  // handleCustomerChange below, which already pulls them from the
  // customer's own Zoho contact person — no need to hardcode those here.
  const handleAutoFillCredit = () => {
    if (!customers.length || !products.length) {
      toast.error('Master data is still loading from server...');
      return;
    }

    const creditCust = customers.find(c => c.type === 'credit') || customers[0];
    handleCustomerChange(creditCust);
    setDeliveryAddress(creditCust.address || "St. Luke's Medical Center - 279 E Rodriguez Sr. Ave, Quezon City");
    setDeliveryNotes('');
    setDeliveryMethod('Lalamove');
    setDoctorName('Dr. Test');
    setOrderSource('Patient order referred by doctor');
    setInvoicingFrom('2mg Incorporated');
    setTermsAndConditions('');

    const testProduct = products.find(p => p.sku === 'GM-4533')
      || products.find(p => /hydroxyget/i.test(p.name || ''))
      || products[0];

    const sampleItems = testProduct ? [{
      productId: testProduct.id, name: testProduct.name, sku: testProduct.sku,
      rate: 31.25, unit: testProduct.unit || 'pcs',
      quantity: 100, discount: 0, taxOption: 'none'
    }] : [];

    setItems(sampleItems);
    toast.success(`⚡ Auto-filled Credit Order (${creditCust.name})`, { icon: '🚀', duration: 3000 });
  };

  const handleAutoFillDirect = () => {
    if (!customers.length || !products.length) {
      toast.error('Master data is still loading from server...');
      return;
    }

    const directCust = customers.find(c => c.type === 'direct') || customers[customers.length - 1];
    handleCustomerChange(directCust);
    setDeliveryAddress(directCust.address || "Unit 402, Greenhills Tower, San Juan, Metro Manila");
    setDeliveryNotes('Direct Patient Order. Advance payment verification required before dispatch.');
    setDeliveryMethod('Grab Express');
    setDoctorName('');
    setOrderSource('Patient order referred by patient');
    setInvoicingFrom('2mg Incorporated');
    setTermsAndConditions('Full payment required prior to dispatch.');

    const sampleItems = [];
    if (products.length >= 1) {
      sampleItems.push({
        productId: products[0].id, name: products[0].name, sku: products[0].sku,
        rate: Number(products[0].unit_price || 0), unit: products[0].unit || 'box',
        quantity: 5, discount: 0, taxOption: 'none'
      });
    }
    if (products.length >= 2) {
      sampleItems.push({
        productId: products[1].id, name: products[1].name, sku: products[1].sku,
        rate: Number(products[1].unit_price || 0), unit: products[1].unit || 'box',
        quantity: 2, discount: 0, taxOption: 'none'
      });
    }

    setItems(sampleItems);
    toast.success(`⚡ Auto-filled Direct Order (${directCust.name})`, { icon: '💳', duration: 3000 });
  };

  // Step 3: Submit via React Query useMutation
  const mutation = useMutation({
    mutationFn: async () => {
      // POST /api/orders (no `status: 'draft'` override) already runs the
      // full workflow gate in one call: it generates the Getmeds Order ID,
      // creates the Zoho Sales Order, and sets the final status
      // (ready_for_dispatch for credit / waiting_for_payment for direct) —
      // see orders.controller.js `create`. A second call to
      // POST /api/orders/:id/submit used to follow this, but `submit` only
      // accepts orders still in `draft` status; since this order is never
      // left in `draft`, that second call always failed with a 409 and
      // surfaced a false "Failed to submit order" error even though the
      // order had already been created successfully. Removed — this single
      // call is now the complete, correct submission.
      const createRes = await client.post('/api/orders', {
        customer_id: parseInt(customerId),
        items: items.map(i => ({
          product_id: parseInt(i.productId),
          quantity: parseInt(i.quantity),
          rate: Number(i.rate),
          discount: Number(i.discount || 0),
          tax_percent: getTaxOption(i.taxOption).percent,
          tax_label: getTaxOption(i.taxOption).label
        })),
        delivery_address: deliveryAddress,
        delivery_notes: deliveryNotes,
        customer_type: customerType,
        // Optional intake fields — see IntakeRow-era comment history in
        // orders.controller.js. Blank strings are normalized to NULL
        // server-side.
        doctor_name: doctorName,
        receiver_name: receiverName,
        receiver_contact_no: receiverContactNo,
        order_source: orderSource,
        delivery_method: deliveryMethod,
        terms: termsAndConditions,
        payment_terms: paymentTerms,
        invoicing_from: invoicingFrom,
        // Sep 2, 2026: only ever sent when the server said the picker is
        // allowed AND one was chosen. The server ignores it otherwise, so
        // this is belt-and-braces rather than the control itself.
        ...(canPickMedrep && actingMedrepId ? { medrep_id: parseInt(actingMedrepId) } : {})
      });
      const order = createRes.data.data.order;
      return order;
    },
    onSuccess: (order) => {
      // Invalidate queries so dashboards & orders lists refresh instantly
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['my-orders'] });
      qc.invalidateQueries({ queryKey: ['medrep-orders'] });
      qc.invalidateQueries({ queryKey: ['management-orders'] });
      qc.invalidateQueries({ queryKey: ['management-summary'] });

      setIsReviewOpen(false);
      setSubmittedOrder(order);

      toast.success(
        `Order ${order.getmeds_order_id} created successfully!`,
        {
          style: {
            background: '#61A644',
            color: '#FFFFFF',
            fontWeight: 'bold',
          },
          icon: '✅',
          duration: 4000,
        }
      );

      if (onSuccess) {
        onSuccess(order);
      }
    },
    onError: (err) => {
      toast.error(err.response?.data?.error?.message || 'Failed to submit order');
    }
  });

  const handleOpenReview = (e) => {
    e.preventDefault();
    if (!isFormValid) {
      toast.error('Please fill in all mandatory fields (marked *)');
      return;
    }
    setIsReviewOpen(true);
  };

  // Any optional field the MedRep actually filled in — shown in the review
  // modal so it's double-checked before submission, same as every other
  // field on the form.
  const filledIntakeDetails = [
    { label: 'Delivery Method', value: deliveryMethod },
    { label: 'Doctor', value: doctorName },
    { label: 'Receiver', value: receiverName },
    { label: 'Contact No.', value: receiverContactNo },
    { label: 'Terms & Conditions', value: termsAndConditions }
  ].filter(f => f.value && f.value.trim());

  return (
    <div className="space-y-6">
      {/* Top Controls Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-ink-primary">Create New Order</h1>
          <p className="text-sm text-ink-secondary mt-1">
            Initiate a new sales requisition for customer verification and fulfillment.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {import.meta.env.VITE_TEST_MODE === 'true' && (
            <>
              {/* Auto-Fill Credit Button */}
              <button
                type="button"
                onClick={handleAutoFillCredit}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-getmeds-blue/15 text-getmeds-blue-dark border border-getmeds-blue/30 hover:bg-getmeds-blue/25 transition-colors shadow-2xs cursor-pointer"
                title="Auto-fill sample order for Institutional Credit customer (bypasses payment queue)"
              >
                <Sparkles size={13} className="text-getmeds-blue" />
                <span>[Auto-Fill: Credit]</span>
              </button>

              {/* Auto-Fill Direct Button */}
              <button
                type="button"
                onClick={handleAutoFillDirect}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold bg-amber-100 text-amber-900 border border-amber-300 hover:bg-amber-200 transition-colors shadow-2xs cursor-pointer"
                title="Auto-fill sample order for Direct Patient customer (routes to finance queue)"
              >
                <Sparkles size={13} className="text-amber-700" />
                <span>[Auto-Fill: Direct]</span>
              </button>
            </>
          )}

          <button
            type="button"
            onClick={onCancel || (() => navigate('/orders'))}
            className="inline-flex items-center gap-1 px-3.5 py-2 border border-slate-200 rounded-lg text-xs font-semibold text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary transition-colors shadow-2xs"
          >
            <ArrowLeft className="w-3.5 h-3.5" /> Back
          </button>
        </div>
      </div>

      {/* Main Crisp Card White Container */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-visible">
        <form onSubmit={handleOpenReview} className="divide-y divide-slate-100">

          {/* SECTION 1: ORDER DETAILS */}
          <div className="p-6 sm:p-8 space-y-5">
            <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100">
              <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
                <ClipboardList size={16} />
              </div>
              <h2 className="text-base font-bold text-ink-primary">1. Order Details</h2>
            </div>

            <Field label="Customer Name" required>
              <CustomerAutocomplete
                selected={selectedCustomer}
                onSelect={handleCustomerChange}
                onClear={handleCustomerClear}
                includeInactive={showInactiveCustomers}
              />
              {selectedCustomer && (
                <p className="text-[11px] text-ink-secondary mt-1">
                  {customerType === 'credit'
                    ? 'Institutional terms — bypasses upfront payment, routes to Dispatch.'
                    : 'Direct patient — requires Finance payment verification before picking.'}
                </p>
              )}
              {/* Only offered when there is actually something behind it —
                  a checkbox that reveals nothing is worse than no checkbox. */}
              {(inactiveCustomerCount > 0 || showInactiveCustomers) && (
                <label className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-ink-secondary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={showInactiveCustomers}
                    onChange={(e) => setShowInactiveCustomers(e.target.checked)}
                    className="rounded border-slate-300 text-getmeds-blue focus:ring-getmeds-blue"
                  />
                  Show inactive clients
                  {inactiveCustomerCount > 0 && ` (${inactiveCustomerCount})`}
                  <span className="text-ink-secondary/70">— listed for reference, cannot be ordered for</span>
                </label>
              )}
            </Field>

            {/* Sep 2, 2026: Test Mode only, and only for an admin — see the
                note beside `canPickMedrep` above. Sits directly over the
                Salesperson field because that is what it changes. */}
            {canPickMedrep && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex items-start gap-3">
                <FlaskConical size={16} className="text-amber-700 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <label className="block text-xs font-bold uppercase tracking-wide text-amber-900 mb-1.5">
                    Raise this order as
                  </label>
                  <select
                    value={actingMedrepId}
                    onChange={e => setActingMedrepId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Default — the seeded MedRep account</option>
                    {medrepOptions.map(m => (
                      <option key={m.id} value={m.id}>
                        {(m.display_name || m.name)}
                        {m.salesperson ? ` — ${m.salesperson}` : ' — no Salesperson set'}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-amber-900/80 mt-1.5">
                    Test Mode only. The order is attributed to the MedRep you pick and carries
                    their Salesperson to Zoho — the audit trail still records that you raised it.
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <Field label="Sales Order Date">
                <span className={readOnlyPillClass}>
                  <CalendarDays size={14} className="text-ink-secondary shrink-0" />
                  {todayLabel}
                </span>
              </Field>

              <Field
                label="Salesperson"
                help={
                  mySalesperson
                    ? 'From your account — sent as the Salesperson on the Zoho Sales Order.'
                    : 'Set from your Division and Display name at sign-up.'
                }
              >
                <span className={readOnlyPillClass}>
                  <UserRound size={14} className="text-ink-secondary shrink-0" />
                  <span className={mySalesperson ? '' : 'text-ink-secondary'}>
                    {displaySalesPerson}
                  </span>
                </span>
              </Field>

              <Field label="Delivery Method" help="Type to see suggestions, or enter your own.">
                <input
                  type="text"
                  list="delivery-method-suggestions"
                  value={deliveryMethod}
                  onChange={e => setDeliveryMethod(e.target.value)}
                  placeholder="e.g. LBC, Grab Express, Own Rider"
                  className={inputClass}
                />
                <datalist id="delivery-method-suggestions">
                  {DELIVERY_METHOD_SUGGESTIONS.map(opt => <option key={opt} value={opt} />)}
                </datalist>
              </Field>

              {/* Sep 2, 2026: read-only, like Salesperson — all three come
                  from the ordering MedRep's account, not from this form.
                  Shown because all three are sent to Zoho, and a field that
                  reaches the Sales Order should not be invisible here. */}
              <Field
                label="Division"
                help={myDivision ? 'Sent as Division on the Zoho Sales Order.' : 'Set at sign-up.'}
              >
                <span className={readOnlyPillClass}>
                  <Building2 size={14} className="text-ink-secondary shrink-0" />
                  <span className={myDivision ? '' : 'text-ink-secondary'}>
                    {myDivision || 'Not set'}
                  </span>
                </span>
              </Field>

              <Field
                label="Sub-division"
                help={mySubDivision ? 'Sent as Sub-division on the Zoho Sales Order.' : 'Optional — blank is not sent.'}
              >
                <span className={readOnlyPillClass}>
                  <Building2 size={14} className="text-ink-secondary shrink-0" />
                  <span className={mySubDivision ? '' : 'text-ink-secondary'}>
                    {mySubDivision || '—'}
                  </span>
                </span>
              </Field>

              <Field label="Payment Terms" help="Type to see suggestions (matches Zoho's list), or enter your own.">
                <input
                  type="text"
                  list="payment-terms-suggestions"
                  value={paymentTerms}
                  onChange={e => setPaymentTerms(e.target.value)}
                  placeholder="e.g. Net 15, 30 days"
                  className={inputClass}
                />
                <datalist id="payment-terms-suggestions">
                  {PAYMENT_TERMS_SUGGESTIONS.map(opt => <option key={opt} value={opt} />)}
                </datalist>
              </Field>

              <Field label="Doctor Name" help="Manual entry — suggestions pulled from customers tagged as doctors.">
                <input
                  type="text"
                  list="doctor-suggestions"
                  value={doctorName}
                  onChange={e => setDoctorName(e.target.value)}
                  placeholder="Referring / prescribing doctor"
                  className={inputClass}
                />
                <datalist id="doctor-suggestions">
                  {doctorSuggestions.map(name => <option key={name} value={name} />)}
                </datalist>
              </Field>

              <Field label="Source" required>
                <select value={orderSource} onChange={e => setOrderSource(e.target.value)} className={inputClass} required>
                  <option value="">-- Select source --</option>
                  {SOURCE_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>

              <Field label="Invoicing From" required help="Determines which entity this order is invoiced under.">
                <select value={invoicingFrom} onChange={e => setInvoicingFrom(e.target.value)} className={inputClass} required>
                  <option value="">-- Select invoicing entity --</option>
                  {INVOICING_FROM_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>
            </div>

            {/* Delivery mini-section — kept alongside the fields above since
                Dispatch depends on an actual address to ship credit orders to. */}
            <div className="rounded-xl border border-slate-200 bg-surface/40 p-4 space-y-4">
              <h3 className="text-xs font-bold uppercase tracking-wide text-ink-secondary">Delivery</h3>
              <Field label="Delivery Address" required>
                <textarea
                  value={deliveryAddress}
                  onChange={e => setDeliveryAddress(e.target.value)}
                  placeholder="Complete hospital, clinic, or residential shipping address..."
                  rows={2}
                  className={`${inputClass} resize-y`}
                  required
                />
                {isFetchingZohoAddress && (
                  <p className="text-[11px] text-ink-secondary flex items-center gap-1 mt-1">
                    <Loader2 size={11} className="animate-spin" /> Fetching this customer's address from Zoho...
                  </p>
                )}
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Receiver Name">
                  <input type="text" value={receiverName} onChange={e => setReceiverName(e.target.value)} placeholder="Who will receive the delivery" className={inputClass} />
                </Field>
                <Field label="Receiver Contact No.">
                  <input type="tel" value={receiverContactNo} onChange={e => setReceiverContactNo(e.target.value)} placeholder="09XXXXXXXXX" className={inputClass} />
                </Field>
              </div>
            </div>

            <Field label="Remarks">
              <textarea
                value={deliveryNotes}
                onChange={e => setDeliveryNotes(e.target.value)}
                placeholder="e.g. Attn: Dr. Santos, Room 302. Handle with cold chain packaging..."
                rows={2}
                className={`${inputClass} resize-y`}
              />
            </Field>
          </div>

          {/* SECTION 2: ORDER ITEMS (PRODUCT AUTOCOMPLETE + CART) */}
          <div className="p-6 sm:p-8 space-y-5 overflow-visible">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
                  <Package size={16} />
                </div>
                <h2 className="text-base font-bold text-ink-primary">2. Order Items <span className="text-state-error">*</span></h2>
              </div>
              <span className="text-xs font-semibold text-ink-secondary">
                {items.length} {items.length === 1 ? 'item' : 'items'} in requisition
              </span>
            </div>

            {/* Standalone ProductAutocomplete Component */}
            <div className="bg-surface p-4 rounded-xl border border-slate-200/80">
              <label className="block text-xs font-bold uppercase tracking-wider text-ink-primary mb-2">
                Quick Product Search & Add
              </label>
              <ProductAutocomplete
                products={products}
                onSelect={handleProductSelect}
                placeholder="Type to search medicine name, SKU, or category (e.g. Paracetamol, Amoxicillin)..."
              />
              <p className="text-[11px] text-ink-secondary mt-1.5">
                Click any product in the floating dropdown to add it to the requisition table below.
              </p>
            </div>

            {/* Cart Line Items Table */}
            {items.length === 0 ? (
              <div className="text-center py-10 border-2 border-dashed border-slate-200 rounded-xl bg-white text-ink-secondary text-sm">
                <ShoppingCart className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                <p className="font-semibold text-ink-primary">Requisition cart is currently empty</p>
                <p className="text-xs text-ink-secondary mt-0.5">Use the search box above to add pharmaceutical line items.</p>
              </div>
            ) : (
              <div className="border border-slate-200 rounded-xl overflow-x-auto shadow-2xs">
                <table className="min-w-full divide-y divide-slate-200 text-xs sm:text-sm">
                  <thead className="bg-surface">
                    <tr>
                      <th className="px-4 py-3 text-left font-bold text-ink-secondary uppercase tracking-wider">Item Details</th>
                      <th className="px-3 py-3 text-center font-bold text-ink-secondary uppercase tracking-wider">Qty</th>
                      <th className="px-3 py-3 text-right font-bold text-ink-secondary uppercase tracking-wider">Rate</th>
                      <th className="px-3 py-3 text-right font-bold text-ink-secondary uppercase tracking-wider">Discount</th>
                      <th className="px-3 py-3 text-center font-bold text-ink-secondary uppercase tracking-wider">Tax</th>
                      <th className="px-4 py-3 text-right font-bold text-ink-secondary uppercase tracking-wider">Amount</th>
                      <th className="px-3 py-3 text-center font-bold text-ink-secondary uppercase tracking-wider w-12"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {items.map((item, idx) => {
                      const line = lineAmounts[idx];
                      return (
                        <tr key={idx} className="hover:bg-surface/50 transition-colors">
                          <td className="px-4 py-3">
                            <p className="font-semibold text-ink-primary whitespace-nowrap">{item.name}</p>
                            <span className="text-[11px] font-mono text-ink-secondary">{item.sku}</span>
                          </td>
                          <td className="px-3 py-3 text-center">
                            <input
                              type="number"
                              min="1"
                              value={item.quantity}
                              onChange={e => handleUpdateItemField(idx, 'quantity', e.target.value)}
                              className="w-16 text-center border border-slate-300 rounded py-1 text-xs font-bold text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
                            />
                          </td>
                          <td className="px-3 py-3 text-right">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.rate}
                              onChange={e => handleUpdateItemField(idx, 'rate', e.target.value)}
                              className="w-20 text-right border border-slate-300 rounded py-1 px-1.5 text-xs font-bold text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
                            />
                          </td>
                          <td className="px-3 py-3 text-right">
                            <input
                              type="number"
                              min="0"
                              step="0.01"
                              value={item.discount}
                              onChange={e => handleUpdateItemField(idx, 'discount', e.target.value)}
                              className="w-20 text-right border border-slate-300 rounded py-1 px-1.5 text-xs font-bold text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
                            />
                          </td>
                          <td className="px-3 py-3 text-center">
                            <select
                              value={item.taxOption}
                              onChange={e => handleUpdateItemField(idx, 'taxOption', e.target.value)}
                              className="border border-slate-300 rounded py-1 px-1 text-[11px] font-semibold text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
                            >
                              {TAX_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                            </select>
                          </td>
                          <td className="px-4 py-3 text-right font-bold text-ink-primary font-mono whitespace-nowrap">
                            {peso(line.amount)}
                          </td>
                          <td className="px-3 py-3 text-center">
                            <button
                              type="button"
                              onClick={() => handleRemoveItem(idx)}
                              className="p-1.5 text-slate-400 hover:text-state-error hover:bg-state-error-light rounded transition-colors"
                              title="Remove item"
                            >
                              <Trash2 size={15} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {/* Dynamic totals breakdown footer */}
                  <tfoot className="bg-surface/80 border-t-2 border-slate-200">
                    <tr>
                      <td colSpan={5} className="px-4 py-2 text-right font-semibold text-ink-secondary text-xs">Subtotal</td>
                      <td colSpan={2} className="px-4 py-2 text-right font-semibold text-ink-primary font-mono text-xs">{peso(totals.subtotal)}</td>
                    </tr>
                    {totals.discount > 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-2 text-right font-semibold text-ink-secondary text-xs">Total Discount</td>
                        <td colSpan={2} className="px-4 py-2 text-right font-semibold text-state-error font-mono text-xs">-{peso(totals.discount)}</td>
                      </tr>
                    )}
                    {totals.tax > 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-2 text-right font-semibold text-ink-secondary text-xs">Total Tax</td>
                        <td colSpan={2} className="px-4 py-2 text-right font-semibold text-ink-primary font-mono text-xs">+{peso(totals.tax)}</td>
                      </tr>
                    )}
                    <tr>
                      <td colSpan={5} className="px-4 py-3.5 text-right font-bold text-ink-primary uppercase tracking-wider text-xs">
                        Grand Total:
                      </td>
                      <td colSpan={2} className="px-4 py-3.5 text-right font-extrabold text-getmeds-blue text-base font-mono">
                        {peso(grandTotal)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* SECTION 3: TERMS & ATTACHMENTS */}
          <div className="p-6 sm:p-8 space-y-5">
            <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100">
              <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
                <FileText size={16} />
              </div>
              <h2 className="text-base font-bold text-ink-primary">3. Terms & Attachments</h2>
            </div>

            <Field label="Terms and Conditions">
              <textarea
                value={termsAndConditions}
                onChange={e => setTermsAndConditions(e.target.value)}
                placeholder="Payment terms, return policy, or any conditions attached to this order..."
                rows={3}
                className={`${inputClass} resize-y`}
              />
            </Field>

            <Field
              label="Attach File(s) to Sales Order"
              help="Prescriptions, purchase orders, or other supporting documents. Not yet sent anywhere — attachments are staged here for review until Zoho document upload is wired up."
            >
              <label className="flex items-center justify-center gap-2 border-2 border-dashed border-slate-300 rounded-xl py-6 cursor-pointer hover:border-getmeds-blue hover:bg-getmeds-blue/5 transition-colors text-sm text-ink-secondary">
                <Paperclip size={16} />
                Click to attach file(s), or drag and drop
                <input type="file" multiple onChange={handleFilesSelected} className="hidden" />
              </label>
              {attachedFiles.length > 0 && (
                <ul className="mt-3 space-y-1.5">
                  {attachedFiles.map((f, idx) => (
                    <li key={idx} className="flex items-center justify-between gap-2 bg-surface border border-slate-200 rounded-lg px-3 py-1.5 text-xs">
                      <span className="flex items-center gap-1.5 min-w-0 text-ink-primary font-medium truncate">
                        <Paperclip size={12} className="shrink-0 text-ink-secondary" /> {f.name}
                      </span>
                      <button type="button" onClick={() => handleRemoveFile(idx)} className="p-0.5 text-slate-400 hover:text-state-error rounded-full shrink-0">
                        <X size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Field>
          </div>

          {/* SUBMISSION CONTROLS */}
          <div className="p-6 sm:p-8 bg-surface/40 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-ink-secondary">
              {!isFormValid ? (
                <span className="text-state-warning font-medium flex items-center gap-1.5">
                  <AlertCircle size={14} /> Mandatory fields required (Customer, Source, Invoicing From, 1+ Items, Address) to unlock submission.
                </span>
              ) : (
                <span className="text-pharmacy-green-dark font-medium flex items-center gap-1.5">
                  <CheckCircle size={14} /> Requisition is valid and ready for workflow review.
                </span>
              )}
            </div>

            <div className="flex items-center gap-3 w-full sm:w-auto">
              <button
                type="button"
                onClick={onCancel || (() => navigate('/orders'))}
                className="w-1/2 sm:w-auto px-5 py-2.5 border border-slate-200 rounded-lg text-sm font-semibold text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary transition-colors"
              >
                Cancel
              </button>

              <button
                type="submit"
                disabled={!isFormValid}
                className={`w-1/2 sm:w-auto flex items-center justify-center gap-2 px-7 py-2.5 rounded-lg text-sm font-bold transition-all shadow-sm ${
                  isFormValid
                    ? 'bg-getmeds-blue hover:bg-getmeds-blue-hover text-white shadow-md shadow-getmeds-blue/20 cursor-pointer'
                    : 'bg-state-neutral text-white cursor-not-allowed opacity-80'
                }`}
              >
                <ShoppingCart size={17} />
                Submit Order
              </button>
            </div>
          </div>
        </form>
      </div>

      {/* Review Modal */}
      <Modal
        isOpen={isReviewOpen}
        onClose={() => !mutation.isPending && setIsReviewOpen(false)}
        title="Confirm Requisition Submission"
      >
        <div className="space-y-4 text-sm text-ink-primary">
          <p className="text-xs text-ink-secondary leading-relaxed">
            Please verify the order line items and workflow route before committing this requisition.
          </p>

          <div className="bg-surface rounded-xl p-4 space-y-2.5 border border-slate-200">
            <div className="flex justify-between items-center">
              <span className="text-xs text-ink-secondary font-medium">Customer:</span>
              <span className="font-bold text-ink-primary">{selectedCustomer?.name || 'N/A'}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-ink-secondary font-medium">Account Type:</span>
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold ${
                customerType === 'credit' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/30' : 'bg-state-warning-light text-amber-950 border border-state-warning/30'
              }`}>
                {customerType === 'credit' ? '🏦 Credit Customer' : '💳 Direct Patient'}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-ink-secondary font-medium">Sales Order Date:</span>
              <span className="font-medium text-ink-primary">{todayLabel}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-ink-secondary font-medium">Salesperson:</span>
              <span className="font-medium text-ink-primary">{displaySalesPerson}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-ink-secondary font-medium">Division:</span>
              <span className="font-medium text-ink-primary">{myDivision || '—'}</span>
            </div>
            {mySubDivision && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-ink-secondary font-medium">Sub-division:</span>
                <span className="font-medium text-ink-primary">{mySubDivision}</span>
              </div>
            )}
            <div className="flex justify-between items-center">
              <span className="text-xs text-ink-secondary font-medium">Source:</span>
              <span className="font-medium text-ink-primary">{orderSource}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-ink-secondary font-medium">Invoicing From:</span>
              <span className="font-medium text-ink-primary">{invoicingFrom}</span>
            </div>
            {paymentTerms && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-ink-secondary font-medium">Payment Terms:</span>
                <span className="font-medium text-ink-primary">{paymentTerms}</span>
              </div>
            )}
            <div className="flex justify-between items-start pt-2 border-t border-slate-200">
              <span className="text-xs text-ink-secondary font-medium">Delivery Address:</span>
              <span className="font-medium text-ink-primary text-right max-w-[240px] truncate">{deliveryAddress}</span>
            </div>
            {deliveryNotes && (
              <div className="flex justify-between items-start">
                <span className="text-xs text-ink-secondary font-medium">Remarks:</span>
                <span className="text-ink-secondary text-right max-w-[240px] italic">{deliveryNotes}</span>
              </div>
            )}
          </div>

          {filledIntakeDetails.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-secondary mb-2">Additional Details</h4>
              <div className="bg-surface rounded-xl p-4 space-y-2 border border-slate-200">
                {filledIntakeDetails.map((f) => (
                  <div key={f.label} className="flex justify-between items-start gap-4">
                    <span className="text-xs text-ink-secondary font-medium shrink-0">{f.label}:</span>
                    <span className="text-ink-primary text-right break-words">{f.value}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {attachedFiles.length > 0 && (
            <div>
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-secondary mb-2">Attached Files</h4>
              <div className="bg-surface rounded-xl p-3 border border-slate-200 space-y-1">
                {attachedFiles.map((f, idx) => (
                  <div key={idx} className="flex items-center gap-1.5 text-xs text-ink-primary">
                    <Paperclip size={11} className="text-ink-secondary" /> {f.name}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-ink-secondary mb-2">Order Line Items</h4>
            <div className="border border-slate-200 rounded-xl overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-surface">
                  <tr>
                    <th className="px-3 py-2 text-left font-bold text-ink-secondary">Item</th>
                    <th className="px-2 py-2 text-center font-bold text-ink-secondary">Qty</th>
                    <th className="px-3 py-2 text-right font-bold text-ink-secondary">Rate</th>
                    <th className="px-3 py-2 text-right font-bold text-ink-secondary">Discount</th>
                    <th className="px-3 py-2 text-center font-bold text-ink-secondary">Tax</th>
                    <th className="px-3 py-2 text-right font-bold text-ink-secondary">Amount</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {items.map((item, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 font-medium text-ink-primary">
                        {item.name} <span className="text-ink-secondary">({item.sku})</span>
                      </td>
                      <td className="px-2 py-2 text-center text-ink-primary font-bold">{item.quantity}</td>
                      <td className="px-3 py-2 text-right text-ink-secondary">{peso(item.rate)}</td>
                      <td className="px-3 py-2 text-right text-ink-secondary">{item.discount > 0 ? `-${peso(item.discount)}` : '—'}</td>
                      <td className="px-3 py-2 text-center text-ink-secondary">{getTaxOption(item.taxOption).label}</td>
                      <td className="px-3 py-2 text-right font-bold text-ink-primary">
                        {peso(lineAmounts[idx].amount)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-surface">
                  <tr>
                    <td colSpan={5} className="px-3 py-2 text-right font-bold text-ink-primary">Grand Total:</td>
                    <td className="px-3 py-2 text-right font-extrabold text-getmeds-blue text-sm">{peso(grandTotal)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-3 border-t border-slate-100">
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => setIsReviewOpen(false)}
              className="flex items-center gap-1 px-4 py-2 border border-slate-200 rounded-lg text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back to Edit
            </button>
            <button
              type="button"
              disabled={mutation.isPending}
              onClick={() => mutation.mutate()}
              className="flex items-center gap-1.5 px-6 py-2 bg-getmeds-blue text-white rounded-lg text-xs font-bold hover:bg-getmeds-blue-hover disabled:opacity-50 shadow-md shadow-getmeds-blue/20"
            >
              {mutation.isPending ? 'Submitting...' : 'Confirm & Submit Requisition'}
            </button>
          </div>
        </div>
      </Modal>

      {/* Post-Submission Success Modal with Green (#61A644) Tracking Badge */}
      {submittedOrder && (
        <Modal
          isOpen={Boolean(submittedOrder)}
          onClose={() => navigate(`/orders/${submittedOrder.id}?tab=timeline`)}
          title="Order Submitted Successfully"
        >
          <div className="text-center py-4 space-y-4">
            <div className="w-16 h-16 rounded-full bg-pharmacy-green/15 text-pharmacy-green flex items-center justify-center mx-auto shadow-sm">
              <CheckCircle size={36} />
            </div>

            <div>
              <h3 className="text-lg font-bold text-ink-primary">Requisition Kicked Off!</h3>
              <p className="text-xs text-ink-secondary mt-1">
                Your order is now officially registered in the Getmeds state machine.
              </p>
            </div>

            {/* Generated Green (#61A644) Tracking Badge */}
            <div className="bg-pharmacy-green/10 border-2 border-pharmacy-green rounded-xl p-4 flex flex-col items-center justify-center gap-1">
              <span className="text-[11px] font-bold uppercase tracking-wider text-pharmacy-green-dark">
                Generated Tracking ID
              </span>
              <span className="text-2xl font-extrabold font-mono text-pharmacy-green tracking-wide">
                {submittedOrder.getmeds_order_id}
              </span>
            </div>

            <p className="text-xs text-ink-secondary">
              Workflow Status: <span className="font-semibold text-ink-primary capitalize">{submittedOrder.status?.replace(/_/g, ' ')}</span>
            </p>

            <div className="flex justify-center gap-3 pt-2">
              <button
                type="button"
                onClick={() => navigate('/orders')}
                className="px-4 py-2 border border-slate-200 rounded-lg text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
              >
                Go to My Orders
              </button>
              <button
                type="button"
                onClick={() => navigate(`/orders/${submittedOrder.id}?tab=timeline`)}
                className="px-6 py-2 bg-pharmacy-green text-white rounded-lg text-xs font-bold hover:bg-pharmacy-green-hover shadow-md shadow-pharmacy-green/20"
              >
                View Order Details
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};

export default OrderForm;
