import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, X, Ban, Archive, Trash2 } from 'lucide-react';
import client from '../../api/client';

/**
 * Management / Admin cancel a DRAFT order. Oct 3, 2026; two kinds Oct 5, 2026.
 *
 *  - Delete permanently (Oct 8, 2026, replaced "Cancel and discard"): no money is
 *    involved. The draft is removed for good; the order id must be typed to confirm.
 *  - Cancel and keep record: the customer paid in advance. The order is never deleted
 *    and Finance follows up the refund.
 *
 * A draft that already has a payment on record (a payment proof, Advanced Payment
 * terms or a verified payment) can only be kept; the server refuses to delete it
 * too. A reason is required: the MedRep sees it.
 *
 * deleteOnly: the draft was already cancelled as discard, so only deleting is offered.
 */
const CancelDraftModal = ({ order, onClose, onConfirm, saving, deleteOnly = false }) => {
  const [reason, setReason] = useState(deleteOnly ? order.draft_cancel_reason || '' : '');
  const [picked, setPicked] = useState(null);
  const [confirmId, setConfirmId] = useState('');

  const check = useQuery({
    queryKey: ['payment-on-record', order.id],
    queryFn: () => client.get(`/api/orders/${order.id}/payment-on-record`).then((r) => r.data?.data),
    staleTime: 0
  });
  const paid = !!check.data?.has;
  const kind = deleteOnly ? 'delete' : picked || (paid ? 'keep_record' : 'delete');
  const confirmed = kind !== 'delete' || confirmId.trim() === order.getmeds_order_id;
  const ready = !check.isLoading && !check.isError && reason.trim().length > 0 && confirmed && !(kind === 'delete' && paid);

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
            <h2 className="text-base font-bold text-ink-primary">{deleteOnly ? 'Delete this draft permanently?' : 'Cancel this draft?'}</h2>
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
              <strong>Payment on record:</strong> {check.data.reasons.join('; ')}. This draft can only be cancelled and <strong>kept on record</strong>, so the refund can be followed up{deleteOnly ? '. It cannot be deleted' : ''}.
            </p>
          ) : null}

          {!deleteOnly && (
            <div className="space-y-2">
              <Option value="delete" icon={<Trash2 className="w-3.5 h-3.5" />} title="Delete permanently" disabled={paid}>
                No money involved. The draft, its items, attachments and history are removed for good. The MedRep is told.
              </Option>
              <Option value="keep_record" icon={<Archive className="w-3.5 h-3.5" />} title="Cancel and keep record">
                The customer paid in advance. It is kept permanently, Finance is told, and it shows as <strong>Refund pending</strong> until Finance records the refund.
              </Option>
            </div>
          )}

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

          {kind === 'delete' && !paid && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5">
              <label htmlFor="delete-confirm" className="block text-[12.5px] text-red-900 mb-1.5">
                This cannot be undone. Type <strong className="font-mono">{order.getmeds_order_id}</strong> to confirm.
              </label>
              <input
                id="delete-confirm"
                type="text"
                autoComplete="off"
                value={confirmId}
                onChange={(e) => setConfirmId(e.target.value)}
                className="w-full text-sm font-mono border border-red-300 rounded-md px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-medium text-ink-secondary hover:bg-surface">
            Keep draft
          </button>
          <button
            type="button"
            onClick={() => onConfirm(reason.trim(), kind, confirmId.trim())}
            disabled={!ready || saving}
            className="px-4 py-2 rounded-md bg-red-600 text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : kind === 'delete' ? <Trash2 className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
            {kind === 'delete'
              ? (saving ? 'Deleting…' : 'Yes, delete permanently')
              : (saving ? 'Cancelling…' : 'Cancel and keep record')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CancelDraftModal;
