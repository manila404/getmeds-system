import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Clock } from 'lucide-react';
import { useReturnChecks } from '../../hooks/useReturnChecks';

/**
 * Top of the Dispatch page: refunds where the goods are coming back, and what to do. Oct 22, 2026; reworked Oct 23, 2026
 * (Finance: there is no void, so Dispatch has nothing to do in Zoho).
 *
 *   amber  Management approved it: when the goods are with us, check the items and record their condition
 *   grey   still waiting for Management: a heads-up, with nothing to do yet
 *
 * Disappears when neither is there. The checklist itself is the Return checks card (ReturnChecksPanel).
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const RefundAttentionBanner = () => {
  const { data } = useReturnChecks();
  const rows = data?.requests || [];
  const upcoming = data?.upcoming || [];
  if (rows.length === 0 && upcoming.length === 0) return null;

  return (
    <div className="space-y-2">
      {rows.length > 0 && (
        <div role="alert" className="rounded-lg border border-amber-400 bg-amber-50 px-4 py-3 text-[13px] text-amber-950">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold flex items-center gap-1.5 text-sm">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                Return check: {rows.length} refund{rows.length === 1 ? '' : 's'} waiting for you to check the returned goods
              </p>
              <p className="mt-0.5 text-[12.5px]">Management approved these refunds. When the goods are with us, check the items and record their condition. Management then checks it and Finance creates the credit note. Nothing to do in Zoho.</p>
              <ul className="mt-2 space-y-1">
                {rows.map((r) => (
                  <li key={r.id} className="rounded-md border border-amber-200 bg-white/70 px-3 py-1.5 text-[12.5px]">
                    <Link to={`/orders/${r.order_id}`} className="font-mono font-semibold text-getmeds-blue hover:underline">{r.getmeds_order_id}</Link>
                    <span> · {r.customer_name} · <b>{r.zoho_invoice_number || r.zoho_so_number}</b> · {peso(r.requested_amount)}</span>
                    <span className="block text-ink-secondary">To do: check the returned items and record good condition or damaged.</span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 rounded-md border border-amber-200 bg-white/70 px-3 py-2 text-[12.5px]">
                <p className="font-semibold mb-0.5">What to do</p>
                <ol className="list-decimal pl-5 space-y-0.5">
                  <li>Open <b>Return checks</b> (sidebar) and wait until the goods are physically back.</li>
                  <li>Check the items against the order: right products, batches and quantities, sealed and in date.</li>
                  <li>Press <b>Good condition</b>, or <b>Damaged</b> and say what is wrong. It goes to Management.</li>
                </ol>
              </div>
            </div>
            <Link to="/dispatch/return-checks"
              className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
              Open Return checks <ArrowRight className="w-3.5 h-3.5" />
            </Link>
          </div>
        </div>
      )}
      {upcoming.length > 0 && (
        <div className="rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-[13px] text-slate-800">
          <p className="font-semibold flex items-center gap-1.5 text-sm"><Clock className="w-4 h-4 shrink-0" />Heads-up: {upcoming.length} return request{upcoming.length === 1 ? '' : 's'} waiting for Management</p>
          <p className="mt-0.5 text-[12.5px]">Nothing to do yet. If Management approves, the returned goods will need your check, and it will show above.</p>
          <ul className="mt-1.5 space-y-0.5 text-[12.5px]">
            {upcoming.map((r) => (
              <li key={r.id}>
                <Link to={`/orders/${r.order_id}`} className="font-mono font-semibold text-getmeds-blue hover:underline">{r.getmeds_order_id}</Link>
                <span> · {r.customer_name} · {r.zoho_invoice_number ? <>invoice <b>{r.zoho_invoice_number}</b></> : <>Sales Order <b>{r.zoho_so_number}</b></>} · {peso(r.requested_amount)} · asked by {r.requested_by_name}: {r.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default RefundAttentionBanner;
