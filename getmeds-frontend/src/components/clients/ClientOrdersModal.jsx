import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X, Loader2, Pill, ChevronDown, ChevronRight, AlertTriangle, FileText } from 'lucide-react';
import client from '../../api/client';

/**
 * One client's medicines and orders, with their prescriptions. Nov 14, 2026 (Aaron).
 *
 * Opened from the Clients Directory by Dispatch (Pharmacy) and Management. Pharmacy needs to hold
 * what the client bought against the doctor's prescription, so the quantity given is exactly what
 * was prescribed. The prescribed quantity lives only on the prescription image, so each order's
 * prescription is shown right next to the quantity bought.
 *
 *   Medicines  each medicine with the total bought, how much of it was on orders with a
 *              prescription, and every order behind it (quantity, doctor, prescription images)
 *   Orders     every order, newest first, with its medicines and prescription state
 *
 * Read only; an order number opens the order. Data: GET /api/customers/:id/orders.
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
const int = (n) => Number(n || 0).toLocaleString('en-PH');
const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'Asia/Manila' }) : '—');
const statusLabel = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const RxBadge = ({ state }) => {
  const rx = RX[state] || RX.none;
  return <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold border whitespace-nowrap ${rx.cls}`}>{rx.label}</span>;
};

/** The order's prescription files: thumbnails for images, a link for anything else. Opens full size. */
const RxFiles = ({ files }) => {
  if (!files || !files.length) return <span className="text-[11px] text-slate-400">—</span>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((f) => (
        <a key={f.id} href={f.view_url} target="_blank" rel="noreferrer" title={`${f.file_name} (${f.status}) — open full size`}
          className="block rounded border border-slate-200 overflow-hidden hover:ring-2 hover:ring-getmeds-blue">
          {f.is_image ? (
            <img src={f.thumb_url} alt={f.file_name} loading="lazy" className="w-14 h-14 object-cover bg-slate-50" />
          ) : (
            <span className="w-14 h-14 flex flex-col items-center justify-center text-[10px] text-ink-secondary bg-slate-50"><FileText className="w-5 h-5" />PDF</span>
          )}
        </a>
      ))}
    </div>
  );
};

const MedicineRow = ({ m, open, onToggle, onClose }) => {
  const withoutRx = m.total_qty - m.rx_qty;
  return (
    <>
      <tr className="hover:bg-slate-50 cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2.5">
          <div className="flex items-center gap-1.5 font-semibold text-ink-primary">
            {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
            {m.name}
          </div>
        </td>
        <td className="px-4 py-2.5 text-right font-mono tabular-nums font-semibold">{int(m.total_qty)} <span className="text-[11px] font-sans font-normal text-ink-secondary">{m.unit || ''}</span></td>
        <td className="px-4 py-2.5 text-right tabular-nums">{int(m.orders)}</td>
        <td className="px-4 py-2.5 text-right tabular-nums">{int(m.rx_qty)}</td>
        <td className="px-4 py-2.5">
          {withoutRx > 0 ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-amber-800"><AlertTriangle className="w-3.5 h-3.5" />{int(withoutRx)} without Rx</span>
          ) : <span className="text-[11px] text-pharmacy-green-dark font-semibold">All on Rx</span>}
        </td>
        <td className="px-4 py-2.5 text-ink-secondary whitespace-nowrap">{day(m.last_at)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={6} className="bg-slate-50/70 px-4 py-3">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-left text-[10.5px] uppercase tracking-wide text-ink-secondary">
                  <th className="py-1 pr-3">Date</th><th className="py-1 pr-3">Order</th><th className="py-1 pr-3 text-right">Qty</th>
                  <th className="py-1 pr-3">Doctor</th><th className="py-1 pr-3">Prescription</th><th className="py-1">Prescription file</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/70">
                {m.lines.map((l, i) => (
                  <tr key={`${l.order_id}-${i}`} className="align-top">
                    <td className="py-2 pr-3 whitespace-nowrap text-ink-secondary">{day(l.created_at)}</td>
                    <td className="py-2 pr-3 whitespace-nowrap"><Link to={`/orders/${l.order_id}`} onClick={onClose} className="font-semibold text-getmeds-blue hover:underline">{l.getmeds_order_id}</Link></td>
                    <td className="py-2 pr-3 text-right font-mono tabular-nums font-semibold">{int(l.quantity)}</td>
                    <td className="py-2 pr-3 text-ink-secondary">{l.doctor || '—'}</td>
                    <td className="py-2 pr-3"><RxBadge state={l.rx_state} /></td>
                    <td className="py-2"><RxFiles files={l.prescriptions} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
};

const ClientOrdersModal = ({ client: cl, onClose }) => {
  const [tab, setTab] = useState('medicines');
  const [rxOnly, setRxOnly] = useState(false);
  const [openMed, setOpenMed] = useState(null);
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
  const meds = data?.medicines || [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-10" role="dialog" aria-modal="true" aria-labelledby="client-orders-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={onClose} aria-hidden="true" />
      <div className="relative w-full max-w-5xl rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="client-orders-title" className="text-base font-semibold text-ink-primary truncate">{cl.name}</h2>
            <p className="text-xs text-ink-secondary mt-0.5">
              {isLoading ? 'Loading…' : `${meds.length} medicine${meds.length === 1 ? '' : 's'} · ${all.length} order${all.length === 1 ? '' : 's'} · ${withRx.length} with a prescription`}
              {data?.limited ? ' · showing the latest 200 orders' : ''}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-ink-primary">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 pt-3 flex items-center gap-1 border-b border-slate-100">
          {[['medicines', 'Medicines bought'], ['orders', 'Orders']].map(([k, label]) => (
            <button key={k} type="button" onClick={() => setTab(k)}
              className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px ${tab === k ? 'border-getmeds-blue text-getmeds-blue' : 'border-transparent text-ink-secondary hover:text-ink-primary'}`}>
              {label}
            </button>
          ))}
          {tab === 'orders' && (
            <div className="ml-auto flex items-center gap-2 pb-2">
              {[[false, 'All orders'], [true, 'With prescription']].map(([v, label]) => (
                <button key={label} type="button" onClick={() => setRxOnly(v)}
                  className={`inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold border ${rxOnly === v ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
                  {v && <Pill className="w-3.5 h-3.5" />}{label}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="max-h-[68vh] overflow-auto">
          {isLoading ? (
            <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading…</p>
          ) : isError ? (
            <p className="p-6 text-sm text-red-700">Could not load this client's orders.</p>
          ) : tab === 'medicines' ? (
            meds.length === 0 ? <p className="p-6 text-sm text-ink-secondary">No medicines bought yet.</p> : (
              <>
                <p className="px-5 pt-3 text-[12px] text-ink-secondary">
                  Click a medicine to see every order behind it, with the quantity and the prescription beside it. Check the total against what the doctor prescribed.
                </p>
                <table className="w-full text-sm mt-2" style={{ minWidth: 760 }}>
                  <thead>
                    <tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary border-b border-slate-200">
                      <th className="px-4 py-2.5">Medicine</th>
                      <th className="px-4 py-2.5 text-right">Total bought</th>
                      <th className="px-4 py-2.5 text-right">Orders</th>
                      <th className="px-4 py-2.5 text-right">On orders with Rx</th>
                      <th className="px-4 py-2.5">Check</th>
                      <th className="px-4 py-2.5">Last bought</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {meds.map((m) => (
                      <MedicineRow key={m.product_id} m={m} open={openMed === m.product_id} onClose={onClose}
                        onToggle={() => setOpenMed(openMed === m.product_id ? null : m.product_id)} />
                    ))}
                  </tbody>
                </table>
              </>
            )
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-ink-secondary">{rxOnly ? 'No orders with a prescription.' : 'No orders for this client.'}</p>
          ) : (
            <table className="w-full text-sm" style={{ minWidth: 860 }}>
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary border-b border-slate-200">
                  <th className="px-4 py-2.5">Date</th>
                  <th className="px-4 py-2.5">Order</th>
                  <th className="px-4 py-2.5">Medicines</th>
                  <th className="px-4 py-2.5">Prescription</th>
                  <th className="px-4 py-2.5">Doctor · MedRep</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((o) => (
                  <tr key={o.id} className="hover:bg-slate-50 align-top">
                    <td className="px-4 py-2 whitespace-nowrap text-ink-secondary">{day(o.created_at)}</td>
                    <td className="px-4 py-2 whitespace-nowrap">
                      <Link to={`/orders/${o.id}`} onClick={onClose} className="font-semibold text-getmeds-blue hover:underline">{o.getmeds_order_id}</Link>
                      {o.zoho_so_number && <div className="text-[11px] text-ink-secondary">{o.zoho_so_number}</div>}
                    </td>
                    <td className="px-4 py-2 text-[12.5px]">
                      {o.items.map((l, i) => (
                        <div key={i}><span className="font-mono font-semibold tabular-nums">{int(l.quantity)}×</span> {l.name}{l.unit_price === 0 ? <span className="text-[11px] text-ink-secondary"> (free)</span> : null}</div>
                      ))}
                    </td>
                    <td className="px-4 py-2"><div className="mb-1"><RxBadge state={o.rx_state} /></div><RxFiles files={o.prescriptions} /></td>
                    <td className="px-4 py-2 text-ink-secondary text-[12.5px]">{o.doctor || '—'}<div className="text-[11px]">{o.medrep || ''}</div></td>
                    <td className="px-4 py-2 whitespace-nowrap text-ink-secondary">{statusLabel(o.status)}</td>
                    <td className="px-4 py-2 text-right font-mono tabular-nums">{peso(o.total_amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
};

export default ClientOrdersModal;
