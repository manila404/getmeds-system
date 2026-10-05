import React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Banknote } from 'lucide-react';
import client from '../../api/client';

/**
 * "Refunds pending: 3 · ₱28,462" on the Finance dashboard, so a refund owed to a
 * customer cannot sit unnoticed. Oct 5, 2026. Turns red once one has waited over
 * 3 days. Loads when the page opens; it does not poll. Renders nothing when there
 * is nothing pending.
 */
const RefundsBadge = () => {
  const { data } = useQuery({
    queryKey: ['refund-summary'],
    queryFn: () => client.get('/api/finance/refunds/summary', { skipAuthRedirect: true }).then((r) => r.data?.data),
    staleTime: 60_000,
    retry: false
  });
  if (!data || !data.pending_count) return null;
  const late = data.overdue_count > 0;
  return (
    <Link
      to="/finance/refunds"
      className={`mt-2 inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[12.5px] font-semibold ${late ? 'border-red-300 bg-red-50 text-red-800' : 'border-amber-300 bg-amber-50 text-amber-900'}`}
    >
      <Banknote className="w-4 h-4" />
      Refunds pending: {data.pending_count} · ₱{Number(data.pending_amount).toLocaleString('en-PH', { maximumFractionDigits: 0 })}
      {late ? ` · ${data.overdue_count} waiting over 3 days` : ''}
    </Link>
  );
};

export default RefundsBadge;
