import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Clock } from 'lucide-react';
import { useVoidRequests } from '../../hooks/useVoidRequests';

/**
 * Top of the Dispatch page: the orders whose invoice has to be voided in Zoho for a refund, and what to do. Oct 22, 2026.
 *
 *   amber  Management approved it: these are yours now (goods returned, void in Zoho, close the Sales Order)
 *   grey   still waiting for Management: a heads-up, with nothing to do yet
 *
 * Disappears when neither is there. The checklist itself is the Void requests card (VoidRequestsPanel).
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const todo = (r) => {
  if (r.stage === 'so') return `void or cancel Sales Order ${r.zoho_so_number} in Zoho`;
  if (r.next === 'dispatch_goods') return 'record the goods as returned, then void the invoice in Zoho';
  if (r.next === 'dispatch_void') return `void ${r.zoho_invoice_number} in Zoho, then press check`;
  return 'waiting for Finance to remove the payment from the invoice first';
};

const RefundAttentionBanner = () => {
  const { data } = useVoidRequests();
  const rows = data?.requests || [];
  const upcoming = data?.upcoming || [];
  if (rows.length === 0 && upcoming.length === 0) return null;

  const mine = rows.filter((r) => r.stage === 'so' || r.next === 'dispatch_goods' || r.next === 'dispatch_void').length;

  return (
    <div className="space-y-2">
      {rows.length > 0 && (
        <div role="alert" className={`rounded-lg border px-4 py-3 text-[13px] ${mine > 0 ? 'border-amber-400 bg-amber-50 text-amber-950' : 'border-slate-300 bg-slate-50 text-slate-800'}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold flex items-center gap-1.5 text-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                {mine > 0 ? `Void in Zoho: ${mine} order${mine === 1 ? '' : 's'} need${mine === 1 ? 's' : ''} you for a refund` : `Refunds in progress (${rows.length}): nothing for Dispatch yet`}
              </p>
              <p className="mt-0.5 text-[12.5px]">Management approved these refunds. Once the invoice is void in Zoho, Management presses Refund and it goes on Finance's refund list.</p>
              <ul className="mt-2 space-y-1">
                {rows.map((r) => (
                  <li key={r.id} className="rounded-md border border-amber-200 bg-white/70 px-3 py-1.5 text-[12.5px]">
                    <Link to={`/orders/${r.order_id}`} className="font-mono font-semibold text-getmeds-blue hover:underline">{r.getmeds_order_id}</Link>
                    <span> · {r.customer_name} · <b>{r.zoho_invoice_number || r.zoho_so_number}</b> · {peso(r.requested_amount)}</span>
                    <span className="block text-ink-secondary">To do: {todo(r)}.</span>
                  </li>
                ))}
              </ul>
              {mine > 0 && (
                <div className="mt-2 rounded-md border border-amber-200 bg-white/70 px-3 py-2 text-[12.5px]">
                  <p className="font-semibold mb-0.5">What to do</p>
                  <ol className="list-decimal pl-5 space-y-0.5">
                    <li>Open <b>Void requests</b> (sidebar). If the goods are coming back, press <b>Mark goods returned</b> once they are with us.</li>
                    <li>Void the invoice <b>in Zoho yourself</b>. Zoho will not void a paid invoice: Finance removes the payment first and the card tells you when.</li>
                    <li>Come back and press <b>I voided it, check Zoho</b>. The app only checks; it never voids anything. If Zoho does not say Void yet, it tells you and nothing moves.</li>
                  </ol>
                </div>
              )}
            </div>
            <Link to="/dispatch/void-requests"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
              Open Void requests <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      )}
      {upcoming.length > 0 && (
        <div className="rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-[13px] text-slate-800">
          <p className="font-semibold flex items-center gap-1.5 text-sm"><Clock className="w-4 h-4 shrink-0" />Heads-up: {upcoming.length} refund request{upcoming.length === 1 ? '' : 's'} waiting for Management</p>
          <p className="mt-0.5 text-[12.5px]">Nothing to do yet. If Management approves, the invoice has to be voided in Zoho, and it will show above with what to do.</p>
          <ul className="mt-1.5 space-y-0.5 text-[12.5px]">
            {upcoming.map((r) => (
              <li key={r.id}>
                <Link to={`/orders/${r.order_id}`} className="font-mono font-semibold text-getmeds-blue hover:underline">{r.getmeds_order_id}</Link>
                <span> · {r.customer_name} · {r.stage === 'invoiced' ? <>invoice <b>{r.zoho_invoice_number}</b></> : <>Sales Order <b>{r.zoho_so_number}</b></>} · {peso(r.requested_amount)} · asked by {r.requested_by_name}: {r.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default RefundAttentionBanner;
