import React, { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X, FileText, ExternalLink, Paperclip, AlertTriangle, Loader2, ShieldCheck, XCircle, Download, ChevronDown, ZoomIn, ZoomOut, RotateCcw, Pill } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { formatPHT } from '../../utils/dateUtils';
import { attachmentLabel, HOSPITAL_REQUIRED_TYPES } from '../../constants/attachmentTypes';

/**
 * Sep 28, 2026: the little status line under a file's name — a proof of
 * payment already had one; a prescription now gets the same treatment,
 * because a resubmitted one sitting next to the old rejected copy with
 * identical "PRESCRIPTION" labels and no status was exactly what made it
 * unclear to Pharmacy which one to review. `superseded` (from the same rule
 * rxSummaries uses server-side, prescriptionService.js's supersededIds) wins
 * over the row's own `status` — an old rejection that has since been replaced
 * reads as "Replaced", not as an open rejection nobody is going to act on.
 */
const attachmentStatusBadge = (a) => {
  if (a.file_type === 'prescription') {
    if (a.superseded) {
      return { label: `Replaced${a.rejection_reason ? ` — was: ${a.rejection_reason}` : ''}`, tone: 'muted' };
    }
    if (a.status === 'verified') return { label: 'Verified', tone: 'good' };
    if (a.status === 'rejected') return { label: `Rejected${a.rejection_reason ? ` — ${a.rejection_reason}` : ''}`, tone: 'bad' };
    return { label: 'New — awaiting review', tone: 'warn' };
  }
  if (a.file_type === 'payment_proof' && a.status) {
    if (a.status === 'verified') return { label: 'Verified', tone: 'good' };
    if (a.status === 'rejected') return { label: `Rejected${a.rejection_reason ? ` — ${a.rejection_reason}` : ''}`, tone: 'bad' };
    return { label: 'Awaiting your check', tone: 'warn' };
  }
  return null;
};
const BADGE_TONE = {
  good: 'text-pharmacy-green-dark',
  bad: 'text-red-700',
  warn: 'text-amber-900',
  muted: 'text-ink-secondary'
};

/**
 * One attachment card in the grid. `dim` (a superseded prescription) mutes
 * the whole tile — still openable, but visibly not the one to act on.
 */
// Sep 28, 2026: which of the "wrong category" mistakes this one-click fix
// covers — a prescription a MedRep uploaded under one of these three by
// mistake. Never 'other', 'purchase_order', or the Dispatch-only
// 'dispatch_proof' — see paymentProof.controller.js's retag for why.
const RETAG_CANDIDATE_TYPES = ['payment_proof', 'id', 'gl'];

const AttachmentTile = ({ a, dim = false, onPreview, onRetag, retagging = false }) => {
  const isImage = String(a.content_type || '').startsWith('image/');
  const badge = attachmentStatusBadge(a);
  const { user } = useAuth();
  const role = String(user?.role || '').toLowerCase();
  const canRetag = onRetag && ['dispatch', 'admin'].includes(role) && RETAG_CANDIDATE_TYPES.includes(a.file_type);
  // Sep 28, 2026: an image opens the in-app lightbox (below) instead of a new
  // tab — Pharmacy and Finance can now inspect a prescription or a receipt
  // without leaving this screen. A PDF or scanned document has no image to
  // zoom into, so it keeps opening in its own tab, same as before.
  const Wrapper = isImage ? 'button' : 'a';
  const wrapperProps = isImage
    ? { type: 'button', onClick: () => onPreview(a) }
    : { href: a.viewUrl, target: '_blank', rel: 'noopener noreferrer' };
  return (
    <div
      className={`relative block bg-white border rounded-lg overflow-hidden transition-colors ${
        dim ? 'border-slate-200 opacity-60' : 'border-slate-200 hover:border-getmeds-blue'
      }`}
    >
      {/* Sep 19, 2026: "add download feature for all users to download
          attachments" — same signed object, minted with
          Content-Disposition: attachment so this saves the file instead of
          opening the view tab the rest of the card still opens. A sibling of
          the view link below, not nested inside it — an <a> inside an <a>
          is invalid HTML and browsers handle it inconsistently. */}
      {a.downloadUrl && (
        <a
          href={a.downloadUrl}
          title={`Download ${a.file_name || 'file'}`}
          className="absolute top-1.5 right-1.5 z-10 p-1.5 rounded-md bg-white/90 border border-slate-200 text-ink-secondary hover:text-getmeds-blue hover:border-getmeds-blue shadow-sm"
        >
          <Download className="w-3.5 h-3.5" />
        </a>
      )}
      <Wrapper {...wrapperProps} className="block w-full text-left">
        {/* Images preview inline; a PDF or scanned document gets an honest
            placeholder rather than a broken <img> that reads as a failed
            upload. */}
        {isImage ? (
          <img
            // Sep 23, 2026 (Priority 2): a 128px-tall grid cell was loading
            // the full original (up to several MB) every time — this asks
            // viewAttachment for a resized rendition instead (Supabase Image
            // Transformations, verified enabled on this project). The
            // lightbox this opens loads the full-size a.viewUrl.
            src={`${a.viewUrl}&w=300&h=300`}
            alt={a.file_name}
            className="w-full h-32 object-cover bg-slate-50"
            loading="lazy"
          />
        ) : (
          <div className="w-full h-32 flex items-center justify-center bg-slate-50">
            <FileText className="w-8 h-8 text-ink-secondary" />
          </div>
        )}
      </Wrapper>
      <div className="px-2.5 py-2">
        <p className="text-[11px] font-bold uppercase tracking-wide text-getmeds-blue-dark">
          {attachmentLabel(a.file_type)}
        </p>
        <p className="text-[12px] text-ink-primary truncate" title={a.file_name}>
          {a.file_name}
        </p>
        <p className="text-[11px] text-ink-secondary mt-0.5">
          {a.uploaded_by_name || 'Unknown'}
          {a.uploaded_at ? ` · ${formatPHT(a.uploaded_at)}` : ''}
        </p>
        {/* Sep 28, 2026: proof of payment and prescription both carry a
            Finance/Pharmacy decision now; every other type is evidence, not
            something to approve, and shows nothing here. */}
        {badge && <p className={`text-[11px] mt-1 font-semibold ${BADGE_TONE[badge.tone]}`}>{badge.label}</p>}
        {/* Sep 28, 2026: "this is actually the prescription" — a MedRep
            mis-tagged it under Proof of Payment or Valid ID, so the file Pharmacy
            needs is sitting right here, just mislabeled. One click re-tags it in
            place instead of asking for a fresh upload (paymentProof.controller.js's
            retag). Dispatch (Pharmacy) and Admin only. */}
        {canRetag && (
          <button
            type="button"
            disabled={retagging}
            onClick={(e) => { e.stopPropagation(); onRetag(a); }}
            title="This is actually the prescription"
            className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-semibold text-getmeds-blue hover:underline disabled:opacity-50"
          >
            <Pill className="w-3 h-3" /> {retagging ? 'Re-tagging…' : 'Mark as Prescription'}
          </button>
        )}
      </div>
    </div>
  );
};

const ZOOM_MIN = 1;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.5;

/**
 * Sep 28, 2026: an image attachment opens here instead of a new browser tab —
 * a prescription or a receipt, inspected right on top of the current screen.
 * Zoom in/out (buttons, the scroll wheel, or double-click) and drag to pan
 * once zoomed; Escape, the backdrop, or the X closes it. The download button
 * on the thumbnail behind this is untouched — this is only the click-through.
 *
 * Sep 28, 2026 (2): a bounded card, not an edge-to-edge black takeover — the
 * whole point of opening this from the Order Details modal is comparing the
 * image against what is still visible behind it (the items table, the
 * order id), which a full-screen overlay hid completely.
 */
const Lightbox = ({ attachment, onClose }) => {
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(null); // { startX, startY, origX, origY } | null

  // A fresh image starts un-zoomed and centred, whichever attachment opened.
  useEffect(() => {
    setZoom(1);
    setPos({ x: 0, y: 0 });
  }, [attachment?.id]);

  useEffect(() => {
    if (!attachment) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [attachment, onClose]);

  if (!attachment) return null;

  const clampZoom = (z) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  const zoomIn = () => setZoom((z) => clampZoom(z + ZOOM_STEP));
  const zoomOut = () =>
    setZoom((z) => {
      const next = clampZoom(z - ZOOM_STEP);
      if (next === ZOOM_MIN) setPos({ x: 0, y: 0 }); // back to 1x: re-centre
      return next;
    });
  const reset = () => { setZoom(1); setPos({ x: 0, y: 0 }); };

  const onWheel = (e) => {
    e.preventDefault();
    setZoom((z) => clampZoom(z + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP)));
  };
  const onMouseDown = (e) => {
    if (zoom <= 1) return;
    setDragging({ startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y });
  };
  const onMouseMove = (e) => {
    if (!dragging) return;
    setPos({ x: dragging.origX + (e.clientX - dragging.startX), y: dragging.origY + (e.clientY - dragging.startY) });
  };
  const stopDrag = () => setDragging(null);

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4"
      onClick={onClose}
      onMouseMove={onMouseMove}
      onMouseUp={stopDrag}
      onMouseLeave={stopDrag}
    >
      {/* The backdrop closes; the card must not, or every click on the toolbar
          (or the image itself) would dismiss the thing being inspected. */}
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-200 bg-surface shrink-0">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink-primary truncate">{attachment.file_name}</p>
            <p className="text-xs text-ink-secondary">{attachmentLabel(attachment.file_type)}</p>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button type="button" onClick={zoomOut} disabled={zoom <= ZOOM_MIN} title="Zoom out" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary disabled:opacity-40">
              <ZoomOut className="w-4 h-4" />
            </button>
            <span className="text-xs tabular-nums w-10 text-center text-ink-secondary">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={zoomIn} disabled={zoom >= ZOOM_MAX} title="Zoom in" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary disabled:opacity-40">
              <ZoomIn className="w-4 h-4" />
            </button>
            <button type="button" onClick={reset} disabled={zoom === 1 && !pos.x && !pos.y} title="Reset" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary disabled:opacity-40">
              <RotateCcw className="w-4 h-4" />
            </button>
            {attachment.downloadUrl && (
              <a href={attachment.downloadUrl} title="Download" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary">
                <Download className="w-4 h-4" />
              </a>
            )}
            <span className="w-px h-5 bg-slate-200 mx-0.5" aria-hidden="true" />
            <button type="button" onClick={onClose} title="Close" className="p-1.5 rounded-md text-ink-secondary hover:bg-slate-100 hover:text-ink-primary">
              <X className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-hidden flex items-center justify-center bg-surface" onWheel={onWheel}>
          <img
            src={attachment.viewUrl}
            alt={attachment.file_name}
            onMouseDown={onMouseDown}
            onDoubleClick={() => (zoom > 1 ? reset() : zoomIn())}
            draggable={false}
            style={{
              transform: `translate(${pos.x}px, ${pos.y}px) scale(${zoom})`,
              cursor: zoom > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
              transition: dragging ? 'none' : 'transform 0.15s ease-out'
            }}
            className="max-w-full max-h-[70vh] object-contain select-none"
          />
        </div>
      </div>
    </div>
  );
};

// Sep 22, 2026: split-invoicing orders — a line item tagged to the other
// entity creates a second Zoho Sales Order (order_split_sales_orders), which
// Finance must verify independently of the primary (two entities, two bank
// accounts — see orderSplitService.js). This panel is the one place that
// already loads the order's full detail (including `splits`), so the second
// Verify action lives here rather than duplicating the fetch elsewhere.
const SplitVerifyRow = ({ orderId, split, canAct }) => {
  const qc = useQueryClient();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: ({ approved, reason: r }) =>
      client
        .post(`/api/finance/orders/${orderId}/splits/${split.id}/verify`, { approved, reason: r })
        .then((res) => res.data),
    onSuccess: (res) => {
      const zohoConfirm = res?.data?.zohoConfirmed;
      if (res?.data?.approved && zohoConfirm && zohoConfirm.ok === false) {
        toast.error(
          `${split.invoicing_from} verified — but its Sales Order is not confirmed in Zoho yet (${zohoConfirm.error || 'Zoho did not answer'}).`,
          { duration: 9000 }
        );
      } else if (res?.data?.approved) {
        const awaiting = res?.data?.awaitingOtherEntities || [];
        toast.success(
          awaiting.length
            ? `${split.invoicing_from} verified — still awaiting ${awaiting.join(', ')}.`
            : `${split.invoicing_from} verified — every entity is now cleared to invoice.`
        );
      } else {
        toast.success(`${split.invoicing_from} put on hold — the whole order is held.`);
      }
      setRejecting(false);
      setReason('');
      qc.invalidateQueries({ queryKey: ['finance-order-detail', orderId] });
      qc.invalidateQueries({ queryKey: ['finance-queue'] });
      qc.invalidateQueries({ queryKey: ['order', String(orderId)] });
    },
    onError: (err) =>
      toast.error(err.response?.data?.error?.message || 'Could not record that'),
  });

  const isPending = split.payment_status === 'pending';
  const statusColor =
    split.payment_status === 'verified'
      ? 'text-pharmacy-green-dark'
      : split.payment_status === 'rejected'
        ? 'text-red-700'
        : 'text-amber-900';

  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink-primary">{split.invoicing_from}</p>
        <span className={`text-[11px] font-semibold capitalize ${statusColor}`}>{split.payment_status}</span>
      </div>
      <dl className="text-[12px] text-ink-secondary space-y-0.5">
        <div className="flex gap-2">
          <dt className="w-24 shrink-0">Zoho SO</dt>
          <dd className="text-ink-primary">{split.zoho_so_number || (split.zoho_sync_error ? `Not synced — ${split.zoho_sync_error}` : '—')}</dd>
        </div>
        {split.zoho_invoice_number && (
          <div className="flex gap-2">
            <dt className="w-24 shrink-0">Zoho invoice</dt>
            <dd className="text-ink-primary">{split.zoho_invoice_number}</dd>
          </div>
        )}
      </dl>
      {isPending && !canAct && (
        <p className="text-[11px] text-ink-secondary pt-1">Awaiting Finance's verification of this entity.</p>
      )}
      {isPending && canAct && (
        rejecting ? (
          <div className="space-y-1.5 pt-1">
            <textarea
              autoFocus
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this entity's payment being held?"
              className="w-full text-xs rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            <div className="flex gap-2">
              <button
                disabled={!reason.trim() || mutation.isPending}
                onClick={() => mutation.mutate({ approved: false, reason: reason.trim() })}
                className="px-2.5 py-1 rounded-md bg-state-error text-white text-[11px] font-semibold disabled:opacity-50"
              >
                {mutation.isPending ? 'Holding…' : 'Put on hold'}
              </button>
              <button
                onClick={() => { setRejecting(false); setReason(''); }}
                className="px-2.5 py-1 rounded-md border border-slate-300 bg-white text-[11px] text-ink-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2 pt-1">
            <button
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ approved: true })}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-pharmacy-green text-white text-[11px] font-semibold hover:opacity-90 disabled:opacity-50"
            >
              <ShieldCheck className="w-3 h-3" /> {mutation.isPending ? 'Verifying…' : 'Verify'}
            </button>
            <button
              disabled={mutation.isPending}
              onClick={() => setRejecting(true)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-state-error/40 text-state-error text-[11px] font-semibold hover:bg-state-error-light disabled:opacity-50"
            >
              <XCircle className="w-3 h-3" /> Hold
            </button>
          </div>
        )
      )}
    </div>
  );
};

// Sep 22, 2026: the primary entity's own card in the "Split Sales Orders"
// section — same shape as SplitVerifyRow (status pill, Verify/Hold inline),
// but the primary's verify/reject already had a real implementation before
// splits existed (verifyAccount, driven by the `onConfirm`/`onReject` props
// the parent — FinanceQueuePage — passes in), so this reuses those instead
// of posting to a new endpoint. Previously this card was just a status
// readout pointing at a "Confirm account" button in the modal's shared
// footer; that made the primary the odd one out next to a split's fully
// self-contained card, and the footer had no Hold at all (only the queue
// row's own separate reject box did). Folding the workflowV2 price/proof
// checklist in here too, since that's the same judgement Verify always
// required — just moved next to the entity it's about.
const PrimaryVerifyCard = ({ order, onConfirm, onReject, confirming, confirmsSalesOrder, canAct, checks, setChecks, checksDone }) => {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const isPending = !order.primary_finance_verified_at;

  return (
    <div className="bg-white border border-slate-200 rounded-lg px-3 py-2.5 space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-semibold text-ink-primary">{order.invoicing_from} (primary)</p>
        <span className={`text-[11px] font-semibold ${isPending ? 'text-amber-900' : 'text-pharmacy-green-dark'}`}>
          {isPending ? 'pending' : 'verified'}
        </span>
      </div>
      {order.zoho_so_number && (
        <dl className="text-[12px] text-ink-secondary space-y-0.5">
          <div className="flex gap-2">
            <dt className="w-24 shrink-0">Zoho SO</dt>
            <dd className="text-ink-primary">{order.zoho_so_number}</dd>
          </div>
        </dl>
      )}
      {isPending && !canAct && (
        <p className="text-[11px] text-ink-secondary pt-1">Awaiting Finance's verification of this entity.</p>
      )}
      {isPending && canAct && (
        rejecting ? (
          <div className="space-y-1.5 pt-1">
            <textarea
              autoFocus
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this entity's payment being held?"
              className="w-full text-xs rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400"
            />
            <div className="flex gap-2">
              <button
                disabled={!reason.trim() || confirming}
                onClick={() => onReject(order.id, reason.trim())}
                className="px-2.5 py-1 rounded-md bg-state-error text-white text-[11px] font-semibold disabled:opacity-50"
              >
                {confirming ? 'Holding…' : 'Put on hold'}
              </button>
              <button
                onClick={() => { setRejecting(false); setReason(''); }}
                className="px-2.5 py-1 rounded-md border border-slate-300 bg-white text-[11px] text-ink-secondary"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5 pt-1">
            {confirmsSalesOrder && (
              <fieldset className="space-y-1">
                <label className="flex items-start gap-2 text-[11px] text-ink-primary">
                  <input
                    type="checkbox"
                    checked={checks.prices}
                    onChange={() => setChecks((c) => ({ ...c, prices: !c.prices }))}
                    className="mt-0.5"
                  />
                  I checked the prices on the Sales Order.
                </label>
                <label className="flex items-start gap-2 text-[11px] text-ink-primary">
                  <input
                    type="checkbox"
                    checked={checks.proof}
                    onChange={() => setChecks((c) => ({ ...c, proof: !c.proof }))}
                    className="mt-0.5"
                  />
                  I checked the proof of payment, or the reason there is none.
                </label>
              </fieldset>
            )}
            <div className="flex gap-2">
              <button
                disabled={confirming || (confirmsSalesOrder && !checksDone)}
                onClick={() => (confirmsSalesOrder ? onConfirm(order.id, checks) : onConfirm(order.id))}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-pharmacy-green text-white text-[11px] font-semibold hover:opacity-90 disabled:opacity-50"
              >
                <ShieldCheck className="w-3 h-3" /> {confirming ? 'Verifying…' : 'Verify'}
              </button>
              <button
                disabled={confirming}
                onClick={() => setRejecting(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-state-error/40 text-state-error text-[11px] font-semibold hover:bg-state-error-light disabled:opacity-50"
              >
                <XCircle className="w-3 h-3" /> Hold
              </button>
            </div>
          </div>
        )
      )}
    </div>
  );
};

/**
 * The whole order, for the person deciding whether to verify it.
 *
 * Sep 12, 2026. The Finance queue showed one document per row — the proof of
 * payment — because for a long time that was the only kind an order could
 * carry. It is now one of six, and a hospital (PAP/DSWD) order is required to
 * carry four: a Guarantee Letter, a Prescription, a Valid ID and the proof.
 *
 * So Finance was being asked to verify an account against paperwork they could
 * not see, and the row gave no hint the other files existed. Their only route
 * to them was the MedRep's order page, which is not a Finance screen.
 *
 * A modal rather than a link away to /orders/:id: verifying is a decision made
 * ON the queue, against the row. Sending someone to another page to read the
 * evidence loses their place in a list they are working down — they come back
 * to the top of it, or they do not come back.
 *
 * Two requests, deliberately:
 *   GET /orders/:id              the order and its items
 *   GET /orders/:id/attachments  every file, each with a freshly signed URL
 *
 * The second is the only endpoint that returns all types. /payment-proof,
 * which the queue row already uses, answers with just the latest proof — which
 * is precisely how the other five came to be invisible here.
 */

const peso = (n) =>
  `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const Row = ({ label, value }) =>
  value === null || value === undefined || value === '' ? null : (
    <div className="flex gap-2 text-[13px] py-1 border-b border-slate-100 last:border-0">
      <dt className="w-40 shrink-0 text-ink-secondary">{label}</dt>
      <dd className="min-w-0 flex-1 text-ink-primary break-words">{value}</dd>
    </div>
  );

const Section = ({ title, children }) => (
  <div>
    <h3 className="text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">{title}</h3>
    <dl className="bg-white border border-slate-200 rounded-lg px-3 py-1.5">{children}</dl>
  </div>
);

// Sep 15, 2026: `footer` — Dispatch opens this same panel as the order's
// receipt (what to prepare), and puts its own actions there instead of
// Finance's Confirm. Without `onConfirm` no Confirm button can appear anyway.
const OrderDetailsModal = ({ orderId, onClose, onConfirm, onReject, onOpenConfirm = null, confirming, workflowV2 = false, footer = null }) => {
  const detail = useQuery({
    queryKey: ['finance-order-detail', orderId],
    queryFn: () => client.get(`/api/orders/${orderId}`).then((r) => r.data),
    enabled: Boolean(orderId),
  });

  const files = useQuery({
    queryKey: ['finance-order-attachments', orderId],
    queryFn: () => client.get(`/api/orders/${orderId}/attachments`).then((r) => r.data),
    enabled: Boolean(orderId),
    // Sep 23, 2026: this is the surface Finance AND Dispatch both reopen
    // routinely for the same order (verify checklist, hold/reopen, "the
    // order's receipt" — see this component's own doc comment above) — no
    // staleTime meant every single reopen refetched and re-minted URLs.
    // The URLs are deterministic now (attachmentLinkService.js) so a
    // refetch alone was already harmless, but skipping the network call
    // entirely on a quick reopen is strictly better.
    staleTime: 5 * 60 * 1000,
  });

  const order = detail.data?.data?.order;
  const items = detail.data?.data?.items || [];
  const splits = detail.data?.data?.splits || [];
  const attachments = files.data?.data?.attachments || [];
  // Sep 28, 2026: a superseded prescription (an old rejection with a
  // resubmitted replacement already on file — see supersededIds in
  // prescriptionService.js) is history, not something Pharmacy still has to
  // act on. It stays out of the primary grid, behind a toggle, so the file
  // that's actually current doesn't sit next to it looking equally live.
  const visibleAttachments = attachments.filter((a) => !a.superseded);
  const supersededAttachments = attachments.filter((a) => a.superseded);
  const [showSuperseded, setShowSuperseded] = useState(false);
  const [lightbox, setLightbox] = useState(null);

  // Sep 28, 2026: "this is actually the prescription" — see AttachmentTile's
  // one-click button and paymentProof.controller.js's retag.
  const attachmentsQc = useQueryClient();
  const retagMutation = useMutation({
    mutationFn: (attachmentId) =>
      client.post(`/api/orders/${orderId}/attachments/${attachmentId}/retag`, { file_type: 'prescription' }).then((r) => r.data),
    onSuccess: () => {
      toast.success('Re-tagged as Prescription — Pharmacy will see it for review.');
      attachmentsQc.invalidateQueries({ queryKey: ['finance-order-attachments', orderId] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not re-tag that file.'),
  });

  // A hospital order is the one case where a missing document actually blocks
  // something downstream, so it is the only case worth calling out. Elsewhere
  // a missing file is a normal, allowed state — see paymentProof.controller.js
  // on why the proof is a soft gate.
  const isHospital = Boolean(order?.intake_hospital);
  const missing = isHospital
    ? HOSPITAL_REQUIRED_TYPES.filter((t) => !attachments.some((a) => a.file_type === t))
    : [];

  /**
   * Confirming is the ONE thing Finance can do to an order, and it is offered
   * only at the one status where it means anything. Read from the order this
   * panel fetched rather than from the row that opened it: the row may be
   * thirty seconds stale, and this is a write.
   */
  //
  // Sep 14, 2026 (GETMEDS_WORKFLOW_V2): with the switch on, confirming takes
  // the same two ticks the queue row asks for — prices and proof of payment —
  // because Dispatch invoices straight after it. They reset for each order.
  const canConfirm = Boolean(onConfirm) && order?.status === 'ready_for_finance_verified';
  const confirmsSalesOrder = canConfirm && workflowV2;
  const [checks, setChecks] = useState({ prices: false, proof: false });
  useEffect(() => { setChecks({ prices: false, proof: false }); }, [orderId]);
  const checksDone = checks.prices && checks.proof;

  const canHold = Boolean(onReject) && order?.status === 'ready_for_finance_verified';
  const [rejecting, setRejecting] = useState(false);
  const [holdReason, setHoldReason] = useState('');
  useEffect(() => { setRejecting(false); setHoldReason(''); }, [orderId]);

  return (
    <>
      <div
        className="fixed inset-0 z-50 bg-black/30"
        onClick={onClose}
      />
      <div
        className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl bg-surface shadow-2xl flex flex-col overflow-hidden"
      >
        <div className="px-5 py-3.5 border-b border-slate-200 bg-white flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h2 className="text-base font-bold text-ink-primary font-mono">
              {order?.getmeds_order_id || 'Loading…'}
            </h2>
            {order && (
              <p className="text-xs text-ink-secondary mt-0.5 truncate">
                {order.customer_name}
                {order.medrep_name ? ` · ${order.medrep_name}` : ''}
                {order.raised_by_name ? ` (raised by ${order.raised_by_name})` : ''}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={onClose} className="text-ink-secondary hover:text-ink-primary" title="Close">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto min-h-0">
        {detail.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-ink-secondary text-sm">
            <Loader2 className="w-4 h-4 animate-spin" /> Loading the order…
          </div>
        ) : detail.isError ? (
          <div className="px-5 py-12 text-center">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 text-state-error" />
            <p className="text-sm text-ink-primary">This order could not be loaded.</p>
            <p className="text-xs text-ink-secondary mt-1">
              {detail.error?.response?.data?.error?.message || detail.error?.message}
            </p>
          </div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            {missing.length > 0 && (
              <div className="flex items-start gap-2 rounded-lg border border-state-warning bg-state-warning-light px-3 py-2.5">
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-900" />
                <p className="text-[12px] text-amber-950">
                  <span className="font-semibold">
                    Hospital order missing {missing.length} requested document
                    {missing.length > 1 ? 's' : ''}:
                  </span>{' '}
                  {missing.map(attachmentLabel).join(', ')}. Worth chasing before verifying — these are
                  what the hospital reimburses against.
                </p>
              </div>
            )}

            <div className="grid md:grid-cols-2 gap-4">
              <Section title="Order">
                <Row label="Status" value={String(order.status || '').replace(/_/g, ' ')} />
                <Row label="Total" value={<span className="font-semibold">{peso(order.total_amount)}</span>} />
                <Row label="Customer type" value={order.customer_type} />
                <Row label="Sales order date" value={order.sales_order_date} />
                <Row label="Submitted" value={order.submitted_at ? formatPHT(order.submitted_at) : null} />
                <Row label="Division" value={order.division} />
                <Row label="Sub-division" value={order.sub_division} />
                <Row label="Headquarter" value={order.headquarter} />
                <Row label="Salesperson" value={order.salesperson} />
              </Section>

              <Section title="Payment & terms">
                <Row label="Mode of payment" value={order.intake_mop} />
                <Row label="Payment terms" value={order.intake_payment_terms} />
                <Row label="Terms" value={order.intake_terms} />
                <Row label="Invoicing from" value={order.invoicing_from} />
                <Row label="TIN" value={order.intake_tin} />
                <Row label="Zoho SO" value={order.zoho_so_number} />
                <Row label="Zoho invoice" value={order.zoho_invoice_number} />
                {/* The two fields that explain an order with no proof at all. */}
                <Row label="No-proof reason" value={order.no_payment_proof_reason} />
                <Row label="No-proof note" value={order.no_payment_proof_note} />
              </Section>

              <Section title="Delivery">
                <Row label="Address" value={order.delivery_address} />
                <Row label="Notes" value={order.delivery_notes} />
                <Row label="Method" value={order.intake_delivery_method} />
                <Row label="Courier" value={order.intake_courier} />
                <Row label="Expected shipment" value={order.intake_expected_shipment_date} />
                <Row label="Receiver" value={order.intake_receiver} />
                <Row label="Receiver type" value={order.intake_receiver_type} />
                <Row label="Contact no." value={order.intake_contact_no || order.contact_number} />
              </Section>

              <Section title="Patient & hospital">
                <Row label="Hospital" value={order.intake_hospital} />
                <Row label="Patient" value={order.intake_patient} />
                <Row label="Doctor" value={order.intake_doctor} />
                <Row label="GL number" value={order.intake_gl_number} />
                <Row label="Source" value={order.intake_source} />
                <Row label="Pls give" value={order.intake_pls_give} />
              </Section>
            </div>

            {splits.length > 0 && (
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">
                  Split Sales Orders — verify each entity independently
                </h3>
                <div className="grid sm:grid-cols-2 gap-2.5">
                  <PrimaryVerifyCard
                    order={order}
                    onConfirm={onConfirm}
                    onReject={onReject}
                    confirming={confirming}
                    confirmsSalesOrder={confirmsSalesOrder}
                    canAct={canConfirm}
                    checks={checks}
                    setChecks={setChecks}
                    checksDone={checksDone}
                  />
                  {splits.map((s) => (
                    <SplitVerifyRow key={s.id} orderId={order.id} split={s} canAct={canConfirm} />
                  ))}
                </div>
              </div>
            )}

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">
                Items ({items.length})
              </h3>
              <div className="bg-white border border-slate-200 rounded-lg overflow-x-auto">
                <table className="min-w-full text-[13px]">
                  <thead className="bg-surface">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium text-ink-secondary">Product</th>
                      <th className="px-3 py-2 text-right font-medium text-ink-secondary">Qty</th>
                      <th className="px-3 py-2 text-right font-medium text-ink-secondary">Unit</th>
                      <th className="px-3 py-2 text-right font-medium text-ink-secondary">Disc.</th>
                      <th className="px-3 py-2 text-right font-medium text-ink-secondary">Line total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {items.map((it) => (
                      <tr key={it.id}>
                        <td className="px-3 py-2 text-ink-primary">
                          {it.product_name}
                          {it.sku && <span className="block text-[11px] text-ink-secondary">{it.sku}</span>}
                          {it.price_remark && (
                            <span className="block text-[11px] text-ink-secondary italic mt-0.5">💬 {it.price_remark}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-ink-primary">{it.quantity}</td>
                        <td className="px-3 py-2 text-right text-ink-primary">{peso(it.unit_price)}</td>
                        <td className="px-3 py-2 text-right text-ink-secondary">
                          {Number(it.discount_amount) ? peso(it.discount_amount) : '—'}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-ink-primary">
                          {peso(it.line_total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot className="bg-surface">
                    <tr>
                      <td colSpan={4} className="px-3 py-2 text-right font-medium text-ink-secondary">
                        Grand total
                      </td>
                      <td className="px-3 py-2 text-right font-bold text-ink-primary">
                        {peso(order.total_amount)}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            <div>
              <h3 className="text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">
                Attachments ({attachments.length})
              </h3>

              {files.isLoading ? (
                <div className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-4 text-[13px] text-ink-secondary">
                  <Loader2 className="w-4 h-4 animate-spin" /> Loading files…
                </div>
              ) : files.isError ? (
                <div className="bg-white border border-state-error/40 rounded-lg px-3 py-4 text-[13px] text-ink-primary">
                  The files on this order could not be loaded. The order details above are still accurate.
                </div>
              ) : attachments.length === 0 ? (
                <div className="bg-white border border-slate-200 rounded-lg px-3 py-4 text-[13px] text-ink-secondary">
                  No files on this order.
                </div>
              ) : (
                <>
                  <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {visibleAttachments.map((a) => (
                      <AttachmentTile
                        key={a.id}
                        a={a}
                        onPreview={setLightbox}
                        onRetag={(row) => retagMutation.mutate(row.id)}
                        retagging={retagMutation.isPending && retagMutation.variables === a.id}
                      />
                    ))}
                  </div>

                  {/* Sep 28, 2026: superseded prescriptions — folded away by
                      default rather than sitting in the grid above looking as
                      current as the file that replaced them. */}
                  {supersededAttachments.length > 0 && (
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => setShowSuperseded((v) => !v)}
                        className="flex items-center gap-1.5 text-[12px] font-semibold text-ink-secondary hover:text-ink-primary"
                      >
                        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSuperseded ? 'rotate-180' : ''}`} />
                        {showSuperseded ? 'Hide' : 'Show'} {supersededAttachments.length} previous / replaced attachment
                        {supersededAttachments.length === 1 ? '' : 's'}
                      </button>
                      {showSuperseded && (
                        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3 mt-2">
                          {supersededAttachments.map((a) => <AttachmentTile key={a.id} a={a} dim onPreview={setLightbox} />)}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              <p className="flex items-center gap-1.5 text-[11px] text-ink-secondary mt-2">
                <Paperclip className="w-3 h-3 shrink-0" />
                Links are signed and short-lived — reopen this panel if one stops working.
              </p>
            </div>
          </div>
        )}
        </div>
        <div className="px-5 py-3 border-t border-slate-200 bg-white flex items-center justify-between gap-3 shrink-0">
          {/* Says why there is no Confirm button, rather than leaving its
              absence to be read as the panel being broken.
              Sep 22, 2026: for a split order, the primary now has its own
              Verify/Hold inline in the "Split Sales Orders" section above —
              this footer would otherwise offer the exact same action a
              second time, with no Hold of its own to match it. */}
          {rejecting ? (
            <div className="min-w-0 flex-1">
              <textarea
                autoFocus
                rows={2}
                value={holdReason}
                onChange={(e) => setHoldReason(e.target.value)}
                placeholder="Why is this order being held?"
                className="w-full text-xs rounded-md border border-red-300 px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-red-400 resize-none"
              />
            </div>
          ) : footer ? (
            <div className="min-w-0">{footer}</div>
          ) : splits.length > 0 ? (
            <p className="text-[11px] text-ink-secondary min-w-0">
              Verify or hold each entity above — this order is split across {splits.length + 1} Sales Orders.
            </p>
          ) : confirmsSalesOrder ? (
            <fieldset className="min-w-0 space-y-1">
              <legend className="text-[11px] text-ink-secondary mb-1">
                Confirming confirms this Sales Order in Zoho. Dispatch invoices it next.
              </legend>
              <label htmlFor="modal-check-prices" className="flex items-start gap-2 text-xs text-ink-primary">
                <input
                  id="modal-check-prices"
                  type="checkbox"
                  checked={checks.prices}
                  onChange={() => setChecks((c) => ({ ...c, prices: !c.prices }))}
                  className="mt-0.5"
                />
                I checked the prices on the Sales Order.
              </label>
              <label htmlFor="modal-check-proof" className="flex items-start gap-2 text-xs text-ink-primary">
                <input
                  id="modal-check-proof"
                  type="checkbox"
                  checked={checks.proof}
                  onChange={() => setChecks((c) => ({ ...c, proof: !c.proof }))}
                  className="mt-0.5"
                />
                I checked the proof of payment, or the reason there is none.
              </label>
            </fieldset>
          ) : (
            <p className="text-[11px] text-ink-secondary min-w-0">
              {canConfirm
                ? 'Confirming moves the Sales Order in Zoho from Draft to Confirmed, which releases it to be invoiced.'
                : order?.status === 'ready_for_finance_verified'
                  ? ''
                  : 'Not awaiting Finance — nothing to confirm at this stage.'}
            </p>
          )}
          <div className="flex items-center gap-2 shrink-0">
            {rejecting ? (
              <>
                <button
                  onClick={() => { setRejecting(false); setHoldReason(''); }}
                  className="px-4 py-2 rounded-md border border-slate-200 text-sm font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
                >
                  Cancel
                </button>
                <button
                  disabled={!holdReason.trim() || confirming}
                  onClick={() => {
                    onReject(order.id, holdReason.trim());
                    setRejecting(false);
                    setHoldReason('');
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-state-error text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Confirm hold
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={onClose}
                  className="px-4 py-2 rounded-md border border-slate-200 text-sm font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary"
                >
                  Close
                </button>
                {canHold && (
                  <button
                    onClick={() => setRejecting(true)}
                    disabled={confirming}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md border border-state-error/40 text-state-error text-sm font-semibold hover:bg-state-error-light disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    Hold
                  </button>
                )}
                {canConfirm && splits.length === 0 && (
                  onOpenConfirm ? (
                    <button
                      onClick={() => onOpenConfirm(order)}
                      disabled={confirming}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-pharmacy-green text-white text-sm font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <ShieldCheck className="w-4 h-4" />
                      Confirm payment…
                    </button>
                  ) : (
                    <button
                      onClick={() => (confirmsSalesOrder ? onConfirm(order.id, checks) : onConfirm(order.id))}
                      disabled={confirming || (confirmsSalesOrder && !checksDone)}
                      className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-pharmacy-green text-white text-sm font-semibold hover:bg-pharmacy-green-dark disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {confirming ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <ShieldCheck className="w-4 h-4" />
                      )}
                      {confirmsSalesOrder ? 'Confirm order' : 'Confirm account'}
                    </button>
                  )
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <Lightbox attachment={lightbox} onClose={() => setLightbox(null)} />
    </>
  );
};

export default OrderDetailsModal;
