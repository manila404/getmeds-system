import React, { useState } from 'react';
import { useParams, useNavigate, Link, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ArrowLeft, Package, CreditCard, Truck, Clock, CheckCircle, AlertCircle, ExternalLink, RefreshCw, Pencil, Trash2, Receipt, X, ShieldCheck, Undo2, XCircle, MessageSquare } from 'lucide-react';
import client from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { formatPHT } from '../utils/dateUtils';
// Sep 10, 2026 (2d): the flat event list became a ten-stage pipeline. See
// components/orders/OrderPipeline.jsx and, on the backend,
// services/orderTimelineService.js.
import OrderPipeline, { RoleBadge } from '../components/orders/OrderPipeline';
import RawEventLogModal from '../components/orders/RawEventLogModal';
import { useProducts } from '../hooks/useOrderData';
import ProductAutocomplete from '../components/orders/ProductAutocomplete';
import PaymentProofPanel from '../components/orders/PaymentProofPanel';
import OrderItemsEditor from '../components/orders/OrderItemsEditor';
import ResubmitHoldModal from '../components/orders/ResubmitHoldModal';
import ResumeOrderModal, { stageLabel } from '../components/orders/ResumeOrderModal';
import ResubmitPrescriptionModal from '../components/orders/ResubmitPrescriptionModal';
import AttachFileField from '../components/orders/AttachFileField';
import { uploadOrderAttachment } from '../utils/attachmentUpload';
import { roleLabel } from '../constants/roles';
import OrderOverviewModal from '../components/orders/OrderOverviewModal';
import { ORDER_SOURCES } from '../constants/orderSources';
import { PAYMENT_TERMS_SUGGESTIONS, paymentTermsProofHint } from '../constants/paymentTerms';
import DeliveryConfirmModal from '../components/dispatch/DeliveryConfirmModal';
import { TRACKING_EDITABLE_STATUSES, TrackingValue } from '../components/dispatch/DeliveryActions';
import { TAX_OPTIONS, inferTaxOption } from '../utils/orderLines';
import ZohoSalespersonCombo from '../components/orders/ZohoSalespersonCombo';
import ConfirmChangesModal from '../components/orders/ConfirmChangesModal';

// Sep 7, 2026 (2): mirrors orders.controller.js's / OrderForm.jsx's exact
// lists for the new "Edit Details" panel below — kept as a duplicate
// on purpose, same reasoning those two files' own comments give for why
// this list lives in more than one place: a value picked here has to
// validate the same way it would have at order-creation time.
const DIVISIONS = [
  // Sep 9, 2026: see the note on DIVISIONS in orders.controller.js — five
  // entries removed, none of them in use on any existing user or order.
  'B&B', 'B2B', 'B2C', 'BID', 'CLIDP', 'HOS', 'MSA', 'STC',
  'TeleSales Anesthesia', 'URO',
  // Sep 10, 2026: already in use in Zoho — see orders.controller.js.
  'TeleSales', 'MD Telesales', 'PS',
];
const SUB_DIVISIONS_BY_DIVISION = {
  'B&B': ['CEBU', 'DAVAO', 'E. RODRIGUEZ', 'EAST AVE', 'NCL', 'SOUTH LUZON', 'TAFT'],
  HOS: [
    'GENSAN', 'PALAWAN', 'BAGUIO', 'BICOL', 'CABANATUAN', 'CAMANAVA', 'CAVITE',
    'CDO', 'COMMONWEALTH', 'DAVAO NORTH', 'DAVAO SOUTH', 'ILOILO', 'LAGUNA',
    'LAS PINAS', 'MANILA VACANT', 'MARIKINA', 'NORTH CEBU', 'PAMPANGA',
    'PARANAQUE', 'PASAY', 'QUEZON PROVINCE', 'SOUTH CEBU', 'TUGUEGARAO', 'ZAMBOANGA',
  ],
  STC: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
  URO: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
};
// Sep 15, 2026: Zoho's own Source options, shared with the order form — see
// constants/orderSources.js.
const SOURCE_OPTIONS = ORDER_SOURCES;
const INVOICING_FROM_OPTIONS = ['2mg Incorporated', 'Getmeds Philippines Inc.'];
const DELIVERY_METHOD_SUGGESTIONS = [
  'Own Rider / Company Vehicle', 'LBC Express', 'Grab Express', 'J&T Express',
  'Lalamove', 'Customer Pick-up', 'Distributor Delivery'
];
// Sep 19, 2026: moved to constants/paymentTerms.js, imported below — this
// used to be a second hand-copy of OrderForm.jsx's own list, with no shared
// source, so the two could only ever drift the next time either changed.

const STATUS_COLORS = {
  draft: 'bg-slate-100 text-slate-700 border border-slate-300',
  submitted: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  validating: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_pending: 'bg-state-warning-light text-amber-900 border border-state-warning/30',
  so_created: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  // Sep 1, 2026 (5): the renamed finance stages. This map is a second copy of
  // the one in ui/OrderStatusBadge.jsx and had drifted — it still listed
  // waiting_for_payment, invoice_drafted and payment_verified, all retired.
  // Sep 1, 2026 (8): the pre-invoice account check — see ui/OrderStatusBadge.jsx
  // for why this one is purple and nothing else is.
  ready_for_finance_verified: 'bg-purple-50 text-purple-800 border border-purple-300 font-semibold',
  ready_for_draft_invoice: 'bg-state-warning-light text-amber-950 border border-state-warning font-semibold',
  ready_for_invoice_sent: 'bg-indigo-50 text-indigo-700 border border-indigo-300 font-semibold',
  ready_for_dispatch: 'bg-getmeds-blue/10 text-getmeds-blue-dark border border-getmeds-blue/30',
  picking_packing: 'bg-indigo-50 text-indigo-700 border border-indigo-200',
  dispatched: 'bg-getmeds-blue/15 text-getmeds-blue-dark border border-getmeds-blue/40',
  tracking_shared: 'bg-teal-50 text-teal-800 border border-teal-200',
  completed: 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/40',
  on_hold: 'bg-state-error-light text-red-800 border border-state-error/30',
  exception: 'bg-state-error-light text-red-950 border border-state-error font-bold',
  cancelled: 'bg-state-error-light text-red-700 border border-state-error/30',
  deleted: 'bg-slate-200 text-slate-600 border border-slate-400 line-through',
};

// Sep 1, 2026 (5): timeline entries are titled with the Zoho Sales Order they
// belong to, and with a short human label instead of the raw event_type.
//
// The event_type values themselves are deliberately left alone — they are the
// machine key that audit queries, the "already logged?" guards and the tests
// all match on, and renaming them to prettify a heading would be trading a
// stable contract for a display detail. So the mapping lives here, at the one
// place a person actually reads.
const EVENT_LABELS = {
  ORDER_SUBMITTED: 'ORDER SUBMITTED',
  STATUS_CHANGE: 'STATUS CHANGE',
  ZOHO_SO_CONFIRMED: 'CONFIRMED',
  ZOHO_SO_STATUS_CHANGED: 'SO STATUS CHANGED',
  ZOHO_SO_EDITED: 'EDITED IN ZOHO',
  ZOHO_SO_CANCELLED: 'CANCELLED',
  ZOHO_SO_DELETED: 'SO DELETED',
  // The only two events in this map that come from a person clicking in this
  // app rather than from Zoho reporting something.
  FINANCE_VERIFIED: 'FINANCE VERIFIED',
  FINANCE_REJECTED: 'FINANCE REJECTED',
  // Sep 4, 2026: the proof of payment. Note there is no PAYMENT_PROOF_VERIFIED
  // — approving a proof happens inside the FINANCE_VERIFIED decision above,
  // which is the one that actually clears the order to be invoiced. Only a
  // rejection is its own event, because it is its own action.
  PAYMENT_PROOF_UPLOADED: 'PAYMENT PROOF UPLOADED',
  PAYMENT_PROOF_REJECTED: 'PAYMENT PROOF REJECTED',
  // Sep 25, 2026: the pharmacist's decision on a prescription.
  RX_VERIFIED: 'PRESCRIPTION VERIFIED',
  RX_REJECTED: 'PRESCRIPTION REJECTED',
  RX_RESUBMITTED: 'PRESCRIPTION RE-SUBMITTED',
  ZOHO_INVOICE_DRAFTED: 'INVOICE DRAFTED',
  ZOHO_INVOICE_SENT: 'INVOICE SENT',
  ZOHO_PAYMENT_VERIFIED: 'PAYMENT RECEIVED',
  ZOHO_PACKAGE_CREATED: 'PACKED',
  ZOHO_DISPATCHED: 'DISPATCHED',
  TRACKING_ENTERED: 'TRACKING ENTERED',
  ORDER_COMPLETED: 'COMPLETED',
  ORDER_COMPLETION_BLOCKED: 'COMPLETION BLOCKED',
  ZOHO_SYNC_FAILED: 'ZOHO SYNC FAILED',
  ZOHO_EVENT_RECEIVED: 'ZOHO EVENT RECEIVED',
  EXCEPTION_SET: 'EXCEPTION SET',
  // Sep 9, 2026: the three the Zoho import writes.
  //
  // ZOHO_LOG is the only entry in this whole timeline that is not this app's
  // own account of what happened — it is a line copied verbatim out of Zoho's
  // Comments & History for the Sales Order, with Zoho's timestamp and the
  // Zoho user Zoho names. Labelled so a reader can tell the two apart at a
  // glance, because "who is saying this" changes how much the entry is worth.
  ZOHO_LOG: 'FROM ZOHO HISTORY',
  ORDER_IMPORTED_FROM_ZOHO: 'IMPORTED FROM ZOHO',
  ZOHO_SO_LINKED: 'LINKED TO ZOHO SO',
  // Sep 10, 2026: milestones read straight out of Zoho's Comments & History
  // (services/zohoHistoryService.js). These carry Zoho's own timestamp and the
  // real person who did it, so they read as what happened rather than as what
  // this app worked out afterwards.
  ZOHO_SO_CREATED: 'CREATED IN ZOHO',
  ZOHO_SO_FULFILLED: 'FULFILLED IN ZOHO',
  ZOHO_DELIVERED: 'DELIVERED',
  ZOHO_PACKAGE_UPDATED: 'PACKAGE UPDATED',
  ZOHO_PACKAGE_DELETED: 'PACKAGE DELETED',
  ZOHO_ATTACHMENT_ADDED: 'ATTACHMENT ADDED IN ZOHO',
  ZOHO_STATUS_SYNCED: 'STATUS SYNCED FROM ZOHO',
  ORDER_REASSIGNED: 'ASSIGNED TO MEDREP',
  // Sep 15, 2026: Dispatch's own records, from the Dispatch page. None of
  // them changes the order's status; they say who checked what, and why a
  // tracking number is not there yet.
  DELIVERY_CONFIRMED: 'CONFIRMED FOR DELIVERY',
  TRACKING_ON_HOLD: 'TRACKING ON HOLD',
  TRACKING_HOLD_RELEASED: 'TRACKING HOLD LIFTED',
  DISPATCH_TRACKING_ADDED: 'TRACKING NUMBER ADDED',
  DISPATCH_PROOF_UPLOADED: 'DISPATCH PROOF UPLOADED',
  DISPATCH_CATERED: 'CATERED BY DISPATCH',
  DISPATCH_RELEASED: 'RELEASED BY DISPATCH',
  DISPATCH_HOLD: 'ON HOLD BY DISPATCH',
  DISPATCH_HOLD_LIFTED: 'DISPATCH HOLD LIFTED',
  CUSTOMER_LINKED_TO_ZOHO: 'CUSTOMER LINKED TO ZOHO',
  ORDER_RESUMED: 'RESUMED BY MANAGEMENT',
  STOCK_WARNING_ACKNOWLEDGED: 'RAISED DESPITE STOCK WARNING'
};

// "[SO-66881] INVOICE SENT". The Sales Order number comes from the order
// rather than the event, because every event on an order shares it — and an
// order whose Zoho push failed has none yet, in which case the prefix is
// simply omitted rather than rendering an empty bracket.
function eventTitle(event, order) {
  const label = EVENT_LABELS[event.event_type] || String(event.event_type || '').replace(/_/g, ' ');
  const so = order?.zoho_so_number;
  return so ? `[${so}] ${label}` : label;
}

const EVENT_ICONS = {
  ORDER_CREATED: '📝', STATUS_CHANGE: '🔄', PAYMENT_VERIFIED: '✅',
  PAYMENT_REJECTED: '❌', ORDER_DISPATCHED: '🚚', TRACKING_ENTERED: '📍',
  ORDER_COMPLETED: '🎉', EXCEPTION_SET: '⚠️', DISPATCH_STATUS_UPDATE: '📦',
  ZOHO_PAYMENT_SYNCED: '⚡', ZOHO_SO_CONFIRMED: '📄', ZOHO_INVOICE_DRAFTED: '🧾',
  ZOHO_PAYMENT_VERIFIED: '✅', ZOHO_PACKAGE_CREATED: '📦', ZOHO_DISPATCHED: '🚚',
  ZOHO_DISPATCH_UPDATED: '🚚', ZOHO_SO_CANCELLED: '🚫', ZOHO_EVENT_RECEIVED: '🔔',
  ZOHO_SO_STATUS_CHANGED: '📄', ORDER_ITEMS_EDITED: '✏️', ZOHO_SO_DELETED: '🗑️',
  FINANCE_VERIFIED: '🔍', FINANCE_REJECTED: '🛑',
  PAYMENT_PROOF_UPLOADED: '🧾', PAYMENT_PROOF_REJECTED: '🛑',
  RX_VERIFIED: '💊', RX_REJECTED: '🛑', RX_RESUBMITTED: '↩',
  ZOHO_LOG: '📜', ORDER_IMPORTED_FROM_ZOHO: '📥', ZOHO_SO_LINKED: '🔗',
  ZOHO_SO_CREATED: '📝', ZOHO_SO_FULFILLED: '🎉', ZOHO_DELIVERED: '🏠',
  ZOHO_PACKAGE_UPDATED: '📦', ZOHO_PACKAGE_DELETED: '🗑️',
  ZOHO_ATTACHMENT_ADDED: '📎', ZOHO_STATUS_SYNCED: '🔄', ORDER_REASSIGNED: '👤',
  DELIVERY_CONFIRMED: '📍', TRACKING_ON_HOLD: '⏸️', TRACKING_HOLD_RELEASED: '▶️',
  DISPATCH_TRACKING_ADDED: '🚚', DISPATCH_PROOF_UPLOADED: '📸',
  DISPATCH_CATERED: '👤', DISPATCH_RELEASED: '↩️',
  DISPATCH_HOLD: '⏸️', DISPATCH_HOLD_LIFTED: '▶️',
  CUSTOMER_LINKED_TO_ZOHO: '🔗', ORDER_RESUMED: '▶️', STOCK_WARNING_ACKNOWLEDGED: '📦⚠️'
};

/**
 * Sep 21, 2026: "if the order has remarks from medrep/management, add to
 * their view so they can check" — Finance's own request, looking at an
 * order well past the stage where it was held (Tracking Shared, in this
 * case). A MedRep's resubmit note or Management's hold/reject/send-back
 * reason already exists on the trail, but only two ways to see it: the
 * order.exception_reason banner further down, which is deliberately hidden
 * the moment the order leaves on_hold/exception/draft (see that banner's
 * own comment), or digging into a specific pipeline stage's collapsed
 * "N updates" toggle in OrderPipeline. Neither is "check the remarks",
 * they're "notice the order was held" and "happen to click the right
 * stage". This pulls every such note into one place, regardless of the
 * order's current status.
 *
 * A fixed, narrow list rather than "any event with a role and a note" —
 * that would also catch routine bookkeeping notes (e.g. "Sales Order
 * drafted..." on a STATUS_CHANGE hop attributed to whoever submitted it),
 * which are not remarks anyone wrote, just automatic narration.
 */
const REMARK_EVENT_TYPES = new Set([
  'RETURNED_TO_FINANCE',    // a MedRep's note resubmitting after a Finance hold
  'ORDER_RESUBMITTED',      // a MedRep's note resubmitting after a Management hold/exception
  'MANAGEMENT_REJECTED',    // Management's reason for rejecting a MedRep's order
  'MANAGEMENT_SENT_BACK',   // Management's "what to fix" note
  'EXCEPTION_SET',          // Management's hold/exception reason
]);

const OrderDetailPage = () => {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const qc = useQueryClient();
  const [searchParams] = useSearchParams();
  // Defaults to the timeline (see the tabs array below). ?tab=items|payment|
  // dispatch|timeline overrides it, so a link can point at a specific tab
  // without this component having to guess where the visitor came from.
  const VALID_TABS = ['timeline', 'items', 'payment', 'dispatch', 'proof'];
  const requestedTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(
    VALID_TABS.includes(requestedTab) ? requestedTab : 'timeline'
  );
  // Sep 22, 2026: split-invoicing orders — clicking either entity's card in
  // the Zoho Integration panel jumps to the Audit Timeline and filters it to
  // just that Sales Order's own events (see orderTimelineService.js's
  // per-event `entity` tagging). null shows everything, same as before this
  // existed. The value is the raw invoicing_from string — order.invoicing_from
  // for the primary, a split row's invoicing_from otherwise — so it matches
  // timeline.stages[].updates[].entity / perEntity[].entity exactly.
  const [timelineFocus, setTimelineFocus] = useState(null);
  const [rawLogOpen, setRawLogOpen] = useState(false);
  const focusTimelineOn = (entity) => { setTimelineFocus(entity); setActiveTab('timeline'); };
  // Aug 31, 2026: lets a MedRep/Admin fix an order's line items in place —
  // added after TestGM-20260831-0001 failed Zoho sync with "Inactive items
  // cannot be added to the sales order" and there was no way to swap the
  // bad item out short of abandoning the order. See the gating on
  // order.zoho_so_id below for why this only shows up before a real Zoho
  // Sales Order exists yet.
  const [isEditingItems, setIsEditingItems] = useState(false);
  const [draftItems, setDraftItems] = useState([]);
  // Sep 7, 2026 (2): the order-level counterpart to isEditingItems/draftItems
  // above — same "only before Zoho exists" gate, everything except the line
  // items. See updateDetails on the backend.
  const [isEditingDetails, setIsEditingDetails] = useState(false);
  const [draftDetails, setDraftDetails] = useState(null);
  // Sep 19, 2026: "Save Changes" on Details/Items used to write straight
  // through with no review step. This holds the pending save (its diff, its
  // Zoho warning, and the payload to actually send) while ConfirmChangesModal
  // asks first — null when no confirmation is showing.
  const [pendingConfirm, setPendingConfirm] = useState(null);
  const { data: products = [] } = useProducts();

  const { data, isLoading, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => client.get(`/api/orders/${id}`).then(r => r.data),
    refetchInterval: 15000
  });

  // Sep 19, 2026: Zoho's own Salesperson list, for the Edit Details picker
  // below — same list and same endpoint OrderForm.jsx uses for order
  // creation (GET /api/orders/meta/medreps also carries `salespersons`, not
  // only the medrep list — see orders.controller.js's getMedreps). Only a
  // Management/admin session can edit Salesperson here, and only while the
  // details panel is open, so there's no reason to fetch it otherwise.
  const isManagementUser = ['management', 'admin'].includes(user?.role);
  const { data: medrepMeta } = useQuery({
    queryKey: ['orders-meta-medreps'],
    queryFn: () => client.get('/api/orders/meta/medreps').then(r => r.data),
    enabled: isManagementUser && isEditingDetails,
    staleTime: 30000
  });
  const zohoSalespersonNames = medrepMeta?.data?.salespersons || [];

  // Sep 15, 2026: re-submit an order Finance held, with the reason.
  const [resubmitOpen, setResubmitOpen] = useState(false);
  // Sep 26, 2026: answer Pharmacy's rejection of the prescription. Pharmacy only:
  // a replacement (optional) is uploaded first, then the note goes with the resubmit.
  const [rxResubmitOpen, setRxResubmitOpen] = useState(false);
  const rxResubmitMutation = useMutation({
    mutationFn: async ({ note, file }) => {
      if (file) await uploadOrderAttachment(client, id, file, 'prescription');
      return client.post(`/api/orders/${id}/resubmit-prescription`, { note }).then(r => r.data);
    },
    onSuccess: (res) => {
      toast.success(res?.data?.message || 'Re-submitted to Pharmacy.');
      setRxResubmitOpen(false);
      qc.invalidateQueries({ queryKey: ['order', id] });
      qc.invalidateQueries({ queryKey: ['order-attachments', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || err.message || 'Could not re-submit the prescription', { duration: 8000 })
  });

  // Sep 15, 2026: the whole order on one screen, like the submission review.
  const [overviewOpen, setOverviewOpen] = useState(false);
  // Sep 18, 2026: reason first (moves the order off the hold/exception with
  // the MedRep's own words on the trail), then the file — attaching
  // afterwards is harmless even for a Finance hold specifically, where
  // attaching to a held order already returns it to Finance on its own
  // (financeHoldService), because by then the order has already left
  // on_hold and that auto-return is a no-op.
  // Sep 19, 2026: resubmit() itself now also resolves a Management hold or
  // exception (not just Finance's) — this mutation didn't need to change,
  // since it only ever cared that /resubmit succeeded before it uploads.
  const resubmitMutation = useMutation({
    mutationFn: async ({ reason, file, fileType }) => {
      const res = await client.post(`/api/orders/${id}/resubmit`, { reason }).then(r => r.data);
      if (file) {
        try {
          await uploadOrderAttachment(client, id, file, fileType);
        } catch (err) {
          toast.error(err.response?.data?.error?.message || err.message || 'Re-submitted, but the file did not upload — attach it from the Payment tab.');
        }
      }
      return res;
    },
    onSuccess: (res) => {
      toast.success(res?.data?.message || 'Re-submitted to Finance.');
      setResubmitOpen(false);
      qc.invalidateQueries({ queryKey: ['order', id] });
      qc.invalidateQueries({ queryKey: ['order-attachments', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not re-submit this order', { duration: 8000 })
  });

  // Sep 15, 2026: Dispatch adds or updates the tracking number from the
  // Dispatch tab — saved on the order and sent to the MedRep; Zoho's own
  // shipment number is changed in Zoho.
  const [trackingOpen, setTrackingOpen] = useState(false);
  const trackingMutation = useMutation({
    mutationFn: (tracking) => client.post(`/api/dispatch/orders/${id}/tracking`, tracking).then(r => r.data),
    onSuccess: (res) => {
      toast.success(res?.data?.message || 'Tracking number saved.');
      setTrackingOpen(false);
      qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not save the tracking number', { duration: 8000 })
  });

  const exceptionMutation = useMutation({
    mutationFn: ({ status, reason }) => client.patch(`/api/orders/${id}/exception`, { status, reason }).then(r => r.data),
    onSuccess: () => { toast.success('Order status updated'); qc.invalidateQueries({ queryKey: ['order', id] }); },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Failed')
  });

  // Sep 15, 2026: take the order off Exception / On Hold so it can continue.
  const [resumeOpen, setResumeOpen] = useState(false);
  const resumeMutation = useMutation({
    mutationFn: (body) => client.post(`/api/orders/${id}/resume`, body).then(r => r.data),
    onSuccess: (res) => {
      toast.success(`Order resumed — now ${String(res.data?.status || '').replace(/_/g, ' ')}`);
      setResumeOpen(false);
      qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not resume the order')
  });

  // Manual fallback for a missed webhook — pulls this order's current Sales
  // Order status straight from Zoho and backfills the audit trail if the
  // live webhook never reached this app (backend/ngrok wasn't running at
  // the moment it was confirmed).
  const zohoSyncMutation = useMutation({
    mutationFn: () => client.post(`/api/orders/${id}/sync-from-zoho`).then(r => r.data),
    onSuccess: (res) => {
      const action = res?.data?.action;
      if (action === 'SO_CONFIRMED_BACKFILLED') toast.success('Zoho confirmation added to the timeline.');
      else if (action === 'SO_CANCELLED_BACKFILLED') toast.success('Zoho cancellation added to the timeline.');
      // Aug 31, 2026: a Sales Order deleted directly in Zoho (not
      // voided/cancelled) used to just show the raw "Sales Order does not
      // exist" error from Zoho with nothing added to the trail — see
      // orders.controller.js's syncFromZoho.
      else if (action === 'SO_DELETED_BACKFILLED') toast.success('Zoho deletion added to the timeline.');
      else if (action === 'PACKAGE_BACKFILLED') toast.success('Zoho package (picking/packing) added to the timeline.');
      else if (action === 'DISPATCHED_BACKFILLED') toast.success('Zoho shipment & tracking added to the timeline.');
      // Sep 7, 2026 (5): a field edited directly in Zoho (Payment Terms,
      // Invoicing From, Doctor Name, Source, Delivery Method, Terms) used to
      // have no backfill path at all outside the live webhook — see
      // zohoReconcileService.js's reconcileOrder.
      else if (action === 'EDIT_BACKFILLED') toast.success('Zoho edit added to the timeline.');
      else if (!(res?.data?.splits || []).some((x) => x.changes?.length)) toast('Already up to date with Zoho.', { icon: 'ℹ️' });
      // Sep 26, 2026: a split order's other Sales Order(s) are pulled too.
      for (const x of res?.data?.splits || []) {
        if (x.error) toast.error(`${x.invoicing_from}: ${x.error}`, { duration: 8000 });
        else if (x.changes?.length) toast.success(`${x.invoicing_from}${x.zoho_so_number ? ` (${x.zoho_so_number})` : ''}: updated from Zoho (${x.changes.join(', ')}).`);
        if (x.items === 'refused') toast('Some items on the second Sales Order could not be copied because a product is missing here. See the timeline.', { icon: '⚠️', duration: 8000 });
      }
      qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not reach Zoho')
  });

  // Manual, on-demand PUSH of a failed Zoho sync. Added Aug 30, 2026 when
  // the automatic 30s background retry loop was switched off by default
  // (see server.js) — a failed sync no longer retries itself; this button
  // is how it gets retried instead, one click at a time.
  const retryZohoSyncMutation = useMutation({
    mutationFn: () => client.post(`/api/orders/${id}/retry-zoho-sync`).then(r => r.data),
    onSuccess: (res) => {
      const outcome = res?.data?.result?.outcome;
      if (outcome === 'succeeded') toast.success('Zoho Sales Order created — sync succeeded.');
      else toast.error(`Still failing: ${res?.data?.result?.error || 'unknown error'}`);
      qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Retry failed')
  });

  // Aug 31, 2026: saves a corrected line-item list (see isEditingItems
  // above). A MedRep only ever reaches this while order.zoho_so_id is still
  // null — the backend refuses it outright once a real Zoho Sales Order
  // exists.
  // Sep 19, 2026: Management is the exception — the backend now pushes the
  // corrected items to the real Sales Order for them instead of refusing.
  const updateItemsMutation = useMutation({
    mutationFn: (payloadItems) => client.patch(`/api/orders/${id}/items`, { items: payloadItems }).then(r => r.data),
    onSuccess: (res) => {
      if (res.data?.zoho_pushed) {
        toast.success('Order items updated, and pushed to the Zoho Sales Order.');
      } else if (res.data?.zoho_error) {
        toast.success('Order items updated.');
        toast.error(`Could not push the change to Zoho: ${res.data.zoho_error}`, { duration: 8000 });
      } else {
        toast.success('Order items updated.');
      }
      setIsEditingItems(false);
      qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not update items')
  });

  // Sep 7, 2026 (2): saves the order-level fields (see isEditingDetails
  // above). Same precondition and Sep 19 Management exception as items.
  const updateDetailsMutation = useMutation({
    mutationFn: (payload) => client.patch(`/api/orders/${id}/details`, payload).then(r => r.data),
    onSuccess: (res) => {
      // Sep 19, 2026: only present at all once this order already had a
      // Zoho Sales Order — see orders.controller.js's updateDetails.
      if (res.data?.zoho_pushed) {
        toast.success('Order details updated, and pushed to the Zoho Sales Order.');
      } else if (res.data?.zoho_error) {
        toast.success('Order details updated.');
        toast.error(`Could not push the change to Zoho: ${res.data.zoho_error}`, { duration: 8000 });
      } else {
        toast.success('Order details updated.');
      }
      setIsEditingDetails(false);
      qc.invalidateQueries({ queryKey: ['order', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not update order details')
  });

  // Sep 7, 2026 (2): the first UI caller of submit() — until now a draft
  // could only ever be created (see OrderForm.jsx's Save as Draft), never
  // sent through the gate afterward. Needed so "Send Back" actually round
  // -trips: an order sent back lands at 'draft' and needs a way back to
  // 'pending_management_approval'.
  // Sep 18, 2026: a resubmission after Management sent it back can carry a
  // file too — the corrected document, so Management does not have to take
  // the MedRep's word that it's fixed. Attached after submit (harmless
  // either order here, since attach() is never status-gated for these
  // types); the submit itself is what matters, so a failed upload only
  // shows a toast rather than blocking it.
  const [sentBackFile, setSentBackFile] = useState(null);
  const [sentBackFileType, setSentBackFileType] = useState('payment_proof');
  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await client.post(`/api/orders/${id}/submit`).then(r => r.data);
      if (sentBackFile) {
        try {
          await uploadOrderAttachment(client, id, sentBackFile, sentBackFileType);
        } catch (err) {
          toast.error(err.response?.data?.error?.message || err.message || 'Resubmitted, but the file did not upload — attach it from the Payment tab.');
        }
      }
      return res;
    },
    onSuccess: (res) => {
      toast.success(res?.data?.pending_management_approval
        ? 'Submitted — waiting for Management approval.'
        : 'Submitted and synced to Zoho.');
      setSentBackFile(null);
      qc.invalidateQueries({ queryKey: ['order', id] });
      qc.invalidateQueries({ queryKey: ['order-attachments', id] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not submit this order')
  });

  // Sep 7, 2026 (2): Approve / Send Back / Reject — mirrors
  // ApprovalQueuePage.jsx's Approve/Reject exactly, plus the new Send Back
  // action, so acting from here or from the queue behaves identically.
  const approveMutation = useMutation({
    mutationFn: () => client.post(`/api/orders/${id}/approve`).then(r => r.data),
    onSuccess: (res) => {
      const synced = res?.data?.zoho_sync_status === 'synced' || res?.data?.zoho_sync_status === 'skipped';
      toast.success(synced
        ? 'Approved — Sales Order created in Zoho.'
        : 'Approved — Zoho sync failed and was queued for automatic retry.');
      qc.invalidateQueries({ queryKey: ['order', id] });
      qc.invalidateQueries({ queryKey: ['management-approval-queue'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not approve this order')
  });

  const sendBackMutation = useMutation({
    mutationFn: (reason) => client.post(`/api/orders/${id}/send-back`, { reason }).then(r => r.data),
    onSuccess: () => {
      toast.success('Sent back to the MedRep to fix and resubmit.');
      qc.invalidateQueries({ queryKey: ['order', id] });
      qc.invalidateQueries({ queryKey: ['management-approval-queue'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not send this order back')
  });

  const rejectMutation = useMutation({
    mutationFn: (reason) => client.post(`/api/orders/${id}/reject`, { reason }).then(r => r.data),
    onSuccess: () => {
      toast.success('Rejected. The order is on hold and the MedRep has been notified.');
      qc.invalidateQueries({ queryKey: ['order', id] });
      qc.invalidateQueries({ queryKey: ['management-approval-queue'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not reject this order')
  });

  const startEditingItems = (currentItems) => {
    setDraftItems(currentItems.map((it) => ({
      product_id: it.product_id,
      name: it.product_name,
      sku: it.sku,
      unit: it.unit,
      quantity: it.quantity,
      rate: it.unit_price,
      discount: it.discount_amount || 0,
      tax_percent: it.tax_percent || 0,
      tax_label: it.tax_label || null,
      // Sep 18, 2026: opens the Tax select on the closest matching preset —
      // see OrderItemsEditor.jsx's Sep 18 note for why tax is now editable
      // here regardless of whether Zoho has this item's tax on file.
      taxOption: inferTaxOption(it.tax_percent, it.tax_label),
      price_remark: it.price_remark || '',
      // Sep 22, 2026: carried over from the server — without this, opening
      // and saving the editor on a split order would silently erase every
      // line's tag back to "follow the order" the moment someone touched
      // Save, even if they never went near the new control.
      invoicing_from: it.invoicing_from || null
    })));
    setIsEditingItems(true);
  };

  const replaceDraftProduct = (index, product) => {
    setDraftItems((rows) => rows.map((row, i) => i === index
      ? { ...row, product_id: product.id, name: product.name, sku: product.sku, unit: product.unit, rate: product.unit_price }
      : row));
  };

  // Sep 14, 2026: same fix as the order form. This forced every keystroke
  // through Math.max(1, Number(value) || 1), so clearing the field put 1 back
  // before anything could be typed. Keep what is typed; settle it on blur.
  const updateDraftQuantity = (index, value) => {
    if (!/^\d*$/.test(value)) return;
    setDraftItems((rows) => rows.map((row, i) => i === index ? { ...row, quantity: value } : row));
  };

  const normalizeDraftQuantity = (index) => {
    setDraftItems((rows) => rows.map((row, i) => {
      if (i !== index) return row;
      const q = parseInt(row.quantity, 10);
      return { ...row, quantity: Number.isFinite(q) && q >= 1 ? q : 1 };
    }));
  };

  // Sep 14, 2026: Management can change a line's price and discount before
  // the order reaches Zoho. The server has always accepted both on this edit
  // (orders.controller.js updateItems); the editor simply never offered them,
  // so the only way to correct a price was to cancel and re-raise the order.
  // Same keystroke rule as the order form: keep what is typed, settle on blur.
  const updateDraftMoney = (index, field, value) => {
    if (!/^\d*\.?\d{0,2}$/.test(value)) return;
    setDraftItems((rows) => rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)));
  };

  const normalizeDraftMoney = (index, field) => {
    setDraftItems((rows) => rows.map((row, i) => {
      if (i !== index) return row;
      const n = Number(row[field]);
      return { ...row, [field]: Number.isFinite(n) && n >= 0 ? n : 0 };
    }));
  };

  // What a line comes to before any VAT the server adds on top. Numbers are
  // coerced because a field mid-edit holds a string.
  const draftNet = (row) =>
    Math.max(0, (Number(row.quantity) || 0) * (Number(row.rate) || 0) - (Number(row.discount) || 0));

  // Sep 14, 2026: the editor reports changes as (row, field, value); these
  // route them to the existing keystroke rules above.
  const changeDraftField = (index, field, value) => {
    if (field === 'quantity') return updateDraftQuantity(index, value);
    if (field === 'rate' || field === 'discount') return updateDraftMoney(index, field, value);
    // Sep 18, 2026: why this line is priced this way — free text, no
    // numeric rule to route through, matching the backend's own 300-char cap.
    if (field === 'price_remark') {
      if (value.length > 300) return undefined;
      setDraftItems((rows) => rows.map((row, i) => (i === index ? { ...row, price_remark: value } : row)));
      return undefined;
    }
    if (field === 'taxOption') {
      const opt = TAX_OPTIONS.find((t) => t.value === value) || TAX_OPTIONS[0];
      setDraftItems((rows) => rows.map((row, i) => (i === index
        ? { ...row, taxOption: value, tax_percent: opt.percent, tax_label: opt.label }
        : row)));
      return undefined;
    }
    // Sep 22, 2026: per-line override of the order's own Invoicing From —
    // '' clears it back to "follow the order". See services/orderSplitService.js.
    if (field === 'invoicing_from') {
      setDraftItems((rows) => rows.map((row, i) => (i === index ? { ...row, invoicing_from: value || null } : row)));
      return undefined;
    }
    return undefined;
  };
  const blurDraftField = (index, field) =>
    field === 'quantity' ? normalizeDraftQuantity(index) : normalizeDraftMoney(index, field);

  const removeDraftRow = (index) => {
    setDraftItems((rows) => rows.filter((_, i) => i !== index));
  };

  const addDraftProduct = (product) => {
    setDraftItems((rows) => [...rows, {
      product_id: product.id, name: product.name, sku: product.sku, unit: product.unit,
      quantity: 1, rate: product.unit_price, discount: 0,
      // Sep 14, 2026: the item's own Zoho tax, as the order form uses.
      // Sep 18, 2026: taxOption now opens on the closest matching preset
      // (rather than always 'none') — tax is editable for every item now,
      // known or not, so a product Zoho does tax should not default to none.
      tax_percent: product.tax_percentage ?? 0, tax_label: product.tax_name ?? null,
      taxUnknown: product.tax_percentage == null, taxOption: inferTaxOption(product.tax_percentage, product.tax_name),
      price_remark: '',
      // Sep 22, 2026: null = follows the order's own Invoicing From, every
      // item's default. See services/orderSplitService.js.
      invoicing_from: null
    }]);
  };

  const activeProductIds = new Set(products.map((p) => String(p.id)));
  const hasInactiveDraftRow = draftItems.some((row) => !activeProductIds.has(String(row.product_id)));

  // Sep 19, 2026: a one-line description of a line item's numbers, shared by
  // both sides of the Items diff below so "before" and "after" are always
  // built the exact same way and a real change can't hide behind formatting.
  const describeDraftLine = ({ quantity, rate, discount, tax_percent, price_remark }) => {
    const qty = quantity ?? 0;
    const price = Number(rate) || 0;
    const disc = Number(discount) || 0;
    const tax = tax_percent != null && tax_percent !== '' ? `${tax_percent}%` : 'none';
    const remark = (price_remark || '').trim();
    return `Qty ${qty} · ₱${price.toFixed(2)}${disc ? ` · -₱${disc.toFixed(2)} disc` : ''} · Tax ${tax}${remark ? ` · “${remark}”` : ''}`;
  };

  const diffOrderItems = () => {
    const origByProduct = new Map((data?.data?.items || []).map((it) => [String(it.product_id), it]));
    const changes = [];
    const seen = new Set();
    for (const row of draftItems) {
      const pid = String(row.product_id);
      seen.add(pid);
      const orig = origByProduct.get(pid);
      const name = row.name || orig?.product_name || pid;
      const after = describeDraftLine(row);
      if (!orig) {
        changes.push({ label: `${name} — added`, before: '—', after });
        continue;
      }
      const before = describeDraftLine({
        quantity: orig.quantity, rate: orig.unit_price, discount: orig.discount_amount,
        tax_percent: orig.tax_percent, price_remark: orig.price_remark
      });
      if (before !== after) changes.push({ label: name, before, after });
    }
    for (const [pid, orig] of origByProduct) {
      if (seen.has(pid)) continue;
      changes.push({
        label: `${orig.product_name} — removed`,
        before: describeDraftLine({
          quantity: orig.quantity, rate: orig.unit_price, discount: orig.discount_amount,
          tax_percent: orig.tax_percent, price_remark: orig.price_remark
        }),
        after: '—'
      });
    }
    return changes;
  };

  const saveDraftItems = () => {
    if (draftItems.length === 0) { toast.error('Add at least one item.'); return; }
    if (hasInactiveDraftRow) { toast.error('Replace the flagged item(s) before saving — they are no longer active in Zoho.'); return; }
    const payloadItems = draftItems.map((row) => ({
      product_id: row.product_id,
      quantity: Math.max(1, parseInt(row.quantity, 10) || 1),
      rate: Number(row.rate) || 0,
      discount: Number(row.discount) || 0,
      tax_percent: row.tax_percent,
      tax_label: row.tax_label,
      price_remark: (row.price_remark || '').trim() || null,
      // Sep 22, 2026: a line billed under the OTHER Invoicing From entity —
      // see services/orderSplitService.js on the backend.
      invoicing_from: row.invoicing_from || null
    }));
    const changes = diffOrderItems();
    if (!changes.length) { toast('No changes to save.'); return; }
    const o = data?.data?.order;
    setPendingConfirm({
      title: `${o?.getmeds_order_id || 'This order'} — confirm item changes before saving`,
      warning: o?.zoho_so_id
        ? `Already in Zoho${o.zoho_so_number ? ` (${o.zoho_so_number})` : ''} — confirming this updates the real Sales Order too.`
        : null,
      changes,
      onConfirm: () => updateItemsMutation.mutate(payloadItems)
    });
  };

  const startEditingDetails = (o) => {
    setDraftDetails({
      division: o.division || '',
      sub_division: o.sub_division || '',
      headquarter: o.headquarter || '',
      salesperson: o.salesperson || '',
      delivery_address: o.delivery_address || '',
      delivery_notes: o.delivery_notes || '',
      doctor_name: o.intake_doctor || '',
      receiver_name: o.intake_receiver || '',
      receiver_contact_no: o.intake_contact_no || '',
      order_source: o.intake_source || '',
      delivery_method: o.intake_delivery_method || '',
      terms: o.intake_terms || '',
      payment_terms: o.intake_payment_terms || '',
      invoicing_from: o.invoicing_from || ''
    });
    setIsEditingDetails(true);
  };

  const updateDraftDetail = (field, value) => setDraftDetails((d) => ({ ...d, [field]: value }));

  // Sep 19, 2026: field-by-field, against the order as it stood before this
  // edit — same DETAIL_FIELDS list saveDraftDetails sends, plus
  // Division/Salesperson when this session can touch them, so the confirm
  // step always matches exactly what's about to be saved.
  const diffOrderDetails = (o) => {
    const rows = [
      ['Delivery Address', o.delivery_address, draftDetails.delivery_address],
      ['Delivery Notes', o.delivery_notes, draftDetails.delivery_notes],
      ['Sub-division', o.sub_division, draftDetails.sub_division],
      ['Headquarter', o.headquarter, draftDetails.headquarter],
      ['Doctor Name', o.intake_doctor, draftDetails.doctor_name],
      ['Receiver Name', o.intake_receiver, draftDetails.receiver_name],
      ['Receiver Contact No.', o.intake_contact_no, draftDetails.receiver_contact_no],
      ['Source', o.intake_source, draftDetails.order_source],
      ['Delivery Method', o.intake_delivery_method, draftDetails.delivery_method],
      ['Terms / Conditions', o.intake_terms, draftDetails.terms],
      ['Payment Terms', o.intake_payment_terms, draftDetails.payment_terms],
      ['Invoicing From', o.invoicing_from, draftDetails.invoicing_from]
    ];
    if (isManagementUser) {
      rows.push(['Division', o.division, draftDetails.division]);
      rows.push(['Salesperson', o.salesperson, draftDetails.salesperson]);
    }
    return rows
      .map(([label, before, after]) => ({ label, before: String(before || '').trim(), after: String(after || '').trim() }))
      .filter((r) => r.before !== r.after);
  };

  const saveDraftDetails = () => {
    if (!draftDetails.delivery_address.trim()) { toast.error('Delivery address cannot be blank.'); return; }
    const payload = {
      delivery_address: draftDetails.delivery_address,
      delivery_notes: draftDetails.delivery_notes,
      doctor_name: draftDetails.doctor_name,
      receiver_name: draftDetails.receiver_name,
      receiver_contact_no: draftDetails.receiver_contact_no,
      order_source: draftDetails.order_source,
      delivery_method: draftDetails.delivery_method,
      terms: draftDetails.terms,
      payment_terms: draftDetails.payment_terms,
      invoicing_from: draftDetails.invoicing_from,
      sub_division: draftDetails.sub_division,
      headquarter: draftDetails.headquarter
    };
    // Sep 7, 2026 (2): Division/Salesperson are Management-only on the
    // backend (mirrors create()'s own rule) — only send them from a
    // Management/admin session so the payload matches who can actually
    // change them.
    if (isManagementUser) {
      payload.division = draftDetails.division;
      payload.salesperson = draftDetails.salesperson;
    }

    const o = data?.data?.order;
    const changes = diffOrderDetails(o);
    if (!changes.length) { toast('No changes to save.'); return; }
    setPendingConfirm({
      title: `${o?.getmeds_order_id || 'This order'} — confirm detail changes before saving`,
      warning: o?.zoho_so_id
        ? `Already in Zoho${o.zoho_so_number ? ` (${o.zoho_so_number})` : ''} — confirming this updates the real Sales Order too.`
        : null,
      changes,
      onConfirm: () => updateDetailsMutation.mutate(payload)
    });
  };

  if (isLoading) return <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-getmeds-blue" /></div>;
  if (error) return <div className="text-center py-20 text-red-600">Failed to load order. <button onClick={() => navigate(-1)} className="underline">Go back</button></div>;

  // Sep 22, 2026: splits — a split-invoicing order's SECOND Sales Order(s).
  // Empty for every order without one, which is the overwhelming default.
  // See services/orderSplitService.js on the backend.
  const { order, items = [], payment, dispatch, splits = [], events = [], timeline } = data?.data || {};
  // Sep 26, 2026: every Sales Order this order is in, e.g. " (SO-67981 and SO-67982)".
  const soNumbers = order
    ? (() => {
        const nums = [order.zoho_so_number, ...splits.map((x) => x.zoho_so_number)].filter(Boolean);
        return nums.length ? ` (${nums.join(' and ')})` : '';
      })()
    : '';
  if (!order) return null;

  // Sep 7, 2026 (2): while editing, Management changing Division live
  // updates which Sub-division list applies — same behavior as OrderForm.jsx.
  const effectiveDetailDivision = (isManagementUser && draftDetails) ? (draftDetails.division || order.division) : order.division;
  const detailSubDivisionOptions = SUB_DIVISIONS_BY_DIVISION[effectiveDetailDivision] || null;

  // Sep 2, 2026: Audit Timeline moved to the front and made the default.
  // Opening an order is almost always asking "what has happened to this?" —
  // where it is in the Zoho flow, whether the Sales Order synced, who moved
  // it and when. The line items are fixed at creation and rarely the
  // question. This also means the "View Order Details" link straight after
  // submitting lands on the story of the order rather than on a table the
  // MedRep just typed themselves.
  const tabs = [
    { id: 'timeline', label: 'Audit Timeline', icon: Clock },
    { id: 'items', label: 'Order Items', icon: Package },
    { id: 'payment', label: 'Payment', icon: CreditCard },
    { id: 'dispatch', label: 'Dispatch', icon: Truck },
    // Sep 4, 2026: the deposit slip or receipt Finance checks before
    // invoicing. Next to Payment because that is what it is evidence about —
    // that tab is Zoho's record of the money, this one is the claim to it.
    // Sep 5, 2026: generalized beyond just the proof — this tab (id kept as
    // 'proof' so existing links/tab-state keep working) now lists every file
    // attached to the order, tagged Proof of Payment or Other.
    { id: 'proof', label: 'Attachments', icon: Receipt },
  ];

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1.5 text-sm text-ink-secondary hover:text-ink-primary">
        <ArrowLeft className="w-4 h-4" /> Back
      </button>

      {/* Header */}
      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-mono text-ink-secondary mb-1">Getmeds Order ID</p>
            <h1 className="text-2xl font-bold font-mono text-getmeds-blue">{order.getmeds_order_id}</h1>
            <p className="text-sm text-ink-secondary mt-1">
              {order.customer_name} · <span className={`capitalize px-2 py-0.5 rounded text-xs font-medium ${order.customer_type === 'credit' ? 'bg-getmeds-blue/10 text-getmeds-blue-dark' : 'bg-state-warning-light text-amber-900 border border-state-warning/30'}`}>{order.customer_type}</span>
            </p>
            <p className="text-xs text-ink-secondary mt-1">
              MedRep: {order.medrep_name}
              {/* Sep 12, 2026: an order raised for a colleague has two people
                  attached to it. Naming only the owner here made the trail's
                  "X submitted this for Y" look like it contradicted the
                  header. NULL raised_by_id is the ordinary order. */}
              {order.raised_by_id && order.raised_by_name ? ` (raised by ${order.raised_by_name})` : ''}
              {' · '}Created: {formatPHT(order.created_at)}
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <span className={`px-3 py-1 rounded-full text-sm font-semibold capitalize ${STATUS_COLORS[order.status] || 'bg-slate-100 text-slate-700'}`}>
              {order.status?.replace(/_/g, ' ')}
            </span>
            <p className="text-xl font-bold text-ink-primary">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</p>
            <button
              type="button"
              onClick={() => setOverviewOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-getmeds-blue/40 bg-white text-xs font-semibold text-getmeds-blue hover:bg-getmeds-blue/5"
            >
              📋 Order overview
            </button>
          </div>
        </div>
        {overviewOpen && <OrderOverviewModal order={order} items={items} splits={splits} onClose={() => setOverviewOpen(false)} />}
        {pendingConfirm && (
          <ConfirmChangesModal
            title={pendingConfirm.title}
            warning={pendingConfirm.warning}
            changes={pendingConfirm.changes}
            onCancel={() => setPendingConfirm(null)}
            onConfirm={() => {
              pendingConfirm.onConfirm();
              setPendingConfirm(null);
            }}
          />
        )}

        {/* Delivery Info */}
        <div className="mt-4 pt-4 border-t border-gray-100 grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs font-medium text-ink-secondary uppercase mb-1">Delivery Address</p>
            <p className="text-ink-primary">{order.delivery_address}</p>
            {order.delivery_notes && <p className="text-ink-secondary text-xs mt-0.5">{order.delivery_notes}</p>}
          </div>
          <div>
            <p className="text-xs font-medium text-ink-secondary uppercase mb-1">
              Zoho Integration
              {/* Sep 22, 2026: split-invoicing order — see
                  services/orderSplitService.js. A non-split order (the
                  overwhelming default) shows nothing extra here. */}
              {splits.length > 0 && (
                <span className="ml-1.5 normal-case font-normal text-getmeds-blue">
                  · split across {splits.length + 1} Sales Orders
                </span>
              )}
            </p>
            {/* Sep 22, 2026: clicking either entity's card jumps to the Audit
                Timeline filtered to just that Sales Order's own events (see
                timelineFocus above / OrderPipeline.jsx). Only offered once
                there's a second entity to distinguish from — a non-split
                order's card stays exactly as it always has, not clickable. */}
            {splits.length > 0 ? (
              <div
                role="button"
                tabIndex={0}
                title={`Focus the Audit Timeline on ${order.invoicing_from}`}
                onClick={() => focusTimelineOn(order.invoicing_from)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusTimelineOn(order.invoicing_from); } }}
                className={`-mx-1.5 px-1.5 py-1 rounded-md cursor-pointer transition-colors ${timelineFocus === order.invoicing_from ? 'bg-getmeds-blue/10 ring-1 ring-getmeds-blue/30' : 'hover:bg-surface'}`}
              >
                <p className="text-[11px] text-ink-secondary mb-1.5">{order.invoicing_from} (primary):</p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {order.zoho_so_number ? (
                    <>
                      <span className="bg-pharmacy-green/15 text-pharmacy-green-dark px-2 py-0.5 rounded font-medium">SO: {order.zoho_so_number}</span>
                      <span className={`px-2 py-0.5 rounded ${order.zoho_sync_status === 'synced' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : 'bg-state-warning-light text-amber-900'}`}>
                        {order.zoho_sync_status}
                      </span>
                      {order.zoho_so_status && (
                        <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded capitalize">{order.zoho_so_status}</span>
                      )}
                      {order.zoho_invoice_number && (
                        <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded font-medium">Invoice: {order.zoho_invoice_number}</span>
                      )}
                      {payment?.status && payment.status !== 'pending' && (
                        <span className={`px-2 py-0.5 rounded capitalize ${payment.status === 'verified' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : 'bg-state-error-light text-red-700'}`}>
                          Finance: {payment.status}
                        </span>
                      )}
                    </>
                  ) : <span className="text-ink-secondary">Not yet synced</span>}
                  {order.zoho_sync_status === 'failed' && (
                    <button
                      type="button"
                      disabled={retryZohoSyncMutation.isPending}
                      onClick={(e) => { e.stopPropagation(); retryZohoSyncMutation.mutate(); }}
                      title="Push this order to Zoho again now — automatic background retry is off, so this is the only way to retry a failed sync"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-state-warning text-amber-900 hover:bg-state-warning-light disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${retryZohoSyncMutation.isPending ? 'animate-spin' : ''}`} />
                      {retryZohoSyncMutation.isPending ? 'Retrying...' : 'Retry Zoho Sync'}
                    </button>
                  )}
                  {order.zoho_so_id && order.status !== 'cancelled' && (
                    <button
                      type="button"
                      disabled={zohoSyncMutation.isPending}
                      onClick={(e) => { e.stopPropagation(); zohoSyncMutation.mutate(); }}
                      title="Pull this order's current status from Zoho for every Sales Order it is split across — items, totals, invoices and shipments. Catches up the timeline if a webhook was missed"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-200 text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50"
                    >
                      <RefreshCw className={`w-3 h-3 ${zohoSyncMutation.isPending ? 'animate-spin' : ''}`} />
                      {zohoSyncMutation.isPending ? 'Checking Zoho...' : `Sync from Zoho (all ${splits.length + 1})`}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {order.zoho_so_number ? (
                  <>
                    <span className="bg-pharmacy-green/15 text-pharmacy-green-dark px-2 py-0.5 rounded font-medium">SO: {order.zoho_so_number}</span>
                    <span className={`px-2 py-0.5 rounded ${order.zoho_sync_status === 'synced' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : 'bg-state-warning-light text-amber-900'}`}>
                      {order.zoho_sync_status}
                    </span>
                    {order.zoho_invoice_number && (
                      <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded font-medium">Invoice: {order.zoho_invoice_number}</span>
                    )}
                  </>
                ) : <span className="text-ink-secondary">Not yet synced</span>}
                {order.zoho_sync_status === 'failed' && (
                  <button
                    type="button"
                    disabled={retryZohoSyncMutation.isPending}
                    onClick={() => retryZohoSyncMutation.mutate()}
                    title="Push this order to Zoho again now — automatic background retry is off, so this is the only way to retry a failed sync"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-state-warning text-amber-900 hover:bg-state-warning-light disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${retryZohoSyncMutation.isPending ? 'animate-spin' : ''}`} />
                    {retryZohoSyncMutation.isPending ? 'Retrying...' : 'Retry Zoho Sync'}
                  </button>
                )}
                {/* Aug 31, 2026: only 'cancelled' hides this now — 'completed'
                    used to as well, but that stopped being safe once
                    syncFromZoho gained an invoice backfill: an order can
                    legitimately still be sitting at 'completed' (e.g. from
                    before the premature-auto-complete bug in the dispatch
                    webhook was fixed) and still need that invoice pulled in. */}
                {order.zoho_so_id && order.status !== 'cancelled' && (
                  <button
                    type="button"
                    disabled={zohoSyncMutation.isPending}
                    onClick={() => zohoSyncMutation.mutate()}
                    title="Pull this order's current status from Zoho — catches up the timeline if a webhook was missed"
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded border border-slate-200 text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3 h-3 ${zohoSyncMutation.isPending ? 'animate-spin' : ''}`} />
                    {zohoSyncMutation.isPending ? 'Checking Zoho...' : 'Sync from Zoho'}
                  </button>
                )}
              </div>
            )}

            {/* Sep 22, 2026: one card per split entity — read-only for now
                (no Sync/Retry buttons yet, see the backend's own scope
                notes). Finance verifies each independently from the
                Payment tab; this is just visibility into where each Sales
                Order stands. */}
            {splits.map((s) => (
              <div
                key={s.id}
                role="button"
                tabIndex={0}
                title={`Focus the Audit Timeline on ${s.invoicing_from}`}
                onClick={() => focusTimelineOn(s.invoicing_from)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); focusTimelineOn(s.invoicing_from); } }}
                className={`mt-2 pt-2 -mx-1.5 px-1.5 pb-1 border-t border-dashed border-slate-200 rounded-md cursor-pointer transition-colors ${timelineFocus === s.invoicing_from ? 'bg-getmeds-blue/10 ring-1 ring-getmeds-blue/30' : 'hover:bg-surface'}`}
              >
                <p className="text-[11px] text-ink-secondary mb-1">{s.invoicing_from}:</p>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  {s.zoho_so_number ? (
                    <>
                      <span className="bg-pharmacy-green/15 text-pharmacy-green-dark px-2 py-0.5 rounded font-medium">SO: {s.zoho_so_number}</span>
                      <span className={`px-2 py-0.5 rounded ${s.zoho_sync_status === 'synced' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : s.zoho_sync_status === 'failed' ? 'bg-state-error-light text-red-700' : 'bg-state-warning-light text-amber-900'}`}>
                        {s.zoho_sync_status}
                      </span>
                      {s.zoho_so_status && (
                        <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded capitalize">{s.zoho_so_status}</span>
                      )}
                      {s.zoho_invoice_number && (
                        <span className="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded font-medium">Invoice: {s.zoho_invoice_number}</span>
                      )}
                      {s.zoho_paid_status === 'paid' && (
                        <span className="bg-pharmacy-green/15 text-pharmacy-green-dark px-2 py-0.5 rounded">Paid in Zoho</span>
                      )}
                      {s.zoho_package_number && !s.zoho_shipment_id && s.zoho_shipped_status !== 'shipped' && (
                        <span className="bg-slate-100 text-slate-700 px-2 py-0.5 rounded">Package: {s.zoho_package_number}</span>
                      )}
                      {s.zoho_shipped_status === 'shipped' && (
                        <span className="bg-sky-50 text-sky-800 px-2 py-0.5 rounded font-medium">Shipped{s.zoho_shipment_number ? `: ${s.zoho_shipment_number}` : ''}</span>
                      )}
                      {s.payment_status && s.payment_status !== 'pending' && (
                        <span className={`px-2 py-0.5 rounded capitalize ${s.payment_status === 'verified' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : 'bg-state-error-light text-red-700'}`}>
                          Finance: {s.payment_status}
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-ink-secondary">
                      Not yet synced{s.zoho_sync_error ? ` — ${s.zoho_sync_error}` : ''}
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Order Details — Sep 7, 2026 (2): everything besides line items,
            editable in place before this order reaches Zoho. Same "only
            before Zoho exists" gate and Save/Cancel pattern as Edit Items
            on the Items tab below.

            Sep 14, 2026: shown for ANY order Zoho does not have yet, not only
            draft / awaiting approval — the server has allowed that since the
            edit window became "until Zoho has it", so a held or
            awaiting-Finance order that never synced (GM-20260913-0002) had an
            edit the API would accept and no way to reach it. Finished orders
            are still read-only.

            Sep 19, 2026: Management can now edit this even once Zoho HAS the
            order — orders.controller.js's updateDetails pushes the change to
            the real Sales Order in that case rather than refusing it. A
            MedRep still only gets here before Zoho has it, same as before. */}
        {(!order.zoho_so_id || isManagementUser) && !['completed', 'cancelled', 'deleted'].includes(order.status) && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-medium text-ink-secondary uppercase">
                Order Details
                {order.zoho_so_id && (
                  <span className="ml-2 normal-case font-normal text-amber-700">
                    · already in Zoho — an edit here updates the real Sales Order too
                  </span>
                )}
              </p>
              {!isEditingDetails && (
                <button
                  type="button"
                  onClick={() => startEditingDetails(order)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-getmeds-blue/40 text-getmeds-blue-dark rounded hover:bg-getmeds-blue/10"
                >
                  <Pencil className="w-3.5 h-3.5" /> Edit Details
                </button>
              )}
            </div>

            {!isEditingDetails ? (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
                {[
                  ['Division', order.division || '—'],
                  ['Sub-division', order.sub_division || '—'],
                  ['Headquarter', order.headquarter || '—'],
                  ['Salesperson', order.salesperson || '—'],
                  ['Doctor', order.intake_doctor || '—'],
                  ['Receiver', order.intake_receiver || '—'],
                  ['Receiver Contact', order.intake_contact_no || '—'],
                  ['Source', order.intake_source || '—'],
                  ['Delivery Method', order.intake_delivery_method || '—'],
                  ['Payment Terms', order.intake_payment_terms || '—'],
                  ['Invoicing From', order.invoicing_from || '—'],
                  // Sep 9, 2026: the Master Form fields. Collected on the
                  // order form and previously readable nowhere — a field
                  // nobody can read back is half a feature.
                  ['Expected Shipment', order.intake_expected_shipment_date || '—'],
                  [
                    'Customer is the doctor',
                    order.intake_is_doctor === 1 ? 'Yes' : order.intake_is_doctor === 0 ? 'No' : '—'
                  ],
                  ['TIN', order.intake_tin || '—'],
                  // Hospital-only in practice, but shown whenever set rather
                  // than gated on the customer's category here: the category
                  // can be changed after the order was raised, and the values
                  // recorded on it stay true regardless.
                  ...(order.intake_gl_number ? [['GL Number', order.intake_gl_number]] : []),
                  ...(order.intake_receiver_type
                    ? [['Receiver Type', order.intake_receiver_type === 'patient' ? 'Patient' : 'Representative']]
                    : []),
                ].map(([label, val]) => (
                  <div key={label}>
                    <p className="text-xs text-ink-secondary">{label}</p>
                    <p className="text-ink-primary font-medium">{val}</p>
                  </div>
                ))}
                {order.intake_terms && (
                  <div className="md:col-span-3">
                    <p className="text-xs text-ink-secondary">Terms / Conditions</p>
                    <p className="text-ink-primary">{order.intake_terms}</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Delivery Address</label>
                    <textarea rows={2} value={draftDetails.delivery_address}
                      onChange={(e) => updateDraftDetail('delivery_address', e.target.value)}
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Delivery Notes</label>
                    <textarea rows={2} value={draftDetails.delivery_notes}
                      onChange={(e) => updateDraftDetail('delivery_notes', e.target.value)}
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                  </div>

                  {isManagementUser && (
                    <div>
                      <label className="block text-xs font-medium text-ink-secondary mb-1">Division</label>
                      <select value={draftDetails.division}
                        onChange={(e) => updateDraftDetail('division', e.target.value)}
                        className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm">
                        <option value="">-- Not set --</option>
                        {DIVISIONS.map((d) => <option key={d} value={d}>{d}</option>)}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Sub-division</label>
                    {detailSubDivisionOptions ? (
                      <select value={draftDetails.sub_division}
                        onChange={(e) => updateDraftDetail('sub_division', e.target.value)}
                        className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm">
                        <option value="">-- Select sub-division --</option>
                        {detailSubDivisionOptions.map((sd) => <option key={sd} value={sd}>{sd}</option>)}
                      </select>
                    ) : (
                      <input type="text" value={draftDetails.sub_division}
                        onChange={(e) => updateDraftDetail('sub_division', e.target.value)}
                        placeholder="Enter sub-division"
                        className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Headquarter</label>
                    <input type="text" value={draftDetails.headquarter}
                      onChange={(e) => updateDraftDetail('headquarter', e.target.value)}
                      placeholder="Enter headquarter"
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                  </div>

                  {isManagementUser && (
                    <div>
                      <label className="block text-xs font-medium text-ink-secondary mb-1">Salesperson</label>
                      <ZohoSalespersonCombo
                        names={zohoSalespersonNames}
                        value={draftDetails.salesperson}
                        onSelect={(name) => updateDraftDetail('salesperson', name)}
                      />
                      <p className="text-[11px] mt-1 text-ink-secondary">
                        Picked from Zoho's own Salesperson list — a typed name Zoho does not
                        recognize would be created there as a new one, so this only offers names it
                        already has.
                      </p>
                    </div>
                  )}

                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Doctor Name</label>
                    <input type="text" value={draftDetails.doctor_name}
                      onChange={(e) => updateDraftDetail('doctor_name', e.target.value)}
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Receiver Name</label>
                    <input type="text" value={draftDetails.receiver_name}
                      onChange={(e) => updateDraftDetail('receiver_name', e.target.value)}
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Receiver Contact No.</label>
                    <input type="tel" value={draftDetails.receiver_contact_no}
                      onChange={(e) => updateDraftDetail('receiver_contact_no', e.target.value)}
                      placeholder="09XXXXXXXXX"
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Source</label>
                    <select value={draftDetails.order_source}
                      onChange={(e) => updateDraftDetail('order_source', e.target.value)}
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm">
                      <option value="">-- Select source --</option>
                      {SOURCE_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Delivery Method</label>
                    <input type="text" list="delivery-method-suggestions" value={draftDetails.delivery_method}
                      onChange={(e) => updateDraftDetail('delivery_method', e.target.value)}
                      placeholder="e.g. LBC, Grab Express, Own Rider"
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                    <datalist id="delivery-method-suggestions">
                      {DELIVERY_METHOD_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
                    </datalist>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Payment Terms</label>
                    <input type="text" list="payment-terms-suggestions" value={draftDetails.payment_terms}
                      onChange={(e) => updateDraftDetail('payment_terms', e.target.value)}
                      placeholder="e.g. PDC 30, NET 30, Net 15"
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                    <datalist id="payment-terms-suggestions">
                      {PAYMENT_TERMS_SUGGESTIONS.map((s) => <option key={s} value={s} />)}
                    </datalist>
                    {/* Sep 19, 2026: what to attach as proof — see
                        constants/paymentTerms.js's paymentTermsProofHint. */}
                    {paymentTermsProofHint(draftDetails.payment_terms) && (
                      <p className="text-[11px] text-amber-800 bg-state-warning-light border border-state-warning/30 rounded px-2 py-1 mt-1.5">
                        {paymentTermsProofHint(draftDetails.payment_terms)}
                      </p>
                    )}
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Invoicing From</label>
                    <select value={draftDetails.invoicing_from}
                      onChange={(e) => updateDraftDetail('invoicing_from', e.target.value)}
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm">
                      <option value="">-- Select invoicing entity --</option>
                      {INVOICING_FROM_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-xs font-medium text-ink-secondary mb-1">Terms / Conditions</label>
                    <textarea rows={2} value={draftDetails.terms}
                      onChange={(e) => updateDraftDetail('terms', e.target.value)}
                      placeholder="Payment terms, return policy, or any conditions attached to this order..."
                      className="w-full border border-slate-300 rounded-md px-2 py-1.5 text-sm" />
                  </div>
                </div>

                <div className="flex justify-end gap-2 pt-1">
                  <button type="button" onClick={() => setIsEditingDetails(false)}
                    className="px-3 py-1.5 text-xs border border-slate-300 text-ink-secondary rounded hover:bg-surface">
                    Cancel
                  </button>
                  <button type="button" disabled={updateDetailsMutation.isPending} onClick={saveDraftDetails}
                    className="px-3 py-1.5 text-xs font-semibold bg-getmeds-blue text-white rounded hover:bg-getmeds-blue-dark disabled:opacity-50">
                    {updateDetailsMutation.isPending ? 'Saving...' : 'Save Changes'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Sep 7, 2026 (2): Management's decision on a MedRep-submitted
            order sitting at the approval gate — mirrors
            ApprovalQueuePage.jsx's Approve/Reject exactly, plus the new
            Send Back action, so acting from here or from the queue behaves
            identically. */}
        {order.status === 'pending_management_approval' && ['management', 'admin'].includes(user?.role) && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <p className="text-xs font-medium text-ink-secondary uppercase mb-2">Management Approval</p>
            {/* Sep 15, 2026: a resubmission, said so — with what was asked
                for last time, so the check is "was that fixed?". */}
            {order.sent_back && (
              <p className="mb-2 rounded-md border border-getmeds-blue/30 bg-getmeds-blue/5 px-3 py-2 text-xs text-getmeds-blue-dark">
                <span className="font-semibold">↩ Resubmitted for re-approval.</span>{' '}
                Sent back earlier by {order.sent_back.by}
                {order.sent_back.reason ? <> for: <span className="font-semibold">{order.sent_back.reason}</span></> : ''}
                {' '}— check it was fixed.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <button
                disabled={approveMutation.isPending}
                onClick={() => approveMutation.mutate()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-pharmacy-green text-white rounded hover:opacity-90 disabled:opacity-50"
              >
                <ShieldCheck className="w-3.5 h-3.5" /> {approveMutation.isPending ? 'Syncing to Zoho...' : 'Approve — sync to Zoho'}
              </button>
              <button
                disabled={sendBackMutation.isPending}
                onClick={() => { const r = prompt('What does the MedRep need to fix?'); if (r) sendBackMutation.mutate(r); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-getmeds-blue/40 text-getmeds-blue-dark rounded hover:bg-getmeds-blue/10 disabled:opacity-50"
              >
                <Undo2 className="w-3.5 h-3.5" /> {sendBackMutation.isPending ? 'Sending back...' : 'Resubmit (Send Back)'}
              </button>
              <button
                disabled={rejectMutation.isPending}
                onClick={() => { const r = prompt('Reason for rejecting?'); if (r) rejectMutation.mutate(r); }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-state-error text-red-700 rounded hover:bg-state-error-light disabled:opacity-50"
              >
                <XCircle className="w-3.5 h-3.5" /> {rejectMutation.isPending ? 'Rejecting...' : 'Reject'}
              </button>
            </div>
          </div>
        )}

        {/* Sep 7, 2026 (2): the other half of Send Back — a draft (fresh,
            or bounced back by Management) needs a way back through the
            gate. Same ownership rule as editing: the order's own MedRep,
            or Management/admin. */}
        {/* Sep 15, 2026: whoever raised the order may submit it too — the
            server always allowed it (canEditOrder); only this button hid it,
            so a rep who raised an order for a colleague and had it sent back
            could not resubmit it. A sent-back draft resubmits from the
            banner below instead. */}
        {order.status === 'draft' && !order.sent_back &&
          (user?.id === order.medrep_id || user?.id === order.raised_by_id || ['management', 'admin'].includes(user?.role)) && (
          <div className="mt-4 pt-4 border-t border-gray-100">
            <button
              disabled={submitMutation.isPending}
              onClick={() => submitMutation.mutate()}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-semibold bg-getmeds-blue text-white rounded hover:bg-getmeds-blue-dark disabled:opacity-50"
            >
              {submitMutation.isPending ? 'Submitting...' : 'Submit Order'}
            </button>
          </div>
        )}

        {/* Management actions */}
        {['management', 'admin'].includes(user?.role) && !['completed', 'cancelled'].includes(order.status) && (
          <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap gap-2">
            {['on_hold', 'exception'].includes(order.status) && (
              <button
                onClick={() => setResumeOpen(true)}
                className="px-3 py-1.5 text-xs font-semibold bg-pharmacy-green text-white rounded hover:opacity-90"
              >▶ Resume order</button>
            )}
            <button
              onClick={() => { const r = prompt('Reason for hold?'); if (r) exceptionMutation.mutate({ status: 'on_hold', reason: r }); }}
              className="px-3 py-1.5 text-xs border border-state-warning text-amber-800 rounded hover:bg-state-warning-light"
            >⏸ Put on Hold</button>
            <button
              onClick={() => { const r = prompt('Exception reason?'); if (r) exceptionMutation.mutate({ status: 'exception', reason: r }); }}
              className="px-3 py-1.5 text-xs border border-state-error text-red-700 rounded hover:bg-state-error-light"
            >⚠️ Mark Exception</button>
          </div>
        )}
        {/* Sep 15, 2026: only while it still applies. exception_reason stays
            on the row after a hold is cleared, so without this a verified
            order kept showing "Exception/Hold Reason: n/a". */}
        {order.exception_reason && ['on_hold', 'exception', 'draft'].includes(order.status) && (
          <div className="mt-3 bg-state-warning-light border border-state-warning/30 rounded p-3 text-xs text-amber-950 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>
                <span className="font-semibold">
                  {order.status === 'draft'
                    ? order.sent_back
                      ? `Sent back by Management · ${order.sent_back.by} — What To Fix:`
                      : 'Sent Back — What To Fix:'
                    : 'Exception/Hold Reason:'}
                </span> {order.exception_reason}
              </p>
              {/* Sep 15, 2026: fix it, then send it back to Management from
                  here. They are told it is a resubmission, with this reason.
                  Sep 18, 2026: a supporting file can go along with it. */}
              {order.status === 'draft' &&
                (isManagementUser || order.medrep_id === user?.id || order.raised_by_id === user?.id) && (
                <button
                  type="button"
                  disabled={submitMutation.isPending}
                  onClick={() => submitMutation.mutate()}
                  className="shrink-0 px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50"
                >
                  {submitMutation.isPending ? 'Resubmitting…' : '↩ Resubmit to Management'}
                </button>
              )}
            </div>
            {order.status === 'draft' &&
              (isManagementUser || order.medrep_id === user?.id || order.raised_by_id === user?.id) && (
              <AttachFileField
                file={sentBackFile}
                fileType={sentBackFileType}
                onFileChange={(f, err) => { if (err) toast.error(err); else setSentBackFile(f); }}
                onTypeChange={setSentBackFileType}
                disabled={submitMutation.isPending}
                label="Attach the corrected document (optional)"
              />
            )}
            {/* Sep 19, 2026: 'exception' added — resubmit used to work only
                for a Finance hold, so this banner showed the reason with no
                way back for anything Management put on. resubmittable now
                covers both (orders.controller.js). */}
            {['on_hold', 'exception'].includes(order.status) && order.resubmittable &&
              (isManagementUser || order.medrep_id === user?.id || order.raised_by_id === user?.id) && (
              <button
                type="button"
                onClick={() => setResubmitOpen(true)}
                className="shrink-0 px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark"
              >
                ↩ Re-submit to {order.resume_to ? stageLabel(order.resume_to) : 'Finance'}
              </button>
            )}
            {/* Sep 19, 2026: resubmittable false but still held/exception —
                say why there's no button rather than the MedRep wondering
                whether the page is broken. Attaching from the tab above still
                works; it just won't auto-clear this hold without a resolvable
                prior stage. */}
            {['on_hold', 'exception'].includes(order.status) && !order.resubmittable &&
              (isManagementUser || order.medrep_id === user?.id || order.raised_by_id === user?.id) && (
              <p className="text-[11px] text-amber-900">
                Could not tell which stage this was at before the hold, so it can't be re-submitted automatically —
                attach what's needed above and ask Management to release it.
              </p>
            )}
          </div>
        )}
        {/* Sep 15, 2026: Dispatch's hold — the order is still being prepared,
            but something needs fixing (usually the items, out of stock). */}
        {order.dispatch_hold && (
          <div className="mt-3 bg-amber-50 border border-amber-300 rounded p-3 text-xs text-amber-950">
            <span className="font-semibold">⏸ On hold by Dispatch · {order.dispatch_hold.by}:</span> {order.dispatch_hold.reason}
            <span className="block mt-0.5 text-amber-900/80">
              Dispatch is still preparing it. Fix what they asked (items are changed in Zoho once the order is synced), and they
              lift the hold.
            </span>
          </div>
        )}
        {/* Sep 26, 2026: Pharmacy rejected the prescription. Answered to Pharmacy, on its own:
            Finance's hold (above) has its own "Re-submit to Finance", and neither touches the other. */}
        {order.rx?.state === 'rejected' &&
          (isManagementUser || order.medrep_id === user?.id || order.raised_by_id === user?.id) && (
          <div className="mt-3 bg-red-50 border border-red-200 rounded p-3 text-xs text-red-950 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p>
                <span className="font-semibold">💊 Pharmacy rejected the prescription:</span> {order.rx.rejection?.reason || 'No reason given.'}
              </p>
              {order.rx.can_resubmit && (
                <button
                  type="button"
                  onClick={() => setRxResubmitOpen(true)}
                  className="shrink-0 px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark"
                >
                  ↩ Re-submit prescription to Pharmacy
                </button>
              )}
            </div>
            <p className="text-red-900/80">
              Upload a replacement or explain what changed. This goes to Pharmacy only; it does not change anything with Finance.
            </p>
          </div>
        )}
        {rxResubmitOpen && (
          <ResubmitPrescriptionModal
            order={order}
            onClose={() => setRxResubmitOpen(false)}
            onSubmit={(body) => rxResubmitMutation.mutate(body)}
            saving={rxResubmitMutation.isPending}
          />
        )}
        {resumeOpen && (
          <ResumeOrderModal
            order={order}
            onClose={() => setResumeOpen(false)}
            onSubmit={(body) => resumeMutation.mutate(body)}
            saving={resumeMutation.isPending}
          />
        )}
        {resubmitOpen && (
          <ResubmitHoldModal
            order={order}
            onClose={() => setResubmitOpen(false)}
            onSubmit={(body) => resubmitMutation.mutate(body)}
            saving={resubmitMutation.isPending}
          />
        )}
      </div>

      {/* Tabs */}
      <div className="bg-white shadow rounded-lg overflow-hidden">
        <div className="border-b border-slate-200 flex">
          {tabs.map(tab => {
            const Icon = tab.icon;
            return (
              <button key={tab.id} onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors ${activeTab === tab.id ? 'border-getmeds-blue text-getmeds-blue font-semibold' : 'border-transparent text-ink-secondary hover:text-ink-primary'}`}
              >
                <Icon className="w-4 h-4" />{tab.label}
              </button>
            );
          })}
        </div>

        <div className="p-6">
          {/* Items Tab */}
          {activeTab === 'items' && (
            <div>
              {!isEditingItems && (
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs text-ink-secondary">
                    {/* Sep 14, 2026: says where to go, not just "no". Edits made in
                        Zoho are copied into these items and the total
                        automatically (zohoLineSyncService).
                        Sep 19, 2026: Management gets "Edit Items" here too now
                        (below) instead of being sent to Zoho — the edit is
                        pushed there for them. */}
                    {order.zoho_so_id
                      ? isManagementUser
                        ? `This order is in Zoho${soNumbers} — editing here also updates the real Sales Order.`
                        : `This order is in Zoho${soNumbers} — edit its items there. Changes made in Zoho are copied here automatically; use Sync from Zoho to pull them now.`
                      : ''}
                  </p>
                  {(!order.zoho_so_id || isManagementUser) && !['completed', 'cancelled', 'deleted'].includes(order.status) && (
                    <button
                      type="button"
                      onClick={() => startEditingItems(items)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold border border-getmeds-blue/40 text-getmeds-blue-dark rounded hover:bg-getmeds-blue/10"
                      title={order.zoho_so_id ? 'This order is already in Zoho — the edit is pushed to the real Sales Order too' : "Fix a bad line item (e.g. a product that's since gone inactive in Zoho) before this order syncs"}
                    >
                      <Pencil className="w-3.5 h-3.5" /> Edit Items
                    </button>
                  )}
                </div>
              )}

              {!isEditingItems ? (
                <>
                  {/* Sep 22, 2026: split-invoicing orders — the total below
                      spans every Sales Order this order has (see
                      zohoLineSyncService.js), so a split order gets a
                      per-entity breakdown alongside it instead of one number
                      that quietly blends two different Zoho invoices. */}
                  {splits.length > 0 && (
                    <div className="mb-3 rounded-md border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-xs text-indigo-900">
                      Split order — items below are billed across {splits.length + 1} Zoho Sales Orders. See the breakdown under the total.
                    </div>
                  )}
                  <table className="min-w-full">
                    <thead>
                      <tr className="text-left text-xs font-medium text-ink-secondary uppercase border-b border-slate-200">
                        <th className="pb-3">Product</th>
                        <th className="pb-3 text-center">Qty</th>
                        <th className="pb-3 text-right">Unit Price</th>
                        <th className="pb-3 text-right">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {items.map(item => (
                        <tr key={item.id}>
                          <td className="py-3">
                            <p className="text-sm font-semibold text-ink-primary">{item.product_name}</p>
                            <p className="text-xs text-ink-secondary">SKU: {item.sku} · Unit: {item.unit}</p>
                            {item.invoicing_from && item.invoicing_from !== order.invoicing_from && (
                              <p className="text-xs font-semibold text-indigo-700 mt-0.5">↳ {item.invoicing_from}</p>
                            )}
                            {item.price_remark && (
                              <p className="text-xs text-ink-secondary italic mt-0.5">💬 {item.price_remark}</p>
                            )}
                          </td>
                          <td className="py-3 text-center text-sm text-ink-primary">{item.quantity}</td>
                          <td className="py-3 text-right text-sm text-ink-secondary">₱{(item.unit_price || 0).toFixed(2)}</td>
                          <td className="py-3 text-right text-sm font-semibold text-ink-primary">₱{(item.subtotal || 0).toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="border-t-2 border-slate-200">
                      {splits.length > 0 && (() => {
                        const byEntity = new Map();
                        items.forEach((it) => {
                          const entity = it.invoicing_from || order.invoicing_from;
                          byEntity.set(entity, (byEntity.get(entity) || 0) + Number(it.subtotal || 0));
                        });
                        return (
                          <tr>
                            <td colSpan="3" className="pt-2 pb-1 text-right">
                              <div className="flex flex-wrap justify-end gap-x-4 gap-y-0.5 text-xs text-ink-secondary">
                                {Array.from(byEntity.entries()).map(([entity, sum]) => (
                                  <span key={entity}>
                                    {entity}: <span className="font-semibold text-ink-primary">₱{sum.toLocaleString('en-PH', { minimumFractionDigits: 2 })}</span>
                                  </span>
                                ))}
                              </div>
                            </td>
                            <td />
                          </tr>
                        );
                      })()}
                      <tr>
                        <td colSpan="3" className="pt-3 text-sm font-semibold text-ink-primary text-right">Total Amount</td>
                        <td className="pt-3 text-right text-lg font-bold text-getmeds-blue">₱{(order.total_amount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}</td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              ) : (
                /* Sep 14, 2026: the same table as raising an order. */
                <OrderItemsEditor
                  rows={draftItems}
                  products={products}
                  inclusive={order.is_inclusive_tax == null ? true : Boolean(Number(order.is_inclusive_tax))}
                  canEditPrice={isManagementUser}
                  activeProductIds={activeProductIds}
                  onChange={changeDraftField}
                  onBlurField={blurDraftField}
                  onRemove={removeDraftRow}
                  onAdd={addDraftProduct}
                  onCancel={() => setIsEditingItems(false)}
                  onSave={saveDraftItems}
                  saving={updateItemsMutation.isPending}
                  alreadySynced={Boolean(order.zoho_so_id)}
                  orderInvoicingFrom={order.invoicing_from}
                />
              )}
            </div>
          )}

          {/* Payment Tab */}
          {activeTab === 'payment' && (
            <div>
              {!payment ? (
                <div className="text-center py-8 text-ink-secondary">
                  <CreditCard className="w-10 h-10 mx-auto mb-2 text-ink-secondary/50" />
                  <p className="text-sm">{order.customer_type === 'credit' ? 'Credit customer — no payment verification required.' : 'No payment record yet.'}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    ['Status', <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${payment.status === 'verified' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark border border-pharmacy-green/30' : payment.status === 'rejected' ? 'bg-state-error-light text-red-700 border border-state-error/30' : 'bg-state-warning-light text-amber-950 border border-state-warning/30'}`}>{payment.status}</span>],
                    ['Reference', payment.payment_reference || '—'],
                    ['Amount', payment.amount ? `₱${payment.amount.toLocaleString('en-PH', { minimumFractionDigits: 2 })}` : '—'],
                    ['Method', payment.payment_method || '—'],
                    ['Payment Date', payment.payment_date || '—'],
                    ['Verified By', payment.verified_by_name || '—'],
                    ['Verified At', payment.verified_at ? formatPHT(payment.verified_at) : '—'],
                    ['Notes', payment.notes || '—'],
                  ].map(([label, val]) => (
                    <div key={label} className="bg-surface rounded p-3 border border-slate-100">
                      <p className="text-xs font-medium text-ink-secondary uppercase mb-1">{label}</p>
                      <div className="text-sm text-ink-primary font-medium">{val}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Dispatch Tab */}
          {activeTab === 'dispatch' && (
            <div>
              {!dispatch ? (
                <div className="text-center py-8 text-ink-secondary">
                  <Truck className="w-10 h-10 mx-auto mb-2 text-ink-secondary/50" />
                  <p className="text-sm">No dispatch record yet.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {[
                    ['Dispatch Status', <span className={`px-2.5 py-0.5 rounded-full text-xs font-semibold capitalize ${dispatch.status === 'dispatched' ? 'bg-getmeds-blue/15 text-getmeds-blue-dark border border-getmeds-blue/40' : 'bg-indigo-100 text-indigo-700'}`}>{dispatch.status}</span>],
                    ['Courier', dispatch.courier || order.entered_tracking?.courier || '—'],
                    // Zoho's number first; else the one Dispatch typed in.
                    // Sep 15, 2026: a link opens, and wraps rather than running
                    // past the edge of the box (it read as cut off).
                    ['Tracking Number', (dispatch.tracking_number || order.entered_tracking?.tracking_number)
                      ? <span className="font-bold text-getmeds-blue break-all"><TrackingValue value={dispatch.tracking_number || order.entered_tracking.tracking_number} /></span>
                      : '—'],
                    ['Dispatched At', dispatch.dispatched_at ? formatPHT(dispatch.dispatched_at) : '—'],
                    ['Notes', dispatch.dispatch_notes || '—'],
                  ].map(([label, val]) => (
                    <div key={label} className="bg-surface rounded p-3 border border-slate-100">
                      <p className="text-xs font-medium text-ink-secondary uppercase mb-1">{label}</p>
                      <div className="text-sm text-ink-primary font-medium">{val}</div>
                    </div>
                  ))}
                </div>
              )}

              {/* Sep 15, 2026: the tracking number Dispatch typed in, and adding
                  or updating it. Not over a number Zoho's shipment carries —
                  that one is changed in Zoho. */}
              {(() => {
                const canEditTracking =
                  ['dispatch', 'management', 'admin'].includes(user?.role) &&
                  TRACKING_EDITABLE_STATUSES.includes(order.status) &&
                  !dispatch?.tracking_number;
                const entered = order.entered_tracking;
                if (!entered && !canEditTracking) return null;
                return (
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-md border border-teal-200 bg-teal-50/60 px-3 py-2.5">
                    <div className="text-sm text-ink-primary">
                      {entered ? (
                        <>
                          Tracking added by Dispatch: <span className="font-semibold">{entered.courier}</span> ·{' '}
                          <span className="font-bold text-getmeds-blue"><TrackingValue value={entered.tracking_number} /></span>
                          <span className="text-xs text-ink-secondary"> ({entered.by}, {formatPHT(entered.at)})</span>
                        </>
                      ) : (
                        <span className="text-ink-secondary">No tracking number yet.</span>
                      )}
                    </div>
                    {canEditTracking && (
                      <button
                        type="button"
                        onClick={() => setTrackingOpen(true)}
                        className="px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark"
                      >
                        {entered ? 'Update tracking number' : 'Add tracking number'}
                      </button>
                    )}
                  </div>
                );
              })()}
              {trackingOpen && (
                <DeliveryConfirmModal
                  order={{ ...order, courier: dispatch?.courier }}
                  mode="tracking"
                  onClose={() => setTrackingOpen(false)}
                  onSubmit={({ tracking }) => trackingMutation.mutate(tracking)}
                  saving={trackingMutation.isPending}
                />
              )}

              {!['completed', 'cancelled'].includes(order.status) && (
                <div className="mt-4 flex items-start gap-2 rounded-md border border-slate-200 bg-surface px-3 py-2 text-xs text-ink-secondary">
                  <RefreshCw className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <p>Picking, packing and shipment status come from Zoho, not from this app — create the Package
                    (picking &amp; packing) and Shipment (courier + tracking) in Zoho Inventory and this record
                    updates automatically.</p>
                </div>
              )}
            </div>
          )}

          {/* Attachments Tab (formerly "Proof of Payment" — id kept as 'proof') */}
          {activeTab === 'proof' && <PaymentProofPanel orderId={id} order={order} />}

          {/* Timeline Tab */}
          {activeTab === 'timeline' && (
            <div>
              {/* Sep 21, 2026: every remark a MedRep or Management left on
                  this order's trail — a resubmit note, a hold/reject reason,
                  a "what to fix" — pulled out of the pipeline's per-stage
                  collapsed updates so Finance (or anyone) can check them at
                  a glance, whatever stage the order is at now. See
                  REMARK_EVENT_TYPES above. */}
              {(() => {
                const remarks = events.filter((e) => REMARK_EVENT_TYPES.has(e.event_type) && e.notes);
                if (!remarks.length) return null;
                return (
                  <div className="mb-5 bg-indigo-50/60 border border-indigo-200 rounded-lg p-3">
                    <p className="text-xs font-semibold text-indigo-900 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                      <MessageSquare className="w-3.5 h-3.5" />
                      Remarks from MedRep / Management
                      <span className="font-normal normal-case text-indigo-700">
                        ({remarks.length})
                      </span>
                    </p>
                    <div className="space-y-2.5">
                      {remarks.map((r) => (
                        <div key={r.id} className="text-xs">
                          <div className="flex items-baseline justify-between gap-3">
                            <p className="font-semibold text-ink-primary flex items-center flex-wrap">
                              {r.actor_name || 'System'}
                              <RoleBadge role={r.actor_role} />
                            </p>
                            <p className="text-ink-secondary shrink-0">
                              {r.created_at ? formatPHT(r.created_at, 'timeline') : ''}
                            </p>
                          </div>
                          <p className="text-ink-secondary mt-0.5">{r.notes}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

              {/* Sep 10, 2026 (2d): the pipeline replaces a flat list that gave
                  every event equal weight — this order once rendered 20 rows
                  for six real things. The raw list is still one click away, so
                  nothing is hidden, it is just no longer the default. */}
              <OrderPipeline timeline={timeline} focusEntity={timelineFocus} onClearFocus={() => setTimelineFocus(null)} />

              {/* Sep 24, 2026: the flat log that used to sit here in full, duplicating
                  the timeline above, is now one small button — see
                  RawEventLogModal for why it isn't simply deleted. */}
              {events.length > 0 && (
                <div className="mt-6 flex justify-end border-t border-slate-100 pt-3">
                  <button
                    type="button"
                    onClick={() => setRawLogOpen(true)}
                    className="text-xs font-semibold text-ink-secondary hover:text-ink-primary underline-offset-2 hover:underline"
                  >
                    View raw log ({events.length})
                  </button>
                </div>
              )}
              <RawEventLogModal
                isOpen={rawLogOpen}
                onClose={() => setRawLogOpen(false)}
                events={events}
                order={order}
                titleFor={(event) => eventTitle(event, order)}
                iconFor={(event) => EVENT_ICONS[event.event_type] || '📋'}
                roleLabel={roleLabel}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OrderDetailPage;
