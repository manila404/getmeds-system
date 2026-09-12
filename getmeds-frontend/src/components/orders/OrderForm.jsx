import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import client from '../../api/client';
import Modal from '../ui/Modal';
import ProductAutocomplete from './ProductAutocomplete';
import CustomerAutocomplete from './CustomerAutocomplete';
import MedrepAccountCombo from './MedrepAccountCombo';
import ZohoSalespersonCombo from './ZohoSalespersonCombo';
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
  Building2,
  ShieldCheck,
  Plus
} from 'lucide-react';
import { useDebug } from '../../context/DebugContext';
import { useAuth } from '../../hooks/useAuth';

import { useProducts, useCustomers } from '../../hooks/useOrderData';
import { fetchCustomerZohoAddress, fetchCustomers } from '../../api/queries';
import { ATTACHMENT_TYPES } from '../../constants/attachmentTypes';

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
  'Distributor order',
  // Sep 9, 2026: the assistance-programme sources the hospital flow uses.
  // Kept in this same list rather than a separate hospital-only one — the
  // Source field is one field with one set of answers, and splitting it would
  // mean a MedRep who picked the wrong customer category sees the wrong menu.
  'PAP-DSWD'
];

/**
 * Sep 9, 2026: which customer categories put the form into its hospital
 * variant — Doctor Name and GL Number required, a receiver type to pick, and
 * four specific attachments before it will submit.
 *
 * Driven by `customers.category`, the local classification tag set from the
 * Clients Directory. A customer with no category behaves as an ordinary one;
 * that is the right default, since an untagged customer is far more likely to
 * be a plain client than a hospital nobody has classified yet.
 */
const HOSPITAL_CATEGORIES = ['hospital'];

/**
 * The attachments a hospital order cannot be submitted without.
 *
 * The list is the requirement itself, so the checklist on screen and the
 * submit gate can never disagree — they both read this.
 */
const HOSPITAL_REQUIRED_ATTACHMENTS = [
  { value: 'gl',            label: 'Guarantee Letter (GL)' },
  { value: 'prescription',  label: 'Prescription' },
  { value: 'payment_proof', label: 'Proof of Payment' },
  { value: 'id',            label: 'Valid ID' },
];

const RECEIVER_TYPES = [
  { value: 'patient',        label: 'Patient' },
  { value: 'representative', label: 'Representative' },
];

// Exactly the two legal entities orders may be invoiced under — enforced
// here AND server-side (orders.controller.js create()).
const INVOICING_FROM_OPTIONS = ['2mg Incorporated', 'Getmeds Philippines Inc.'];

// Sep 5, 2026 (3): mirrors auth.controller.js's / orders.controller.js's
// SUB_DIVISIONS_BY_DIVISION exactly — see auth.controller.js's comment for
// why only these four Divisions have a fixed list. Division itself stays
// read-only here (it drives Salesperson and is not editable per order — see
// myDivision below); Sub-division is the one field of the three that can be
// typed/picked per order, keyed off whichever Division the ordering
// MedRep's account actually has.
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

// Sep 5, 2026 (4): mirrors auth.controller.js's / orders.controller.js's
// DIVISIONS exactly. Only used for Management's manual Division override
// below (myDivision/divisionOverride) — a MedRep never sees this list,
// their Division stays a read-only mirror of their own account.
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

// Common delivery methods — offered as suggestions via SuggestField below
// (a native <datalist> before Sep 5, 2026 — see that component's comment),
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
// Order screen. Same pattern as Delivery Method above: suggestions via
// SuggestField, not a locked dropdown, since Zoho's own field accepts a
// custom typed value too (not just one of these presets) — there's no
// Zoho Inventory API to read this list live (checked Sep 5, 2026: only an
// undocumented, Books-only settings endpoint exists, not guaranteed to work
// or stay working), and a typed field with suggestions is exactly how Zoho
// itself behaves here, so hardcoding stays the right call. Refreshed Sep 5,
// 2026 against the org's current dropdown (grew from 6 to 24 entries since
// the Aug 30 list below was captured) — kept in Zoho's own display order.
// 'net' (lowercase) is listed twice in Zoho itself, alongside 'Net' — kept
// as two separate suggestions since that's genuinely what's configured
// there, not a typo on this end.
const PAYMENT_TERMS_SUGGESTIONS = [
  'Due end of next month',
  'Due end of the month',
  'Paid',
  'Advanced Payment',
  'Advanced Payment - Partial',
  'Donation/Charity',
  'Samples',
  'Due on Receipt',
  '60% DP 40% UPON DEL',
  'CASH',
  'COD',
  'Net',
  'Net 15',
  '30 days',
  '45 Day',
  'BPO WALLET',
  '60 Day',
  'DSWD/PCSO',
  'net',
  'OP',
  '90 Day',
  'INITIAL STOCKING',
  '120 Day',
  '180 Day'
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
 * A free-text input with a styled suggestions dropdown underneath it —
 * Delivery Method, Payment Terms, and Doctor Name all need "type anything,
 * but here's what's common" rather than a locked picklist (Zoho's own
 * fields behave the same way).
 *
 * Sep 5, 2026: replaces the native `<input list="...">` + `<datalist>`
 * pattern those three fields used before. A native datalist's dropdown
 * panel is painted entirely by the browser/OS, not by this app — it
 * ignores every bit of our CSS. On Windows with a dark OS theme, Chrome and
 * Edge render that panel dark-on-dark-background regardless of how the
 * page around it looks, which is exactly the mismatch a MedRep/management
 * user reported seeing. This is a small custom combobox instead, built the
 * same way ProductAutocomplete/CustomerAutocomplete already are (styled
 * list, click-outside-to-close) — the field is still fully free-typed,
 * never locked to one of these suggestions.
 */
const SuggestField = ({ value, onChange, suggestions = [], placeholder, className = inputClass }) => {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const term = (value || '').trim().toLowerCase();
  const filtered = term
    ? suggestions.filter((s) => s.toLowerCase().includes(term))
    : suggestions;

  const handleSelect = (s) => {
    onChange(s);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <input
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); setIsOpen(true); }}
        onFocus={() => setIsOpen(true)}
        placeholder={placeholder}
        className={className}
        autoComplete="off"
      />
      {isOpen && filtered.length > 0 && (
        <ul className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 shadow-lg rounded-lg z-20 max-h-52 overflow-y-auto divide-y divide-slate-100">
          {filtered.map((s) => (
            <li key={s}>
              <button
                type="button"
                onClick={() => handleSelect(s)}
                className="w-full text-left px-3 py-2 text-sm text-ink-primary hover:bg-surface focus:bg-surface focus:outline-none transition-colors"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * OrderForm Component
 *
 * Implements:
 * - Step 1: React Query cached master data from useOrderData
 * - Step 2: Autocomplete integration via <CustomerAutocomplete /> and <ProductAutocomplete />
 * - Step 3: Cart state, per-line discount/tax, .reduce() totals, useMutation to /api/orders, and fast-track debug button.
 */
const OrderForm = ({ orderForMode = null, onChangeOrderOwner, onCancel, onSuccess }) => {
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

  // ── Sep 9, 2026: Master Form fields ────────────────────────────────────────
  //
  // `isDoctor` is deliberately '' (unanswered) rather than defaulting to Yes
  // or No — it is a required question, and a default would mean most orders
  // silently carry whichever answer happened to be pre-selected.
  const [isDoctor, setIsDoctor] = useState('');
  const [expectedShipmentDate, setExpectedShipmentDate] = useState('');
  const [customerTin, setCustomerTin] = useState('');
  const [glNumber, setGlNumber] = useState('');
  const [receiverType, setReceiverType] = useState('');
  // UI-only for now — files are listed here but never uploaded anywhere
  // (see the mapping doc: Zoho's `documents` field needs each file already
  // uploaded to Zoho first, which isn't built yet). Kept purely so the form
  // matches the field list and the UX is ready for that later.
  // Sep 4, 2026: proof of payment, staged here and uploaded immediately AFTER
  // the order is created. It cannot go up during the form: the storage path is
  // orders/<id>/... and there is no id until create returns. Staging the File
  // object in memory and uploading on success is what lets the MedRep attach it
  // where they naturally look for it without a temp path and a move.
  //
  // The previous "Attach File(s) to Sales Order" control lived here and was
  // dead — `// UI-only for now — files are listed here but never uploaded
  // anywhere`. It sat exactly where a MedRep would put the deposit slip, so it
  // was worse than nothing: it looked like filing and discarded the file.
  //
  // Sep 5, 2026: generalized to Zoho's own shape — "Attach File(s) to Sales
  // Order" — any number of files, each tagged with a type. `stagedAttachments`
  // is `[{ localId, file, fileType }]`; `localId` is a client-only key (React
  // list key + removal target) that never leaves the browser. Every file still
  // uploads AFTER order creation, same reason as before (no order id yet).
  const [stagedAttachments, setStagedAttachments] = useState([]);
  const [noProofReason, setNoProofReason] = useState('');
  const [noProofNote, setNoProofNote] = useState('');

  // Does the staged list contain at least one 'payment_proof'-type file? Used
  // wherever the old code asked "is there a proof file" — the "no proof, say
  // why" reason is specifically about the ABSENCE of a payment_proof, not
  // about attachments in general, so an 'other'-only staged list still needs
  // a reason.
  const hasStagedProof = stagedAttachments.some(a => a.fileType === 'payment_proof');


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

  // ── Sep 9, 2026: the hospital variant of this form ─────────────────────────
  //
  // One selected customer decides it. Everything downstream — which fields are
  // required, which attachments are demanded, what the review screen shows —
  // reads these three, so there is one definition of "this is a hospital
  // order" rather than a category check repeated at each site.
  //
  // Declared HERE, immediately after `selectedCustomer`, and not up with the
  // other derived values near the top of this component. `const` is not
  // hoisted the way `var` is: reading `selectedCustomer` above its own
  // declaration throws "Cannot access 'selectedCustomer' before
  // initialization" and takes the whole form down with it. That is a RUNTIME
  // error — the bundler compiles it happily — so the only thing that catches
  // it is opening the page.
  const isHospitalOrder = HOSPITAL_CATEGORIES.includes(
    String(selectedCustomer?.category || '').toLowerCase()
  );

  const stagedTypes = new Set(stagedAttachments.map(a => a.fileType));
  // Computed from HOSPITAL_REQUIRED_ATTACHMENTS rather than listed again, so
  // the checklist on screen and the submit gate can never disagree.
  const missingHospitalAttachments = isHospitalOrder
    ? HOSPITAL_REQUIRED_ATTACHMENTS.filter(t => !stagedTypes.has(t.value))
    : [];

  // Doctor Name is only typed when the customer is NOT the doctor. When they
  // are, the field is the customer's own name — asking someone to retype what
  // is already on screen is how a form gets a typo instead of an answer.
  //
  // Sep 11, 2026: no longer required on an ordinary order; still required on a
  // hospital one (see isFormValid).
  const effectiveDoctorName = isDoctor === 'yes'
    ? (selectedCustomer?.name || '')
    : doctorName;

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
  // Seeded from the pre-form choice (OrderForWhoModal). Back office still sets
  // it from the dropdown inside the form.
  const [actingMedrepId, setActingMedrepId] = useState('');
  /**
   * BOX 1's value — the Zoho Salesperson actually sent.
   *
   * Empty means "follow the account", which is what mySalesperson resolves
   * below. Typed or picked, it wins: a rep covering several Salespersons, or
   * raising an order that belongs under a different one, says so here.
   */
  const [zohoSalespersonChoice, setZohoSalespersonChoice] = useState('');

  const { data: medrepPicker } = useQuery({
    queryKey: ['order-medreps'],
    queryFn: async () => (await client.get('/api/orders/meta/medreps')).data.data,
    staleTime: 1000 * 60 * 5
  });
  const canPickMedrep = !!medrepPicker?.enabled;
  // A MedRep gets the two-way choice; admin and management keep the optional
  // dropdown, because blank means something different for them.
  const isRepChoosing = canPickMedrep && (user?.role || '').toLowerCase() === 'medrep';
  const medrepOptions = medrepPicker?.medreps || [];
  // Themselves excluded — "for myself" is the other answer, and offering it
  // here invites picking the one that does not clear the mode.
  const colleagueAccounts = medrepOptions.filter((m) => String(m.id) !== String(user?.id));
  const actingMedrep = canPickMedrep
    ? medrepOptions.find(m => String(m.id) === String(actingMedrepId)) || null
    : null;

  // Seeded from the owner, then left alone.
  //
  // Keyed on who the order is FOR, so switching colleague re-seeds — but it
  // does not run on every render, which would overwrite a rep who deliberately
  // typed a different Salesperson the moment anything else on the form
  // changed.
  const seededFor = useRef(null);
  useEffect(() => {
    if (!isRepChoosing) return;
    const ownerKey = orderForMode === 'other' ? `other:${actingMedrepId}` : 'self';
    if (seededFor.current === ownerKey) return;
    const owner = orderForMode === 'other' ? actingMedrep : user;
    const ownersOwn = (owner?.salesperson || '').trim();
    // Only re-seed when the new owner HAS one. Otherwise leave what is there:
    // picking the Salesperson first and the account second is a normal order
    // of work, and blanking the field at that point silently discards a
    // deliberate choice — which is exactly what happened when an account with
    // no Salesperson was selected after one had been picked.
    if (!ownersOwn) {
      seededFor.current = ownerKey;
      return;
    }
    seededFor.current = ownerKey;
    setZohoSalespersonChoice(ownersOwn);
  }, [isRepChoosing, orderForMode, actingMedrepId, actingMedrep, user]);
  // The pre-form choice is the only source for a rep, so there is no stale
  // selection to guard against here any more.
  const effectiveMedrepId = actingMedrepId;
  // Sep 5, 2026: the picker also appears for management (production pilot
  // use), not just TEST_MODE admin — see /api/orders/meta/medreps.
  //
  // Sep 5, 2026 (4): selecting a MedRep here is OPTIONAL again for
  // Management (it was briefly required — see resolveOrderMedrep's Sep 5
  // (4) note on the backend). Left blank, the order is attributed to the
  // Management account itself, and Division/Salesperson below become
  // manual fields instead of a read-only mirror of an account.
  // Sep 9, 2026: renamed from isManagementUser and widened to include admin.
  //
  // Every branch this gates asks the same underlying question — "is this order
  // being raised from the back office rather than by the MedRep it belongs
  // to?" — and admin answers it identically to management: their own account
  // has no Division and no Salesperson, so they pick a MedRep or type both
  // manually, and the "no proof of payment, say why" prompt is not aimed at
  // them. Naming it after one role was what made an admin's version of this
  // form silently behave like a MedRep's.
  const isBackOffice = ['management', 'admin'].includes((user?.role || '').toLowerCase());
  // Sep 5, 2026 (4): Zoho's own known Salesperson names, for the manual
  // Salesperson field below — same gate as medrepOptions above (server
  // decides via `enabled`), so this is empty for anyone who can't use it.
  //
  // Sep 11, 2026: the picked MedRep's own Salespersons lead the list — a rep
  // can cover several, and those are the likeliest right answers.
  const actingMedrepSalespersons = (actingMedrep?.salespersons || []).map((s) => s.salesperson);
  // Zoho's full list, as returned by /api/orders/meta/medreps.
  const allZohoSalespersons = medrepPicker?.salespersons || [];
  const salespersonSuggestions = [
    ...actingMedrepSalespersons,
    ...(medrepPicker?.salespersons || []).filter((n) => !actingMedrepSalespersons.includes(n))
  ];

  // Sep 11, 2026: a MedRep may cover several Zoho Salespersons (see
  // user_salespersons in schema.pg.sql) and picks one per order. This is their
  // own list; the server accepts only these, and sending none means primary.
  const { data: mySalespersonStatus } = useQuery({
    queryKey: ['my-salespersons'],
    queryFn: async () =>
      (await client.get('/api/orders/meta/salesperson', { skipAuthRedirect: true })).data.data,
    enabled: !!user && !isBackOffice,
    staleTime: 1000 * 60 * 5
  });
  const myOwnSalespersons = mySalespersonStatus?.salespersons || [];

  /**
   * The Salespersons belonging to whoever this order is FOR.
   *
   * Listed first in the picker and labelled "theirs". Raising an order for a
   * colleague who covers three Salespersons should not mean searching 198
   * names for one of the three.
   */
  const ownerSalespersons = actingMedrep
    ? (actingMedrep.salespersons || []).map((x) => x.salesperson).filter(Boolean)
    // For a rep's own order: their whole list, not just the primary —
    // /api/orders/meta/salesperson returns every Salesperson on the account.
    : (myOwnSalespersons.length
        ? myOwnSalespersons.map((x) => x.salesperson).filter(Boolean)
        : (user?.salesperson ? [user.salesperson] : []));

  /** Who the order is for, for use in the Salesperson field's own copy. */
  const ownerOwnerLabel = actingMedrep
    ? (actingMedrep.display_name || actingMedrep.name)
    : 'Your account';

  const [ownSalespersonChoice, setOwnSalespersonChoice] = useState('');

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
  //
  // Sep 7, 2026 (4): the "otherwise the logged-in account" fallback below is
  // now MedRep-only. A Management/admin account is not a field rep and has
  // no real Salesperson of its own — a seeded account's Division is a
  // placeholder (e.g. "Management"), not one of the real DIVISIONS Zoho
  // recognizes, so `user.salesperson` for Management is guaranteed junk
  // ("Management | Test Manager", say). Falling back to it here used to
  // silently pre-fill the Salesperson override with that junk value
  // whenever Management left "Create this order for" blank — this account
  // is the "Admin" who created the order (see orders.controller.js's
  // onBehalfOf audit note), never the Salesperson; the Salesperson is
  // always the picked MedRep, or one Management types manually below.
  const isTestCustomerSelected = !!selectedCustomer && testCustomerGateEnabled;
  // Box 1 wins when a rep has set it. Otherwise it follows the account the
  // order belongs to — the colleague's when raising for one, the rep's own
  // otherwise — which is what box 1 is seeded with below.
  const mySalesperson = (
    (isRepChoosing && zohoSalespersonChoice)
      ? zohoSalespersonChoice
      : (actingMedrep ? actingMedrep.salesperson : (isBackOffice ? '' : (ownSalespersonChoice || user?.salesperson)))
    || ''
  ).trim();
  const displaySalesPerson =
    mySalesperson || (isTestCustomerSelected ? 'TEST | MEDREP' : 'Not set');

  // Sep 2, 2026: Division and Sub-division are their own custom fields on
  // this org's Sales Order (cf_division / cf_sub_division) and are sent with
  // every order, so they are shown rather than left invisible. Read from the
  // SAME source as the Salesperson above — the acting MedRep when an admin
  // has picked one, otherwise the logged-in account (MedRep only — see the
  // Sep 7 (4) note above) — because the backend reads all three from one
  // user row and the screen must not imply otherwise.
  const myDivision = ((actingMedrep ? actingMedrep.division : (isBackOffice ? '' : user?.division)) || '').trim();
  const mySubDivision = ((actingMedrep ? actingMedrep.sub_division : (isBackOffice ? '' : user?.sub_division)) || '').trim();

  // Sep 5, 2026 (4): Division and Salesperson, manually typed — Management
  // ONLY (a MedRep's own account values above are never overridden; these
  // two inputs simply aren't rendered for them — see the Fields below).
  // Starts out equal to whatever myDivision/mySalesperson already show
  // (the picked MedRep's own account, or blank when none is picked) and
  // resets whenever that changes, same reasoning as subDivisionInput below
  // — switching MedRep should not silently carry over an override that was
  // typed for someone else. From there Management can freely edit either
  // one, or leave it blank to fall back to the account value (or nothing).
  const [divisionOverride, setDivisionOverride] = useState(myDivision);
  useEffect(() => {
    setDivisionOverride(myDivision);
  }, [myDivision]);
  const [salespersonOverride, setSalespersonOverride] = useState(mySalesperson);
  useEffect(() => {
    setSalespersonOverride(mySalesperson);
  }, [mySalesperson]);
  // The Division actually in effect for THIS order right now — Management's
  // typed override when present, else the account value. Feeds the
  // Sub-division options below exactly like the backend's effectiveDivision
  // feeds its own Sub-division check, so the two never disagree about which
  // branch list applies.
  const effectiveDivision = isBackOffice ? (divisionOverride || myDivision) : myDivision;

  // Sep 5, 2026 (3): Sub-division is editable ON THIS ORDER, by whoever is
  // raising it — medrep or management — unlike Division and Salesperson,
  // which stay tied to the ordering MedRep's account above. Starts out
  // equal to the account's own default (`mySubDivision`) and resets to it
  // whenever that default changes — i.e. when the account loads, or when
  // management switches which MedRep they're raising the order for — so
  // switching MedRep never silently carries over a Sub-division that
  // belonged to a different Division. From there the field can be freely
  // edited before submitting.
  const [subDivisionInput, setSubDivisionInput] = useState(mySubDivision);
  useEffect(() => {
    setSubDivisionInput(mySubDivision);
  }, [mySubDivision]);

  // null when the Division in effect (see effectiveDivision above) has no
  // fixed Sub-division list — the field renders free text in that case,
  // same as Sign Up/Profile Settings.
  const subDivisionOptions = SUB_DIVISIONS_BY_DIVISION[effectiveDivision] || null;

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
    // Sep 9, 2026: the TIN comes with the customer when Zoho has one. Editable
    // when it does not — Zoho refuses a Sales Order for a business-subtype
    // contact with an empty TIN, so the MedRep supplying it here is what
    // unblocks the order (orders.controller.js writes it through to the
    // contact before creating the Sales Order).
    setCustomerTin(c.tin || '');
    // Answers that were about the PREVIOUS customer. Left standing, "Is
    // Doctor: Yes" from one customer would silently carry onto the next.
    setIsDoctor('');
    setDoctorName('');

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
    // Sep 9, 2026: clear what belonged to that customer, for the same reason
    // handleCustomerChange resets them — see the note there.
    setCustomerTin('');
    setIsDoctor('');
    setDoctorName('');
    setGlNumber('');
    setReceiverType('');
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

  // Sep 5, 2026: matches the backend's ALLOWED_TYPES in paymentProofStorage.js
  // — widened beyond photos/PDF so an 'other' attachment (a PO, a signed
  // contract) can be a Word or Excel file too.
  const PROOF_MAX_BYTES = 15 * 1024 * 1024;
  const PROOF_ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,' +
    'application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
    'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  const NO_PROOF_REASONS = [
    { value: 'on_payment_terms',  label: 'Customer is on payment terms' },
    { value: 'payment_to_follow', label: 'Payment to follow' },
    { value: 'paid_no_slip',      label: 'Paid — no slip issued' },
    { value: 'other',             label: 'Other (explain below)' },
  ];

  // Sep 5, 2026: one handler for the "Take photo" / "Choose file" buttons
  // (mobile), the drag-and-drop zone (desktop), and any number of files —
  // each newly picked file is appended to the staged list, defaulted to
  // 'payment_proof' (the common case; the MedRep re-tags it with the
  // dropdown next to it if it's actually something else).
  //
  // Sep 5, 2026 (2): pulled out of the <input onChange> handler so the same
  // logic can run from a drop event too (FileList in both cases, but a drop
  // event has no `target` to clear).
  const processFiles = (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;

    const accepted = [];
    for (const file of files) {
      if (file.size > PROOF_MAX_BYTES) {
        toast.error(`"${file.name}" is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 15 MB.`);
        continue;
      }
      accepted.push({ localId: `${Date.now()}-${Math.random().toString(36).slice(2)}`, file, fileType: 'payment_proof' });
    }
    if (!accepted.length) return;

    setStagedAttachments(prev => [...prev, ...accepted]);
    // A newly-staged proof retires whatever reason was given for not having
    // one — the reason and the file are mutually exclusive states, and the
    // reason only applies again if every proof-type file is removed.
    setNoProofReason('');
    setNoProofNote('');
  };

  const handleFilesSelected = (e) => {
    processFiles(e.target.files);
    e.target.value = ''; // so picking the same file twice still fires onChange
  };

  // Sep 5, 2026 (2): drag-and-drop for desktop — the click-to-choose
  // buttons stay as the mobile affordance (a touch screen has no drag
  // gesture between apps in the same way), this is the PC-only addition
  // sitting alongside them. `isDragActive` only drives the highlight style;
  // drop still goes through the same processFiles as every other path.
  const [isDragActive, setIsDragActive] = useState(false);
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragActive(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragActive(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragActive(false);
    processFiles(e.dataTransfer.files);
  };

  const handleRemoveAttachment = (localId) => {
    setStagedAttachments(prev => prev.filter(a => a.localId !== localId));
  };

  const handleAttachmentTypeChange = (localId, fileType) => {
    setStagedAttachments(prev => prev.map(a => (a.localId === localId ? { ...a, fileType } : a)));
  };

  /**
   * The three-step handshake, run once the order exists, for every staged
   * file in turn.
   *
   * Identical to PaymentProofPanel's: each file goes browser -> Supabase
   * directly against a signed URL, because Vercel caps request bodies at
   * 4.5 MB and a phone photo is routinely larger. Plain fetch, not `client`,
   * so our API baseURL and session JWT do not get attached to a Supabase URL.
   *
   * Sep 5, 2026: renamed from uploadPaymentProof (singular) — now uploads the
   * whole staged list against the generalized /attachments endpoints. Returns
   * the file names that failed, so the caller can tell the MedRep exactly
   * which ones to re-attach from the order's Attachments tab rather than a
   * blanket "something failed".
   */
  const uploadAttachments = async (orderId, attachments) => {
    const failed = [];
    for (const { file, fileType } of attachments) {
      try {
        const { data: urlRes } = await client.post(`/api/orders/${orderId}/attachments/upload-url`, {
          contentType: file.type, fileName: file.name, fileSize: file.size, file_type: fileType,
        });
        const { signedUrl, storagePath } = urlRes.data;

        const put = await fetch(signedUrl, {
          method: 'PUT',
          headers: { 'content-type': file.type },
          body: file,
        });
        if (!put.ok) throw new Error(`Upload to storage failed (${put.status})`);

        await client.post(`/api/orders/${orderId}/attachments`, {
          storagePath, fileName: file.name, contentType: file.type, fileSize: file.size, file_type: fileType,
        });
      } catch (err) {
        console.error(`[ATTACHMENTS] upload failed for "${file.name}":`, err);
        failed.push(file.name);
      }
    }
    return failed;
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
    // "Another MedRep" with nobody chosen would silently fall back to the
    // rep's own account — right on screen, wrong person in Zoho.
    (!isRepChoosing || orderForMode !== 'other' || actingMedrepId) &&
    customerId &&
    deliveryAddress.trim() &&
    orderSource &&
    invoicingFrom &&
    // Sep 9, 2026: the Master Form's own required set. Same standing as Source
    // and Invoicing From above — a client-side UX guarantee, deliberately NOT
    // enforced by POST /api/orders, which would otherwise reject every other
    // caller of that endpoint including the test suite.
    paymentTerms.trim() &&
    expectedShipmentDate &&
    deliveryNotes.trim() &&
    // Sep 11, 2026: "Is the customer the doctor?" and Doctor Name are OPTIONAL
    // on an ordinary order. Most orders are not placed for a named doctor, and
    // making every rep answer a question that does not apply produces a filled
    // box rather than a fact.
    //
    // They stay REQUIRED on a hospital order, which is what the Master Form
    // always specified. That clause is written out here on purpose: the old
    // code relied on the global requirement above and said so in a comment
    // ("a hospital order can never be Yes in practice, which is why the
    // hospital rule needs no separate clause for it"), so simply deleting the
    // global one would have quietly dropped the hospital requirement too.
    (!isHospitalOrder ||
      (effectiveDoctorName.trim() &&
        glNumber.trim() &&
        receiverType &&
        missingHospitalAttachments.length === 0)) &&
    items.length > 0 &&
    items.every(i => i.productId && Number(i.quantity) > 0 && Number(i.rate) >= 0) &&
    // Sep 4, 2026: a proof of payment, or a reason there is none. Never neither,
    // so Finance always gets either evidence or an explanation rather than a
    // blank. Like Source and Invoicing From above, this is a client-side UX
    // guarantee — POST /api/orders still accepts an order without it, because
    // the proof itself uploads after create.
    // Sep 5, 2026: "a proof of payment" now means "at least one staged file
    // tagged payment_proof" — an 'other'-only staged list still needs a
    // reason, same as an empty one.
    // Sep 5, 2026 (2): management is exempt from this entirely — the "no
    // proof, say why" field is not shown to them at all (see isBackOffice
    // below and the Field it gates), so there is nothing here for them to
    // fill in and this requirement must not block their submission.
    // Sep 9, 2026: a hospital order requires a Proof of Payment outright (it is
    // in HOSPITAL_REQUIRED_ATTACHMENTS), so the "or say why there isn't one"
    // escape does not apply to it — including for management, who are
    // otherwise exempt from this rule entirely.
    (isHospitalOrder ||
      isBackOffice || hasStagedProof ||
      (Boolean(noProofReason) && (noProofReason !== 'other' || Boolean(noProofNote.trim()))))
    // Sep 5, 2026 (4): management picking a MedRep here used to be
    // required (see the Sep 5 removal note on resolveOrderMedrep on the
    // backend) — it's optional again now that Division/Salesperson can be
    // typed manually instead, so there is no client-side requirement left
    // to enforce here.
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
    setDeliveryNotes('Auto-filled test order — no special handling instructions.');
    setDeliveryMethod('Lalamove');
    setIsDoctor('no');
    setDoctorName('Dr. Test');
    setOrderSource('Patient order referred by doctor');
    setInvoicingFrom('2mg Incorporated');
    setTermsAndConditions('');
    // Sep 9, 2026: the Master Form's own required fields, so this button still
    // produces a form that can actually be submitted.
    setPaymentTerms('30 days');
    setExpectedShipmentDate(new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));

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
    setIsDoctor('no');
    setDoctorName('Dr. Test');
    setOrderSource('Patient order referred by patient');
    setInvoicingFrom('2mg Incorporated');
    setTermsAndConditions('Full payment required prior to dispatch.');
    // See the note on the credit auto-fill above.
    setPaymentTerms('30 days');
    setExpectedShipmentDate(new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10));

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
        // Sep 9, 2026: `effectiveDoctorName`, not `doctorName` — when the
        // customer IS the doctor their own name is the answer, and sending the
        // empty typed field would record no doctor at all on exactly the
        // orders that most clearly have one.
        doctor_name: effectiveDoctorName,
        receiver_name: receiverName,
        receiver_contact_no: receiverContactNo,
        // ── Sep 9, 2026: Master Form fields ──────────────────────────────────
        expected_shipment_date: expectedShipmentDate || null,
        is_doctor: isDoctor === 'yes' ? true : isDoctor === 'no' ? false : null,
        // Written through to the customer record and to Zoho's cf_tin
        // (best-effort) before the Sales Order is created — see
        // orders.controller.js. Sent on every order, and a no-op server-side
        // when unchanged.
        customer_tin: customerTin.trim() || null,
        // Hospital-only fields, and only sent for a hospital order: a GL
        // Number left over in state from a customer the MedRep then changed
        // away from must not ride along on an ordinary order.
        gl_number: isHospitalOrder ? (glNumber.trim() || null) : null,
        receiver_type: isHospitalOrder ? (receiverType || null) : null,
        order_source: orderSource,
        delivery_method: deliveryMethod,
        terms: termsAndConditions,
        payment_terms: paymentTerms,
        invoicing_from: invoicingFrom,
        // Sep 5, 2026 (3): editable per order now — see subDivisionInput
        // above. Blank is treated the same as "not sent" server-side
        // (orders.controller.js falls back to the account default), so
        // there is no separate "clear it" affordance needed here.
        sub_division: subDivisionInput,
        // Only ever sent when no proof-type file was staged — staging one
        // clears these (see handleFilesSelected).
        no_payment_proof_reason: hasStagedProof ? null : (noProofReason || null),
        no_payment_proof_note: hasStagedProof ? null : (noProofNote.trim() || null),
        // Sep 2, 2026: only ever sent when the server said the picker is
        // allowed AND one was chosen. The server ignores it otherwise, so
        // this is belt-and-braces rather than the control itself.
        // effectiveMedrepId, not actingMedrepId: a rep who picked a colleague
        // and then switched back to "Myself" must not still send them. The
        // toggle clears it too, so this is the second of two guards rather
        // than the only one.
        ...(canPickMedrep && effectiveMedrepId ? { medrep_id: parseInt(effectiveMedrepId) } : {}),
        // Sep 5, 2026 (4): Division/Salesperson manual override — only ever
        // sent by Management (the backend independently ignores these two
        // from anyone else, same belt-and-braces reasoning as medrep_id
        // above). Blank is treated the same as "not sent" server-side, so
        // there's no separate "clear it" affordance needed here either.
        ...(isBackOffice && divisionOverride.trim() ? { division: divisionOverride.trim() } : {}),
        ...(isBackOffice && salespersonOverride.trim() ? { salesperson: salespersonOverride.trim() } : {}),
        // Sep 11, 2026: the Zoho Salesperson the form is showing — box 1.
        //
        // This used to send `ownSalespersonChoice`, the old dropdown over the
        // rep's OWN Salespersons. Once box 1 became a picker over Zoho's whole
        // list, that left the field on screen and the value sent as two
        // different things: a rep could choose "HOS | PASAY", submit, and have
        // the order filed under their primary instead, with nothing to show
        // the pick had been ignored.
        //
        // `mySalesperson` is the one the rest of the form displays, so sending
        // it is what keeps the screen and the Sales Order in agreement.
        ...(!isBackOffice && mySalesperson ? { salesperson: mySalesperson } : {})
      });
      const order = createRes.data.data.order;

      // After the order exists, not before — see uploadAttachments. Deliberately
      // NOT allowed to fail the mutation: the order is already created and
      // synced to Zoho by this point, so throwing here would show "order
      // failed" for an order that exists. Each file is recoverable from the
      // order's Attachments tab; a phantom failure is not.
      let failedAttachments = [];
      if (stagedAttachments.length) {
        failedAttachments = await uploadAttachments(order.id, stagedAttachments);
      }
      return { ...order, _failedAttachments: failedAttachments };
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

      if (order._failedAttachments?.length) {
        toast.error(
          `Order ${order.getmeds_order_id} was created, but ${order._failedAttachments.length > 1 ? 'these files' : 'this file'} ` +
            `did not upload: ${order._failedAttachments.join(', ')}. Open the order and attach ${order._failedAttachments.length > 1 ? 'them' : 'it'} from the Attachments tab.`,
          { duration: 9000 }
        );
      }

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
    { label: 'Payment Terms', value: paymentTerms },
    // Sep 9, 2026: the Master Form fields, shown on the review screen for the
    // same reason every other field is — a value that is never read back
    // before submission is a value nobody checks.
    { label: 'Expected Shipment', value: expectedShipmentDate },
    { label: 'Doctor', value: effectiveDoctorName },
    { label: 'Customer is the doctor', value: isDoctor === 'yes' ? 'Yes' : isDoctor === 'no' ? 'No' : '' },
    { label: 'TIN', value: customerTin },
    // Hospital-only, and only when it applies — an empty "GL Number: —" row on
    // every ordinary order is noise that trains people to skip this list.
    ...(isHospitalOrder
      ? [
          { label: 'GL Number', value: glNumber },
          {
            label: 'Receiver Type',
            value: (RECEIVER_TYPES.find(r => r.value === receiverType) || {}).label || ''
          }
        ]
      : []),
    { label: 'Receiver', value: receiverName },
    { label: 'Contact No.', value: receiverContactNo },
    { label: 'Customer Remarks', value: deliveryNotes },
    { label: 'Terms & Conditions', value: termsAndConditions }
  ].filter(f => f.value && String(f.value).trim());

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

          {/* ── SECTION 1: GENERAL MEDREP ──────────────────────────────────
              Sep 9, 2026: split out of what used to be one "1. Order Details"
              section holding everything.

              What belongs here is exactly what a MedRep does NOT fill in:
              Salesperson, Division and Sub-division come from the ordering
              account, and the MedRep picker above them is the control that
              decides WHICH account that is. Grouping them separates "who is
              this order from" from "what is being ordered and for whom",
              which is the order the form is now read in. */}
          <div className="p-6 sm:p-8 space-y-5">
            <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100">
              <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
                <UserRound size={16} />
              </div>
              <h2 className="text-base font-bold text-ink-primary">1. General MedRep</h2>
            </div>

            {/* Sep 2, 2026: originally TEST_MODE + admin only.
                Sep 5, 2026: also shown to management for the real (non-test)
                pilot — see isBackOffice above and resolveOrderMedrep on
                the backend. Sits directly over the Salesperson field because
                that is what it changes.
                Sep 5, 2026 (4): no longer required for management — picking
                a MedRep here, and the Division/Salesperson fields below,
                are now three independently optional ways to say who/what
                this order is for. Leaving all three blank simply attributes
                the order to the back-office account with no Division/
                Salesperson, exactly as it would for any other role with
                nothing set on their account.
                Sep 9, 2026: the second, amber "Test Mode only — raise this
                order as the seeded MedRep account" variant of this block is
                gone. It existed for admin, who could only reach this picker
                in TEST_MODE; admin now has the same access management does in
                normal mode, so `canPickMedrep` and `isBackOffice` are true for
                exactly the same people and that branch could no longer
                render. Kept as one styling, rather than a condition that
                always takes the same side. */}
            {canPickMedrep && !isRepChoosing && (
              <div className="rounded-lg border border-getmeds-blue/30 bg-getmeds-blue/5 px-4 py-3 flex items-start gap-3">
                <FlaskConical size={16} className="shrink-0 mt-0.5 text-getmeds-blue-dark" />
                <div className="flex-1 min-w-0">
                  <label className="block text-xs font-bold uppercase tracking-wide mb-1.5 text-getmeds-blue-dark">
                    Create this order for
                  </label>
                  <select
                    value={actingMedrepId}
                    onChange={e => setActingMedrepId(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">— Select a MedRep (optional) —</option>
                    {medrepOptions.map(m => (
                      <option key={m.id} value={m.id}>
                        {(m.display_name || m.name)}
                        {m.salesperson ? ` — ${m.salesperson}` : ' — no Salesperson set'}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] mt-1.5 text-getmeds-blue-dark/80">
                    Optional. Picking a MedRep attributes the order to them and carries their Salesperson to Zoho.
                    Leave it blank to set Division and/or Salesperson manually below instead — the audit trail
                    always records that you created it.
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

              {/* Sep 7, 2026 (4): read-only, auto-filled with whoever is
                  logged in — the same account "Create this order for" above
                  already attributes the order to in the audit trail (see
                  orders.controller.js's onBehalfOf note, "[Admin] created an
                  order for [MedRep]"). Shown next to Salesperson deliberately:
                  Admin (who raised this) and Salesperson (the MedRep it's
                  actually for, sent to Zoho) are two different things, and
                  this account is never itself a candidate for the
                  Salesperson field below — see mySalesperson above. */}
              {canPickMedrep && (
                <Field label="Admin" help="Automatically the account you're logged in as — not sent to Zoho.">
                  <span className={readOnlyPillClass}>
                    <ShieldCheck size={14} className="text-getmeds-blue-dark shrink-0" />
                    {user?.name || 'You'}
                  </span>
                </Field>
              )}

              {/* Sep 5, 2026 (4): editable for Management only — a typed
                  value overrides whatever the picked MedRep's account (or
                  Management's own account) would otherwise send. Still a
                  read-only mirror for a MedRep, exactly as before: their own
                  Salesperson always comes straight from their account.
                  Suggestions are Zoho's own known Salesperson names
                  (salespersonSuggestions above) — the field still accepts
                  anything typed, but create() rejects a name Zoho doesn't
                  recognize, same "type anything, but here's what's real"
                  pattern as Delivery Method/Payment Terms, with the
                  difference that this one IS actually checked. */}
              {/* BOX 2 — the ACCOUNT this order belongs to.
                  Sep 11, 2026. Not a Zoho name: a person in THIS system, who
                  can log in and own an order. For a rep raising their own it
                  is themselves and needs no picking; raising one for a
                  colleague, it is searchable over accounts by name or email.
               */}
              <Field
                label={isRepChoosing ? 'MedRep (account)' : 'Salesperson'}
                required
                help={
                  isRepChoosing
                    ? orderForMode === 'other'
                      ? 'Search by name or email. Only people with an account here can be given an order.'
                      : 'Your own account — this order is attributed to you.'
                    : isBackOffice
                      ? 'Optional — must match a Salesperson Zoho already has. Blank falls back to the picked MedRep\'s own Salesperson, if any.'
                      : myOwnSalespersons.length > 1
                        ? 'You cover several Salespersons — pick the one this order is for.'
                        : mySalesperson
                          ? 'From your account — sent as the Salesperson on the Zoho Sales Order.'
                          : 'Not set on your account — ask an administrator to assign one.'
                }
              >
                {isRepChoosing ? (
                  orderForMode === 'other' ? (
                    <>
                      <MedrepAccountCombo
                        accounts={colleagueAccounts}
                        value={actingMedrepId}
                        onSelect={setActingMedrepId}
                        placeholder="Search MedReps by name or email…"
                      />
                      {/* Only while box 1 is ALSO empty. Warning that the
                          account has none while the rep has already picked one
                          above tells them to do something they have done. */}
                      {actingMedrep && !actingMedrep.salesperson && !zohoSalespersonChoice && (
                        <p className="text-[11px] mt-1 text-amber-800">
                          {(actingMedrep.display_name || actingMedrep.name)} has no Zoho Salesperson
                          on their account — pick one above before submitting.
                        </p>
                      )}
                    </>
                  ) : (
                    <span className={readOnlyPillClass}>
                      <UserRound size={14} className="text-ink-secondary shrink-0" />
                      <span>{user?.display_name || user?.name}</span>
                    </span>
                  )
                ) : isBackOffice ? (
                  <SuggestField
                    value={salespersonOverride}
                    onChange={setSalespersonOverride}
                    suggestions={salespersonSuggestions}
                    placeholder="Type or pick a Salesperson"
                  />
                ) : myOwnSalespersons.length > 1 ? (
                  <select
                    className={inputClass}
                    value={ownSalespersonChoice || mySalesperson}
                    onChange={(e) => setOwnSalespersonChoice(e.target.value)}
                  >
                    {myOwnSalespersons.map((s) => (
                      <option key={s.salesperson} value={s.salesperson}>
                        {s.salesperson}{s.is_primary ? ' (primary)' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className={readOnlyPillClass}>
                    <UserRound size={14} className="text-ink-secondary shrink-0" />
                    <span className={mySalesperson ? '' : 'text-ink-secondary'}>
                      {displaySalesPerson}
                    </span>
                  </span>
                )}
              </Field>

              {/* Sep 2, 2026: read-only for a MedRep — Division comes from
                  their account, not this form, because it also drives their
                  Salesperson, and changing it here without changing the
                  account would let the two disagree.
                  Sep 5, 2026 (4): editable for Management, as one of the 15
                  DIVISIONS above (never free text — same enum Profile
                  Settings and Create account enforce), since a Management account
                  typically has no Division of its own to show. Picking one
                  here also drives the Sub-division list right below. */}
              <Field
                label="Division"
                required
                help={
                  isBackOffice
                    ? 'Optional — sent as Division on the Zoho Sales Order. Blank falls back to the picked MedRep\'s own Division, if any.'
                    : myDivision ? 'Sent as Division on the Zoho Sales Order.' : 'Not set on your account — set it under Profile Settings.'
                }
              >
                {isBackOffice ? (
                  <select
                    className={inputClass}
                    value={divisionOverride}
                    onChange={(e) => setDivisionOverride(e.target.value)}
                  >
                    <option value="">-- Not set --</option>
                    {DIVISIONS.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                ) : (
                  <span className={readOnlyPillClass}>
                    <Building2 size={14} className="text-ink-secondary shrink-0" />
                    <span className={myDivision ? '' : 'text-ink-secondary'}>
                      {myDivision || 'Not set'}
                    </span>
                  </span>
                )}
              </Field>

              {/* Sep 5, 2026 (3): Sub-division, unlike Division above, is
                  editable on THIS order — any medrep or management raising
                  an order can set it here, defaulting to the account's own
                  value (see subDivisionInput above). A fixed dropdown when
                  the ordering MedRep's Division has a defined list
                  (SUB_DIVISIONS_BY_DIVISION), otherwise free text — same
                  fallback Profile Settings uses. */}
              <Field
                label="Sub-division"
                help={
                  subDivisionOptions
                    ? `Sent as Sub-division on the Zoho Sales Order — one of ${effectiveDivision}'s branches.`
                    : 'Sent as Sub-division on the Zoho Sales Order. Optional — blank is not sent.'
                }
              >
                {subDivisionOptions ? (
                  <select
                    className={inputClass}
                    value={subDivisionInput}
                    onChange={(e) => setSubDivisionInput(e.target.value)}
                  >
                    <option value="">-- Select sub-division --</option>
                    {subDivisionOptions.map((sd) => (
                      <option key={sd} value={sd}>{sd}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    className={inputClass}
                    placeholder="Enter sub-division"
                    value={subDivisionInput}
                    onChange={(e) => setSubDivisionInput(e.target.value)}
                  />
                )}
              </Field>

            </div>

            {/* BOX 1 — the ZOHO Salesperson.
                Sep 11, 2026. This is the name that goes on the Zoho Sales
                Order, and it is editable whichever mode the rep chose: raising
                an order for yourself does not mean you only ever cover one
                Salesperson, and raising one for a colleague does not mean
                theirs is the right pick either.
                Sourced from Zoho's own list — see salespersonSuggestions. It
                is NOT the account below; the two do not correspond one to one.
             */}
            {isRepChoosing && (
              <div className="rounded-lg border border-getmeds-blue/30 bg-getmeds-blue/5 px-4 py-3">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <label className="block text-xs font-bold uppercase tracking-wide text-getmeds-blue-dark">
                    Zoho Salesperson
                  </label>
                  {onChangeOrderOwner && (
                    <button
                      type="button"
                      onClick={onChangeOrderOwner}
                      className="shrink-0 text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark"
                    >
                      Change who this is for
                    </button>
                  )}
                </div>

                {/* ONLY the owner's Salespersons.
                    Sep 11, 2026: it briefly offered all 198 from Zoho, which
                    was worse than useless — the server accepts only the ones
                    on the account this order belongs to
                    (salespersonService.resolveForUser), so 197 of them were
                    choices that would come back as a 400. A picker whose
                    options are mostly invalid teaches people to distrust it. */}
                {ownerSalespersons.length ? (
                  <>
                    <ZohoSalespersonCombo
                      names={ownerSalespersons}
                      value={zohoSalespersonChoice}
                      onSelect={setZohoSalespersonChoice}
                    />
                    <p className="text-[11px] mt-1.5 text-getmeds-blue-dark/80">
                      Sent as the Salesperson on the Zoho Sales Order.
                      {ownerSalespersons.length > 1
                        ? ` ${ownerOwnerLabel} covers ${ownerSalespersons.length} — pick the one this order is for.`
                        : ''}
                    </p>
                  </>
                ) : (
                  /* No list to pick from. Said here rather than discovered as
                     a 400 at submit, and it names the fix. */
                  <p className="text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    {ownerOwnerLabel} has no Zoho Salesperson assigned, so this order cannot be
                    submitted yet. An admin assigns one on the Users page.
                  </p>
                )}
              </div>
            )}

          </div>

          {/* ── SECTION 2: CUSTOMER DETAILS ────────────────────────────────
              Everything about who the order is FOR and where it goes, in the
              order the Master Form specifies: name, shipment, payment terms,
              source, doctor, invoicing entity, remarks, expected shipment. */}
          <div className="p-6 sm:p-8 space-y-5 border-t border-slate-100">
            <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100">
              <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
                <Building2 size={16} />
              </div>
              <h2 className="text-base font-bold text-ink-primary">2. Customer Details</h2>
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

              {/* Sep 9, 2026: placeholder for "the customer isn't in Zoho yet".
                  Deliberately inert — creating a contact is a Zoho WRITE, and
                  this app's adapter has no method that can create one on
                  purpose (see ZohoAdapter.js). Shown disabled rather than
                  omitted so the gap is visible where it will be filled, and so
                  nobody wires a half-built create into the order form by
                  accident. */}
              <button
                type="button"
                disabled
                title="Not built yet — new customers are still created in Zoho directly."
                className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-lg border border-dashed border-slate-300 text-ink-secondary cursor-not-allowed opacity-70"
              >
                <Plus size={12} /> Add new customer
              </button>
              <span className="ml-2 text-[11px] text-ink-secondary">
                Coming soon — create the customer in Zoho, then sync from the Clients page.
              </span>

              {isHospitalOrder && (
                <p className="mt-2 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-indigo-50 text-indigo-800 border border-indigo-200 text-[11px] font-semibold">
                  🏥 Hospital order — Doctor Name, GL Number, receiver type and four attachments are required below.
                </p>
              )}

              {/* Sep 11, 2026: an UNCLASSIFIED customer, said out loud.
                  `category` means "hospital order rules apply" — it is what
                  turns on the GL Number, the receiver type and the four
                  attachments. Every one of the 95,063 customers in this
                  database is currently NULL, so that rule has never fired for
                  anybody, and the way it fails is silent: the controls are
                  simply absent and the order submits looking complete.
                  A visible line is the difference between a control somebody
                  decided to skip and one nobody knew existed. */}
              {selectedCustomer && !String(selectedCustomer.category || '').trim() && (
                <p className="mt-2 inline-flex items-start gap-1.5 px-2 py-1 rounded-md bg-amber-50 text-amber-900 border border-amber-200 text-[11px]">
                  <span>
                    This customer is not classified, so hospital rules are{' '}
                    <strong>not</strong> applied. If this is a hospital order, set them to Hospital in
                    the Clients Directory first — otherwise GL Number and the four attachments will
                    not be asked for.
                  </span>
                </p>
              )}
            </Field>

            {/* Sep 9, 2026: TIN. Auto-filled from the customer when Zoho has
                one; typed here when it does not, because Zoho REFUSES to
                create a Sales Order for a business-subtype contact with an
                empty TIN. What is typed here is written to the CONTACT before
                the Sales Order is created (orders.controller.js), not just
                onto the order — otherwise supplying it would not actually fix
                the thing it exists to fix. */}
            {selectedCustomer && (
              <Field
                label="TIN"
                help={
                  selectedCustomer.tin
                    ? 'From this customer’s Zoho record.'
                    : 'Zoho has no TIN for this customer. Zoho rejects Sales Orders for business accounts without one — entering it here saves it to the customer too.'
                }
              >
                <input
                  type="text"
                  value={customerTin}
                  onChange={(e) => setCustomerTin(e.target.value)}
                  placeholder="000-000-000-000"
                  className={inputClass}
                />
              </Field>
            )}

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

              {/* Sep 9, 2026: hospital-only, and here rather than up with
                  Source/Invoicing From — the Guarantee Letter and who collects
                  the delivery are both facts about the shipment, and reading
                  them next to the address is how anyone checking a hospital
                  order actually reads them. */}
              {isHospitalOrder && (
                <>
                  <Field label="GL Number" required help="Guarantee Letter reference — e.g. the GL number issued by DSWD.">
                    <input
                      type="text"
                      value={glNumber}
                      onChange={(e) => setGlNumber(e.target.value)}
                      placeholder="e.g. GL-2026-00123"
                      className={inputClass}
                      required
                    />
                  </Field>

                  <Field label="Receiver" required help="Who physically receives the delivery.">
                    <select
                      value={receiverType}
                      onChange={(e) => setReceiverType(e.target.value)}
                      className={inputClass}
                      required
                    >
                      <option value="">-- Select receiver --</option>
                      {RECEIVER_TYPES.map((r) => (
                        <option key={r.value} value={r.value}>{r.label}</option>
                      ))}
                    </select>
                  </Field>
                </>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              <Field label="Payment Terms" required help="Type to see suggestions (matches Zoho's list), or enter your own.">
                <SuggestField
                  value={paymentTerms}
                  onChange={setPaymentTerms}
                  suggestions={PAYMENT_TERMS_SUGGESTIONS}
                  placeholder="e.g. Net 15, 30 days"
                />
              </Field>

              <Field label="Source" required>
                <select value={orderSource} onChange={e => setOrderSource(e.target.value)} className={inputClass} required>
                  <option value="">-- Select source --</option>
                  {SOURCE_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>

              {/* Sep 9, 2026: is the customer themselves the prescribing
                  doctor? Starts unanswered on purpose — a default here would
                  mean most orders quietly carry whichever answer happened to
                  be pre-selected rather than one somebody gave. */}
              <Field label="Is the customer the doctor?">
                <div className="flex items-center gap-4 pt-1.5">
                  {[{ v: 'yes', l: 'Yes' }, { v: 'no', l: 'No' }].map(({ v, l }) => (
                    <label key={v} className="inline-flex items-center gap-1.5 text-sm text-ink-primary cursor-pointer select-none">
                      <input
                        type="radio"
                        name="is-doctor"
                        value={v}
                        checked={isDoctor === v}
                        onChange={() => setIsDoctor(v)}
                        className="text-getmeds-blue focus:ring-getmeds-blue"
                      />
                      {l}
                    </label>
                  ))}
                </div>
              </Field>

              {/* Answered Yes, the doctor IS the customer, so the name is
                  already known and shown rather than retyped — retyping what
                  is on screen produces typos, not answers.

                  Sep 11, 2026: optional on an ordinary order, required on a
                  hospital one. The hospital rule now has its own clause in
                  isFormValid rather than leaning on a global requirement that
                  no longer exists. */}
              <Field
                label="Doctor Name"
                required={isHospitalOrder}
                help={
                  isDoctor === 'yes'
                    ? 'The selected customer is the doctor.'
                    : 'Referring / prescribing doctor — suggestions pulled from customers tagged as doctors.'
                }
              >
                {isDoctor === 'yes' ? (
                  <input
                    type="text"
                    value={effectiveDoctorName}
                    readOnly
                    className={`${inputClass} bg-slate-50 text-ink-secondary cursor-not-allowed`}
                  />
                ) : (
                  <SuggestField
                    value={doctorName}
                    onChange={setDoctorName}
                    suggestions={doctorSuggestions}
                    placeholder="Referring / prescribing doctor"
                  />
                )}
              </Field>

              <Field label="Invoicing From" required help="Determines which entity this order is invoiced under.">
                <select value={invoicingFrom} onChange={e => setInvoicingFrom(e.target.value)} className={inputClass} required>
                  <option value="">-- Select invoicing entity --</option>
                  {INVOICING_FROM_OPTIONS.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </Field>

              <Field label="Delivery Method" help="Type to see suggestions, or enter your own.">
                <SuggestField
                  value={deliveryMethod}
                  onChange={setDeliveryMethod}
                  suggestions={DELIVERY_METHOD_SUGGESTIONS}
                  placeholder="e.g. LBC, Grab Express, Own Rider"
                />
              </Field>

            </div>

            {/* Sep 9, 2026: renamed from "Remarks" and now required. Same
                column (delivery_notes) — this is what actually reaches
                Dispatch, and "no special instructions" is worth saying
                explicitly rather than leaving as a blank nobody can tell from
                an unfilled form. */}
            <Field label="Customer Remarks" required>
              <textarea
                value={deliveryNotes}
                onChange={e => setDeliveryNotes(e.target.value)}
                placeholder="e.g. Attn: Dr. Santos, Room 302. Handle with cold chain packaging. Write 'None' if there are no special instructions."
                rows={2}
                className={`${inputClass} resize-y`}
                required
              />
            </Field>

            {/* Sep 9, 2026: last in this section, and on its own row rather
                than back in the grid above — the Master Form's sequence puts
                it after Customer Remarks, and a date input is the one field
                here people reliably forget when it is buried mid-grid. */}
            {/* Sep 9, 2026: Expected Shipment Date. The one new field here
                that reaches Zoho — it maps to the Sales Order's own
                `shipment_date` (see LiveZohoAdapter.createSalesOrder). */}
            <Field label="Expected Shipment Date" required help="Sent to Zoho as the Sales Order's expected shipment date.">
              <input
                type="date"
                value={expectedShipmentDate}
                onChange={(e) => setExpectedShipmentDate(e.target.value)}
                className={inputClass}
                required
              />
            </Field>
          </div>

          {/* SECTION 3: ORDER DETAILS (PRODUCT AUTOCOMPLETE + CART) */}
          <div className="p-6 sm:p-8 space-y-5 overflow-visible">
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
                  <Package size={16} />
                </div>
                <h2 className="text-base font-bold text-ink-primary">3. Order Details <span className="text-state-error">*</span></h2>
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

          {/* ── SECTION 4: ATTACHMENTS ──────────────────────────────────────
              Sep 9, 2026: was one "3. Terms & Attachments" section with Terms
              first. Split, and reordered, to match the Master Form's sequence
              — attachments then terms. Attachments lead because they are the
              part that can BLOCK submission (a hospital order needs four of
              them; every other order needs a proof of payment or a stated
              reason), and Terms & Conditions is free text that never does. */}
          <div className="p-6 sm:p-8 space-y-5">
            <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100">
              <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
                <Paperclip size={16} />
              </div>
              <h2 className="text-base font-bold text-ink-primary">4. Attachments</h2>
            </div>

            {/* Sep 4, 2026: proof of payment, replacing the dead "Attach
                File(s)" control that used to sit here and discard whatever was
                dropped on it.
                Sep 5, 2026: generalized to match Zoho's own "Attach File(s) to
                Sales Order" — any number of files, each tagged with a type.
                The Submit button still stays locked until there is at least
                one Proof of Payment file OR a reason there is none, so
                Finance never opens an order and finds a blank where the
                evidence should be; an 'Other' file never satisfies that on
                its own. */}
            <Field
              label="Attach File(s) to Sales Order"
              help={isBackOffice
                ? "A deposit slip, transfer screenshot, purchase order, or any other file worth attaching. Tag each as Proof of Payment, Purchase Order, or Other — Finance only reviews Proof of Payment files when they verify the order for invoicing."
                : "A deposit slip, transfer screenshot, purchase order, or any other file worth attaching. Tag each as Proof of Payment, Purchase Order, or Other — Finance only reviews Proof of Payment files when they verify the order for invoicing. If there's no proof of payment yet, say why below."}
            >
              {/* Sep 9, 2026: the hospital checklist. Driven by
                  HOSPITAL_REQUIRED_ATTACHMENTS and the staged files' own tags,
                  so what is shown here and what the submit gate enforces are
                  literally the same computation — a checklist that can say
                  "all four attached" while the button stays disabled is worse
                  than no checklist. */}
              {isHospitalOrder && (
                <div className="mb-3 rounded-xl border border-indigo-200 bg-indigo-50/60 p-3">
                  <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-900 mb-2">
                    Required for a hospital order
                  </p>
                  <ul className="space-y-1">
                    {HOSPITAL_REQUIRED_ATTACHMENTS.map((t) => {
                      const attached = stagedTypes.has(t.value);
                      return (
                        <li
                          key={t.value}
                          className={`flex items-center gap-1.5 text-xs ${attached ? 'text-pharmacy-green-dark font-semibold' : 'text-indigo-900'}`}
                        >
                          {attached ? <CheckCircle size={13} /> : <AlertCircle size={13} className="text-indigo-400" />}
                          {t.label}
                          {!attached && <span className="text-indigo-500">— not attached yet</span>}
                        </li>
                      );
                    })}
                  </ul>
                  <p className="mt-2 text-[11px] text-indigo-800">
                    Attach each file below and tag it with the matching type in the dropdown next to it.
                  </p>
                </div>
              )}

              {stagedAttachments.length > 0 && (
                <div className="space-y-2 mb-3">
                  {stagedAttachments.map((a) => (
                    <div
                      key={a.localId}
                      className="flex items-center justify-between gap-2 bg-pharmacy-green/10 border border-pharmacy-green/40 rounded-xl px-3 py-2.5 text-sm"
                    >
                      <span className="flex items-center gap-2 min-w-0 text-ink-primary font-medium truncate">
                        <Paperclip size={14} className="shrink-0 text-pharmacy-green-dark" />
                        <span className="truncate">{a.file.name}</span>
                        <span className="text-xs text-ink-secondary shrink-0">
                          ({(a.file.size / 1024 / 1024).toFixed(1)} MB)
                        </span>
                      </span>
                      <span className="flex items-center gap-2 shrink-0">
                        <select
                          value={a.fileType}
                          onChange={(e) => handleAttachmentTypeChange(a.localId, e.target.value)}
                          className="text-xs border border-slate-300 rounded-lg px-2 py-1 bg-white text-ink-primary"
                        >
                          {ATTACHMENT_TYPES.map(t => (
                            <option key={t.value} value={t.value}>{t.label}</option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => handleRemoveAttachment(a.localId)}
                          className="p-0.5 text-slate-400 hover:text-state-error rounded-full"
                          title="Remove"
                        >
                          <X size={14} />
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Sep 5, 2026 (2): desktop gets a drag-and-drop zone; mobile
                  keeps the original click-to-choose pair. A touch device has
                  no "drag a file in from the OS" gesture the way a desktop
                  does, so the two affordances are genuinely different tools
                  for their platforms rather than one being a fallback for
                  the other — shown/hidden with Tailwind's `sm:` breakpoint
                  rather than any device sniffing. */}
              <label
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`hidden sm:flex flex-col items-center justify-center gap-1.5 border-2 border-dashed rounded-xl py-8 px-4 text-center cursor-pointer transition-colors ${
                  isDragActive
                    ? 'border-getmeds-blue bg-getmeds-blue/10'
                    : 'border-slate-300 hover:border-getmeds-blue hover:bg-getmeds-blue/5'
                }`}
              >
                <Paperclip size={18} className="text-ink-secondary" />
                <p className="text-sm text-ink-secondary">
                  <span className="font-semibold text-getmeds-blue">Drag & drop files here</span>, or click to browse
                </p>
                <p className="text-[11px] text-ink-secondary/70">Photos, PDFs, Word or Excel files — up to 15 MB each</p>
                <input type="file" accept={PROOF_ACCEPT} multiple onChange={handleFilesSelected} className="hidden" />
              </label>

              {/* Two inputs rather than one: `capture` opens the camera
                  straight away, which is right at the counter and wrong
                  when the slip was photographed earlier and is sitting in
                  the gallery. `multiple` lets several files be picked in one
                  go from a gallery/file browser; each lands as its own
                  staged row above, defaulted to Proof of Payment. */}
              <div className="flex sm:hidden flex-wrap gap-2">
                <label className="flex items-center justify-center gap-2 flex-1 min-w-[9rem] border-2 border-dashed border-slate-300 rounded-xl py-4 cursor-pointer hover:border-getmeds-blue hover:bg-getmeds-blue/5 transition-colors text-sm text-ink-secondary">
                  <Paperclip size={16} />
                  Take photo
                  <input type="file" accept={PROOF_ACCEPT} capture="environment" onChange={handleFilesSelected} className="hidden" />
                </label>
                <label className="flex items-center justify-center gap-2 flex-1 min-w-[9rem] border-2 border-dashed border-slate-300 rounded-xl py-4 cursor-pointer hover:border-getmeds-blue hover:bg-getmeds-blue/5 transition-colors text-sm text-ink-secondary">
                  <Paperclip size={16} />
                  Choose file(s)
                  <input type="file" accept={PROOF_ACCEPT} multiple onChange={handleFilesSelected} className="hidden" />
                </label>
              </div>

              {!hasStagedProof && !isBackOffice && !isHospitalOrder && (
                <div className="mt-4">
                  <label className="block text-xs font-semibold text-ink-primary mb-1.5">
                    No proof of payment? Say why <span className="text-state-error">*</span>
                  </label>
                  <select
                    value={noProofReason}
                    onChange={(e) => setNoProofReason(e.target.value)}
                    className={inputClass}
                  >
                    <option value="">Select a reason…</option>
                    {NO_PROOF_REASONS.map(r => (
                      <option key={r.value} value={r.value}>{r.label}</option>
                    ))}
                  </select>

                  {noProofReason && (
                    <textarea
                      value={noProofNote}
                      onChange={(e) => setNoProofNote(e.target.value)}
                      rows={2}
                      placeholder={noProofReason === 'other'
                        ? 'Required — explain briefly for Finance'
                        : 'Optional note for Finance'}
                      className={`${inputClass} resize-y mt-2`}
                    />
                  )}

                  {noProofReason === 'other' && !noProofNote.trim() && (
                    <p className="mt-1.5 text-xs text-state-warning font-medium flex items-center gap-1.5">
                      <AlertCircle size={13} /> A note is required when the reason is Other.
                    </p>
                  )}
                </div>
              )}
            </Field>
          </div>

          {/* ── SECTION 5: TERMS & CONDITIONS ───────────────────────────────
              Sep 9, 2026: its own section now — see the note on Attachments
              above. Free text, never required, and last because that is where
              the Master Form puts it. */}
          <div className="p-6 sm:p-8 space-y-5">
            <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100">
              <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
                <FileText size={16} />
              </div>
              <h2 className="text-base font-bold text-ink-primary">5. Terms &amp; Conditions</h2>
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
              <span className="font-medium text-ink-primary">
                {(isBackOffice ? salespersonOverride.trim() : '') || displaySalesPerson}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-xs text-ink-secondary font-medium">Division:</span>
              <span className="font-medium text-ink-primary">{effectiveDivision || '—'}</span>
            </div>
            {subDivisionInput && (
              <div className="flex justify-between items-center">
                <span className="text-xs text-ink-secondary font-medium">Sub-division:</span>
                <span className="font-medium text-ink-primary">{subDivisionInput}</span>
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

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-ink-secondary mb-2">Attachments</h4>
            <div className="bg-surface rounded-xl p-3 border border-slate-200 text-xs text-ink-primary space-y-1.5">
              {stagedAttachments.length > 0 ? (
                stagedAttachments.map(a => (
                  <span key={a.localId} className="flex items-center gap-1.5">
                    <Paperclip size={11} className="text-ink-secondary shrink-0" />
                    <span className="truncate">{a.file.name}</span>
                    <span className="text-ink-secondary shrink-0">
                      ({(ATTACHMENT_TYPES.find(t => t.value === a.fileType) || {}).label || a.fileType})
                    </span>
                  </span>
                ))
              ) : null}
              {!hasStagedProof && !isBackOffice && (
                <span className="flex items-center gap-1.5">
                  {stagedAttachments.length > 0 && <Paperclip size={11} className="text-transparent shrink-0" />}
                  No proof of payment — {(NO_PROOF_REASONS.find(r => r.value === noProofReason) || {}).label || 'no reason given'}
                  {noProofNote.trim() && <span className="text-ink-secondary"> · {noProofNote.trim()}</span>}
                </span>
              )}
            </div>
          </div>

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
