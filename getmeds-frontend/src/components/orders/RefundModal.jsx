import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X, Loader2, Banknote } from 'lucide-react';
import client from '../../api/client';

/**
 * Finance / Admin record (or correct) the refund for a paid draft that was cancelled
 * and kept on record. Oct 5, 2026.
 *
 * The system only RECORDS the refund; the money moves outside it. "Amount refunded"
 * may be less than "amount received" — a partial payment or a cancellation fee — and
 * the part kept is shown as it is worked out.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

const RefundModal = ({ order, onClose, onDone }) => {
  const held = order.refund_received_amount ?? order.held_amount ?? order.total_amount ?? 0;
  const [status, setStatus] = useState(order.refund_status === 'pending' ? 'done' : order.refund_status || 'done');
  const [received, setReceived] = useState(String(held));
  const [refund, setRefund] = useState(order.refund_amount != null ? String(order.refund_amount) : String(held));
  const [reference, setReference] = useState(order.refund_reference || '');
  const [date, setDate] = useState(order.refund_at || today());
  const [note, setNote] = useState(order.refund_note || '');

  const kept = Math.max(0, (Number(received) || 0) - (status === 'done' ? Number(refund) || 0 : 0));

  const save = useMutation({
    mutationFn: () =>
      client.post(`/api/orders/${order.id}/refund`, {
        status,
        received_amount: Number(received),
        refund_amount: status === 'done' ? Number(refund) : 0,
        reference: reference.trim(),
        refund_date: status === 'done' ? date : undefined,
        note: note.trim()
      }).then((r) => r.data),
    onSuccess: () => { toast.success(status === 'done' ? 'Refund recorded. The MedRep has been told.' : 'Saved.'); onDone(); },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not save the refund.', { duration: 8000 })
  });

  const field = 'w-full text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent';
  const label = 'block text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1';

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md my-12">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-bold text-ink-primary">Record refund</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{order.getmeds_order_id} · order total {peso(order.total_amount)}</p>
          </div>
          <button type="button" onClick={onClose} disabled={save.isPending} className="text-ink-secondary hover:text-ink-primary" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <div>
            <span className={label}>Outcome</span>
            <div className="flex flex-wrap gap-2">
              {[['done', 'Refund done'], ['pending', 'Still pending'], ['not_due', 'No refund due']].map(([v, t]) => (
                <button key={v} type="button" onClick={() => setStatus(v)}
                  className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${status === v ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'border-slate-300 text-ink-secondary'}`}>{t}</button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label} htmlFor="rf-recv">Amount received (₱)</label>
              <input id="rf-recv" type="number" min="0" step="0.01" className={field} value={received} onChange={(e) => setReceived(e.target.value)} />
            </div>
            {status === 'done' && (
              <div>
                <label className={label} htmlFor="rf-amt">Amount refunded (₱)</label>
                <input id="rf-amt" type="number" min="0" step="0.01" className={field} value={refund} onChange={(e) => setRefund(e.target.value)} />
              </div>
            )}
          </div>

          {status === 'done' && (
            <>
              <p className="text-[12px] text-ink-secondary">
                {kept > 0 ? <>Kept (for example a cancellation fee): <strong>{peso(kept)}</strong></> : 'The full amount is refunded.'}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label} htmlFor="rf-ref">Reference</label>
                  <input id="rf-ref" className={field} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Bank / e-wallet transaction no." />
                </div>
                <div>
                  <label className={label} htmlFor="rf-date">Date paid</label>
                  <input id="rf-date" type="date" className={field} value={date} onChange={(e) => setDate(e.target.value)} />
                </div>
              </div>
            </>
          )}

          <div>
            <label className={label} htmlFor="rf-note">{status === 'not_due' ? 'Why is no refund due? (required)' : 'Note (optional)'}</label>
            <input id="rf-note" maxLength={500} className={field} value={note} onChange={(e) => setNote(e.target.value)}
              placeholder={status === 'not_due' ? 'e.g. The payment never arrived' : 'e.g. Less ₱200 cancellation fee'} />
          </div>
          <p className="text-[11.5px] text-ink-secondary">This records the refund only; the money itself is sent outside the system. Every change is kept in the order’s timeline.</p>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <button type="button" onClick={onClose} disabled={save.isPending} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-medium text-ink-secondary hover:bg-surface">Close</button>
          <button type="button" onClick={() => save.mutate()} disabled={save.isPending}
            className="px-4 py-2 rounded-md bg-getmeds-blue text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50">
            {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Banknote className="w-4 h-4" />}
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RefundModal;
