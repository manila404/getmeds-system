import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, ShieldCheck, Calendar, Loader2 } from 'lucide-react';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';

const todayStr = () => new Date().toISOString().slice(0, 10);

/**
 * "Each finance can see their approved/verified SO, filter it one day
 * (Today) and can select dates."
 *
 * Sep 19, 2026. Personal and narrow on purpose: this answers "what did I
 * confirm, and when" for whoever is looking at it — not a roll-up across
 * every Finance user (Zoho's own "Sales by Salesperson" report is that
 * tool, for a different question). Reads GET /api/finance/my-confirmations,
 * which is the FINANCE_VERIFIED trail filtered to the signed-in user's own
 * actor_id — the same event the queue's own "Confirmed" date already comes
 * from, just read back per person instead of per order.
 */
const MyConfirmationsPanel = ({ onClose }) => {
  const [dateFrom, setDateFrom] = useState(todayStr());
  const [dateTo, setDateTo] = useState(todayStr());

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['finance-my-confirmations', dateFrom, dateTo],
    queryFn: () =>
      client
        .get('/api/finance/my-confirmations', { params: { date_from: dateFrom, date_to: dateTo } })
        .then(r => r.data),
  });

  const orders = data?.data?.orders || [];
  const summary = data?.data?.summary || { count: 0, totalAmount: 0 };
  const isToday = dateFrom === todayStr() && dateTo === todayStr();
  const goToToday = () => { setDateFrom(todayStr()); setDateTo(todayStr()); };

  return (
    <div className="bg-white shadow rounded-lg border border-slate-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-slate-200 bg-surface flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink-primary flex items-center gap-1.5">
            <ShieldCheck className="w-4 h-4 text-getmeds-blue" /> My Confirmations
          </h2>
          <p className="text-xs text-ink-secondary mt-0.5">
            Every order you personally confirmed, in this range — not the shared queue.
          </p>
        </div>
        <button onClick={onClose} className="text-ink-secondary hover:text-ink-primary shrink-0" title="Close">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-4 py-3 border-b border-slate-200 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          From
          <input
            type="date"
            value={dateFrom}
            max={dateTo}
            onChange={(e) => setDateFrom(e.target.value)}
            className="px-2 py-1 border border-slate-200 rounded text-xs text-ink-primary focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-ink-secondary">
          To
          <input
            type="date"
            value={dateTo}
            min={dateFrom}
            onChange={(e) => setDateTo(e.target.value)}
            className="px-2 py-1 border border-slate-200 rounded text-xs text-ink-primary focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
          />
        </label>
        {!isToday && (
          <button
            type="button"
            onClick={goToToday}
            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark border border-getmeds-blue/30 rounded hover:bg-getmeds-blue/5"
          >
            <Calendar className="w-3 h-3" /> Today
          </button>
        )}
        {isFetching && !isLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-secondary" />}

        <div className="ml-auto flex items-center gap-4 text-right">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">Confirmed</p>
            <p className="text-sm font-bold text-ink-primary">{summary.count}</p>
          </div>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-secondary">Total</p>
            <p className="text-sm font-bold text-ink-primary">
              ₱{(summary.totalAmount || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}
            </p>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="w-6 h-6 animate-spin text-getmeds-blue" /></div>
      ) : orders.length === 0 ? (
        <div className="text-center py-10 text-ink-secondary">
          <p className="text-sm">
            {isToday ? "You haven't confirmed anything yet today." : 'Nothing confirmed by you in this range.'}
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {orders.map((o) => (
            <li key={o.id} className="px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-mono font-semibold text-getmeds-blue">{o.getmeds_order_id}</p>
                <p className="text-[13px] text-ink-primary truncate">{o.customer_name || '—'}</p>
                {o.zoho_so_number && (
                  <p className="text-[11px] text-ink-secondary">
                    SO: <span className="font-mono">{o.zoho_so_number}</span>
                    {o.zoho_invoice_number && <> · Invoice: <span className="font-mono">{o.zoho_invoice_number}</span></>}
                  </p>
                )}
              </div>
              <div className="text-right shrink-0">
                <p className="text-sm font-bold text-ink-primary">
                  ₱{(Number(o.total_amount) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2 })}
                </p>
                <p className="text-[11px] text-ink-secondary">{formatPHT(o.confirmed_at, 'short-datetime')}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default MyConfirmationsPanel;
