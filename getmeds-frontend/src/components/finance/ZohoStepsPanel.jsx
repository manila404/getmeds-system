import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';
import client from '../../api/client';
import DevZohoButtons from './DevZohoButtons';

/**
 * Refunds on Finance's list that need a step in Zoho first. Oct 23, 2026 (Finance: there is no void).
 *
 *   Goods not coming back   Record the customer's payment in Zoho (Payments Received) if it is not there, then refund it
 *                           in Zoho. The app reads the invoice and only accepts the step when Zoho shows the payment.
 *   Goods came back         Create the credit note in Zoho against the invoice for the refund amount. The app looks it up
 *                           and checks it exists, is not a draft, is this customer's and is the right size.
 *
 * Then, on Refund pending, press Record refund. The app never writes to Zoho; that button is refused until the step is confirmed.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const FINANCE_STEPS_KEY = ['finance-steps'];
const errText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

const StepCard = ({ r, canAct, onDone }) => {
  const [cn, setCn] = useState('');
  const isReturn = r.path === 'return';
  const check = useMutation({
    mutationFn: () => (isReturn
      ? client.post(`/api/refund-requests/${r.id}/credit-note-check`, { number: cn.trim() || undefined })
      : client.post(`/api/refund-requests/${r.id}/payment-recorded`)).then((x) => x.data),
    onSuccess: () => { toast.success(isReturn ? 'Credit note found in Zoho. Now refund it in Zoho and record the refund.' : 'Payment is in Zoho. Now refund it in Zoho and record the refund.'); onDone(); },
    onError: (e) => toast.error(errText(e, 'Zoho does not show that yet'), { duration: 10000 })
  });

  return (
    <li className="px-4 py-3 border-b border-slate-100 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to={`/orders/${r.order_id}`} className="font-mono font-semibold text-getmeds-blue hover:underline text-sm">{r.getmeds_order_id}</Link>
          <span className="text-sm text-ink-primary"> · {r.customer_name} · <b>{r.zoho_invoice_number || r.zoho_so_number}</b></span>
          <p className="text-xs text-ink-secondary mt-0.5">Refund {peso(r.requested_amount)} · {isReturn ? `goods came back (${r.goods_condition === 'damaged' ? 'damaged' : 'good condition'})` : 'goods not coming back'} · {r.reason}</p>
          {isReturn ? (
            <p className="text-[12.5px] mt-1.5"><b>In Zoho:</b> create the credit note against {r.zoho_invoice_number || 'the invoice'} for {peso(r.requested_amount)}. Then check it here.</p>
          ) : (
            <p className="text-[12.5px] mt-1.5"><b>In Zoho:</b> {r.stage === 'invoiced' ? `record the customer's payment on ${r.zoho_invoice_number}` : `record the customer's payment for ${r.zoho_so_number}`} (Payments Received) if it is not there. Then check it here.</p>
          )}
          <p className="text-[11.5px] text-ink-secondary mt-0.5">After that: refund it in Zoho (the Refund button on the payment{isReturn ? ' or credit note' : ''}), then press Record refund on Refund pending.</p>
        </div>
        {canAct && (
          <div className="flex flex-wrap items-center gap-1.5">
            {isReturn && <input value={cn} onChange={(e) => setCn(e.target.value)} placeholder="Credit note no. (optional)" maxLength={40} className="w-44 rounded border border-slate-300 px-2 py-1.5 text-xs" />}
            <button type="button" disabled={check.isPending} onClick={() => check.mutate()} className="rounded-md bg-getmeds-blue px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {check.isPending ? 'Checking…' : isReturn ? 'Credit note is in Zoho, check' : 'Payment is in Zoho, check'}
            </button>
          </div>
        )}
      </div>
      <DevZohoButtons soId={r.zoho_so_id} amount={r.requested_amount} actions={isReturn ? ['credit', 'wrongcredit'] : ['unpay', 'pay']} />
    </li>
  );
};

const ZohoStepsPanel = ({ canAct }) => {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: FINANCE_STEPS_KEY,
    queryFn: () => client.get('/api/refund-requests/finance-steps').then((r) => r.data?.data?.requests || [])
  });
  const rows = data || [];
  const done = () => { qc.invalidateQueries({ queryKey: FINANCE_STEPS_KEY }); qc.invalidateQueries({ queryKey: ['refunds'] }); };

  if (isLoading) return <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>;
  if (rows.length === 0) return <p className="p-6 text-sm text-ink-secondary">No refund is waiting for a step in Zoho.</p>;
  return <ul>{rows.map((r) => <StepCard key={r.id} r={r} canAct={canAct} onDone={done} />)}</ul>;
};

export default ZohoStepsPanel;
