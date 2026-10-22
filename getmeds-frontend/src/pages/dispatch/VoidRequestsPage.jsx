import React from 'react';
import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';
import VoidRequestsPanel from '../../components/dispatch/VoidRequestsPanel';
import { useVoidRequests } from '../../hooks/useVoidRequests';

/**
 * Dispatch's own page for refunds. Oct 22, 2026.
 *
 * When Management approves a refund on an invoiced order, the invoice has to be voided IN ZOHO BY HAND. This page is the
 * checklist: goods returned, the payment removed by Finance, the void, then the app checks Zoho. It never voids anything.
 * Below it, a heads-up for requests Management has not decided yet.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const VoidRequestsPage = () => {
  const { data } = useVoidRequests();
  const upcoming = data?.upcoming || [];
  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink-primary">Void requests</h1>
        <p className="text-sm text-ink-secondary mt-1 max-w-3xl">
          Refunds Management approved. Clear each one in Zoho by hand, then press check: the app reads Zoho and only moves the order on when it says Void.
          Once the invoice is void, Management presses Refund and it goes on Finance's refund list.
        </p>
      </div>

      <VoidRequestsPanel alwaysShow />

      {upcoming.length > 0 && (
        <div className="rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-[13px] text-slate-800">
          <p className="font-semibold flex items-center gap-1.5 text-sm"><Clock className="w-4 h-4 shrink-0" />Heads-up: {upcoming.length} refund request{upcoming.length === 1 ? '' : 's'} waiting for Management</p>
          <p className="mt-0.5 text-[12.5px]">Nothing to do yet. If Management approves, the order moves up to the list above.</p>
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

export default VoidRequestsPage;
