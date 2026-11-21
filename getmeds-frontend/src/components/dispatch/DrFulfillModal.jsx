import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  X, Trash2, RotateCcw, Check, CheckCircle2, AlertTriangle, Printer, Copy, ShieldAlert, ArrowLeft, Layers, Truck,
  Paperclip, ExternalLink, RefreshCw, Pencil
} from 'lucide-react';
import client from '../../api/client';
import { fetchAndPrintSalesOrder } from '../../utils/printSalesOrder';
import { attachmentLabel } from '../../constants/attachmentTypes';
import AttachmentLightbox from '../orders/AttachmentLightbox';
import DrPrintVoucherModal from './DrPrintVoucherModal';

const DELIVERY_METHOD_OPTIONS = [
  'Lalamove', 'Grab Express', 'LBC Express', 'J&T Express',
  'Inhouse', 'Own Rider / Company Vehicle', 'Customer Pick-up',
  'Air Asia', 'Victory Liner', 'Partas',
  'AO Freight', 'Daily Overland', 'AP Cargo', 'Distributor Delivery'
];

function getTrackingExemptionInfo(method) {
  const low = String(method || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (/customer pick-?up|office pick-?up|^pick-?up$|^pickup$|^walk-?in$|^will call$/.test(low)) {
    return { exempt: true, zohoLabel: 'Customer Pick-up' };
  }
  if (/^(in-?\s?house|own rider(\s*\/\s*company vehicle)?|company vehicle|internal delivery)$/.test(low)) {
    return { exempt: true, zohoLabel: 'Inhouse' };
  }
  return { exempt: false, zohoLabel: String(method || '').trim() };
}

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
  const [deliveryMethod, setDeliveryMethod] = useState('');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [shipResult, setShipResult] = useState(null);
  const [shipping, setShipping] = useState(false);
  const [editingZohoTracking, setEditingZohoTracking] = useState(false);
  const [editingCompliance, setEditingCompliance] = useState(false);
  const [tinInput, setTinInput] = useState('');
  const [ltoInput, setLtoInput] = useState('');
  const [savingCompliance, setSavingCompliance] = useState(false);
  const [lightboxAttachment, setLightboxAttachment] = useState(null);
  const [copiedKey, setCopiedKey] = useState(null);

  const attachmentsQuery = useQuery({
    queryKey: ['finance-order-attachments', order.id],
    queryFn: () => client.get(`/api/orders/${order.id}/attachments`).then((r) => r.data),
    enabled: Boolean(order?.id),
    staleTime: 5 * 60 * 1000
  });
  const attachments = (attachmentsQuery.data?.data?.attachments || [])
    .filter((a) => !a.superseded)
    .sort((a, b) => {
      const aPo = a.file_type === 'purchase_order' ? 0 : 1;
      const bPo = b.file_type === 'purchase_order' ? 0 : 1;
      return aPo - bPo;
    });

  const syncOrderUpdatedAt = (nextUpdatedAt) => {
    if (!nextUpdatedAt) return;
    setBatchData((prev) => (prev ? { ...prev, order: { ...prev.order, updated_at: nextUpdatedAt } } : prev));
  };

  const loadState = async () => {
    setLoading(true);
    setConflictMsg('');
    try {
      const { data: res } = await client.get(`/api/dispatch/orders/${order.id}/batches`);
      const d = res.data;
      setBatchData(d);
      setDoctorName(d.order.dispatch_doctor_name || d.order.intake_doctor || 'NNH');
      setRequiresSi(Boolean(d.classification?.requires_si));
      setEntityKey(d.classification?.primary_entity || d.classification?.entity_keys?.[0] || 'GPI');
      setSiSuffix(d.order.oojeema_si_number || '');
      setTinInput(d.order.tin || '');
      setLtoInput(d.order.lto_license_number || '');
      setDeliveryMethod(d.order.courier || d.order.entered_tracking?.courier || d.order.intake_delivery_method || '');
      setTrackingNumber(d.order.tracking_number || d.order.entered_tracking?.tracking_number || '');
      if (d.order.zoho_invoice_number) {
        setFinalInvoice((prev) => prev || {
          entity_key: d.order.oojeema_entity || d.classification?.primary_entity || 'GPI',
          zoho_invoice_id: d.order.zoho_invoice_id,
          zoho_invoice_number: d.order.zoho_invoice_number
        });
      }
      if (d.order.zoho_shipment_id || d.order.zoho_shipment_number) {
        setShipResult((prev) => prev || {
          zoho_package_number: d.order.zoho_package_number,
          zoho_shipment_id: d.order.zoho_shipment_id,
          zoho_shipment_number: d.order.zoho_shipment_number,
          delivery_method: d.order.courier || d.order.entered_tracking?.courier || d.order.intake_delivery_method || '',
          tracking_number: d.order.tracking_number || d.order.entered_tracking?.tracking_number || ''
        });
      }
      if (d.order.zoho_invoice_number || d.order.zoho_shipment_id || d.order.zoho_shipment_number) {
        setStep(3);
      }

      const initPicks = {};
      for (const ln of d.lines || []) {
        const seedPicks = (ln.saved_picks && ln.saved_picks.length) ? ln.saved_picks : (ln.suggested_picks || []);
        initPicks[ln.order_item_id] = seedPicks.map((p) => ({
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
  }, [order.id]);

  useEffect(() => {
    const checkFreshness = async () => {
      if (document.visibilityState !== 'visible' || saving || shipping || finalInvoice) return;
      try {
        const { data: res } = await client.get(`/api/dispatch/orders/${order.id}/batches`);
        const latestUpdatedAt = res?.data?.order?.updated_at;
        if (batchData?.order?.updated_at && latestUpdatedAt && latestUpdatedAt !== batchData.order.updated_at) {
          setConflictMsg('This order changed in another tab or by another dispatcher. Click Refresh before saving.');
        }
      } catch {
        // Ignore silent focus check errors
      }
    };
    window.addEventListener('focus', checkFreshness);
    document.addEventListener('visibilitychange', checkFreshness);
    return () => {
      window.removeEventListener('focus', checkFreshness);
      document.removeEventListener('visibilitychange', checkFreshness);
    };
  }, [order.id, batchData?.order?.updated_at, saving, shipping, finalInvoice]);

  const handleApiError = (err, fallback) => {
    const msg = err?.response?.data?.error?.message || fallback;
    if (err?.response?.status === 409) {
      setConflictMsg(msg);
      loadState();
      if (onCompleted) onCompleted();
    }
    toast.error(msg);
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
    setPicksByItem((prev) => {
      const current = prev[line.order_item_id] || [];
      const usedNumbers = new Set(current.map((p) => p.batch_number));
      const nextBatch = avail.find((b) => !usedNumbers.has(b.batch_number)) || avail[0];
      const currentSum = current.reduce((s, p) => s + Number(p.quantity || 0), 0);
      const remaining = Math.max(0, Number(line.quantity || 0) - currentSum);
      const suggestedQty = Math.min(remaining, Number(nextBatch.available_quantity || 0));
      return {
        ...prev,
        [line.order_item_id]: [
          ...current,
          {
            order_item_id: line.order_item_id,
            zoho_batch_id: nextBatch.zoho_batch_id,
            zoho_batch_in_id: nextBatch.zoho_batch_in_id,
            batch_number: nextBatch.batch_number,
            expiry_date: nextBatch.expiry_date,
            quantity: suggestedQty
          }
        ]
      };
    });
  };

  const removeBatchRow = (lineId, pickIdx) => {
    setPicksByItem((prev) => {
      const current = [...(prev[lineId] || [])];
      if (current.length <= 1) return prev;
      current.splice(pickIdx, 1);
      return { ...prev, [lineId]: current };
    });
  };

  const useSingleBatchFullQty = (line, batchObj) => {
    if (!batchObj || batchObj.is_expired) return;
    setPicksByItem((prev) => ({
      ...prev,
      [line.order_item_id]: [{
        order_item_id: line.order_item_id,
        zoho_batch_id: batchObj.zoho_batch_id,
        zoho_batch_in_id: batchObj.zoho_batch_in_id,
        batch_number: batchObj.batch_number,
        expiry_date: batchObj.expiry_date,
        quantity: Number(line.quantity || 0)
      }]
    }));
  };

  const resetLineToFefo = (line) => {
    setPicksByItem((prev) => ({
      ...prev,
      [line.order_item_id]: (line.suggested_picks || []).map((p) => ({
        order_item_id: line.order_item_id,
        zoho_batch_id: p.zoho_batch_id,
        zoho_batch_in_id: p.zoho_batch_in_id,
        batch_number: p.batch_number,
        expiry_date: p.expiry_date,
        quantity: Number(p.quantity || 0)
      }))
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
      syncOrderUpdatedAt(drRes.data.order_updated_at);
      setConflictMsg('');
      setStep(2);
      toast.success(`${drRes.data.receipt.entity_key} DR #${drRes.data.receipt.dr_number} issued!`);
      if (onCompleted) onCompleted();
    } catch (err) {
      if (err?.response?.data?.error?.code === 'DR_ALREADY_EXISTS' && err?.response?.data?.error?.details?.existing_dr?.id) {
        const existingId = err.response.data.error.details.existing_dr.id;
        const { data: existingDr } = await client.get(`/api/dispatch/dr/${existingId}`);
        setDrData(existingDr.data);
        setConflictMsg('');
        setStep(2);
        toast('Loaded existing active DR for this order.');
      } else {
        handleApiError(err, 'Could not save batches / generate DR.');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCompliance = async () => {
    setSavingCompliance(true);
    try {
      const { data: res } = await client.post(`/api/dispatch/orders/${order.id}/compliance`, {
        tin: tinInput,
        lto_license_number: ltoInput,
        expected_updated_at: batchData?.order?.updated_at || null
      });
      const d = res.data;
      setBatchData((prev) => (prev ? {
        ...prev,
        order: {
          ...prev.order,
          tin: d.tin,
          lto_license_number: d.lto_license_number,
          updated_at: d.order_updated_at || prev.order.updated_at
        }
      } : prev));
      setConflictMsg('');
      setEditingCompliance(false);
      toast.success(d.zoho_pushed ? 'TIN & LTO saved and updated in Zoho!' : 'TIN & LTO saved.');
      if (onCompleted) onCompleted();
    } catch (err) {
      handleApiError(err, 'Could not save TIN / LTO.');
    } finally {
      setSavingCompliance(false);
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
      const { data: voidRes } = await client.post(`/api/dispatch/dr/${drData.receipt.id}/void`, {
        reason: 'Switched from Requires SI & DR back to Patient/Doctor No-SI flow before Zoho invoicing.',
        switch_to_no_si: true,
        expected_updated_at: batchData?.order?.updated_at || null
      });
      syncOrderUpdatedAt(voidRes?.data?.order_updated_at);
      setConflictMsg('');
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

  const copyField = async (key, label, rawValue) => {
    const val = String(rawValue ?? '').trim();
    if (!val || val === '—') return;
    try {
      await navigator.clipboard?.writeText(val);
      setCopiedKey(key);
      toast.success(`Copied ${label}: ${val}`);
      setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1500);
    } catch {
      toast.error('Clipboard permission unavailable.');
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
    setCopiedKey('__all__');
    toast.success('Copied full Oojeema summary to clipboard!');
    setTimeout(() => setCopiedKey((prev) => (prev === '__all__' ? null : prev)), 1500);
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
      syncOrderUpdatedAt(res.data.order_updated_at);
      setConflictMsg('');
      toast.success(`Zoho Invoice ${res.data.zoho_invoice_number || ''} created & marked Sent!`);
      if (onCompleted) onCompleted();
    } catch (err) {
      handleApiError(err, 'Failed to finalize Zoho invoice.');
    } finally {
      setSaving(false);
    }
  };

  const handleShipZoho = async () => {
    if (!deliveryMethod.trim()) {
      toast.error('Please enter or select the Mode of Delivery.');
      return;
    }
    const { exempt } = getTrackingExemptionInfo(deliveryMethod);
    if (!exempt && !trackingNumber.trim()) {
      toast.error('Please enter the Tracking Number (or choose Customer Pick-up / Inhouse).');
      return;
    }
    setShipping(true);
    try {
      const { data: res } = await client.post(`/api/dispatch/orders/${order.id}/ship-zoho`, {
        entity_key: entityKey,
        delivery_method: deliveryMethod.trim(),
        tracking_number: trackingNumber.trim(),
        expected_updated_at: batchData?.order?.updated_at || null
      });
      setShipResult(res.data);
      syncOrderUpdatedAt(res.data.order_updated_at);
      setConflictMsg('');
      toast.success(`Zoho Package${res.data.zoho_package_number ? ` ${res.data.zoho_package_number}` : ''} & Shipment marked Shipped (${res.data.delivery_method})!`);
      if (onCompleted) onCompleted();
    } catch (err) {
      handleApiError(err, 'Could not create Zoho package & shipment.');
    } finally {
      setShipping(false);
    }
  };

  const handleUpdateZohoTracking = async () => {
    if (!deliveryMethod.trim() || !trackingNumber.trim()) {
      toast.error('Please enter both Mode of Delivery and Tracking Number.');
      return;
    }
    setShipping(true);
    try {
      const { data: res } = await client.post(`/api/dispatch/orders/${order.id}/zoho-tracking`, {
        delivery_method: deliveryMethod.trim(),
        tracking_number: trackingNumber.trim()
      });
      setShipResult((prev) => ({
        ...(prev || {}),
        zoho_shipment_id: res.data.zoho_shipment_id || prev?.zoho_shipment_id,
        zoho_shipment_number: res.data.zoho_shipment_number || prev?.zoho_shipment_number,
        delivery_method: res.data.delivery_method,
        tracking_number: res.data.tracking_number
      }));
      setEditingZohoTracking(false);
      toast.success(res.data.message || 'Zoho Shipment tracking updated!');
      if (onCompleted) onCompleted();
    } catch (err) {
      handleApiError(err, 'Could not update Zoho shipment tracking.');
    } finally {
      setShipping(false);
    }
  };

  const cls = batchData?.classification;
  const o = batchData?.order || order;

  return (
    <div className="fixed inset-0 z-40 bg-slate-900/50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[92vh] flex flex-col overflow-hidden border border-slate-200">
        <div className="px-5 py-3.5 bg-surface border-b border-slate-200 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-ink-primary flex items-center gap-2">
              <Layers className="w-4 h-4 text-getmeds-blue shrink-0" />
              <span className="truncate">{o.getmeds_order_id} — {o.customer_name}</span>
            </h3>
            <div className="text-xs text-ink-secondary flex flex-wrap items-center gap-x-2 gap-y-1 mt-0.5">
              <span>SO: {o.zoho_so_number || '—'}</span>
              <span>· Warehouse: {o.fulfil_warehouse_name || 'Main (Zoho default)'}</span>
              <span>· TIN: <b className="text-ink-primary">{o.tin || '—'}</b></span>
              <span>· LTO: <b className="text-ink-primary">{o.lto_license_number || '—'}</b></span>
              {!loading && (
                <button
                  type="button"
                  onClick={() => setEditingCompliance((v) => !v)}
                  className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[11px] font-semibold ${
                    !o.tin
                      ? 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                      : 'border-slate-300 bg-white text-ink-secondary hover:text-ink-primary'
                  }`}
                >
                  <Pencil className="w-3 h-3" /> {editingCompliance ? 'Cancel' : (o.tin ? 'Edit TIN/LTO' : 'Add TIN/LTO')}
                </button>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={() => fetchAndPrintSalesOrder(order.id)}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-md border border-slate-300 bg-white text-ink-primary text-xs font-semibold hover:bg-surface"
              title="Print Zoho-style Sales Order in Hub"
            >
              <Printer className="w-3.5 h-3.5" /> Print SO
            </button>
            {finalInvoice && step !== 3 && (
              <button
                type="button"
                onClick={() => setStep(3)}
                className="px-2.5 py-1.5 rounded-md bg-emerald-50 border border-emerald-300 text-emerald-900 text-xs font-semibold hover:bg-emerald-100"
              >
                Package &amp; Ship →
              </button>
            )}
            <button type="button" onClick={onClose} className="p-1.5 rounded-md border border-slate-300 bg-white text-ink-secondary hover:text-ink-primary">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {editingCompliance && (
          <div className="px-5 py-2.5 bg-amber-50/70 border-b border-amber-200 flex flex-wrap items-end gap-2 text-xs">
            <div>
              <label className="block text-[10px] font-semibold uppercase text-ink-secondary mb-0.5">Customer TIN (syncs to Zoho)</label>
              <input
                type="text"
                placeholder="e.g. 009-341-772-000"
                value={tinInput}
                onChange={(e) => setTinInput(e.target.value)}
                className="px-2.5 py-1 border border-slate-300 rounded bg-white text-xs w-44"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase text-ink-secondary mb-0.5">LTO License No.</label>
              <input
                type="text"
                placeholder="e.g. LTO-300001884"
                value={ltoInput}
                onChange={(e) => setLtoInput(e.target.value)}
                className="px-2.5 py-1 border border-slate-300 rounded bg-white text-xs w-44"
              />
            </div>
            <button
              type="button"
              disabled={savingCompliance}
              onClick={handleSaveCompliance}
              className="px-3 py-1 rounded bg-getmeds-blue text-white font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50"
            >
              {savingCompliance ? 'Saving…' : 'Save TIN / LTO'}
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="px-5 py-2 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="inline-flex items-center gap-1 font-semibold text-ink-secondary mr-1">
              <Paperclip className="w-3.5 h-3.5" /> Attached Files ({attachments.length}):
            </span>
            {attachments.map((att) => {
              const isImage = String(att.content_type || '').startsWith('image/');
              const isPo = att.file_type === 'purchase_order';
              const label = `${attachmentLabel(att.file_type)}${att.file_name ? ` — ${att.file_name}` : ''}`;
              return isImage ? (
                <button
                  key={att.id}
                  type="button"
                  onClick={() => setLightboxAttachment(att)}
                  title={label}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium max-w-[220px] ${
                    isPo
                      ? 'border-blue-300 bg-blue-50 text-blue-900 hover:bg-blue-100'
                      : 'border-slate-300 bg-white text-ink-primary hover:bg-slate-100'
                  }`}
                >
                  {isPo && <span className="px-1 rounded bg-getmeds-blue text-white text-[9px] font-bold">PO</span>}
                  <span className="truncate">{att.file_name || attachmentLabel(att.file_type)}</span>
                </button>
              ) : (
                <a
                  key={att.id}
                  href={att.viewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={label}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border text-[11px] font-medium max-w-[220px] ${
                    isPo
                      ? 'border-blue-300 bg-blue-50 text-blue-900 hover:bg-blue-100'
                      : 'border-slate-300 bg-white text-ink-primary hover:bg-slate-100'
                  }`}
                >
                  {isPo && <span className="px-1 rounded bg-getmeds-blue text-white text-[9px] font-bold">PO</span>}
                  <span className="truncate">{att.file_name || attachmentLabel(att.file_type)}</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              );
            })}
          </div>
        )}

        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {conflictMsg && (
            <div className="p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-950 text-xs flex items-center justify-between gap-2">
              <div className="flex items-start gap-2">
                <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-700" />
                <div><b>Order Updated:</b> {conflictMsg}</div>
              </div>
              <button
                type="button"
                onClick={loadState}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-amber-400 bg-white text-amber-900 font-semibold shrink-0 hover:bg-amber-100"
              >
                <RefreshCw className="w-3 h-3" /> Refresh
              </button>
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
                    disabled={Boolean(cls?.primary_entity && !cls?.is_split)}
                    onChange={(e) => setEntityKey(e.target.value)}
                    className={`w-full px-2.5 py-1.5 border border-slate-300 rounded ${cls?.primary_entity && !cls?.is_split ? 'bg-slate-100 text-ink-secondary cursor-not-allowed' : 'bg-white'}`}
                  >
                    <option value="GPI">Getmeds Philippines Inc. (GPI)</option>
                    <option value="2MG">2mg Incorporated (2MG)</option>
                  </select>
                  {cls?.primary_entity && !cls?.is_split && (
                    <div className="mt-0.5 text-[10px] text-ink-secondary">Locked to Sales Order entity ({cls.primary_entity})</div>
                  )}
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
                      const validBatches = (ln.available_batches || []).filter((b) => !b.is_expired && Number(b.available_quantity) > 0);
                      const pickedTotal = linePicks.reduce((s, p) => s + Number(p.quantity || 0), 0);
                      const qtyDiff = Number(ln.quantity || 0) - pickedTotal;
                      const singleFullBatch = validBatches.find((b) => Number(b.available_quantity) >= Number(ln.quantity || 0));
                      return (
                        <tr key={ln.order_item_id}>
                          <td className="px-3 py-2.5 font-medium text-ink-primary">
                            {ln.product_name}
                            {ln.is_csp && <span className="ml-1.5 px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 text-[10px] font-bold">CSP</span>}
                          </td>
                          <td className="px-3 py-2.5 font-semibold whitespace-nowrap">{ln.quantity} {ln.unit || 'pc'}</td>
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
                                    {linePicks.length > 1 && (
                                      <button
                                        type="button"
                                        onClick={() => removeBatchRow(ln.order_item_id, idx)}
                                        title="Remove this batch row"
                                        aria-label="Remove batch row"
                                        className="p-1 rounded border border-slate-200 text-slate-500 hover:text-red-600 hover:border-red-300 hover:bg-red-50"
                                      >
                                        <Trash2 className="w-3.5 h-3.5" />
                                      </button>
                                    )}
                                  </div>
                                ))}
                                <div className="flex flex-wrap items-center gap-3 pt-0.5 text-[11px]">
                                  <span className={`font-semibold ${qtyDiff === 0 ? 'text-emerald-700' : 'text-amber-700'}`}>
                                    Picked: {pickedTotal} / {ln.quantity} {ln.unit || 'pc'}
                                    {qtyDiff > 0 ? ` (need ${qtyDiff} more)` : qtyDiff < 0 ? ` (${Math.abs(qtyDiff)} over)` : ' ✓'}
                                  </span>
                                  {validBatches.length > 1 && (
                                    <button
                                      type="button"
                                      onClick={() => addSplitBatchRow(ln)}
                                      className="font-semibold text-getmeds-blue hover:underline"
                                    >
                                      + Split across another batch
                                    </button>
                                  )}
                                  {singleFullBatch && (linePicks.length > 1 || linePicks[0]?.batch_number !== singleFullBatch.batch_number || pickedTotal !== Number(ln.quantity || 0)) && (
                                    <button
                                      type="button"
                                      onClick={() => useSingleBatchFullQty(ln, singleFullBatch)}
                                      className="font-semibold text-indigo-700 hover:underline"
                                    >
                                      Use single batch ({singleFullBatch.batch_number} × {ln.quantity})
                                    </button>
                                  )}
                                  {(ln.suggested_picks || []).length > 0 && (
                                    <button
                                      type="button"
                                      onClick={() => resetLineToFefo(ln)}
                                      className="inline-flex items-center gap-1 text-slate-600 hover:text-ink-primary hover:underline"
                                    >
                                      <RotateCcw className="w-3 h-3" /> Reset FEFO
                                    </button>
                                  )}
                                </div>
                                {linePicks.length > 1 && (
                                  <p className="text-[11px] text-ink-secondary">
                                    Manual multi-batch split ({linePicks.length} lots). Remove a row or click <b>Use single batch</b> if taking everything from one lot.
                                  </p>
                                )}
                                {!singleFullBatch && qtyDiff > 0 && (
                                  <p className="text-[11px] font-medium text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                                    No single batch in this warehouse has all {ln.quantity} {ln.unit || 'pc'} available. Put this order <b>On Hold</b>, or click <b>+ Split across another batch</b> only if splitting across lots is approved.
                                  </p>
                                )}
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
                  <b>{drData.receipt.entity_key} DR #{drData.receipt.dr_number}</b> issued. You can go back to edit batches, print the DR, or void &amp; switch to No-SI if classified by mistake.
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
                <div className="space-y-3">
                  <div className="p-4 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 text-sm flex items-center gap-2">
                    <CheckCircle2 className="w-5 h-5 shrink-0" />
                    <div>
                      <b>Zoho Invoice Posted &amp; Marked Sent:</b>{' '}
                      <span className="font-mono font-bold">{finalInvoice.zoho_invoice_number}</span>
                      {finalInvoice.dr_number ? ` · Linked DR #${finalInvoice.dr_number}` : ''}
                    </div>
                  </div>

                  {shipResult ? (
                    <div className="p-4 rounded-lg border border-emerald-300 bg-emerald-50 text-emerald-900 text-xs space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Truck className="w-4 h-4 shrink-0" />
                          <div>
                            <b>Zoho Package &amp; Shipment Created:</b>{' '}
                            {shipResult.zoho_package_number || 'Package created'}
                            {shipResult.zoho_shipment_number ? ` · Shipment #${shipResult.zoho_shipment_number}` : ''}
                            {' · '}Mode of Delivery: <b>{shipResult.delivery_method || '—'}</b>
                            {shipResult.tracking_number ? ` · Tracking: ${shipResult.tracking_number}` : ' · No tracking yet'}
                          </div>
                        </div>
                        {shipResult.zoho_shipment_id && (
                          <button
                            type="button"
                            onClick={() => setEditingZohoTracking((v) => !v)}
                            className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-400 bg-white text-emerald-900 font-semibold hover:bg-emerald-100"
                          >
                            <Pencil className="w-3 h-3" />
                            {editingZohoTracking ? 'Cancel' : (shipResult.tracking_number ? 'Edit Zoho Tracking' : 'Add Tracking to Zoho')}
                          </button>
                        )}
                      </div>
                      {editingZohoTracking && (
                        <div className="pt-2 border-t border-emerald-200 grid grid-cols-1 sm:grid-cols-2 gap-3 text-ink-primary">
                          <div>
                            <label className="block font-semibold text-ink-secondary mb-1">Mode of Delivery *</label>
                            <input
                              type="text"
                              list="dr-delivery-methods"
                              placeholder="e.g. Lalamove, LBC Express, Own Rider..."
                              value={deliveryMethod}
                              onChange={(e) => setDeliveryMethod(e.target.value)}
                              className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white text-xs"
                            />
                            <datalist id="dr-delivery-methods">
                              {DELIVERY_METHOD_OPTIONS.map((opt) => (
                                <option key={opt} value={opt} />
                              ))}
                            </datalist>
                          </div>
                          <div>
                            <label className="block font-semibold text-ink-secondary mb-1">Tracking Number *</label>
                            <div className="flex gap-2">
                              <input
                                type="text"
                                placeholder="Waybill or courier tracking link"
                                value={trackingNumber}
                                onChange={(e) => setTrackingNumber(e.target.value)}
                                className="flex-1 px-2.5 py-1.5 border border-slate-300 rounded bg-white text-xs"
                              />
                              <button
                                type="button"
                                disabled={shipping || !deliveryMethod.trim() || !trackingNumber.trim()}
                                onClick={handleUpdateZohoTracking}
                                className="px-3 py-1.5 rounded bg-emerald-700 text-white font-semibold hover:bg-emerald-800 disabled:opacity-50"
                              >
                                {shipping ? 'Saving…' : 'Sync to Zoho'}
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (() => {
                    const trackingMeta = getTrackingExemptionInfo(deliveryMethod);
                    return (
                    <div className="p-4 rounded-lg border border-blue-200 bg-blue-50/50 space-y-3 text-xs">
                      <div className="font-semibold text-ink-primary flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1.5">
                          <Truck className="w-4 h-4 text-getmeds-blue" />
                          4. Zoho Packaging, Mode of Delivery &amp; Tracking
                        </span>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setDeliveryMethod('Inhouse')}
                            className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                              trackingMeta.zohoLabel === 'Inhouse'
                                ? 'border-emerald-500 bg-emerald-100 text-emerald-900'
                                : 'border-slate-300 bg-white text-ink-secondary hover:bg-surface'
                            }`}
                          >
                            Inhouse
                          </button>
                          <button
                            type="button"
                            onClick={() => setDeliveryMethod('Customer Pick-up')}
                            className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                              trackingMeta.zohoLabel === 'Customer Pick-up'
                                ? 'border-emerald-500 bg-emerald-100 text-emerald-900'
                                : 'border-slate-300 bg-white text-ink-secondary hover:bg-surface'
                            }`}
                          >
                            Customer Pick-up
                          </button>
                        </div>
                      </div>
                      <p className="text-ink-secondary">
                        Required step: records Packaging &amp; Shipment directly in Zoho Inventory. For couriers, a tracking number or link is required just like Oojeema SI; Inhouse and Customer Pick-up are auto-detected.
                      </p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block font-semibold text-ink-secondary mb-1">Mode of Delivery *</label>
                          <input
                            type="text"
                            list="dr-delivery-methods"
                            placeholder="e.g. Lalamove, LBC Express, Inhouse, Customer Pick-up..."
                            value={deliveryMethod}
                            onChange={(e) => setDeliveryMethod(e.target.value)}
                            className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white text-xs"
                          />
                          <datalist id="dr-delivery-methods">
                            {DELIVERY_METHOD_OPTIONS.map((opt) => (
                              <option key={opt} value={opt} />
                            ))}
                          </datalist>
                        </div>
                        <div>
                          <label className="block font-semibold text-ink-secondary mb-1">
                            {trackingMeta.exempt ? 'Tracking Number (optional for Inhouse / Pick-up)' : 'Tracking Number *'}
                          </label>
                          <input
                            type="text"
                            placeholder={trackingMeta.exempt ? `Optional — recorded in Zoho as ${trackingMeta.zohoLabel}` : 'Required — waybill or Lalamove share link'}
                            value={trackingNumber}
                            onChange={(e) => setTrackingNumber(e.target.value)}
                            className={`w-full px-2.5 py-1.5 border rounded bg-white text-xs ${
                              !trackingMeta.exempt && !trackingNumber.trim() ? 'border-amber-400' : 'border-slate-300'
                            }`}
                          />
                        </div>
                      </div>
                      {trackingMeta.exempt && (
                        <div className="p-2.5 rounded border border-emerald-200 bg-emerald-50 text-emerald-900 text-[11px]">
                          <b>No Tracking Number Required ({trackingMeta.zohoLabel}):</b> Zoho Package &amp; Shipment will be recorded as <b>{trackingMeta.zohoLabel}</b> without needing a tracking number.
                        </div>
                      )}
                    </div>
                    );
                  })()}
                </div>
              ) : requiresSi ? (
                <>
                  <div className="rounded-lg border border-blue-200 bg-blue-50/60 overflow-hidden">
                    <div className="px-3.5 py-2.5 bg-blue-50 border-b border-blue-200 flex flex-wrap items-center justify-between gap-2 text-xs text-blue-950">
                      <span><b>Click any field below</b> to copy it straight into <b>Oojeema</b>, save the SI there, then type the SI number below.</span>
                      <button
                        type="button"
                        onClick={handleCopyOojeema}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-blue-300 text-[11px] font-semibold text-blue-900 hover:bg-blue-50"
                      >
                        {copiedKey === '__all__' ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />} Copy All
                      </button>
                    </div>
                    <div className="p-3.5 space-y-3 text-xs bg-white">
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                        {[
                          { key: 'cust', label: 'Customer', val: o.customer_name },
                          { key: 'tin', label: 'TIN', val: o.tin },
                          { key: 'lto', label: 'LTO No.', val: o.lto_license_number },
                          { key: 'terms', label: 'Terms / MOP', val: o.intake_payment_terms || 'COD' },
                          { key: 'so', label: 'Zoho SO No.', val: o.zoho_so_number },
                          { key: 'dr', label: 'DR No.', val: drData?.receipt?.dr_number ? `${drData.receipt.dr_number}` : null },
                          { key: 'doc', label: 'Doctor', val: doctorName },
                          { key: 'gl', label: 'GL No.', val: o.intake_gl_number }
                        ].filter((f) => f.val).map((f) => (
                          <button
                            key={f.key}
                            type="button"
                            onClick={() => copyField(f.key, f.label, f.val)}
                            title={`Click to copy ${f.label}`}
                            className="text-left px-2.5 py-1.5 rounded border border-slate-200 bg-surface hover:border-getmeds-blue hover:bg-blue-50/50 transition-colors flex items-center justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <div className="text-[10px] font-semibold uppercase text-ink-secondary">{f.label}</div>
                              <div className="font-medium text-ink-primary truncate">{f.val}</div>
                            </div>
                            {copiedKey === f.key
                              ? <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                              : <Copy className="w-3 h-3 text-slate-400 shrink-0" />}
                          </button>
                        ))}
                        {o.delivery_address && (
                          <button
                            type="button"
                            onClick={() => copyField('addr', 'Address', o.delivery_address)}
                            title="Click to copy Delivery Address"
                            className="sm:col-span-2 lg:col-span-3 text-left px-2.5 py-1.5 rounded border border-slate-200 bg-surface hover:border-getmeds-blue hover:bg-blue-50/50 transition-colors flex items-center justify-between gap-2"
                          >
                            <div className="min-w-0">
                              <div className="text-[10px] font-semibold uppercase text-ink-secondary">Delivery Address</div>
                              <div className="font-medium text-ink-primary truncate">{o.delivery_address}</div>
                            </div>
                            {copiedKey === 'addr'
                              ? <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                              : <Copy className="w-3 h-3 text-slate-400 shrink-0" />}
                          </button>
                        )}
                      </div>

                      <div className="border border-slate-200 rounded overflow-hidden">
                        <table className="min-w-full text-xs">
                          <thead className="bg-surface border-b border-slate-200 text-[10px] uppercase text-ink-secondary">
                            <tr>
                              <th className="px-2.5 py-1.5 text-left">Medicine (click to copy)</th>
                              <th className="px-2.5 py-1.5 text-left">Qty</th>
                              <th className="px-2.5 py-1.5 text-left">Unit Price</th>
                              <th className="px-2.5 py-1.5 text-left">Batch &amp; Expiry</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {(batchData?.lines || []).map((ln) => {
                              const linePicks = picksByItem[ln.order_item_id] || [];
                              const itemKey = `item-${ln.order_item_id}`;
                              const qtyKey = `qty-${ln.order_item_id}`;
                              const priceKey = `price-${ln.order_item_id}`;
                              const priceStr = ln.unit_price != null ? Number(ln.unit_price).toFixed(2) : null;
                              return (
                                <tr key={ln.order_item_id}>
                                  <td className="px-2.5 py-1.5">
                                    <button
                                      type="button"
                                      onClick={() => copyField(itemKey, 'Medicine', ln.product_name)}
                                      className="inline-flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-blue-50 font-medium text-ink-primary text-left"
                                      title="Click to copy medicine name"
                                    >
                                      <span>{ln.product_name}</span>
                                      {copiedKey === itemKey ? <Check className="w-3 h-3 text-emerald-600 shrink-0" /> : <Copy className="w-3 h-3 text-slate-400 shrink-0" />}
                                    </button>
                                  </td>
                                  <td className="px-2.5 py-1.5 whitespace-nowrap">
                                    <button
                                      type="button"
                                      onClick={() => copyField(qtyKey, 'Qty', String(ln.quantity))}
                                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-blue-50 font-semibold"
                                      title="Click to copy quantity"
                                    >
                                      <span>{ln.quantity} {ln.unit || 'pc'}</span>
                                      {copiedKey === qtyKey ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3 text-slate-400" />}
                                    </button>
                                  </td>
                                  <td className="px-2.5 py-1.5 whitespace-nowrap">
                                    {priceStr ? (
                                      <button
                                        type="button"
                                        onClick={() => copyField(priceKey, 'Unit Price', priceStr)}
                                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded hover:bg-blue-50 font-mono"
                                        title="Click to copy unit price"
                                      >
                                        <span>₱{priceStr}</span>
                                        {copiedKey === priceKey ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3 text-slate-400" />}
                                      </button>
                                    ) : '—'}
                                  </td>
                                  <td className="px-2.5 py-1.5">
                                    <div className="flex flex-wrap gap-1.5">
                                      {linePicks.map((p, idx) => {
                                        const bKey = `b-${ln.order_item_id}-${idx}`;
                                        const eKey = `e-${ln.order_item_id}-${idx}`;
                                        return (
                                          <span key={idx} className="inline-flex items-center gap-1 bg-surface border border-slate-200 rounded px-1.5 py-0.5">
                                            <button
                                              type="button"
                                              onClick={() => copyField(bKey, 'Batch #', p.batch_number)}
                                              className="inline-flex items-center gap-1 font-mono hover:text-getmeds-blue"
                                              title="Click to copy Batch #"
                                            >
                                              {p.batch_number}
                                              {copiedKey === bKey ? <Check className="w-2.5 h-2.5 text-emerald-600" /> : <Copy className="w-2.5 h-2.5 text-slate-400" />}
                                            </button>
                                            {p.expiry_date && (
                                              <>
                                                <span className="text-slate-400">·</span>
                                                <button
                                                  type="button"
                                                  onClick={() => copyField(eKey, 'Expiry', p.expiry_date)}
                                                  className="inline-flex items-center gap-1 text-ink-secondary hover:text-getmeds-blue"
                                                  title="Click to copy Expiry Date"
                                                >
                                                  Exp {p.expiry_date}
                                                  {copiedKey === eKey ? <Check className="w-2.5 h-2.5 text-emerald-600" /> : <Copy className="w-2.5 h-2.5 text-slate-400" />}
                                                </button>
                                              </>
                                            )}
                                          </span>
                                        );
                                      })}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
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
                {saving
                  ? 'Posting to Zoho…'
                  : requiresSi
                    ? `Convert to Zoho Invoice (${entityKey}) & Mark Sent`
                    : `Create Zoho Auto-Invoice (${entityKey}) & Mark Sent`}
              </button>
            )}
            {step === 3 && finalInvoice && !shipResult && (
              <button
                type="button"
                disabled={shipping || !deliveryMethod.trim() || (!getTrackingExemptionInfo(deliveryMethod).exempt && !trackingNumber.trim())}
                onClick={handleShipZoho}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50"
              >
                <Truck className="w-3.5 h-3.5" />
                {shipping ? 'Creating Package & Shipment…' : 'Create Zoho Package & Mark Shipped'}
              </button>
            )}
            {step === 3 && finalInvoice && shipResult && (
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700"
              >
                <Check className="w-3.5 h-3.5" /> Done
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
      <AttachmentLightbox
        attachment={lightboxAttachment}
        onClose={() => setLightboxAttachment(null)}
      />
    </div>
  );
};

export default DrFulfillModal;
