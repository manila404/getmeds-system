import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Ban, Check, Clock, Loader2, Lock } from 'lucide-react';
import client from '../../api/client';
import DevZohoButtons from '../finance/DevZohoButtons';

/**
 * Dispatch's checklist for refunds Management approved. Oct 22, 2026.
 *
 *   Invoiced order   payment removed (Finance) -> goods returned (Dispatch) -> void the invoice IN ZOHO BY HAND
 *                    -> press check: the app READS Zoho and only moves the order on if it says Void.
 *   Sales Order only the Sales Order is closed in Zoho; never holds the refund up.
 *
 * The app never writes to Zoho here. See services/refundRequestService.js.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const GOODS_TEXT = { not_shipped: 'not shipped', returning: 'shipped, coming back to us', customer_returns: 'delivered, customer returns them', customer_keeps: 'the customer keeps them' };
const errText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

const Row = ({ state, children, action }) => (
  <li className="flex items-start gap-2 py-1.5 border-b border-slate-100 last:border-0 text-[12.5px]">
    <span className={`mt-0.5 inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full ${
      state === 'ok' ? 'bg-emerald-100 text-emerald-700' : state === 'lock' ? 'bg-slate-100 text-slate-500' : 'bg-red-100 text-red-700'}`}>
      {state === 'ok' ? <Check className="w-3 h-3" /> : state === 'lock' ? <Lock className="w-2.5 h-2.5" /> : <Clock className="w-3 h-3" />}
    </span>
    <span className="flex-1">{children}</span>
    {action}
  </li>
);

const VoidCard = ({ r, onDone }) => {
  const [note, setNote] = useState('');
  const isSo = r.stage === 'so';
  const call = (path, body) => client.post(`/api/refund-requests/${r.id}/${path}`, body).then((x) => x.data);
  const goods = useMutation({ mutationFn: () => call('goods-returned', { note: note.trim() || undefined }), onSuccess: () => { toast.success('Goods recorded as returned.'); onDone(); }, onError: (e) => toast.error(errText(e, 'Could not record it'), { duration: 8000 }) });
  const check = useMutation({ mutationFn: () => call(isSo ? 'check-so' : 'check-void'), onSuccess: () => { toast.success(isSo ? 'Zoho confirms the Sales Order is closed.' : `Zoho confirms ${r.zoho_invoice_number} is void. Sent back to Management to refund.`); onDone(); }, onError: (e) => toast.error(errText(e, 'Zoho does not say that yet'), { duration: 9000 }) });

  const needsGoods = ['returning', 'customer_returns'].includes(r.goods_status);
  const waitingPayment = !isSo && r.payment_applied !== false && !r.payment_removed_at;
  const goodsBlocked = needsGoods && !r.goods_returned_at;
  const blocked = waitingPayment || goodsBlocked;
  const busy = goods.isPending || check.isPending;

  return (
    <li className="px-4 py-3 border-b border-slate-100 last:border-0">
      <div className="flex justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/orders/${r.order_id}`} className="font-mono font-semibold text-getmeds-blue hover:underline text-sm">{r.getmeds_order_id}</Link>
          <p className="text-sm text-ink-primary truncate">{r.customer_name}</p>
          <p className="text-xs text-ink-secondary">
            {isSo ? <>Sales Order <b>{r.zoho_so_number}</b></> : <>Invoice <b>{r.zoho_invoice_number}</b> · {r.zoho_so_number}</>} · refund asked by {r.requested_by_name}
          </p>
          <p className="text-xs text-ink-secondary">Reason: {r.reason}. Goods: {GOODS_TEXT[r.goods_status] || r.goods_status}.</p>
        </div>
        <p className="text-sm font-semibold shrink-0">{peso(r.requested_amount)}</p>
      </div>
      <ul className="mt-2">
        <Row state="ok">Approved by {r.decided_by_name || 'Management'}</Row>
        {isSo ? (
          <Row state="bad" action={<button type="button" disabled={busy} onClick={() => check.mutate()} className="shrink-0 rounded-md bg-getmeds-blue px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">{check.isPending ? 'Checking…' : 'I closed it, check Zoho'}</button>}>
            <b>Void or cancel {r.zoho_so_number} in Zoho</b>; its stock is still committed. The refund does not wait for this.
          </Row>
        ) : (
          <>
            {r.payment_applied !== false && (r.payment_removed_at
              ? <Row state="ok">Payment removed in Zoho (Finance)</Row>
              : <Row state="bad" action={<span className="shrink-0 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-900">Waiting for Finance</span>}><b>A payment is applied to this invoice in Zoho.</b> Zoho will not void a paid invoice; Finance removes it first.</Row>)}
            {needsGoods && (r.goods_returned_at
              ? <Row state="ok">Goods returned{r.goods_returned_note ? `: ${r.goods_returned_note}` : ''}</Row>
              : <Row state="bad" action={
                <span className="flex shrink-0 items-center gap-1.5">
                  <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" maxLength={200} className="w-32 rounded border border-slate-300 px-1.5 py-1 text-xs" />
                  <button type="button" disabled={busy} onClick={() => goods.mutate()} className="rounded-md bg-getmeds-blue px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">{goods.isPending ? 'Saving…' : 'Mark goods returned'}</button>
                </span>}><b>Goods:</b> {GOODS_TEXT[r.goods_status]}. Record them as returned before voiding.</Row>)}
            <Row state={blocked ? 'lock' : 'bad'} action={!blocked && (
              <button type="button" disabled={busy} onClick={() => check.mutate()} className="shrink-0 rounded-md bg-getmeds-blue px-2.5 py-1 text-xs font-semibold text-white disabled:opacity-50">{check.isPending ? 'Checking…' : 'I voided it, check Zoho'}</button>)}>
              <b>Void {r.zoho_invoice_number} in Zoho</b>, then come back and press check.{blocked ? ' (locked until the steps above are done)' : ''}
            </Row>
          </>
        )}
      </ul>
      <DevZohoButtons soId={r.zoho_so_id} actions={isSo ? ['closeso'] : ['void', 'unpay', 'pay']} />
    </li>
  );
};

// Shared by the checklist below and the attention banner at the top of the page (one request, one cache entry).
export const useVoidRequests = () => useQuery({
  queryKey: ['void-requests'],
  // { requests: approved, to act on; upcoming: still waiting for Management (heads-up only) }
  queryFn: () => client.get('/api/refund-requests/void-requests').then((r) => ({ requests: r.data?.data?.requests || [], upcoming: r.data?.data?.upcoming || [] })),
  refetchInterval: 60000
});

export const VOID_REQUESTS_ID = 'void-requests';

const VoidRequestsPanel = () => {
  const qc = useQueryClient();
  const { data, isLoading } = useVoidRequests();
  const rows = data?.requests || [];
  if (isLoading || rows.length === 0) return null;
  const refresh = () => { qc.invalidateQueries({ queryKey: ['void-requests'] }); qc.invalidateQueries({ queryKey: ['payments-to-remove'] }); };
  return (
    <div id={VOID_REQUESTS_ID} className="bg-white shadow rounded-lg border border-amber-300 overflow-hidden scroll-mt-4">
      <div className="px-4 py-3 border-b border-amber-200 bg-amber-50">
        <h2 className="text-sm font-semibold text-ink-primary flex items-center gap-2">
          <Ban className="w-4 h-4 text-amber-700" /> Void requests
          <span className="min-w-[1.5rem] text-center rounded-full px-1.5 text-xs tabular-nums bg-amber-600 text-white">{rows.length}</span>
        </h2>
        <p className="text-xs text-ink-secondary mt-0.5">Management approved a refund. Clear it in Zoho by hand; the app only checks, it never voids anything.</p>
      </div>
      <ul>{rows.map((r) => <VoidCard key={r.id} r={r} onDone={refresh} />)}</ul>
    </div>
  );
};

export default VoidRequestsPanel;
