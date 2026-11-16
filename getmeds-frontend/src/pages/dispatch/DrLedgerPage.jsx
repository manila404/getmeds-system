import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { FileSpreadsheet, PlusCircle, Printer, Ban, Search } from 'lucide-react';
import client from '../../api/client';
import DrPrintVoucherModal from '../../components/dispatch/DrPrintVoucherModal';

const DrLedgerPage = () => {
  const qc = useQueryClient();
  const [entity, setEntity] = useState('');
  const [referenceType, setReferenceType] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [printDrData, setPrintDrData] = useState(null);
  const [toOpen, setToOpen] = useState(false);
  const [toForm, setToForm] = useState({
    entity_key: 'GPI',
    external_ref: 'TO # ',
    transfer_name: 'GPI WH -> 2MG WH',
    item_name: '',
    batch_number: '',
    expiry_date: '',
    quantity: 1,
    unit: 'BOX'
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

  const submitTransferOrder = async (e) => {
    e.preventDefault();
    try {
      await client.post('/api/dispatch/dr-ledger/transfer-order', {
        entity_key: toForm.entity_key,
        external_ref: toForm.external_ref,
        transfer_name: toForm.transfer_name,
        items: [
          {
            item_name: toForm.item_name,
            batch_number: toForm.batch_number || null,
            expiry_date: toForm.expiry_date || null,
            quantity: Number(toForm.quantity),
            unit: toForm.unit
          }
        ]
      });
      toast.success('Transfer Order DR issued.');
      setToOpen(false);
      qc.invalidateQueries({ queryKey: ['dr-ledger'] });
    } catch (err) {
      toast.error(err?.response?.data?.error?.message || 'Could not create Transfer Order DR.');
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
          <form onSubmit={submitTransferOrder} className="bg-white rounded-xl shadow-xl max-w-lg w-full p-5 space-y-3 border border-slate-200">
            <h3 className="text-base font-bold text-ink-primary">Issue Transfer Order DR (TO #)</h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              <div>
                <label className="block font-semibold mb-1">Entity Sequence</label>
                <select value={toForm.entity_key} onChange={(e) => setToForm({ ...toForm, entity_key: e.target.value })} className="w-full px-2.5 py-1.5 border rounded">
                  <option value="GPI">GPI</option>
                  <option value="2MG">2MG</option>
                </select>
              </div>
              <div>
                <label className="block font-semibold mb-1">TO Reference</label>
                <input required type="text" value={toForm.external_ref} onChange={(e) => setToForm({ ...toForm, external_ref: e.target.value })} className="w-full px-2.5 py-1.5 border rounded" placeholder="TO # 0014" />
              </div>
            </div>
            <div className="text-xs">
              <label className="block font-semibold mb-1">Transfer Route / Name</label>
              <input required type="text" value={toForm.transfer_name} onChange={(e) => setToForm({ ...toForm, transfer_name: e.target.value })} className="w-full px-2.5 py-1.5 border rounded" />
            </div>
            <div className="text-xs">
              <label className="block font-semibold mb-1">Item Name</label>
              <input required type="text" value={toForm.item_name} onChange={(e) => setToForm({ ...toForm, item_name: e.target.value })} className="w-full px-2.5 py-1.5 border rounded" />
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
              <input type="text" placeholder="Batch #" value={toForm.batch_number} onChange={(e) => setToForm({ ...toForm, batch_number: e.target.value })} className="px-2.5 py-1.5 border rounded" />
              <input type="date" value={toForm.expiry_date} onChange={(e) => setToForm({ ...toForm, expiry_date: e.target.value })} className="px-2.5 py-1.5 border rounded" />
              <div className="flex gap-1">
                <input required type="number" min="1" value={toForm.quantity} onChange={(e) => setToForm({ ...toForm, quantity: e.target.value })} className="w-16 px-2 py-1.5 border rounded" />
                <input required type="text" value={toForm.unit} onChange={(e) => setToForm({ ...toForm, unit: e.target.value })} className="w-16 px-2 py-1.5 border rounded" />
              </div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={() => setToOpen(false)} className="px-3 py-1.5 rounded border text-xs font-semibold">Cancel</button>
              <button type="submit" className="px-3.5 py-1.5 rounded bg-getmeds-blue text-white text-xs font-semibold">Issue Transfer DR</button>
            </div>
          </form>
        </div>
      )}

      {printDrData && <DrPrintVoucherModal drData={printDrData} onClose={() => setPrintDrData(null)} onPrinted={setPrintDrData} />}
    </div>
  );
};

export default DrLedgerPage;
