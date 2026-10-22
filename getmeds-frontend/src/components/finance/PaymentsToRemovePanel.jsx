import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Loader2 } from 'lucide-react';
import client from '../../api/client';
import DevZohoButtons from './DevZohoButtons';

/**
 * Refunds approved on a PAID invoice. Oct 22, 2026. Zoho will not void a paid invoice, so Finance takes the
 * payment off it in Zoho and presses check; the app reads Zoho and only then lets Dispatch go on. The app
 * never removes the payment itself.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const PAYMENTS_QUERY_KEY = ['payments-to-remove'];

const PaymentsToRemovePanel = ({ canAct }) => {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: PAYMENTS_QUERY_KEY,
    queryFn: () => client.get('/api/refund-requests/payments-to-remove').then((r) => r.data?.data?.requests || [])
  });
  const check = useMutation({
    mutationFn: (id) => client.post(`/api/refund-requests/${id}/payment-removed`).then((r) => r.data),
    onSuccess: () => { toast.success('Zoho shows no payment on the invoice. Dispatch can void it now.'); qc.invalidateQueries({ queryKey: PAYMENTS_QUERY_KEY }); qc.invalidateQueries({ queryKey: ['void-requests'] }); },
    onError: (err) => toast.error(err?.response?.data?.error?.message || 'Zoho still shows the payment', { duration: 9000 })
  });
  const rows = data || [];

  if (isLoading) return <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>;
  if (rows.length === 0) return <p className="p-6 text-sm text-ink-secondary">No payment is waiting to be removed.</p>;
  return (
    <ul>
      {rows.map((r) => (
        <li key={r.id} className="px-4 py-3 border-b border-slate-100 last:border-0">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Link to={`/orders/${r.order_id}`} className="font-mono font-semibold text-getmeds-blue hover:underline text-sm">{r.getmeds_order_id}</Link>
              <span className="text-sm text-ink-primary"> · {r.customer_name} · <b>{r.zoho_invoice_number}</b></span>
              <p className="text-xs text-ink-secondary mt-0.5">
                Refund {peso(r.requested_amount)} approved by {r.decided_by_name || 'Management'}. Take the payment of {peso(r.amount_paid)} off the invoice in Zoho so Dispatch can void it.
              </p>
              {r.payment_applied === null && <p className="text-xs text-amber-800 mt-0.5">Zoho could not be read when it was approved, so check whether a payment is on it.</p>}
            </div>
            {canAct && (
              <button type="button" disabled={check.isPending} onClick={() => check.mutate(r.id)}
                className="rounded-md bg-getmeds-blue px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                {check.isPending && check.variables === r.id ? 'Checking…' : 'I removed it, check Zoho'}
              </button>
            )}
          </div>
          <DevZohoButtons soId={r.zoho_so_id} actions={['unpay', 'pay']} />
        </li>
      ))}
    </ul>
  );
};

export default PaymentsToRemovePanel;
