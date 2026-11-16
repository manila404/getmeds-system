import React, { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  X, CheckCircle2, AlertTriangle, Printer, Copy, ShieldAlert, ArrowLeft, Layers, Truck
} from 'lucide-react';
import client from '../../api/client';
import DrPrintVoucherModal from './DrPrintVoucherModal';

const DrFulfillModal = ({ order, onClose, onCompleted }) => {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflictMsg, setConflictMsg] = useState('');
  const [batchData, setBatchData] = useState(null);
  const [step, setStep] = useState(1);

  const [doctorName, setDoctorName] = useState('NNH');
  const [requiresSi, setRequiresSi] = useState(false);
  const [entityKey, setEntityKey] = useState('GPI');
  const [picksByItem, setPicksByItem] = useState({});
  const [drData, setDrData] = useState(null);
  const [printOpen, setPrintOpen] = useState(false);
  const [siSuffix, setSiSuffix] = useState('');
  const [finalInvoice, setFinalInvoice] = useState(null);

  const loadState = async () => {
    setLoading(true);
    setConflictMsg('');
    try {
      const { data: res } = await client.get(`/api/dispatch/orders/${order.id}/batches`);
      const d = res.data;
      setBatchData(d);
      setDoctorName(d.order.dispatch_doctor_name || d.order.intake_doctor || 'NNH');
      setRequiresSi(Boolean(d.classification?.requires_si));
      setEntityKey(d.classification?.primary_entity || 'GPI');
      setSiSuffix(d.order.oojeema_si_number || '');

      const initPicks = {};
      for (const ln of d.lines || []) {
        initPicks[ln.order_item_id] = (ln.suggested_picks || []).map((p) => ({
          order_item_id: ln.order_item_id,
          zoho_batch_id: p.zoho_batch_id,
          zoho_batch_in_id: p.zoho_batch_in_id,
          batch_number: p.batch_number,
          expiry_date: p.expiry_date,
          quantity: Number(p.quantity || 0)
        }));
      }
      setPicksByItem(initPicks);
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to load batch options.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadState();
    const onFocus = () => {
      if (document.visibilityState === 'visible') loadState();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [order.id]);

  const handleApiError = (err, fallback) => {
    const code = err?.response?.data?.error?.code;
    const msg = err?.response?.data?.error?.message || fallback;
    if (err?.response?.status === 409) {
      setConflictMsg(msg);
      loadState();
      if (onCompleted) onCompleted();
    }
    toast.error(code ? `${msg} (${code})` : msg);
  };

  const updateBatchSelect = (line, pickIdx, batchNumber) => {
    const found = (line.available_batches || []).find((b) => b.batch_number === batchNumber);
    if (!found) return;
    setPicksByItem((prev) => {
      const list = [...(prev[line.order_item_id] || [])];
      list[pickIdx] = {
        ...list[pickIdx],
        zoho_batch_id: found.zoho_batch_id,
        zoho_batch_in_id: found.zoho_batch_in_id,
        batch_number: found.batch_number,
        expiry_date: found.expiry_date
      };
      return { ...prev, [line.order_item_id]: list };
    });
  };

  const updateBatchQty = (lineId, pickIdx, val) => {
    setPicksByItem((prev) => {
      const list = [...(prev[lineId] || [])];
      list[pickIdx] = { ...list[pickIdx], quantity: Math.max(0, Number(val) || 0) };
      return { ...prev, [lineId]: list };
    });
  };

  const addSplitBatchRow = (line) => {
    const avail = (line.available_batches || []).filter((b) => !b.is_expired);
    if (!avail.length) return;
    setPicksByItem((prev) => ({
      ...prev,
      [line.order_item_id]: [
        ...(prev[line.order_item_id] || []),
        {
          order_item_id: line.order_item_id,
          zoho_batch_id: avail[0].zoho_batch_id,
          zoho_batch_in_id: avail[0].zoho_batch_in_id,
          batch_number: avail[0].batch_number,
          expiry_date: avail[0].expiry_date,
          quantity: 0
        }
      ]
    }));
  };

  const handleSaveBatchesAndAdvance = async () => {
    setSaving(true);
    try {
      const flatPicks = Object.values(picksByItem).flat().filter((p) => Number(p.quantity) > 0);
      const { data: res } = await client.post(`/api/dispatch/orders/${order.id}/batches`, {
        doctor_name: doctorName,
        requires_si: requiresSi,
        picks: flatPicks,
        expected_updated_at: batchData?.order?.updated_at || null
      });
      setBatchData(res.data);

      if (!requiresSi) {
        setStep(3);
        toast.success('Batches saved — skipped DR (No SI required).');
        return;
      }

      const { data: drRes } = await client.post(`/api/dispatch/orders/${order.id}/dr`, {
        entity_key: entityKey,
        doctor_name: doctorName,
        expected_updated_at: res.data.order?.updated_at || null
      });
      setDrData(drRes.data);
      setStep(2);
      toast.success(`${drRes.data.receipt.entity_key} DR #${drRes.data.receipt.dr_number} issued!`);
      if (onCompleted) onCompleted();
    } catch (err) {
      if (err?.response?.data?.error?.code === 'DR_ALREADY_EXISTS' && err?.response?.data?.error?.details?.existing_dr?.id) {
        const existingId = err.response.data.error.details.existing_dr.id;
        const { data: existingDr } = await client.get(`/api/dispatch/dr/${existingId}`);
        setDrData(existingDr.data);
        setStep(2);
        toast('Loaded existing active DR for this order.');
      } else {
        handleApiError(err, 'Could not save batches / generate DR.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSwitchToNoSi = async () => {
    if (!drData?.receipt?.id) {
      setRequiresSi(false);
      setStep(3);
      return;
    }
    setSaving(true);
    try {
      await client.post(`/api/dispatch/dr/${drData.receipt.id}/void`, {
        reason: 'Switched from Requires SI & DR back to Patient/Doctor No-SI flow before Zoho invoicing.',
        switch_to_no_si: true,
        expected_updated_at: batchData?.order?.updated_at || null
      });
      setDrData(null);
      setRequiresSi(false);
      setStep(1);
      await loadState();
      toast.success('Unused DR marked VOID cleanly and switched to No-SI flow.');
      if (onCompleted) onCompleted();
    } catch (err) {
      handleApiError(err, 'Failed to void DR.');
    } finally {
      setSaving(false);
    }
  };

  const handleCopyOojeema = () => {
    const o = batchData?.order || {};
    const lines = (batchData?.lines || []).map((ln) => {
      const picks = (picksByItem[ln.order_item_id] || []).map((p) => `${p.batch_number} (Exp ${p.expiry_date || 'N/A'})`).join(', ');
      return `${ln.quantity} ${ln.unit || 'pc'} x ${ln.product_name}${picks ? ` [${picks}]` : ''}`;
    });
    const text = [
      `CUSTOMER: ${o.customer_name || ''}`,
      `TIN: ${o.tin || 'N/A'} | LTO: ${o.lto_license_number || 'N/A'}`,
      `ADDRESS: ${o.delivery_address || ''}`,
      `TERMS: ${o.intake_payment_terms || 'COD'} | DOCTOR: ${doctorName}`,
      `DR NO.: ${drData?.receipt?.dr_number || ''} (${entityKey})`,
      `ITEMS:\n${lines.join('\n')}`
    ].join('\n');
    navigator.clipboard?.writeText(text);
    toast.success('Copied Oojeema invoice details to clipboard!');
  };

  const handleFinalizeInvoice = async () => {
    setSaving(true);
    try {
      const { data: res } = await client.post(`/api/dispatch/orders/${order.id}/finalize-invoice`, {
        entity_key: entityKey,
        si_suffix: requiresSi ? siSuffix : null,
        doctor_name: doctorName,
        expected_updated_at: batchData?.order?.updated_at || null
      });
      setFinalInvoice(res.data);
      toast.success(`Zoho Invoice ${res.data.zoho_invoice_number || ''} created & marked Sent!`);
      if (onCompleted) onCompleted();
    } catch (err) {
      handleApiError(err, 'Failed to finalize Zoho invoice.');
    } finally {
      setSaving(false);
    }
  };

  const cls = batchData?.classification;
  const o = batchData?.order || order;

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[92vh] flex flex-col overflow-hidden border border-slate-200">
        <div className="px-5 py-3.5 bg-surface border-b border-slate-200 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-bold text-ink-primary flex items-center gap-2">
              <Layers className="w-4 h-4 text-getmeds-blue" />
              {o.getmeds_order_id} — {o.customer_name}
            </h3>
            <p className="text-xs text-ink-secondary">
              SO: {o.zoho_so_number || '—'} · Warehouse: {o.fulfil_warehouse_name || 'Main (Zoho default)'} · TIN: {o.tin || '—'} · LTO: {o.lto_license_number || '—'}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-md border border-slate-300 bg-white text-ink-secondary hover:text-ink-primary">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {conflictMsg && (
            <div className="p-3 rounded-lg border border-red-300 bg-red-50 text-red-900 text-xs flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
              <div><b>Concurrency Lock Triggered:</b> {conflictMsg}</div>
            </div>
          )}

          {cls?.is_csp && (
            <div className="p-3 rounded-lg border border-purple-300 bg-purple-50 text-purple-900 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span><b>CSP Order — DO NOT PRINT SALES ORDER in Zoho.</b> Non-stocked CSP products are handled without mandatory physical warehouse batch deduction.</span>
            </div>
          )}

          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className={`px-3 py-2 rounded-lg border ${step === 1 ? 'border-getmeds-blue bg-blue-50 font-semibold text-getmeds-blue' : 'border-slate-200 bg-surface text-ink-secondary'}`}>
              1. Doctor &amp; Zoho Batches
            </div>
            <div className={`px-3 py-2 rounded-lg border ${step === 2 ? 'border-getmeds-blue bg-blue-50 font-semibold text-getmeds-blue' : 'border-slate-200 bg-surface text-ink-secondary'}`}>
              2. {requiresSi ? 'Delivery Receipt & Print' : 'DR Skipped (No SI)'}
            </div>
            <div className={`px-3 py-2 rounded-lg border ${step === 3 ? 'border-getmeds-blue bg-blue-50 font-semibold text-getmeds-blue' : 'border-slate-200 bg-surface text-ink-secondary'}`}>
              3. {requiresSi ? 'Oojeema SI → Zoho' : 'Zoho Auto-Invoice'}
            </div>
          </div>

          {loading ? (
            <p className="text-sm text-ink-secondary py-8 text-center">Loading live Zoho batches &amp; order details…</p>
          ) : step === 1 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-surface border border-slate-200 rounded-lg p-3 text-xs">
                <div>
                  <label className="block font-semibold text-ink-secondary mb-1">Entity (Strict Separation)</label>
                  <select
                    value={entityKey}
                    onChange={(e) => setEntityKey(e.target.value)}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                  >
                    <option value="GPI">Getmeds Philippines Inc. (GPI)</option>
                    <option value="2MG">2mg Incorporated (2MG)</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-ink-secondary mb-1">Requires Oojeema SI &amp; DR?</label>
                  <select
                    value={requiresSi ? 'yes' : 'no'}
                    onChange={(e) => setRequiresSi(e.target.value === 'yes')}
                    className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                  >
                    <option value="yes">YES — Issue DR + Oojeema SI</option>
                    <option value="no">NO — Keep Zoho Auto-Invoice (Patient / Doctor)</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold text-ink-secondary mb-1">Attending Doctor (Zoho)</label>
                  <div className="flex gap-1.5">
                    <input
                      type="text"
                      value={doctorName}
                      onChange={(e) => setDoctorName(e.target.value)}
                      className="flex-1 px-2.5 py-1.5 border border-slate-300 rounded bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => setDoctorName('NNH')}
                      className="px-2 py-1 border border-slate-300 rounded bg-white hover:bg-slate-50 font-semibold"
                    >
                      NNH
                    </button>
                  </div>
                </div>
              </div>

              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="min-w-full text-xs">
                  <thead className="bg-surface border-b border-slate-200">
                    <tr>
                      <th className="px-3 py-2 text-left">Medicine</th>
                      <th className="px-3 py-2 text-left">Qty</th>
                      <th className="px-3 py-2 text-left">Warehouse FEFO Zoho Batches</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(batchData?.lines || []).map((ln) => {
                      const linePicks = picksByItem[ln.order_item_id] || [];
                      return (
                        <tr key={ln.order_item_id}>
                          <td className="px-3 py-2.5 font-medium text-ink-primary">
                            {ln.product_name}
                            {ln.is_csp && <span className="ml-1.5 px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 text-[10px] font-bold">CSP</span>}
                          </td>
                          <td className="px-3 py-2.5 font-semibold">{ln.quantity} {ln.unit || 'pc'}</td>
                          <td className="px-3 py-2.5 space-y-1.5">
                            {ln.is_csp && !(ln.available_batches || []).length ? (
                              <span className="text-ink-secondary">CSP non-stocked item</span>
                            ) : !(ln.available_batches || []).length ? (
                              <span className="text-ink-secondary">No batch-tracked stock returned from Zoho</span>
                            ) : (
                              <>
                                {linePicks.map((p, idx) => (
                                  <div key={idx} className="flex flex-wrap items-center gap-2">
                                    <select
                                      value={p.batch_number}
                                      onChange={(e) => updateBatchSelect(ln, idx, e.target.value)}
                                      className="px-2 py-1 border border-slate-300 rounded bg-white"
                                    >
                                      {ln.available_batches.map((b) => (
                                        <option key={b.batch_number} value={b.batch_number} disabled={b.is_expired}>
                                          {b.batch_number} · Exp {b.expiry_date || 'N/A'} · Avail {b.available_quantity}{b.is_expired ? ' (EXPIRED)' : ''}
                                        </option>
                                      ))}
                                    </select>
                                    <input
                                      type="number"
                                      min="0"
                                      max={ln.quantity}
                                      value={p.quantity}
                                      onChange={(e) => updateBatchQty(ln.order_item_id, idx, e.target.value)}
                                      className="w-20 px-2 py-1 border border-slate-300 rounded bg-white"
                                    />
                                  </div>
                                ))}
                                <button
                                  type="button"
                                  onClick={() => addSplitBatchRow(ln)}
                                  className="text-[11px] font-semibold text-getmeds-blue hover:underline"
                                >
                                  + Split across another batch
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : step === 2 && drData ? (
            <div className="space-y-3">
              <div className="p-3 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 text-xs flex flex-wrap items-center justify-between gap-2">
                <span>
                  <b>{drData.receipt.entity_key} DR #{drData.receipt.dr_number}</b> generated atomically. You can go back to edit batches, print the DR, or void &amp; switch to No-SI if classified by mistake.
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPrintOpen(true)}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-getmeds-blue text-white font-semibold"
                  >
                    <Printer className="w-3.5 h-3.5" /> Open Printable DR
                  </button>
                  <button
                    type="button"
                    onClick={handleSwitchToNoSi}
                    disabled={saving}
                    className="px-2.5 py-1.5 rounded border border-amber-400 bg-white text-amber-900 font-semibold"
                  >
                    Void DR &amp; Switch to No-SI
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {finalInvoice ? (
                <div className="p-4 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 text-sm flex items-center gap-2">
                  <CheckCircle2 className="w-5 h-5 shrink-0" />
                  <div>
                    <b>Zoho Invoice Posted &amp; Marked Sent:</b>{' '}
                    <span className="font-mono font-bold">{finalInvoice.zoho_invoice_number}</span>
                    {finalInvoice.dr_number ? ` · Linked DR #${finalInvoice.dr_number}` : ''}
                  </div>
                </div>
              ) : requiresSi ? (
                <>
                  <div className="p-3 rounded-lg border border-blue-200 bg-blue-50 text-blue-900 text-xs flex items-center justify-between gap-2">
                    <span>Copy these details into <b>Oojeema</b>, save the Sales Invoice, then enter the SI number below.</span>
                    <button
                      type="button"
                      onClick={handleCopyOojeema}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-white border border-blue-300 font-semibold text-blue-900"
                    >
                      <Copy className="w-3.5 h-3.5" /> Copy for Oojeema
                    </button>
                  </div>
                  <div className="p-4 rounded-lg border border-slate-200 bg-surface space-y-2">
                    <label className="block text-xs font-semibold text-ink-secondary">Oojeema SI Number (saved to Zoho without spaces)</label>
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-sm text-ink-primary">{entityKey}-</span>
                      <input
                        type="text"
                        placeholder="SI000004987"
                        value={siSuffix}
                        onChange={(e) => setSiSuffix(e.target.value)}
                        className="px-3 py-1.5 border border-slate-300 rounded bg-white text-sm font-mono flex-1 max-w-xs"
                      />
                      {siSuffix.trim() && (
                        <span className="text-xs font-mono font-bold text-emerald-700">
                          → {entityKey}-{siSuffix.trim().replace(new RegExp(`^${entityKey}\\s*-\\s*`, 'i'), '')}
                        </span>
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="p-4 rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-900 text-xs">
                  <b>No Oojeema SI / DR Required:</b> Ready to post Zoho auto-numbered invoice with your selected Doctor &amp; Warehouse Batches and mark Sent.
                </div>
              )}
            </div>
          )}
        </div>

        <div className="px-5 py-3 bg-surface border-t border-slate-200 flex items-center justify-between gap-2">
          <div>
            {step > 1 && !finalInvoice && (
              <button
                type="button"
                onClick={() => setStep(step - 1)}
                className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-slate-300 bg-white text-xs font-semibold"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Back
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            {step === 1 && (
              <button
                type="button"
                disabled={loading || saving}
                onClick={handleSaveBatchesAndAdvance}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50"
              >
                {saving ? 'Saving…' : requiresSi ? 'Save Batches & Issue DR →' : 'Save Batches & Skip DR →'}
              </button>
            )}
            {step === 2 && (
              <button
                type="button"
                onClick={() => setStep(3)}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark"
              >
                Next: Oojeema SI →
              </button>
            )}
            {step === 3 && !finalInvoice && (
              <button
                type="button"
                disabled={saving || (requiresSi && !siSuffix.trim())}
                onClick={handleFinalizeInvoice}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-pharmacy-green text-white text-xs font-semibold disabled:opacity-50"
              >
                <Truck className="w-3.5 h-3.5" />
                {saving ? 'Posting to Zoho…' : requiresSi ? 'Convert to Zoho Invoice & Mark Sent' : 'Create Zoho Auto-Invoice & Mark Sent'}
              </button>
            )}
          </div>
        </div>
      </div>

      {printOpen && drData && (
        <DrPrintVoucherModal
          drData={drData}
          onClose={() => setPrintOpen(false)}
          onPrinted={(updated) => setDrData(updated)}
        />
      )}
    </div>
  );
};

export default DrFulfillModal;
