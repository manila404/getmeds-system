import React, { useState, useEffect, useRef } from 'react';
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
  Loader2
} from 'lucide-react';
import { useDebug } from '../../context/DebugContext';
import { useAuth } from '../../hooks/useAuth';

import { useProducts, useCustomers } from '../../hooks/useOrderData';
import { fetchCustomerZohoAddress } from '../../api/queries';

// Aug 27, 2026: "Order Intake Details" — a single label-left, spreadsheet
// styled block (matching the team's old paper/Google-Forms order sheet)
// that sits above the product cart. Every field here is OPTIONAL and
// purely informational: none of it is required to submit, and none of it
// is ever sent to Zoho (orders.controller.js's zohoPayload only ever
// carries customer/items/address/total — see schema.sql's `orders` table
// comment for the full list of new intake_* columns). "Order" and
// "Amount" are read-only — they mirror the product cart below rather than
// being typed in separately, so there's only ever one source of truth for
// what's actually being ordered and what it costs.
const IntakeRow = ({ label, children, alt, required }) => (
  <div
    className={`grid grid-cols-1 sm:grid-cols-[168px_1fr] border-t border-emerald-900/10 ${
      alt ? 'bg-emerald-50/80' : 'bg-white'
    }`}
  >
    <div className="px-4 py-2.5 flex items-start sm:items-center font-bold text-[11px] sm:text-xs text-slate-800 sm:border-r border-emerald-900/10 uppercase tracking-wide">
      {label} {required && <span className="text-state-error ml-0.5">*</span>} :
    </div>
    <div className="px-4 py-2 flex items-center min-w-0">{children}</div>
  </div>
);

const textInputClass =
  'w-full bg-white border border-slate-300 rounded-md px-3 py-1.5 text-sm text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue shadow-2xs transition-colors';

/**
 * OrderForm Component
 *
 * Implements:
 * - Step 1: React Query cached master data from useOrderData
 * - Step 2: Autocomplete integration via <CustomerAutocomplete /> and <ProductAutocomplete />
 * - Step 3: Cart state, .reduce() totals, useMutation to /api/orders, and fast-track debug button.
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
  const [deliveryNotes, setDeliveryNotes] = useState('');

  // Order-intake fields (all optional — see IntakeRow comment above)
  const [courier, setCourier] = useState('');
  const [doctorName, setDoctorName] = useState('');
  const [hospitalName, setHospitalName] = useState('');
  const [patientName, setPatientName] = useState('');
  const [mop, setMop] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [receiverContactNo, setReceiverContactNo] = useState('');
  const [orderSource, setOrderSource] = useState('');
  const [plsGiveNote, setPlsGiveNote] = useState('');

  // Live clock for the TIMESTAMP header — display only, the real
  // created_at timestamp is stamped server-side when the order is saved.
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const formattedTimestamp = now.toLocaleString('en-PH', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });

  // Cart State: [{ productId, name, sku, price, unit, quantity }]
  const [items, setItems] = useState([]);

  // Post-submission success state
  const [submittedOrder, setSubmittedOrder] = useState(null);
  const [isReviewOpen, setIsReviewOpen] = useState(false);

  // Step 1: Query hooks
  const { data: customers = [], isLoading: loadingCustomers } = useCustomers();
  const { data: products = [], isLoading: loadingProducts } = useProducts();

  const selectedCustomer = customers.find(c => String(c.id) === String(customerId));

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
          price: Number(product.unit_price || 0),
          unit: product.unit || 'unit',
          quantity: 1,
        }
      ]);
      toast.success(`Added ${product.name} to order`);
    }
  };

  const handleUpdateQuantity = (index, newQty) => {
    const qty = parseInt(newQty, 10);
    if (isNaN(qty) || qty < 1) return;
    const updated = [...items];
    updated[index].quantity = qty;
    setItems(updated);
  };

  const handleRemoveItem = (index) => {
    setItems(items.filter((_, idx) => idx !== index));
  };

  // Step 3: Dynamic Grand Total calculation via .reduce()
  const grandTotal = items.reduce((total, item) => total + (item.price * item.quantity), 0);

  // Read-only "ORDER" summary row — mirrors the cart below, single source
  // of truth (nothing here is separately typed in).
  const orderSummaryText = items.length
    ? items.map(i => `${i.name} x${i.quantity}`).join('; ')
    : '';

  // Form Validation
  const isFormValid = Boolean(
    customerId &&
    deliveryAddress.trim() &&
    items.length > 0 &&
    items.every(i => i.productId && Number(i.quantity) > 0)
  );

  // Step 3: [TEST MODE: Auto-Fill] Logic
  const handleAutoFillCredit = () => {
    if (!customers.length || !products.length) {
      toast.error('Master data is still loading from server...');
      return;
    }

    const creditCust = customers.find(c => c.type === 'credit') || customers[0];
    handleCustomerChange(creditCust);
    setDeliveryAddress(creditCust.address || "St. Luke's Medical Center - 279 E Rodriguez Sr. Ave, Quezon City");
    setDeliveryNotes('Institutional Credit Order. Deliver to Receiving Bay. Ref: PO-2026-CREDIT.');
    setCourier('LBC Express');
    setHospitalName(creditCust.name || '');
    setMop('Credit Terms');
    setOrderSource('Repeat Customer');

    const sampleItems = [];
    if (products.length >= 1) {
      sampleItems.push({
        productId: products[0].id,
        name: products[0].name,
        sku: products[0].sku,
        price: Number(products[0].unit_price || 0),
        unit: products[0].unit || 'box',
        quantity: 20
      });
    }
    if (products.length >= 2) {
      sampleItems.push({
        productId: products[1].id,
        name: products[1].name,
        sku: products[1].sku,
        price: Number(products[1].unit_price || 0),
        unit: products[1].unit || 'box',
        quantity: 10
      });
    }
    if (products.length >= 3) {
      sampleItems.push({
        productId: products[2].id,
        name: products[2].name,
        sku: products[2].sku,
        price: Number(products[2].unit_price || 0),
        unit: products[2].unit || 'bottle',
        quantity: 5
      });
    }

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
    setCourier('Grab Express');
    setPatientName(directCust.name || '');
    setMop('GCash');
    setOrderSource('Walk-in');

    const sampleItems = [];
    if (products.length >= 1) {
      sampleItems.push({
        productId: products[0].id,
        name: products[0].name,
        sku: products[0].sku,
        price: Number(products[0].unit_price || 0),
        unit: products[0].unit || 'box',
        quantity: 5
      });
    }
    if (products.length >= 2) {
      sampleItems.push({
        productId: products[1].id,
        name: products[1].name,
        sku: products[1].sku,
        price: Number(products[1].unit_price || 0),
        unit: products[1].unit || 'box',
        quantity: 2
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
          quantity: parseInt(i.quantity)
        })),
        delivery_address: deliveryAddress,
        delivery_notes: deliveryNotes,
        customer_type: customerType,
        // Optional intake fields — see IntakeRow comment above. Blank
        // strings are normalized to NULL server-side.
        courier,
        doctor_name: doctorName,
        hospital_name: hospitalName,
        patient_name: patientName,
        mode_of_payment: mop,
        receiver_name: receiverName,
        receiver_contact_no: receiverContactNo,
        order_source: orderSource,
        pls_give_note: plsGiveNote
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
      toast.error('Please fill in all mandatory fields');
      return;
    }
    setIsReviewOpen(true);
  };

  // Any optional intake field the MedRep actually filled in — shown in the
  // review modal so it's double-checked before submission, same as every
  // other field on the form.
  const filledIntakeDetails = [
    { label: 'Courier', value: courier },
    { label: 'Doctor', value: doctorName },
    { label: 'Hospital', value: hospitalName },
    { label: 'Patient', value: patientName },
    { label: 'Mode of Payment', value: mop },
    { label: 'Receiver', value: receiverName },
    { label: 'Contact No.', value: receiverContactNo },
    { label: 'Source', value: orderSource },
    { label: 'Pls Give', value: plsGiveNote }
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

          {/* SECTION 1: ORDER INTAKE DETAILS (spreadsheet-style form) */}
          <div className="p-6 sm:p-8 space-y-4">
            <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100">
              <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
                <ClipboardList size={16} />
              </div>
              <h2 className="text-base font-bold text-ink-primary">1. Order Intake Details</h2>
            </div>

            <div className="rounded-xl border border-emerald-900/15 overflow-hidden shadow-2xs">
              {/* Timestamp header bar */}
              <div className="bg-pharmacy-green text-white flex items-center justify-between px-4 py-2.5">
                <span className="font-bold text-[11px] sm:text-xs uppercase tracking-wider">Timestamp</span>
                <span className="font-mono text-xs sm:text-sm font-semibold">{formattedTimestamp}</span>
              </div>

              <IntakeRow label="Customer" required>
                <div className="w-full space-y-1">
                  <CustomerAutocomplete
                    customers={customers}
                    value={customerId}
                    onSelect={handleCustomerChange}
                    onClear={handleCustomerClear}
                    disabled={loadingCustomers}
                  />
                  {selectedCustomer && (
                    <p className="text-[11px] text-ink-secondary">
                      {customerType === 'credit'
                        ? 'Institutional terms — bypasses upfront payment, routes to Dispatch.'
                        : 'Direct patient — requires Finance payment verification before picking.'}
                    </p>
                  )}
                </div>
              </IntakeRow>

              <IntakeRow label="Courier" alt>
                <input type="text" value={courier} onChange={e => setCourier(e.target.value)} placeholder="e.g. LBC, Grab Express, J&T" className={textInputClass} />
              </IntakeRow>

              <IntakeRow label="Doctor">
                <input type="text" value={doctorName} onChange={e => setDoctorName(e.target.value)} placeholder="Referring / prescribing doctor" className={textInputClass} />
              </IntakeRow>

              <IntakeRow label="Hospital" alt>
                <input type="text" value={hospitalName} onChange={e => setHospitalName(e.target.value)} placeholder="Hospital / clinic name" className={textInputClass} />
              </IntakeRow>

              <IntakeRow label="Patient">
                <input type="text" value={patientName} onChange={e => setPatientName(e.target.value)} placeholder="Patient name" className={textInputClass} />
              </IntakeRow>

              <IntakeRow label="MOP" alt>
                <select value={mop} onChange={e => setMop(e.target.value)} className={textInputClass}>
                  <option value="">-- Select mode of payment --</option>
                  <option value="Cash">Cash</option>
                  <option value="Check">Check</option>
                  <option value="Bank Transfer">Bank Transfer</option>
                  <option value="GCash">GCash</option>
                  <option value="Credit Terms">Credit Terms</option>
                  <option value="Other">Other</option>
                </select>
              </IntakeRow>

              <IntakeRow label="Receiver">
                <input type="text" value={receiverName} onChange={e => setReceiverName(e.target.value)} placeholder="Who will receive the delivery" className={textInputClass} />
              </IntakeRow>

              <IntakeRow label="Contact No." alt>
                <input type="tel" value={receiverContactNo} onChange={e => setReceiverContactNo(e.target.value)} placeholder="09XXXXXXXXX" className={textInputClass} />
              </IntakeRow>

              <IntakeRow label="Address" required>
                <div className="w-full space-y-1">
                  <textarea
                    value={deliveryAddress}
                    onChange={e => setDeliveryAddress(e.target.value)}
                    placeholder="Complete hospital, clinic, or residential shipping address..."
                    rows={2}
                    className={`${textInputClass} resize-y`}
                    required
                  />
                  {isFetchingZohoAddress && (
                    <p className="text-[11px] text-ink-secondary flex items-center gap-1">
                      <Loader2 size={11} className="animate-spin" /> Fetching this customer's address from Zoho...
                    </p>
                  )}
                </div>
              </IntakeRow>

              <IntakeRow label="Pls Give" alt>
                <textarea
                  value={plsGiveNote}
                  onChange={e => setPlsGiveNote(e.target.value)}
                  placeholder="Anything to note about what to give, beyond the item list below..."
                  rows={2}
                  className={`${textInputClass} resize-y`}
                />
              </IntakeRow>

              <IntakeRow label="Remarks">
                <textarea
                  value={deliveryNotes}
                  onChange={e => setDeliveryNotes(e.target.value)}
                  placeholder="e.g. Attn: Dr. Santos, Room 302. Handle with cold chain packaging..."
                  rows={2}
                  className={`${textInputClass} resize-y`}
                />
              </IntakeRow>

              <IntakeRow label="Salesperson" alt>
                <span className="text-sm font-semibold text-ink-primary">{user?.name || '—'}</span>
              </IntakeRow>

              <IntakeRow label="Source">
                <input type="text" value={orderSource} onChange={e => setOrderSource(e.target.value)} placeholder="e.g. Referral, Repeat Customer, Walk-in" className={textInputClass} />
              </IntakeRow>

              <IntakeRow label="Order" alt>
                <span className="text-sm text-ink-primary">
                  {orderSummaryText || <span className="text-ink-secondary italic">Add items in section 2 below...</span>}
                </span>
              </IntakeRow>

              <IntakeRow label="Amount">
                <span className="text-base font-extrabold text-getmeds-blue font-mono">
                  ₱{grandTotal.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </IntakeRow>
            </div>
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
                Click any product in the floating dropdown to append it to the requisition table below — this is what fills in the "Order" and "Amount" rows above.
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
              <div className="border border-slate-200 rounded-xl overflow-hidden shadow-2xs">
                <table className="min-w-full divide-y divide-slate-200 text-xs sm:text-sm">
                  <thead className="bg-surface">
                    <tr>
                      <th className="px-4 py-3 text-left font-bold text-ink-secondary uppercase tracking-wider">Product Name & SKU</th>
                      <th className="px-4 py-3 text-right font-bold text-ink-secondary uppercase tracking-wider">Unit Price</th>
                      <th className="px-4 py-3 text-center font-bold text-ink-secondary uppercase tracking-wider">Quantity</th>
                      <th className="px-4 py-3 text-right font-bold text-ink-secondary uppercase tracking-wider">Subtotal</th>
                      <th className="px-4 py-3 text-center font-bold text-ink-secondary uppercase tracking-wider w-16"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {items.map((item, idx) => (
                      <tr key={idx} className="hover:bg-surface/50 transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-ink-primary">{item.name}</p>
                          <span className="text-[11px] font-mono text-ink-secondary">{item.sku}</span>
                        </td>
                        <td className="px-4 py-3 text-right text-ink-secondary font-mono">
                          ₱{item.price.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <input
                            type="number"
                            min="1"
                            value={item.quantity}
                            onChange={e => handleUpdateQuantity(idx, e.target.value)}
                            className="w-16 text-center border border-slate-300 rounded py-1 text-xs font-bold text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
                          />
                        </td>
                        <td className="px-4 py-3 text-right font-bold text-ink-primary font-mono">
                          ₱{(item.price * item.quantity).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </td>
                        <td className="px-4 py-3 text-center">
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
                    ))}
                  </tbody>
                  {/* Dynamic Grand Total Footer */}
                  <tfoot className="bg-surface/80 border-t-2 border-slate-200">
                    <tr>
                      <td colSpan={3} className="px-4 py-3.5 text-right font-bold text-ink-primary uppercase tracking-wider text-xs">
                        Grand Total:
                      </td>
                      <td className="px-4 py-3.5 text-right font-extrabold text-getmeds-blue text-base font-mono">
                        ₱{grandTotal.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td></td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>

          {/* SUBMISSION CONTROLS */}
          <div className="p-6 sm:p-8 bg-surface/40 flex flex-col sm:flex-row items-center justify-between gap-4">
            <div className="text-xs text-ink-secondary">
              {!isFormValid ? (
                <span className="text-state-warning font-medium flex items-center gap-1.5">
                  <AlertCircle size={14} /> Mandatory fields required (Customer, 1+ Items, Address) to unlock submission.
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
              <h4 className="text-xs font-bold uppercase tracking-wider text-ink-secondary mb-2">Additional Intake Details</h4>
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
            <h4 className="text-xs font-bold uppercase tracking-wider text-ink-secondary mb-2">Order Line Items</h4>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              <table className="min-w-full divide-y divide-slate-200 text-xs">
                <thead className="bg-surface">
                  <tr>
                    <th className="px-3 py-2 text-left font-bold text-ink-secondary">Item</th>
                    <th className="px-2 py-2 text-center font-bold text-ink-secondary">Qty</th>
                    <th className="px-3 py-2 text-right font-bold text-ink-secondary">Price</th>
                    <th className="px-3 py-2 text-right font-bold text-ink-secondary">Subtotal</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 bg-white">
                  {items.map((item, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2 font-medium text-ink-primary">
                        {item.name} <span className="text-ink-secondary">({item.sku})</span>
                      </td>
                      <td className="px-2 py-2 text-center text-ink-primary font-bold">{item.quantity}</td>
                      <td className="px-3 py-2 text-right text-ink-secondary">₱{item.price.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right font-bold text-ink-primary">
                        ₱{(item.price * item.quantity).toFixed(2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-surface">
                  <tr>
                    <td colSpan={3} className="px-3 py-2 text-right font-bold text-ink-primary">Grand Total:</td>
                    <td className="px-3 py-2 text-right font-extrabold text-getmeds-blue text-sm">₱{grandTotal.toFixed(2)}</td>
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
          onClose={() => navigate(`/orders/${submittedOrder.id}`)}
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
                onClick={() => navigate(`/orders/${submittedOrder.id}`)}
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
