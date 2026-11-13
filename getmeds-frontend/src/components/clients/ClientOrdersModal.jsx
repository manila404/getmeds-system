import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X, Loader2, Pill } from 'lucide-react';
import client from '../../api/client';

/**
 * One client's orders, newest first, with each order's prescription state. Nov 14, 2026 (Aaron).
 *
 * Opened from the Clients Directory by Dispatch (Pharmacy) and Management, so the pharmacist can
 * backtrack a client's orders, especially the ones that needed a prescription. Read only: each
 * order number opens the order itself. Data: GET /api/customers/:id/orders.
 */

const RX = {
  verified: { label: 'Rx verified', cls: 'bg-pharmacy-green/10 text-pharmacy-green-dark border-pharmacy-green/30' },
  pending: { label: 'Rx pending', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  rejected: { label: 'Rx rejected', cls: 'bg-red-50 text-red-700 border-red-200' },
  requested: { label: 'Rx requested', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  not_required: { label: 'Rx not needed', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  none: { label: 'No Rx', cls: 'bg-white text-slate-400 border-slate-200' },
};
const HAS_RX = ['verified', 'pending', 'rejected'];
const peso = (n) => `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }) : '—');
const statusLabel = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const ClientOrdersModal = ({ client: cl, onClose }) => {
  const [rxOnly, setRxOnly] = useState(false);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['client-orders', cl.id],
    queryFn: () => client.get(`/api/customers/${cl.id}/orders`).then((r) => r.data.data),
    staleTime: 60_000,
  });

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const all = data?.orders || [];
  const withRx = all.filter((o) => HAS_RX.includes(o.rx_state));
  const rows = rxOnly ? withRx : all;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-10" role="dialog" aria-modal="true" aria-labelledby="client-orders-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-4xl rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="client-orders-title" className="text-base font-semibold text-ink-primary truncate">{cl.name}</h2>
            <p className="text-xs text-ink-secondary mt-0.5">
              {isLoading ? 'Loading orders…' : `${all.length} order${all.length === 1 ? '' : 's'} · ${withRx.length} with a prescription`}
              {data?.limited ? ' · showing the latest 200' : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-ink-primary">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-3 flex items-center gap-2 border-b border-slate-100">
          {[[false, 'All orders'], [true, 'With prescription']].map(([v, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setRxOnly(v)}
              className={`inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold border ${
                rxOnly === v ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {v && <Pill className="w-3.5 h-3.5" />}{label}
            </button>
          ))}
        </div>

        <div className="max-h-[65vh] overflow-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-700">Could not load this client's orders.</p>
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-ink-secondary">{rxOnly ? 'No orders with a prescription.' : 'No orders for this client.'}</p>
          ) : (
            <table className="w-full text-sm" style={{ minWidth: 760 }}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary border-b border-slate-200">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Order</th>
                  <th className="px-4 py-2.5">Prescription</th>
                  <th className="px-4 py-2.5">Doctor</th>
                  <th className="px-4 py-2.5">MedRep</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((o) => {
                  const rx = RX[o.rx_state] || RX.none;
                  return (
                    <tr key={o.id} className="hover:bg-slate-50">
                      <td className="px-4 py-2 whitespace-nowrap text-ink-secondary">{day(o.created_at)}</td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <Link to={`/orders/${o.id}`} onClick={onClose} className="font-semibold text-getmeds-blue hover:underline">{o.getmeds_order_id}</Link>
                        {o.zoho_so_number && <div className="text-[11px] text-ink-secondary">{o.zoho_so_number}</div>}
                      </td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border ${rx.cls}`}>{rx.label}</span>
                        {o.rx_files > 1 && <span className="ml-1 text-[11px] text-ink-secondary">{o.rx_files} files</span>}
                      </td>
                      <td className="px-4 py-2 text-ink-secondary">{o.doctor || '—'}</td>
                      <td className="px-4 py-2 text-ink-secondary">{o.medrep || '—'}</td>
                      <td className="px-4 py-2 whitespace-nowrap text-ink-secondary">{statusLabel(o.status)}</td>
                      <td className="px-4 py-2 text-right font-mono tabular-nums">{peso(o.total_amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

export default ClientOrdersModal;
