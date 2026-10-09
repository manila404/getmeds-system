import React, { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X, Loader2, ShieldCheck, AlertTriangle, CheckCircle2, Package, ChevronDown, ChevronRight } from 'lucide-react';
import client from '../../api/client';

/**
 * Management approves an order, after seeing its stock. Oct 9, 2026.
 *
 * Shows, for each line, how much is available to sell in the chosen Zoho warehouse (read live
 * from Zoho when this opens), and lets Management pick which warehouse the Sales Order is sent
 * from. A warehouse that cannot fill a line is flagged, and approving from it needs an explicit
 * tick. If Zoho cannot be reached the check is skipped with a notice and approval works exactly
 * as it did before: the check is advice, never a gate on the system.
 */

const errorMessage = (err, fallback) => err?.response?.data?.error?.message || fallback;
const fmt = (n) => Number(n || 0).toLocaleString('en-PH');

const Chip = ({ status, shortBy }) => {
  if (status === 'ok') return <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-900 border border-emerald-300 px-2 py-0.5 text-[11px] font-semibold"><CheckCircle2 className="w-3 h-3" />Enough</span>;
  if (status === 'short') return <span className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-900 border border-red-300 px-2 py-0.5 text-[11px] font-semibold"><AlertTriangle className="w-3 h-3" />Short by {fmt(shortBy)}</span>;
  return <span className="inline-flex rounded-full bg-slate-100 text-slate-700 border border-slate-300 px-2 py-0.5 text-[11px] font-semibold">Not checked</span>;
};

const ApproveOrderModal = ({ orderId, orderRef, onClose, onApproved }) => {
  const [warehouseId, setWarehouseId] = useState(null);
  const [ack, setAck] = useState(false);
  const [open, setOpen] = useState({});

  const check = useQuery({
    queryKey: ['stock-check', orderId, warehouseId],
    queryFn: () =>
      client.get(`/api/orders/${orderId}/stock-check`, { params: warehouseId ? { warehouse_id: warehouseId } : {} }).then((r) => r.data?.data),
    staleTime: 30 * 1000,
    keepPreviousData: true,
    retry: false
  });
  const d = check.data;
  const usable = !!d?.available;
  const chosenId = usable ? d.selected_warehouse_id : null;
  const chosen = usable ? d.warehouses.find((w) => w.id === chosenId) : null;
  const shortCount = usable ? d.summary.short_lines : 0;
  const needsAck = shortCount > 0;

  const approve = useMutation({
    mutationFn: () =>
      client
        .post(`/api/orders/${orderId}/approve`, usable ? { warehouse_id: chosenId, stock_ack: needsAck ? ack : false } : {})
        .then((r) => r.data),
    onSuccess: (res) => onApproved(res),
    onError: (err) => toast.error(errorMessage(err, 'Could not approve that order'), { duration: 8000 })
  });

  const pick = (id) => { setWarehouseId(id); setAck(false); };
  const canApprove = !check.isLoading && !approve.isPending && (!usable || !needsAck || ack);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-10">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-bold text-ink-primary flex items-center gap-2"><Package className="w-4 h-4 text-getmeds-blue" />Approve and check stock</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{orderRef}</p>
          </div>
          <button type="button" onClick={onClose} disabled={approve.isPending} className="text-ink-secondary hover:text-ink-primary" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {check.isLoading ? (
            <p className="text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Checking stock in Zoho…</p>
          ) : !usable ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[13px] text-amber-900">
              <strong>Stock could not be checked.</strong> {d?.reason || errorMessage(check.error, 'Zoho did not answer.')} You can still approve; the order
              goes to Zoho's main warehouse as usual.
            </p>
          ) : (
            <>
              <div>
                <p className="block text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-1.5">
                  Send from warehouse <span className="normal-case font-normal">(click one to choose)</span>
                </p>
                <div role="radiogroup" aria-label="Warehouse" className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {d.warehouses.map((w) => {
                    const on = w.id === chosenId;
                    return (
                      <label
                        key={w.id}
                        className={`flex items-start gap-2 rounded-lg border px-3 py-2 cursor-pointer text-[13px] ${
                          on ? 'border-getmeds-blue bg-blue-50 ring-1 ring-getmeds-blue' : 'border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <input type="radio" name="warehouse" className="mt-1" checked={on} onChange={() => pick(w.id)} />
                        <span className="min-w-0">
                          <span className="block font-semibold text-ink-primary">{w.name}{w.is_primary ? <span className="ml-1 text-[10px] font-semibold uppercase text-ink-secondary">main</span> : null}</span>
                          {w.fills_all
                            ? <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-800"><CheckCircle2 className="w-3 h-3" />Can fill every line</span>
                            : <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-800"><AlertTriangle className="w-3 h-3" />Short on {w.short_lines} line{w.short_lines === 1 ? '' : 's'}</span>}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {check.isFetching && <p className="mt-1 text-[11px] text-ink-secondary flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />Updating…</p>}
              </div>

              <div className="overflow-hidden rounded-lg border border-slate-200">
                <table className="w-full text-[13px]">
                  <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-ink-secondary">
                    <tr>
                      <th className="text-left px-3 py-2 font-semibold">Item</th>
                      <th className="text-right px-3 py-2 font-semibold">Ordered</th>
                      <th className="text-right px-3 py-2 font-semibold">Available here</th>
                      <th className="text-left px-3 py-2 font-semibold">Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.lines.map((l) => {
                      const here = l.per_warehouse.find((p) => p.warehouse_id === chosenId);
                      const isOpen = !!open[l.line_id];
                      return (
                        <React.Fragment key={l.line_id}>
                          <tr className="border-t border-slate-100">
                            <td className="px-3 py-2">
                              <button type="button" onClick={() => setOpen((o) => ({ ...o, [l.line_id]: !isOpen }))} disabled={!l.per_warehouse.length} className="flex items-start gap-1 text-left">
                                {l.per_warehouse.length ? (isOpen ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 shrink-0" /> : <ChevronRight className="w-3.5 h-3.5 mt-0.5 shrink-0" />) : <span className="w-3.5" />}
                                <span><span className="font-medium text-ink-primary">{l.name}</span>{l.sku ? <span className="block text-[11px] text-ink-secondary">{l.sku}</span> : null}</span>
                              </button>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums">{fmt(l.quantity)}</td>
                            <td className="px-3 py-2 text-right tabular-nums">{here ? fmt(here.available) : '—'}</td>
                            <td className="px-3 py-2"><Chip status={l.status} shortBy={l.short_by} />{l.note ? <span className="block text-[11px] text-ink-secondary mt-0.5">{l.note}</span> : null}</td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-slate-50/60">
                              <td colSpan={4} className="px-3 pb-2.5 pt-1">
                                <p className="text-[11px] text-ink-secondary mb-1">Available for sale in each warehouse (on hand minus already committed):</p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-0.5">
                                  {l.per_warehouse.map((p) => (
                                    <div key={p.warehouse_id} className={`flex justify-between text-[12px] ${p.warehouse_id === chosenId ? 'font-semibold text-ink-primary' : 'text-ink-secondary'}`}>
                                      <span>{p.warehouse_name}</span>
                                      <span className="tabular-nums">{fmt(p.available)} <span className="text-[10px] font-normal">({fmt(p.on_hand)} on hand, {fmt(p.committed)} committed)</span></span>
                                    </div>
                                  ))}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {needsAck ? (
                <>
                  {d.warehouses.some((w) => w.fills_all && w.id !== chosenId) && (
                    <div className="flex flex-wrap items-center gap-2 text-[12px]">
                      <span className="text-ink-secondary">Can fill the whole order:</span>
                      {d.warehouses.filter((w) => w.fills_all && w.id !== chosenId).map((w) => (
                        <button key={w.id} type="button" onClick={() => pick(w.id)} className="px-2.5 py-1 rounded-md border border-emerald-400 bg-emerald-50 text-emerald-900 font-semibold hover:bg-emerald-100">
                          Switch to {w.name}
                        </button>
                      ))}
                    </div>
                  )}
                  <label className="flex items-start gap-2 rounded-lg border border-red-300 bg-red-50 px-3 py-2.5 text-[13px] text-red-900 cursor-pointer">
                    <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    <span><strong>{chosen?.name} cannot fill {shortCount} line{shortCount === 1 ? '' : 's'} of this order.</strong> Choose another warehouse above, or tick this to approve anyway.</span>
                  </label>
                </>
              ) : d.summary.unknown_lines > 0 ? (
                <p className="text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">{d.summary.unknown_lines} line(s) could not be checked (not linked to a Zoho item, or Zoho did not answer for them).</p>
              ) : (
                <p className="text-[12px] text-emerald-900 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">{chosen?.name} has enough stock for every line.</p>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
          <button type="button" onClick={onClose} disabled={approve.isPending} className="px-3.5 py-2 rounded-md border border-slate-200 bg-white text-sm font-medium text-ink-secondary">Cancel</button>
          <button
            type="button"
            disabled={!canApprove}
            onClick={() => approve.mutate()}
            className="px-4 py-2 rounded-md bg-pharmacy-green text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {approve.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
            {approve.isPending ? 'Syncing to Zoho…' : usable ? `Approve — sync to Zoho from ${chosen?.name}` : 'Approve — sync to Zoho'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default ApproveOrderModal;
