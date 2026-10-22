import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ClipboardCheck, Check, Loader2 } from 'lucide-react';
import client from '../../api/client';
import { useReturnChecks, RETURN_CHECKS_KEY } from '../../hooks/useReturnChecks';

/**
 * Dispatch's checklist for refunds Management approved where the goods are coming back. Oct 23, 2026 (Finance: no void).
 *
 * When the goods are with us, check the items against the order and record the condition: good, or damaged (say what is
 * wrong). That goes to Management, who checks it and presses Refund; Finance then creates the credit note in Zoho.
 * Dispatch does nothing in Zoho. See services/refundRequestService.js.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const GOODS_TEXT = { returning: 'shipped, coming back to us', customer_returns: 'delivered, customer returns them' };
const errText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

const CheckCard = ({ r, onDone }) => {
  const [condition, setCondition] = useState('');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () => client.post(`/api/refund-requests/${r.id}/goods-checked`, { condition, note: note.trim() || undefined }).then((x) => x.data),
    onSuccess: () => { toast.success('Recorded. Sent to Management to check and refund.'); onDone(); },
    onError: (e) => toast.error(errText(e, 'Could not record it'), { duration: 8000 })
  });
  const ready = condition === 'good' || (condition === 'damaged' && note.trim().length > 0);
  const opt = (k, text) => (
    <button type="button" onClick={() => setCondition(k)}
      className={`px-3 py-1.5 rounded-lg border text-xs ${condition === k ? (k === 'good' ? 'border-emerald-500 bg-emerald-50 text-emerald-900 font-semibold' : 'border-red-400 bg-red-50 text-red-900 font-semibold') : 'border-slate-300 text-ink-secondary'}`}>{text}</button>
  );

  return (
    <li className="px-4 py-3 border-b border-slate-100 last:border-0">
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/orders/${r.order_id}`} className="font-mono font-semibold text-getmeds-blue hover:underline text-sm">{r.getmeds_order_id}</Link>
          <p className="text-sm text-ink-primary truncate">{r.customer_name}</p>
          <p className="text-xs text-ink-secondary">
            {r.zoho_invoice_number ? <>Invoice <b>{r.zoho_invoice_number}</b></> : <>Sales Order <b>{r.zoho_so_number}</b></>} · refund asked by {r.requested_by_name}
          </p>
          <p className="text-xs text-ink-secondary">Reason: {r.reason}. Goods: {GOODS_TEXT[r.goods_status] || r.goods_status}.</p>
        </div>
        <p className="text-sm font-semibold shrink-0">{peso(r.requested_amount)}</p>
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-ink-secondary"><Check className="w-3.5 h-3.5 text-emerald-600" />Approved by {r.decided_by_name || 'Management'}{r.decision_note ? `: ${r.decision_note}` : ''}</p>
      <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
        <p className="text-[12.5px] font-semibold text-ink-primary">When the goods are with us, check the items against the order. Are they in good condition?</p>
        <div className="mt-2 flex flex-wrap gap-2">{opt('good', 'Good condition')}{opt('damaged', 'Damaged / not resellable')}</div>
        {condition && (
          <div className="mt-2">
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
              placeholder={condition === 'damaged' ? 'What is wrong? (required, Management reads it)' : 'note (optional)'}
              className="w-full max-w-lg rounded border border-slate-300 px-2 py-1.5 text-xs" />
          </div>
        )}
        <button type="button" disabled={!ready || save.isPending} onClick={() => save.mutate()}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-getmeds-blue px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {save.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}Record the check, send to Management
        </button>
      </div>
    </li>
  );
};

export const RETURN_CHECKS_ID = 'return-checks';

const ReturnChecksPanel = ({ alwaysShow = false }) => {
  const qc = useQueryClient();
  const { data, isLoading } = useReturnChecks();
  const rows = data?.requests || [];
  if (isLoading) return alwaysShow ? <p className="text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p> : null;
  if (rows.length === 0) {
    return alwaysShow ? (
      <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center text-sm text-ink-secondary">No returned goods are waiting for a check right now.</div>
    ) : null;
  }
  const refresh = () => { qc.invalidateQueries({ queryKey: RETURN_CHECKS_KEY }); qc.invalidateQueries({ queryKey: ['refund-requests'] }); };
  return (
    <div id={RETURN_CHECKS_ID} className="bg-white shadow rounded-lg border border-amber-300 overflow-hidden scroll-mt-4">
      <div className="px-4 py-3 border-b border-amber-200 bg-amber-50">
        <h2 className="text-sm font-semibold text-ink-primary flex items-center gap-2">
          <ClipboardCheck className="w-4 h-4 text-amber-700" /> Return checks
          <span className="min-w-[1.5rem] text-center rounded-full px-1.5 text-xs tabular-nums bg-amber-600 text-white">{rows.length}</span>
        </h2>
        <p className="text-xs text-ink-secondary mt-0.5">Management approved a refund and the goods are coming back. Check the items when they arrive and record their condition. Nothing to do in Zoho.</p>
      </div>
      <ul>{rows.map((r) => <CheckCard key={r.id} r={r} onDone={refresh} />)}</ul>
    </div>
  );
};

export default ReturnChecksPanel;
