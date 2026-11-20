import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FileSpreadsheet, PlusCircle, Printer, Ban, Search, Trash2, RefreshCw } from 'lucide-react';
import client from '../../api/client';
import DrPrintVoucherModal from '../../components/dispatch/DrPrintVoucherModal';

const emptyToItem = () => ({
  include: true,
  product_id: null,
  item_name: '',
  batch_number: '',
  expiry_date: '',
  quantity: 1,
  unit: 'Vials'
});

const DrLedgerPage = () => {
  const qc = useQueryClient();
  const [entity, setEntity] = useState('');
  const [referenceType, setReferenceType] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [printDrData, setPrintDrData] = useState(null);
  const [toOpen, setToOpen] = useState(false);
  const [toSearch, setToSearch] = useState('');
  const [selectedToId, setSelectedToId] = useState('');
  const [loadingToDetail, setLoadingToDetail] = useState(false);
  const [submittingTo, setSubmittingTo] = useState(false);
  const [existingToDr, setExistingToDr] = useState(null);
  const [toForm, setToForm] = useState({
    entity_key: 'GPI',
    external_ref: '',
    transfer_name: '',
    delivery_address: '',
    date_issued: ''
  });
  const [toItems, setToItems] = useState([emptyToItem()]);

  const zohoTosQuery = useQuery({
    queryKey: ['zoho-transfer-orders', toSearch],
    queryFn: () =>
      client
        .get('/api/dispatch/dr-ledger/transfer-orders', {
          params: { search: toSearch.trim() || undefined, per_page: 50 }
        })
        .then((r) => r.data?.data?.transfer_orders || []),
    enabled: toOpen
  });

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['dr-ledger', entity, referenceType, status, search, page],
    queryFn: () =>
      client
        .get('/api/dispatch/dr-ledger', {
          params: {
            entity: entity || undefined,
            reference_type: referenceType || undefined,
            status: status || undefined,
            search: search || undefined,
            page,
            limit: 50
          }
        })
        .then((r) => r.data?.data)
  });

  const rows = data?.rows || [];
  const sequences = data?.sequences || [];
  const pagination = data?.pagination;

  const openPrint = async (drId) => {
    try {
      const { data: res } = await client.get(`/api/dispatch/dr/${drId}`);
      setPrintDrData(res.data);
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Failed to load DR voucher.');
    }
  };

  const handleVoid = async (drId, drNo) => {
    const reason = window.prompt(`Reason for voiding DR #${drNo}:`);
    if (!reason || !reason.trim()) return;
    try {
      await client.post(`/api/dispatch/dr/${drId}/void`, { reason: reason.trim() });
      toast.success(`DR #${drNo} marked VOID.`);
      qc.invalidateQueries({ queryKey: ['dr-ledger'] });
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not void DR.');
    }
  };

  const handleExport = async () => {
    try {
      const resp = await client.get('/api/dispatch/dr-ledger/export', {
        params: {
          entity: entity || undefined,
          reference_type: referenceType || undefined,
          status: status || undefined,
          search: search || undefined
        },
        responseType: 'blob'
      });
      const url = window.URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `dr-ledger${entity ? `-${entity}` : ''}.xlsx`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Excel export failed.');
    }
  };

  const handleSelectZohoTo = async (toId) => {
    setSelectedToId(toId);
    if (!toId) return;
    setLoadingToDetail(true);
    try {
      const { data: res } = await client.get(`/api/dispatch/dr-ledger/transfer-orders/${toId}`);
      const d = res.data;
      const to = d.transfer_order || {};
      setToForm((prev) => ({
        ...prev,
        external_ref: to.transfer_order_number || '',
        transfer_name: to.to_warehouse_name || to.description || '',
        delivery_address: to.default_address || '',
        date_issued: to.date || ''
      }));
      setExistingToDr(d.existing_dr || null);
      const loadedItems = (d.items || []).map((it) => ({
        include: true,
        product_id: it.product_id || null,
        item_name: it.item_name || '',
        batch_number: it.batch_number || '',
        expiry_date: it.expiry_date || '',
        quantity: Number(it.quantity || 1),
        unit: it.unit || 'pc'
      }));
      setToItems(loadedItems.length ? loadedItems : [emptyToItem()]);
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not load Transfer Order from Zoho.');
    } finally {
      setLoadingToDetail(false);
    }
  };

  const updateToItem = (idx, patch) => {
    setToItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };

  const removeToItem = (idx) => {
    setToItems((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
  };

  const submitTransferOrder = async (e) => {
    e.preventDefault();
    const chosen = toItems
      .filter((it) => it.include !== false)
      .filter((it) => String(it.item_name || '').trim() && Number(it.quantity) > 0)
      .map((it) => ({
        product_id: it.product_id || null,
        item_name: String(it.item_name).trim(),
        batch_number: String(it.batch_number || '').trim() || null,
        expiry_date: String(it.expiry_date || '').trim() || null,
        quantity: Number(it.quantity),
        unit: String(it.unit || 'pc').trim() || 'pc'
      }));
    if (!chosen.length) {
      toast.error('Add or select at least one Transfer Order item with quantity > 0.');
      return;
    }
    setSubmittingTo(true);
    try {
      const { data: res } = await client.post('/api/dispatch/dr-ledger/transfer-order', {
        entity_key: toForm.entity_key,
        external_ref: toForm.external_ref.trim(),
        transfer_name: toForm.transfer_name.trim(),
        delivery_address: toForm.delivery_address.trim(),
        date_issued: toForm.date_issued || undefined,
        items: chosen
      });
      toast.success(`${res.data.receipt.entity_key} DR #${res.data.receipt.dr_number} issued for ${toForm.external_ref.trim()}!`);
      setToOpen(false);
      qc.invalidateQueries({ queryKey: ['dr-ledger'] });
      setPrintDrData(res.data);
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not create Transfer Order DR.');
    } finally {
      setSubmittingTo(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Delivery Receipt Ledger</h1>
          <p className="text-sm text-ink-secondary">
            Unified GPI &amp; 2MG sequential DR registry replacing external Excel workbooks.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {sequences.map((s) => (
            <span key={s.entity_key} className="px-2.5 py-1 rounded-full bg-surface border border-slate-200 text-xs font-semibold text-ink-primary">
              {s.entity_key} Last DR: #{s.last_dr_no} · Item #{s.last_item_no}
            </span>
          ))}
          <button
            type="button"
            onClick={() => setToOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark"
          >
            <PlusCircle className="w-4 h-4" /> Transfer Order DR (TO #)
          </button>
          <button
            type="button"
            onClick={handleExport}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-300 bg-white text-xs font-semibold text-ink-primary hover:bg-surface"
          >
            <FileSpreadsheet className="w-4 h-4 text-pharmacy-green" /> Export Excel (.xlsx)
          </button>
        </div>
      </div>

      <div className="bg-white border border-slate-200 rounded-xl p-3 flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-ink-secondary absolute left-3 top-2.5" />
          <input
            type="text"
            placeholder="Search DR#, SI#, TO#, customer, item…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            className="w-full pl-9 pr-3 py-1.5 border border-slate-300 rounded-md text-xs"
          />
        </div>
        <select value={entity} onChange={(e) => { setEntity(e.target.value); setPage(1); }} className="px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white">
          <option value="">All Entities (2MG &amp; GPI)</option>
          <option value="2MG">2MG Incorporated</option>
          <option value="GPI">Getmeds Philippines Inc. (GPI)</option>
        </select>
        <select value={referenceType} onChange={(e) => { setReferenceType(e.target.value); setPage(1); }} className="px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white">
          <option value="">Sales Orders &amp; Transfer Orders</option>
          <option value="sales_order">Sales Orders</option>
          <option value="transfer_order">Transfer Orders (TO #)</option>
        </select>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white">
          <option value="">All Statuses</option>
          <option value="issued">Issued</option>
          <option value="void">Void</option>
        </select>
      </div>

      {isError && (
        <div className="p-4 rounded-lg border border-amber-300 bg-amber-50 text-amber-900 text-xs">
          {error?.response?.data?.error?.message || 'DR Ledger unavailable — check GETMEDS_DR_WORKFLOW and database migration status.'}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-xs">
            <thead className="bg-surface">
              <tr>
                <th className="px-3 py-2 text-left">Entity</th>
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">DR No.</th>
                <th className="px-3 py-2 text-left">Client / Transfer Name</th>
                <th className="px-3 py-2 text-left">Item No.</th>
                <th className="px-3 py-2 text-left">SI / TO No.</th>
                <th className="px-3 py-2 text-left">Item &amp; Batch / Expiry</th>
                <th className="px-3 py-2 text-left">Qty / Unit</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {isLoading ? (
                <tr><td colSpan="10" className="px-4 py-8 text-center text-ink-secondary">Loading DR ledger…</td></tr>
              ) : !rows.length ? (
                <tr><td colSpan="10" className="px-4 py-8 text-center text-ink-secondary">No DR entries match the current filters.</td></tr>
              ) : rows.map((r) => (
                <tr key={r.dr_item_id || `${r.dr_id}-empty`} className={r.status === 'void' ? 'bg-red-50/40 text-ink-secondary' : 'hover:bg-surface'}>
                  <td className="px-3 py-2 font-bold">{r.entity_key}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.date_issued}</td>
                  <td className="px-3 py-2 font-mono font-bold text-ink-primary">{r.display_dr_no || ''}</td>
                  <td className="px-3 py-2 font-medium">{r.customer_name}</td>
                  <td className="px-3 py-2 font-mono">{r.item_seq_no}</td>
                  <td className="px-3 py-2 font-mono">{r.si_or_to_no || r.si_number || r.external_ref || '—'}</td>
                  <td className="px-3 py-2">{r.item_name}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{r.quantity} {r.unit}</td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${r.status === 'void' ? 'bg-red-100 text-red-700' : 'bg-emerald-100 text-emerald-800'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {r.display_dr_no && (
                      <div className="inline-flex gap-1.5">
                        <button type="button" onClick={() => openPrint(r.dr_id)} className="px-2 py-1 border border-slate-300 rounded bg-white hover:bg-surface" title="Print DR">
                          <Printer className="w-3.5 h-3.5" />
                        </button>
                        {r.status !== 'void' && (
                          <button type="button" onClick={() => handleVoid(r.dr_id, r.dr_number)} className="px-2 py-1 border border-red-200 rounded bg-white text-red-700 hover:bg-red-50" title="Void DR">
                            <Ban className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {pagination && pagination.pages > 1 && (
          <div className="px-4 py-2.5 bg-surface border-t border-slate-200 flex items-center justify-between text-xs">
            <span>Page {pagination.page} of {pagination.pages} ({pagination.total} rows)</span>
            <div className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="px-2.5 py-1 rounded border border-slate-300 bg-white disabled:opacity-40">Previous</button>
              <button type="button" disabled={page >= pagination.pages} onClick={() => setPage(page + 1)} className="px-2.5 py-1 rounded border border-slate-300 bg-white disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

      {toOpen && (
        <div className="fixed inset-0 z-40 bg-slate-900/50 flex items-center justify-center p-4">
          <form onSubmit={submitTransferOrder} className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[92vh] flex flex-col overflow-hidden border border-slate-200">
            <div className="px-5 py-3.5 bg-surface border-b border-slate-200 flex items-center justify-between gap-2">
              <div>
                <h3 className="text-base font-bold text-ink-primary">Issue Transfer Order DR (TO #)</h3>
                <p className="text-xs text-ink-secondary">
                  Load a Zoho Transfer Order (Cebu, Davao, Consignment &amp; active Homestocks) or add rows manually.
                </p>
              </div>
              <button
                type="button"
                onClick={() => zohoTosQuery.refetch()}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white text-xs font-semibold hover:bg-surface"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${zohoTosQuery.isFetching ? 'animate-spin' : ''}`} /> Refresh Zoho TOs
              </button>
            </div>

            <div className="p-5 overflow-y-auto space-y-4 text-xs">
              <div className="p-3 rounded-lg border border-blue-200 bg-blue-50/50 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex-1 min-w-[200px]">
                    <label className="block font-semibold text-ink-secondary mb-1">Load from Zoho Transfer Orders</label>
                    <select
                      value={selectedToId}
                      onChange={(e) => handleSelectZohoTo(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white text-xs"
                    >
                      <option value="">
                        {zohoTosQuery.isLoading ? 'Loading Zoho Transfer Orders…' : '— Select Zoho Transfer Order (or enter manually below) —'}
                      </option>
                      {(zohoTosQuery.data || []).map((to) => (
                        <option key={to.transfer_order_id} value={to.transfer_order_id}>
                          {to.transfer_order_number} · {to.to_warehouse_name} ({to.date})
                          {to.existing_dr ? ` [Issued ${to.existing_dr.entity_key} DR #${to.existing_dr.dr_number}]` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="w-48">
                    <label className="block font-semibold text-ink-secondary mb-1">Filter TO# / Warehouse</label>
                    <input
                      type="text"
                      placeholder="Search TO-00379, Cebu..."
                      value={toSearch}
                      onChange={(e) => setToSearch(e.target.value)}
                      className="w-full px-2.5 py-1.5 border border-slate-300 rounded bg-white text-xs"
                    />
                  </div>
                </div>
                {loadingToDetail && <p className="text-[11px] text-getmeds-blue font-semibold">Loading Zoho Transfer Order lines &amp; batch numbers…</p>}
                {existingToDr && (
                  <p className="text-[11px] text-amber-800 font-semibold">
                    Note: {existingToDr.entity_key} DR #{existingToDr.dr_number} is already issued for {existingToDr.external_ref}. Confirm before issuing a duplicate.
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-semibold mb-1">Entity Sequence *</label>
                  <select
                    value={toForm.entity_key}
                    onChange={(e) => setToForm({ ...toForm, entity_key: e.target.value })}
                    className="w-full px-2.5 py-1.5 border rounded bg-white"
                  >
                    <option value="GPI">GPI</option>
                    <option value="2MG">2MG</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">TO Reference *</label>
                  <input
                    required
                    type="text"
                    value={toForm.external_ref}
                    onChange={(e) => setToForm({ ...toForm, external_ref: e.target.value })}
                    className="w-full px-2.5 py-1.5 border rounded font-mono"
                    placeholder="TO-00379"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Destination Warehouse *</label>
                  <input
                    required
                    type="text"
                    value={toForm.transfer_name}
                    onChange={(e) => setToForm({ ...toForm, transfer_name: e.target.value })}
                    className="w-full px-2.5 py-1.5 border rounded"
                    placeholder="CEBU WAREHOUSE / DAVAO WAREHOUSE..."
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Date Issued</label>
                  <input
                    type="date"
                    value={toForm.date_issued}
                    onChange={(e) => setToForm({ ...toForm, date_issued: e.target.value })}
                    className="w-full px-2.5 py-1.5 border rounded"
                  />
                </div>
              </div>

              <div>
                <label className="block font-semibold mb-1">Delivery Address (editable for Consignment / Homestocks)</label>
                <input
                  type="text"
                  value={toForm.delivery_address}
                  onChange={(e) => setToForm({ ...toForm, delivery_address: e.target.value })}
                  className="w-full px-2.5 py-1.5 border rounded"
                  placeholder="Unit1023, City Soho Mall, Cebu / Davao City / Consignment address..."
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-ink-primary">
                    Transfer Items ({toItems.filter((it) => it.include !== false).length} selected)
                  </span>
                  <button
                    type="button"
                    onClick={() => setToItems((prev) => [...prev, emptyToItem()])}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-slate-300 bg-white text-xs font-semibold hover:bg-surface"
                  >
                    <PlusCircle className="w-3.5 h-3.5" /> Add Item Row
                  </button>
                </div>
                <div className="border border-slate-200 rounded-lg overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-surface border-b border-slate-200 text-[11px] uppercase text-ink-secondary">
                      <tr>
                        <th className="px-2 py-1.5 text-center w-8">Use</th>
                        <th className="px-2 py-1.5 text-left">Item Name *</th>
                        <th className="px-2 py-1.5 text-left w-32">Batch #</th>
                        <th className="px-2 py-1.5 text-left w-32">Expiry Date</th>
                        <th className="px-2 py-1.5 text-left w-20">Qty *</th>
                        <th className="px-2 py-1.5 text-left w-24">Unit</th>
                        <th className="px-2 py-1.5 w-8" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {toItems.map((it, idx) => (
                        <tr key={idx} className={it.include === false ? 'opacity-45 bg-slate-50' : ''}>
                          <td className="px-2 py-1.5 text-center">
                            <input
                              type="checkbox"
                              checked={it.include !== false}
                              onChange={(e) => updateToItem(idx, { include: e.target.checked })}
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={it.item_name}
                              onChange={(e) => updateToItem(idx, { item_name: e.target.value })}
                              placeholder="Medicine name"
                              className="w-full px-2 py-1 border border-slate-300 rounded"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={it.batch_number}
                              onChange={(e) => updateToItem(idx, { batch_number: e.target.value })}
                              placeholder="Batch #"
                              className="w-full px-2 py-1 border border-slate-300 rounded font-mono"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="date"
                              value={it.expiry_date}
                              onChange={(e) => updateToItem(idx, { expiry_date: e.target.value })}
                              className="w-full px-2 py-1 border border-slate-300 rounded"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="number"
                              min="1"
                              value={it.quantity}
                              onChange={(e) => updateToItem(idx, { quantity: e.target.value })}
                              className="w-full px-2 py-1 border border-slate-300 rounded"
                            />
                          </td>
                          <td className="px-2 py-1.5">
                            <input
                              type="text"
                              value={it.unit}
                              onChange={(e) => updateToItem(idx, { unit: e.target.value })}
                              placeholder="Vials"
                              className="w-full px-2 py-1 border border-slate-300 rounded"
                            />
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => removeToItem(idx)}
                              disabled={toItems.length <= 1}
                              className="text-red-600 disabled:opacity-30"
                              title="Remove row"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="px-5 py-3 bg-surface border-t border-slate-200 flex justify-end gap-2">
              <button type="button" onClick={() => setToOpen(false)} className="px-3 py-1.5 rounded border bg-white text-xs font-semibold">
                Cancel
              </button>
              <button
                type="submit"
                disabled={submittingTo}
                className="px-4 py-1.5 rounded bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50"
              >
                {submittingTo ? 'Issuing DR…' : 'Issue & Print Transfer DR'}
              </button>
            </div>
          </form>
        </div>
      )}

      {printDrData && <DrPrintVoucherModal drData={printDrData} onClose={() => setPrintDrData(null)} onPrinted={setPrintDrData} />}
    </div>
  );
};

export default DrLedgerPage;
