import React, { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Receipt, Upload, FileText, ShieldCheck, XCircle, Clock, AlertCircle, RefreshCw, Camera, Paperclip,
} from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { formatPHT } from '../../utils/dateUtils';
import { ATTACHMENT_TYPES, attachmentLabel } from '../../constants/attachmentTypes';

/**
 * Attachments for one order: proof of payment, and everything else.
 *
 * Sep 4, 2026, generalized Sep 5, 2026.
 *
 * ── What changed on Sep 5 ───────────────────────────────────────────────────
 *
 * This was a single "proof of payment" slot — at most one per order. It is
 * now a typed, multi-file list, matching Zoho's own "Attach File(s) to Sales
 * Order" on the Sales Order screen: every file is tagged 'payment_proof' or
 * 'other' at upload. 'other' files are purely informational — nothing here
 * (or anywhere else) verifies, rejects, or notifies Finance about them; they
 * just sit on the order as a record. Only 'payment_proof' files go through
 * the review flow described below.
 *
 * ── The upload does NOT go through our API ─────────────────────────────────
 *
 * Three steps, and the middle one talks to Supabase directly:
 *
 *   1. POST /api/orders/:id/attachments/upload-url -> { signedUrl, storagePath }
 *   2. PUT the file to signedUrl                    -> Supabase Storage
 *   3. POST /api/orders/:id/attachments             -> confirm, row is written
 *
 * Step 2 uses plain fetch() rather than the axios client on purpose. The
 * client has our API's baseURL and attaches our Authorization header to every
 * request — both wrong for a signed Supabase URL, and sending our JWT to
 * another origin is not something to do by accident.
 *
 * The reason for the detour at all: Vercel caps a function's request body at
 * 4.5 MB, and a phone photo is routinely 3-8 MB. Posting the file to our own
 * API would fail for roughly half of real slips — and would pass every test
 * written against a small fixture image.
 *
 * If step 2 succeeds and step 3 never runs (tab closed, connection dropped),
 * the result is an orphaned object in a private bucket and no database row:
 * the order simply shows nothing new and the rep uploads again. That is the
 * safe direction to fail.
 *
 * Approving a proof is NOT here. Finance approves it by verifying the ORDER at
 * ready_for_finance_verified — the decision that already gates invoicing — so
 * this panel only ever shows the outcome. Rejecting one IS a separate action,
 * but it lives in FinanceQueuePage (Finance works from their queue, not from
 * inside an order they're not currently deciding on) — this panel stays
 * read/upload only, same as before.
 */

// Sep 12, 2026: the type list moved to constants/attachmentTypes.js. This
// file used to carry its own three-entry copy, so a Guarantee Letter,
// Prescription or Valid ID uploaded on the order form was displayed here as
// "Other attachment".
const MAX_BYTES = 15 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,' +
  'application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';



const PROOF_STATUS = {
  pending: {
    label: 'Awaiting Finance check',
    icon: Clock,
    className: 'bg-state-warning-light text-amber-950 border-state-warning',
  },
  verified: {
    label: 'Verified by Finance',
    icon: ShieldCheck,
    className: 'bg-pharmacy-green/15 text-pharmacy-green-dark border-pharmacy-green/40',
  },
  rejected: {
    label: 'Rejected by Finance',
    icon: XCircle,
    className: 'bg-state-error-light text-red-800 border-state-error/40',
  },
};

const NO_PROOF_REASONS = {
  on_payment_terms:  'Customer is on payment terms',
  payment_to_follow: 'Payment to follow',
  paid_no_slip:      'Paid — no slip issued',
  other:             'Other',
};

const prettySize = (bytes) => {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

/** One attachment row — a proof of payment (with its review status) or an
 * 'other' file (informational, no status to show). */
const AttachmentCard = ({ attachment, orderGetmedsId, onRefetch, isFetching }) => {
  const isProof = attachment.file_type === 'payment_proof';
  const isImage = attachment.content_type?.startsWith('image/');
  const stage = isProof ? PROOF_STATUS[attachment.status] : null;
  const StageIcon = stage?.icon;

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden bg-surface">
      {isProof ? (
        <div className={`flex items-start gap-2 px-3 py-2 text-xs border-b ${stage.className}`}>
          <StageIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold">{stage.label}</p>
            {attachment.status === 'pending' && (
              <p className="opacity-90 mt-0.5">Finance will check this when they verify the order for invoicing.</p>
            )}
            {attachment.status === 'rejected' && attachment.rejection_reason && (
              <p className="opacity-90 mt-0.5">Reason: {attachment.rejection_reason} — upload a corrected copy below.</p>
            )}
            {attachment.status === 'verified' && (
              <p className="opacity-90 mt-0.5">Verified alongside the order's finance check. This record is now final.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 text-xs border-b border-slate-200 bg-slate-50 text-ink-secondary">
          <Paperclip className="w-3.5 h-3.5 shrink-0" />
          <span className="font-semibold">{attachmentLabel(attachment.file_type)}</span>
          <span className="opacity-80">— informational only, not reviewed by Finance</span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3">
        {[
          ['File', attachment.file_name || '—'],
          ['Size', prettySize(attachment.file_size)],
          ['Uploaded By', attachment.uploaded_by_name || '—'],
          ['Uploaded At', attachment.uploaded_at ? formatPHT(attachment.uploaded_at) : '—'],
          ...(isProof ? [
            ['Verified By', attachment.verified_by_name || '—'],
            ['Verified At', attachment.verified_at ? formatPHT(attachment.verified_at) : '—'],
          ] : []),
        ].map(([label, val]) => (
          <div key={label} className="bg-white rounded p-2.5 border border-slate-100">
            <p className="text-xs font-medium text-ink-secondary uppercase mb-1">{label}</p>
            <div className="text-sm text-ink-primary font-medium break-words">{val}</div>
          </div>
        ))}
      </div>

      {/* The view URL is signed and short-lived — minted per request by the
          API, never stored. A stale tab will 403 on the image; Refresh mints
          a new one. */}
      <div className="px-3 py-2 border-t border-slate-200 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-ink-primary">Attached document</span>
        <button
          onClick={onRefetch}
          className="flex items-center gap-1.5 text-xs text-ink-secondary hover:text-ink-primary"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh link
        </button>
      </div>
      {isImage ? (
        <a href={attachment.viewUrl} target="_blank" rel="noopener noreferrer" className="block bg-white">
          <img
            src={attachment.viewUrl}
            alt={`${isProof ? 'Proof of payment' : 'Attachment'} for ${orderGetmedsId || 'this order'}`}
            className="max-h-96 w-auto mx-auto"
          />
        </a>
      ) : (
        <div className="p-6 text-center">
          <FileText className="w-10 h-10 mx-auto mb-2 text-ink-secondary/50" />
          <a
            href={attachment.viewUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-getmeds-blue underline"
          >
            Open {attachment.file_name || 'document'}
          </a>
        </div>
      )}
    </div>
  );
};

const PaymentProofPanel = ({ orderId, order }) => {
  const qc = useQueryClient();
  const { user } = useAuth();
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [uploadType, setUploadType] = useState('payment_proof');

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['order-attachments', orderId],
    queryFn: async () => {
      const res = await client.get(`/api/orders/${orderId}/attachments`);
      return res.data?.data?.attachments || [];
    },
  });

  const attachments = data || [];
  const proofAttachments = attachments.filter(a => a.file_type === 'payment_proof');
  const otherAttachments = attachments.filter(a => a.file_type !== 'payment_proof');
  const latestProof = proofAttachments[0] || null; // list is uploaded_at DESC

  // Mirrors the server's canAttach in paymentProof.controller.js, and the
  // ownership check getById already applies. The server is the authority —
  // this only decides whether to show the control.
  //
  // Sep 5, 2026: management added — they can create/submit an order on a
  // MedRep's behalf, so they can also attach files to it.
  const role = (user?.role || '').toLowerCase();
  const canUpload =
    role === 'admin' || role === 'management' || (order?.medrep_id != null && order.medrep_id === user?.id);

  // A verified proof "locks" new proof-of-payment uploads the same way it
  // always has — it is the evidence Finance already cleared the order on.
  // 'other' files never lock; they can be added any time.
  const proofLocked = latestProof?.status === 'verified';

  const uploadMutation = useMutation({
    mutationFn: async ({ file, fileType }) => {
      // 1. ask our API where this file may go
      const { data: urlRes } = await client.post(`/api/orders/${orderId}/attachments/upload-url`, {
        contentType: file.type,
        fileName: file.name,
        fileSize: file.size,
        file_type: fileType,
      });
      const { signedUrl, storagePath } = urlRes.data;

      // 2. straight to Supabase — see the header note
      const put = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'content-type': file.type },
        body: file,
      });
      if (!put.ok) {
        throw new Error(`Upload to storage failed (${put.status}). Nothing was recorded — please try again.`);
      }

      // 3. confirm, which is what actually writes the row
      const { data: confirmRes } = await client.post(`/api/orders/${orderId}/attachments`, {
        storagePath,
        fileName: file.name,
        contentType: file.type,
        fileSize: file.size,
        file_type: fileType,
      });
      return confirmRes.data;
    },
    onSuccess: (data, variables) => {
      const base = variables.fileType === 'payment_proof' ? 'Proof of payment uploaded.' : 'File attached.';
      // Sep 8, 2026: `attach` also best-effort pushes this file to the
      // matching Zoho Sales Order (once one exists) — reflect whether that
      // part actually landed, same idea as ClientsPage's TIN save toast.
      if (data?.zoho_pushed) {
        toast.success(`${base} Also added to the Zoho Sales Order.`);
      } else if (data?.zoho_error) {
        toast.success(base);
        toast.error(`Could not add it to the Zoho Sales Order: ${data.zoho_error}`);
      } else {
        toast.success(base);
      }
      qc.invalidateQueries({ queryKey: ['order-attachments', orderId] });
      qc.invalidateQueries({ queryKey: ['order-payment-proof', orderId] });
      qc.invalidateQueries({ queryKey: ['order', String(orderId)] });
    },
    onError: (err) => {
      toast.error(err.response?.data?.error?.message || err.message || 'Upload failed');
    },
    onSettled: () => setUploading(false),
  });

  // Sep 5, 2026 (2): pulled out of onPick so a drop event (desktop
  // drag-and-drop) can share the same size check / mutate call.
  const processFile = (file) => {
    if (!file) return;
    if (file.size > MAX_BYTES) {
      toast.error(`That file is ${prettySize(file.size)}. The limit is ${MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setUploading(true);
    uploadMutation.mutate({ file, fileType: uploadType });
  };

  const onPick = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same file twice still fires onChange
    processFile(file);
  };

  // Sep 5, 2026 (2): drag-and-drop for desktop, alongside the click-to-choose
  // buttons kept for mobile below — same split as OrderForm's attach control.
  const [isDragActive, setIsDragActive] = useState(false);
  const dropDisabled = uploading || (uploadType === 'payment_proof' && proofLocked);
  const handleDragOver = (e) => {
    e.preventDefault();
    if (!dropDisabled) setIsDragActive(true);
  };
  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragActive(false);
  };
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragActive(false);
    if (dropDisabled) return;
    processFile(e.dataTransfer.files?.[0]);
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Nothing attached yet ───────────────────────────────────────── */}
      {attachments.length === 0 && (
        <div className="space-y-3">
          <div className="text-center py-6 text-ink-secondary">
            <Receipt className="w-10 h-10 mx-auto mb-2 text-ink-secondary/50" />
            <p className="text-sm">No files attached to this order.</p>
            {!canUpload && (
              <p className="text-xs mt-1">
                Only the MedRep who raised this order (or management) can attach one.
              </p>
            )}
          </div>
        </div>
      )}

      {/* The reason given at order creation for having no proof of payment.
          Shown whenever there is no proof-type file on the order yet, even if
          'other' files are attached — the reason and 'other' attachments are
          independent of each other. */}
      {!latestProof && (
        order?.no_payment_proof_reason ? (
          <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-surface px-3 py-2 text-xs text-ink-secondary">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-ink-primary">
                Reason given: {NO_PROOF_REASONS[order.no_payment_proof_reason] || order.no_payment_proof_reason}
              </p>
              {order.no_payment_proof_note && (
                <p className="mt-0.5">{order.no_payment_proof_note}</p>
              )}
            </div>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-surface px-3 py-2 text-xs text-ink-secondary">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <p>No reason on file — this order predates the requirement.</p>
          </div>
        )
      )}

      {/* ── Proof(s) of payment ────────────────────────────────────────── */}
      {proofAttachments.map((a) => (
        <AttachmentCard
          key={a.id}
          attachment={a}
          orderGetmedsId={order?.getmeds_order_id}
          onRefetch={refetch}
          isFetching={isFetching}
        />
      ))}

      {/* ── Other attachments ──────────────────────────────────────────── */}
      {otherAttachments.map((a) => (
        <AttachmentCard
          key={a.id}
          attachment={a}
          orderGetmedsId={order?.getmeds_order_id}
          onRefetch={refetch}
          isFetching={isFetching}
        />
      ))}

      {/* ── Upload / attach another ────────────────────────────────────── */}
      {canUpload && (
        <div className="rounded-lg border border-slate-200 bg-surface p-4">
          <p className="text-xs font-semibold text-ink-primary mb-2">
            Attach File(s) to Sales Order
          </p>
          <p className="text-xs text-ink-secondary mb-3">
            A deposit slip, transfer screenshot, purchase order, or any other file worth attaching. Up to{' '}
            {MAX_BYTES / 1024 / 1024} MB each. Multi-page paperwork goes in as one PDF.
          </p>

          <div className="mb-3">
            <label className="block text-xs font-semibold text-ink-primary mb-1.5">Attach as</label>
            <select
              value={uploadType}
              onChange={(e) => setUploadType(e.target.value)}
              disabled={uploading || (uploadType === 'payment_proof' && proofLocked)}
              className="text-sm border border-slate-300 rounded-lg px-2.5 py-1.5 bg-white text-ink-primary disabled:opacity-50"
            >
              {ATTACHMENT_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          {uploadType === 'payment_proof' && proofLocked ? (
            <div className="flex items-start gap-2 text-xs text-ink-secondary bg-white border border-slate-200 rounded-lg p-3">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <p>
                A verified proof of payment cannot be replaced — it is the evidence Finance cleared this order
                for invoicing on. If it is wrong, ask Finance to reject it; the upload control comes back.
              </p>
            </div>
          ) : (
            <>
              {/* Two inputs rather than one: `capture` forces the camera on
                  mobile, which is right when the rep is at the door and wrong
                  when the photo was taken earlier and is sitting in the
                  gallery. */}
              <input ref={cameraRef} type="file" accept={ACCEPT} capture="environment" onChange={onPick} className="hidden" />
              <input ref={fileRef} type="file" accept={ACCEPT} onChange={onPick} className="hidden" />

              {/* Sep 5, 2026 (2): desktop drag-and-drop zone, click-to-choose
                  pair kept for mobile below — same split as OrderForm.jsx's
                  attach control. */}
              <label
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`hidden sm:flex flex-col items-center justify-center gap-1 border-2 border-dashed rounded-lg py-5 px-3 text-center cursor-pointer transition-colors ${
                  isDragActive
                    ? 'border-getmeds-blue bg-getmeds-blue/10'
                    : 'border-slate-300 hover:border-getmeds-blue hover:bg-getmeds-blue/5'
                }`}
              >
                <Upload className="w-4 h-4 text-ink-secondary" />
                <p className="text-xs text-ink-secondary">
                  <span className="font-semibold text-getmeds-blue">Drag & drop a file here</span>, or click to browse
                </p>
                <input type="file" accept={ACCEPT} onChange={onPick} className="hidden" disabled={uploading} />
              </label>

              <div className="flex sm:hidden flex-wrap gap-2">
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => cameraRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50"
                >
                  <Camera className="w-3.5 h-3.5" />
                  {uploading ? 'Uploading…' : 'Take photo'}
                </button>
                <button
                  type="button"
                  disabled={uploading}
                  onClick={() => fileRef.current?.click()}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-slate-300 bg-white text-ink-secondary text-xs font-semibold hover:bg-surface disabled:opacity-50"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {uploading ? 'Uploading…' : 'Choose file'}
                </button>
              </div>

              {uploading && (
                <p className="text-xs text-ink-secondary mt-2">
                  Sending the file to storage. Large photos over a mobile connection can take a moment — don't close this tab.
                </p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

export default PaymentProofPanel;
