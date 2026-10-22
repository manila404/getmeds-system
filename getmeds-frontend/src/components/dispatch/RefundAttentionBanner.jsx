import React from 'react';
import { AlertTriangle, ArrowDown } from 'lucide-react';
import { useVoidRequests, VOID_REQUESTS_ID } from './VoidRequestsPanel';

/**
 * Top of the Dispatch page: refunds Management approved that are waiting on Dispatch, and what to do. Oct 22, 2026.
 * Disappears when nothing is waiting. The checklist itself is the Void requests card (VoidRequestsPanel).
 */
const RefundAttentionBanner = () => {
  const { data } = useVoidRequests();
  const rows = data || [];
  if (rows.length === 0) return null;

  const goods = rows.filter((r) => r.stage === 'invoiced' && r.next === 'dispatch_goods').length;
  const toVoid = rows.filter((r) => r.stage === 'invoiced' && r.next === 'dispatch_void').length;
  const closeSo = rows.filter((r) => r.stage === 'so').length;
  const waitingFinance = rows.filter((r) => r.stage === 'invoiced' && r.next === 'finance_payment').length;
  const mine = goods + toVoid + closeSo;

  const goDown = () => document.getElementById(VOID_REQUESTS_ID)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const Line = ({ n, children }) => (n > 0 ? <li><span className="font-semibold tabular-nums">{n}</span> {children}</li> : null);

  return (
    <div role="alert" className={`rounded-lg border px-4 py-3 text-[13px] ${mine > 0 ? 'border-amber-400 bg-amber-50 text-amber-950' : 'border-slate-300 bg-slate-50 text-slate-800'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold flex items-center gap-1.5 text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {mine > 0 ? `Refunds need your attention (${mine})` : `Refunds in progress (${rows.length}): nothing for Dispatch yet`}
          </p>
          <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
            <Line n={goods}>to record as <b>goods returned</b>: the parcel is not with the customer.</Line>
            <Line n={toVoid}>to <b>void the invoice in Zoho</b>, then press the check button.</Line>
            <Line n={closeSo}>to <b>void or cancel the Sales Order in Zoho</b> (its stock is still committed).</Line>
            <Line n={waitingFinance}>waiting for Finance to remove a payment from the invoice. Nothing to do yet.</Line>
          </ul>
          {mine > 0 && (
            <div className="mt-2 rounded-md border border-amber-200 bg-white/70 px-3 py-2 text-[12.5px]">
              <p className="font-semibold mb-0.5">What to do</p>
              <ol className="list-decimal pl-5 space-y-0.5">
                <li>Open the <b>Void requests</b> card below and read the order, the invoice number and where the goods are.</li>
                <li>If the goods are coming back, press <b>Mark goods returned</b> once they are with us.</li>
                <li>Void the invoice <b>in Zoho yourself</b> (Zoho will not void a paid invoice; Finance removes the payment first and the card tells you when).</li>
                <li>Come back and press <b>I voided it, check Zoho</b>. The app only checks; it never voids anything. If Zoho does not say Void yet, it tells you and nothing moves.</li>
              </ol>
            </div>
          )}
        </div>
        <button type="button" onClick={goDown}
          className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700">
          Go to Void requests <ArrowDown className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
};

export default RefundAttentionBanner;
