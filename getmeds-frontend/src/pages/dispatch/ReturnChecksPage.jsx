import React from 'react';
import { Link } from 'react-router-dom';
import { Clock } from 'lucide-react';
import ReturnChecksPanel from '../../components/dispatch/ReturnChecksPanel';
import { useReturnChecks } from '../../hooks/useReturnChecks';

/**
 * Dispatch's own page for refunds. Oct 22, 2026; reworked Oct 23, 2026 (Finance: there is no void).
 *
 * When Management approves a refund and the goods are coming back, Dispatch checks the items when they arrive and records
 * whether they are in good condition. Management then checks and presses Refund; Finance creates the credit note in Zoho.
 * Below, a heads-up for requests Management has not decided yet.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ReturnChecksPage = () => {
  const { data } = useReturnChecks();
  const upcoming = data?.upcoming || [];
  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink-primary">Return checks</h1>
        <p className="text-sm text-ink-secondary mt-1 max-w-3xl">
          Refunds Management approved where the goods are coming back. When they are with us, check the items and record whether they are in good condition.
          Management then checks it and presses Refund, and Finance creates the credit note in Zoho.
        </p>
      </div>

      <ReturnChecksPanel alwaysShow />

      {upcoming.length > 0 && (
        <div className="rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-[13px] text-slate-800">
          <p className="font-semibold flex items-center gap-1.5 text-sm"><Clock className="w-4 h-4 shrink-0" />Heads-up: {upcoming.length} return request{upcoming.length === 1 ? '' : 's'} waiting for Management</p>
          <p className="mt-0.5 text-[12.5px]">Nothing to do yet. If Management approves, the order moves up to the list above.</p>
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

export default ReturnChecksPage;
