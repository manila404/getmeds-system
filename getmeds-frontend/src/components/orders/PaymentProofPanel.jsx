import React, { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Receipt, Upload, FileText, ShieldCheck, XCircle, Clock, AlertCircle, RefreshCw, Camera,
} from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { formatPHT } from '../../utils/dateUtils';

/**
 * Proof of payment for one order.
 *
 * Sep 4, 2026.
 *
 * ── The upload does NOT go through our API ─────────────────────────────────
 *
 * Three steps, and the middle one talks to Supabase directly:
 *
 *   1. POST /api/orders/:id/payment-proof/upload-url -> { signedUrl, storagePath }
 *   2. PUT the file to signedUrl            -> Supabase Storage
 *   3. POST /api/orders/:id/payment-proof            -> confirm, row is written
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
 * the order simply shows no proof and the rep uploads again. That is the safe
 * direction to fail.
 *
 * Approving a proof is NOT here. Finance approves it by verifying the ORDER at
 * ready_for_finance_verified — the decision that already gates invoicing — so
 * this panel only ever shows the outcome. See FinanceQueuePage.
 */

const MAX_BYTES = 15 * 1024 * 1024;
const ACCEPT = 'image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf';

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

const prettySize = (bytes) => {
  if (!bytes && bytes !== 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

const PaymentProofPanel = ({ orderId, order }) => {
  const qc = useQueryClient();
  const { user } = useAuth();
  const cameraRef = useRef(null);
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);

  // 404 is the normal "nothing attached yet" answer, not a failure, so it is
  // mapped to null rather than left to surface as an error state.
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['order-payment-proof', orderId],
    queryFn: async () => {
      try {
        const res = await client.get(`/api/orders/${orderId}/payment-proof`);
        return res.data?.data?.proof || null;
      } catch (err) {
        if (err.response?.status === 404) return null;
        throw err;
      }
    },
  });

  const proof = data || null;

  // Mirrors the server's canAttach in proof.controller.js, and the ownership
  // check getById already applies. The server is the authority — this only
  // decides whether to show the control.
  const role = (user?.role || '').toLowerCase();
  const canUpload =
    role === 'admin' || (order?.medrep_id != null && order.medrep_id === user?.id);

  const uploadMutation = useMutation({
    mutationFn: async (file) => {
      // 1. ask our API where this file may go
      const { data: urlRes } = await client.post(`/api/orders/${orderId}/payment-proof/upload-url`, {
        contentType: file.type,
        fileName: file.name,
        fileSize: file.size,
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
      const { data: confirmRes } = await client.post(`/api/orders/${orderId}/payment-proof`, {
        storagePath,
        fileName: file.name,
        contentType: file.type,
        fileSize: file.size,
      });
      return confirmRes.data;
    },
    onSuccess: () => {
      toast.success('Proof of payment uploaded.');
      qc.invalidateQueries({ queryKey: ['order-payment-proof', orderId] });
      qc.invalidateQueries({ queryKey: ['order', String(orderId)] });
    },
    onError: (err) => {
      toast.error(err.response?.data?.error?.message || err.message || 'Upload failed');
    },
    onSettled: () => setUploading(false),
  });

  const onPick = (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // so picking the same file twice still fires onChange
    if (!file) return;

    if (file.size > MAX_BYTES) {
      toast.error(`That file is ${prettySize(file.size)}. The limit is ${MAX_BYTES / 1024 / 1024} MB.`);
      return;
    }
    setUploading(true);
    uploadMutation.mutate(file);
  };

  const isImage = proof?.content_type?.startsWith('image/');
  const stage = proof ? PROOF_STATUS[proof.status] : null;
  const StageIcon = stage?.icon;
  const canReplace = canUpload && (!proof || proof.status !== 'verified');

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
      {!proof && (
        <div className="text-center py-8 text-ink-secondary">
          <Receipt className="w-10 h-10 mx-auto mb-2 text-ink-secondary/50" />
          <p className="text-sm">No proof of payment attached yet.</p>
          {!canUpload && (
            <p className="text-xs mt-1">
              Only the MedRep who raised this order can attach one.
            </p>
          )}
        </div>
      )}

      {/* ── The proof ──────────────────────────────────────────────────── */}
      {proof && (
        <>
          <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${stage.className}`}>
            <StageIcon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold">{stage.label}</p>
              {proof.status === 'pending' && (
                <p className="opacity-90 mt-0.5">Finance will check this when they verify the order for invoicing.</p>
              )}
              {proof.status === 'rejected' && proof.rejection_reason && (
                <p className="opacity-90 mt-0.5">
                  Reason: {proof.rejection_reason} — upload a corrected copy below.
                </p>
              )}
              {proof.status === 'verified' && (
                <p className="opacity-90 mt-0.5">
                  Verified alongside the order's finance check. This record is now final.
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[
              ['File', proof.file_name || '—'],
              ['Size', prettySize(proof.file_size)],
              ['Uploaded By', proof.uploaded_by_name || '—'],
              ['Uploaded At', proof.uploaded_at ? formatPHT(proof.uploaded_at) : '—'],
              ['Verified By', proof.verified_by_name || '—'],
              ['Verified At', proof.verified_at ? formatPHT(proof.verified_at) : '—'],
            ].map(([label, val]) => (
              <div key={label} className="bg-surface rounded p-3 border border-slate-100">
                <p className="text-xs font-medium text-ink-secondary uppercase mb-1">{label}</p>
                <div className="text-sm text-ink-primary font-medium break-words">{val}</div>
              </div>
            ))}
          </div>

          {/* The view URL is signed and short-lived — minted per request by the
              API, never stored. A stale tab will 403 on the image; Refresh
              mints a new one. */}
          <div className="rounded-lg border border-slate-200 overflow-hidden bg-surface">
            <div className="px-3 py-2 border-b border-slate-200 flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-ink-primary">Attached document</span>
              <button
                onClick={() => refetch()}
                className="flex items-center gap-1.5 text-xs text-ink-secondary hover:text-ink-primary"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} /> Refresh link
              </button>
            </div>
            {isImage ? (
              <a href={proof.viewUrl} target="_blank" rel="noopener noreferrer" className="block bg-white">
                <img
                  src={proof.viewUrl}
                  alt={`Proof of payment for ${order?.getmeds_order_id || 'this order'}`}
                  className="max-h-96 w-auto mx-auto"
                />
              </a>
            ) : (
              <div className="p-6 text-center">
                <FileText className="w-10 h-10 mx-auto mb-2 text-ink-secondary/50" />
                <a
                  href={proof.viewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm font-semibold text-getmeds-blue underline"
                >
                  Open {proof.file_name || 'document'}
                </a>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Upload / replace ───────────────────────────────────────────── */}
      {canReplace && (
        <div className="rounded-lg border border-slate-200 bg-surface p-4">
          <p className="text-xs font-semibold text-ink-primary mb-2">
            {proof ? 'Replace the proof of payment' : 'Attach the proof of payment'}
          </p>
          <p className="text-xs text-ink-secondary mb-3">
            A deposit slip, transfer screenshot or official receipt. JPG, PNG, HEIC, WebP or PDF, up to{' '}
            {MAX_BYTES / 1024 / 1024} MB. Multi-page paperwork goes in as one PDF.
          </p>

          {/* Two inputs rather than one: `capture` forces the camera on mobile,
              which is right when the rep is at the door and wrong when the
              photo was taken earlier and is sitting in the gallery. */}
          <input ref={cameraRef} type="file" accept={ACCEPT} capture="environment" onChange={onPick} className="hidden" />
          <input ref={fileRef} type="file" accept={ACCEPT} onChange={onPick} className="hidden" />

          <div className="flex flex-wrap gap-2">
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
        </div>
      )}

      {proof?.status === 'verified' && canUpload && (
        <div className="flex items-start gap-2 text-xs text-ink-secondary bg-surface border border-slate-200 rounded-lg p-3">
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <p>
            A verified proof of payment cannot be replaced — it is the evidence Finance cleared this order
            for invoicing on. If it is wrong, ask Finance to reject it; the upload control comes back.
          </p>
        </div>
      )}
    </div>
  );
};

export default PaymentProofPanel;
