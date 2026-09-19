import React, { useState } from 'react';

// Sep 15, 2026: Management takes an order off Exception / On Hold so it can
// still be processed. By default it goes back to the stage it was at before
// the hold (the server reads that from the order's trail); another stage can
// be chosen instead.
export const RESUME_STAGES = [
  ['pending_management_approval', 'Management approval'],
  ['ready_for_finance_verified', 'Finance verification'],
  ['ready_for_draft_invoice', 'Draft invoice (Finance)'],
  ['ready_for_invoice_sent', 'Invoice to send (Finance)'],
  ['ready_for_dispatch', 'Ready for dispatch'],
  ['picking_packing', 'Picking & packing'],
  ['dispatched', 'Dispatched'],
  ['tracking_shared', 'Tracking shared']
];
// Sep 19, 2026: exported so ResubmitHoldModal.jsx can name the same
// destination for a MedRep's own resubmit — resume's default and resubmit's
// only option resolve to the same stage (statusBeforeHold), so the label
// should read identically either way.
export const stageLabel = (s) => (RESUME_STAGES.find(([k]) => k === s) || [s, String(s || '').replace(/_/g, ' ')])[1];

const ResumeOrderModal = ({ order, onClose, onSubmit, saving }) => {
  // '' = where it was before the hold; resume_to is only known on the order page.
  const [stage, setStage] = useState('');
  const [reason, setReason] = useState('');
  const heldAs = order.status === 'exception' ? 'Exception' : 'On Hold';

  const submit = (e) => {
    e.preventDefault();
    if (!reason.trim()) return;
    onSubmit({ reason: reason.trim(), status: stage || undefined });
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
      <form onSubmit={submit} className="bg-white rounded-xl max-w-md w-full p-6 shadow-2xl space-y-4 border border-slate-200">
        <div className="pb-3 border-b border-slate-100">
          <h3 className="text-lg font-bold text-ink-primary">▶ Resume {order.getmeds_order_id}</h3>
          <p className="text-xs text-ink-secondary">
            Takes the order off {heldAs} so it can be processed again. Nothing is changed in Zoho.
          </p>
        </div>

        {order.exception_reason && (
          <p className="rounded-md bg-state-warning-light border border-state-warning/30 px-3 py-2 text-xs text-amber-950">
            <span className="font-semibold">Held for:</span> {order.exception_reason}
          </p>
        )}

        <div>
          <label className="block text-xs font-semibold text-ink-primary uppercase mb-1">Continue from</label>
          <select
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
          >
            <option value="">
              {order.resume_to ? `Where it was before the hold — ${stageLabel(order.resume_to)}` : 'Where it was before the hold'}
            </option>
            {RESUME_STAGES.map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-xs font-semibold text-ink-primary uppercase mb-1">Why can it continue? *</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Additional payment received"
            rows={3}
            required
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
          />
          <p className="mt-1 text-[11px] text-ink-secondary">The MedRep, Management and the team at that stage are notified.</p>
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <button type="button" onClick={onClose} className="px-4 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !reason.trim()}
            className="px-5 py-2 bg-pharmacy-green text-white rounded-md text-sm font-semibold hover:opacity-90 disabled:opacity-50"
          >
            {saving ? 'Resuming…' : 'Resume order'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default ResumeOrderModal;
