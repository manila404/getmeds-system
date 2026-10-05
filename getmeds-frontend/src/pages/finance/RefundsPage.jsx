import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Banknote, AlertTriangle } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../context/AuthContext';
import RefundModal from '../../components/orders/RefundModal';

/**
 * Cancelled drafts that were paid in advance, and the refunds owed. Oct 5, 2026.
 *
 * Finance and Admin work the list off (Record refund); Management reads it to track
 * money owed back to customers. Loads when opened — no automatic refresh.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const TABS = [['pending', 'Refund pending'], ['done', 'Refund done'], ['not_due', 'No refund due'], ['all', 'All']];
const CHIP = {
  pending: 'bg-amber-100 text-amber-900 border-amber-300',
  done: 'bg-emerald-100 text-emerald-900 border-emerald-300',
  not_due: 'bg-slate-100 text-slate-700 border-slate-300'
};
const LABEL = { pending: 'Refund pending', done: 'Refund done', not_due: 'No refund due' };

const RefundsPage = () => {
  const { user } = useAuth();
  const canRecord = ['finance', 'admin'].includes(user?.role);
  const qc = useQueryClient();
  const [tab, setTab] = useState('pending');
  const [editing, setEditing] = useState(null);

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['refunds', tab],
    queryFn: () => client.get('/api/finance/refunds', { params: tab === 'all' ? {} : { status: tab } }).then((r) => r.data?.data),
    staleTime: 30_000
  });
  const s = data?.summary;
  const rows = data?.refunds || [];

  return (
    <div className="max-w-6xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-semibold text-ink-primary">Cancelled with payment</h1>
      <p className="text-sm text-ink-secondary mt-1 max-w-3xl">
        Drafts the customer paid for in advance and then cancelled. They are kept on record, never deleted, and the refund is followed up here.
        {canRecord ? '' : ' You can see the list; Finance records the refunds.'}
      </p>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-4">
        {[
          ['Refunds pending', s ? s.pending_count : '—', s ? peso(s.pending_amount) + ' held' : ''],
          ['Waiting over 3 days', s ? s.overdue_count : '—', s?.overdue_count ? 'follow up' : 'none overdue'],
          ['Refunds done', s ? s.done_count : '—', s ? peso(s.done_amount) + ' refunded' : ''],
          ['Closed, no refund due', s ? s.not_due_count : '—', '']
        ].map(([t, v, sub], i) => (
          <div key={t} className={`rounded-xl border bg-white p-4 ${i === 1 && s?.overdue_count ? 'border-red-300' : 'border-slate-200'}`}>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{t}</p>
            <p className={`text-2xl font-bold mt-1 ${i === 1 && s?.overdue_count ? 'text-red-600' : 'text-ink-primary'}`}>{v}</p>
            <p className="text-xs text-ink-secondary mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mt-5">
        {TABS.map(([k, t]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${tab === k ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'border-slate-300 text-ink-secondary bg-white'}`}>{t}</button>
        ))}
      </div>

      <div className="mt-3 rounded-xl border border-slate-200 bg-white overflow-x-auto">
        {isLoading ? (
          <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>
        ) : isError ? (
          <p className="p-6 text-sm text-red-700">Could not load the list. <button className="underline" onClick={() => refetch()}>Try again</button></p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-sm text-ink-secondary">Nothing here.</p>
        ) : (
          <table className="w-full text-sm min-w-[860px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary border-b border-slate-200">
                <th className="px-4 py-2.5">Order</th><th className="px-3 py-2.5">Customer</th><th className="px-3 py-2.5">MedRep</th>
                <th className="px-3 py-2.5 text-right">Held</th><th className="px-3 py-2.5">Cancelled</th><th className="px-3 py-2.5">Status</th>
                {canRecord && <th className="px-3 py-2.5" />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 align-top">
                  <td className="px-4 py-3 font-semibold"><Link className="text-getmeds-blue hover:underline" to={`/orders/${r.id}`}>{r.getmeds_order_id}</Link></td>
                  <td className="px-3 py-3">{r.customer_name}</td>
                  <td className="px-3 py-3">{r.medrep_name}</td>
                  <td className="px-3 py-3 text-right tabular-nums">{peso(r.held_amount)}</td>
                  <td className="px-3 py-3">
                    <span className="block">{r.draft_cancelled_at ? new Date(r.draft_cancelled_at).toLocaleDateString() : ''}{r.cancelled_by_name ? ` · ${r.cancelled_by_name}` : ''}</span>
                    <span className="block text-xs text-ink-secondary max-w-[260px]">{r.draft_cancel_reason}</span>
                  </td>
                  <td className="px-3 py-3">
                    <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border ${CHIP[r.refund_status] || ''}`}>{LABEL[r.refund_status] || r.refund_status}</span>
                    {r.refund_status === 'pending' && r.days_waiting >= 3 && (
                      <span className="mt-1 flex items-center gap-1 text-[11px] text-red-700"><AlertTriangle className="w-3 h-3" />{r.days_waiting} days waiting</span>
                    )}
                    {r.refund_status === 'done' && (
                      <span className="block text-xs text-ink-secondary mt-1">{peso(r.refund_amount)} · ref {r.refund_reference}{r.kept_amount > 0 ? ` · kept ${peso(r.kept_amount)}` : ''}</span>
                    )}
                    {r.refund_status === 'not_due' && r.refund_note && <span className="block text-xs text-ink-secondary mt-1">{r.refund_note}</span>}
                  </td>
                  {canRecord && (
                    <td className="px-3 py-3 text-right">
                      <button type="button" onClick={() => setEditing(r)} className="inline-flex items-center gap-1 text-xs font-semibold text-getmeds-blue hover:underline">
                        <Banknote className="w-3.5 h-3.5" />{r.refund_status === 'pending' ? 'Record refund' : 'Edit'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {editing && (
        <RefundModal
          order={editing}
          onClose={() => setEditing(null)}
          onDone={() => { setEditing(null); qc.invalidateQueries({ queryKey: ['refunds'] }); qc.invalidateQueries({ queryKey: ['refund-summary'] }); }}
        />
      )}
    </div>
  );
};

export default RefundsPage;
