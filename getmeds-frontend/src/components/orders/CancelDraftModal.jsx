import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, X, Ban, Archive, Trash2 } from 'lucide-react';
import client from '../../api/client';

/**
 * Management / Admin cancel a DRAFT order. Oct 3, 2026; two kinds Oct 5, 2026.
 *
 *  - Cancel and discard: no money is involved.
 *  - Cancel and keep record: the customer paid in advance. The order is never deleted
 *    and Finance follows up the refund.
 *
 * A draft that already has a payment on record (a payment proof, Advanced Payment
 * terms or a verified payment) can only be kept; the server refuses "discard" for it
 * too. A reason is required: the MedRep sees it.
 */
const CancelDraftModal = ({ order, onClose, onConfirm, saving }) => {
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState(null);

  const check = useQuery({
    queryKey: ['payment-on-record', order.id],
    queryFn: () => client.get(`/api/orders/${order.id}/payment-on-record`).then((r) => r.data?.data),
    staleTime: 0
  });
  const paid = !!check.data?.has;
  const kind = picked || (paid ? 'keep_record' : 'discard');
  const ready = !check.isLoading && !check.isError && reason.trim().length > 0;

  const Option = ({ value, icon, title, children, disabled }) => (
    <label className={`flex gap-3 rounded-lg border p-3 text-[13px] ${kind === value ? 'border-getmeds-blue bg-blue-50' : 'border-slate-200'} ${disabled ? 'opacity-50' : 'cursor-pointer'}`}>
      <input type="radio" name="cancel-kind" className="mt-1" checked={kind === value} disabled={disabled} onChange={() => setPicked(value)} />
      <span>
        <span className="font-semibold text-ink-primary flex items-center gap-1.5">{icon}{title}</span>
        <span className="block text-ink-secondary mt-0.5">{children}</span>
      </span>
    </label>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md my-16">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-bold text-ink-primary">Cancel this draft?</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{order.getmeds_order_id}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} className="text-ink-secondary hover:text-ink-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="px-5 py-4 space-y-3">
          {check.isLoading ? (
            <p className="text-xs text-ink-secondary flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Checking for a payment on this order…</p>
          ) : check.isError ? (
            <p className="text-xs text-red-700">Could not check whether a payment is on record. Close this and try again.</p>
          ) : paid ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[12.5px] text-amber-900">
              <strong>Payment on record:</strong> {check.data.reasons.join('; ')}. This draft can only be cancelled and <strong>kept on record</strong>, so the refund can be followed up.
            </p>
          ) : null}

          <div className="space-y-2">
            <Option value="discard" icon={<Trash2 className="w-3.5 h-3.5" />} title="Cancel and discard" disabled={paid}>
              No money involved. It leaves Finance and Management lists and counts; the MedRep sees it as Cancelled.
            </Option>
            <Option value="keep_record" icon={<Archive className="w-3.5 h-3.5" />} title="Cancel and keep record">
              The customer paid in advance. It is kept permanently, Finance is told, and it shows as <strong>Refund pending</strong> until Finance records the refund.
            </Option>
          </div>

          <div>
            <label htmlFor="cancel-reason" className="block text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1">
              Reason (required)
            </label>
            <textarea
              id="cancel-reason"
              autoFocus
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Customer cancelled — duplicate of GM-20261003-0001"
              className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent"
            />
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-medium text-ink-secondary hover:bg-surface">
            Keep draft
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim(), kind)}
            disabled={!ready || saving}
            className="px-4 py-2 rounded-md bg-red-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Ban className="w-4 h-4" />}
            {saving ? 'Cancelling…' : kind === 'keep_record' ? 'Cancel and keep record' : 'Cancel and discard'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CancelDraftModal;
