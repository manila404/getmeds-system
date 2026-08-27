import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { formatDistanceToNow } from 'date-fns';
import {
  fetchInventoryStatus,
  syncPullStock
} from '../../api/queries';
import toast from 'react-hot-toast';
import {
  Package,
  RefreshCw,
  DownloadCloud,
  CheckCircle2,
  AlertCircle,
  Search,
  ChevronLeft,
  ChevronRight,
  Clock
} from 'lucide-react';

const PAGE_SIZE = 25;

const InventoryPage = () => {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  // Fetch Inventory Status
  // Aug 27, 2026 (2): this now reads a purely local snapshot — the
  // backend no longer calls Zoho on every request (see
  // inventory.controller.js's getInventoryStatus) — so a 30s auto-refresh
  // costs nothing and just keeps the "Diff (Δ...)" flags current if
  // someone adjusts stock locally elsewhere. "Zoho Stock" below is only
  // ever as fresh as the last time "Pull from Zoho" ran — see the
  // last-synced note next to that button.
  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['inventoryStatus'],
    queryFn: fetchInventoryStatus,
    refetchInterval: 30000 // auto-refresh every 30s — cheap now, local-only
  });

  // Mutations
  // Aug 27, 2026: the old "push catalog to Zoho" mutation was removed —
  // the backend route it called (POST /api/inventory/sync-push) no longer
  // exists (see inventory.controller.js / inventory.routes.js). This app
  // is read-only towards Zoho Inventory now: it only ever pulls stock in,
  // never pushes the local catalog out.
  //
  // Aug 27, 2026 (2): the per-row "Adjust Stock" action was also removed
  // from this page at the user's request, so this screen is now a pure,
  // read-only mirror of Zoho with no way to change any stock number from
  // here — even though that action only ever touched GetMeds' own local
  // count and never wrote to Zoho. The backend endpoint it called
  // (POST /api/inventory/adjust) is untouched and still covered by tests;
  // it's just no longer reachable from this UI.
  const pullMutation = useMutation({
    mutationFn: syncPullStock,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['inventoryStatus'] });
      qc.invalidateQueries({ queryKey: ['products'] });
      toast.success(res.message || 'Stock pulled from Zoho successfully', { icon: '🔄' });
    },
    onError: (err) => {
      const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      toast.error(`Pull failed: ${msg}`);
    }
  });

  const inventoryData = data?.data || {};
  const products = inventoryData.products || [];
  const summary = inventoryData.summary || {};
  const mode = inventoryData.mode || 'mock';
  const orgId = inventoryData.organization_id || '936158981';

  const filteredProducts = products.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      p.sku.toLowerCase().includes(search.toLowerCase())
  );

  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageStartIdx = (safePage - 1) * PAGE_SIZE;
  const pagedProducts = filteredProducts.slice(pageStartIdx, pageStartIdx + PAGE_SIZE);

  const handleSearchChange = (e) => {
    setSearch(e.target.value);
    setPage(1); // reset to page 1 whenever the filter changes
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Top Banner & Zoho Live Status */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="p-2 rounded-lg bg-blue-50 text-getmeds-blue">
                <Package size={24} />
              </div>
              <div>
                <h1 className="text-xl font-bold text-ink-primary flex items-center gap-2">
                  Inventory & Zoho Live Synchronization
                  <span className={`text-xs px-2.5 py-0.5 rounded-full font-bold uppercase tracking-wider border ${
                    mode === 'live'
                      ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
                      : 'bg-amber-50 text-amber-800 border-amber-300'
                  }`}>
                    {mode === 'live' ? '⚡ Zoho Live API Connected' : `Mode: ${mode}`}
                  </span>
                </h1>
                <p className="text-xs text-ink-secondary mt-0.5 flex items-center gap-2">
                  <span>Linked Organization: <strong className="text-slate-800 font-semibold">{orgId}</strong> (Getmeds Demo Sandbox)</span>
                  <span>•</span>
                  <span>Currency: <strong className="text-slate-800 font-semibold">PHP (₱)</strong></span>
                </p>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                onClick={() => refetch()}
                disabled={isFetching}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-all shadow-2xs cursor-pointer disabled:opacity-50"
                title="Re-read the local database — instant, does not contact Zoho"
              >
                <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
                Refresh Status
              </button>

              <button
                onClick={() => pullMutation.mutate()}
                disabled={pullMutation.isPending}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 transition-all shadow-xs cursor-pointer disabled:opacity-50"
                title="Fetch live stock_on_hand from Zoho and update GetMeds DB — this is the only action that actually contacts Zoho"
              >
                <DownloadCloud size={15} className={pullMutation.isPending ? 'animate-bounce' : ''} />
                {pullMutation.isPending ? 'Pulling from Zoho...' : 'Pull from Zoho'}
              </button>
            </div>
            <span className="text-[11px] text-ink-secondary flex items-center gap-1">
              <Clock size={11} />
              {summary.last_synced_at
                ? <>Zoho data as of {formatDistanceToNow(new Date(summary.last_synced_at + 'Z'), { addSuffix: true })} — click "Pull from Zoho" for the latest</>
                : <>Never pulled from Zoho yet — click "Pull from Zoho" to fetch stock</>}
            </span>
          </div>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 block">Total Catalog Items</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-black text-slate-900">{summary.total_products || 0}</span>
            <span className="text-xs font-medium text-slate-400">Medicines</span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 block">Fully In-Sync</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-black text-emerald-700">{summary.in_sync || 0}</span>
            <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded">
              {summary.total_products ? Math.round(((summary.in_sync || 0) / summary.total_products) * 100) : 0}%
            </span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-600 block">Stock Discrepancy</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-black text-amber-700">{summary.mismatches || 0}</span>
            <span className="text-xs text-amber-600">Items</span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-purple-600 block">Zoho Integration</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-sm font-bold text-purple-900 truncate">REST OAuth 2.0</span>
            <span className="text-[10px] font-bold text-purple-700 bg-purple-50 px-1.5 py-0.5 rounded uppercase">Active</span>
          </div>
        </div>
      </div>

      {/* Product Comparison & Sync Table (read-only — no per-row actions) */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-50/50">
          <div className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by SKU or medicine name..."
              value={search}
              onChange={handleSearchChange}
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
            />
          </div>
          <div className="text-xs text-slate-500">
            {filteredProducts.length > 0 ? (
              <>
                Showing <strong>{pageStartIdx + 1}–{Math.min(pageStartIdx + PAGE_SIZE, filteredProducts.length)}</strong> of <strong>{filteredProducts.length}</strong> items
              </>
            ) : (
              <>Showing <strong>0</strong> items</>
            )}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 uppercase text-[10.5px] font-bold tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-3 px-4">Medicine / SKU</th>
                <th className="py-3 px-4">Unit Price</th>
                <th className="py-3 px-4 text-center">GetMeds Stock</th>
                <th className="py-3 px-4 text-center">Zoho Stock (last sync)</th>
                <th className="py-3 px-4">Zoho Item ID</th>
                <th className="py-3 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {isLoading ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400">
                    <RefreshCw size={20} className="animate-spin mx-auto mb-2 text-getmeds-blue" />
                    Loading inventory...
                  </td>
                </tr>
              ) : pagedProducts.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-slate-400">
                    No products found matching "{search}"
                  </td>
                </tr>
              ) : (
                pagedProducts.map((p) => {
                  const isSync = p.sync_status === 'in_sync';
                  const isMismatch = p.sync_status === 'mismatch';

                  return (
                    <tr key={p.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-900">{p.name}</div>
                        <div className="text-[11px] text-slate-400 font-mono">{p.sku}</div>
                      </td>
                      <td className="py-3 px-4 text-slate-700 font-mono">
                        ₱{Number(p.unit_price).toFixed(2)} / {p.unit}
                      </td>
                      <td className="py-3 px-4 text-center">
                        <span className="inline-block px-2.5 py-1 rounded-md font-bold text-xs bg-slate-100 text-slate-800">
                          {p.local_stock} {p.unit}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-center">
                        {p.zoho_stock !== null ? (
                          <span
                            className={`inline-block px-2.5 py-1 rounded-md font-bold text-xs ${
                              isSync
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : 'bg-amber-50 text-amber-800 border border-amber-300 font-black'
                            }`}
                          >
                            {p.zoho_stock} {p.unit}
                          </span>
                        ) : (
                          <span className="text-slate-400 italic">Not created</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500">
                        {p.zoho_item_id ? (
                          <span className="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                            {p.zoho_item_id}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        {isSync && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full border border-emerald-200">
                            <CheckCircle2 size={12} /> In Sync
                          </span>
                        )}
                        {isMismatch && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-amber-800 bg-amber-100 px-2 py-0.5 rounded-full border border-amber-300">
                            <AlertCircle size={12} /> Diff (Δ {p.zoho_stock - p.local_stock})
                          </span>
                        )}
                        {p.sync_status === 'not_in_zoho' && (
                          <span className="inline-flex items-center gap-1 text-[11px] font-bold text-slate-600 bg-slate-100 px-2 py-0.5 rounded-full border border-slate-200">
                            Not in Zoho
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {filteredProducts.length > PAGE_SIZE && (
          <div className="p-3 border-t border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
            <span className="text-xs text-slate-500">
              Page <strong>{safePage}</strong> of <strong>{totalPages}</strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={safePage <= 1}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={safePage >= totalPages}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Next <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default InventoryPage;
