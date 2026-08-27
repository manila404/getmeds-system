import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchClients, fetchClientStats, syncCustomersFromZoho, updateCustomerCategory } from '../../api/queries';
import toast from 'react-hot-toast';
import {
  Users,
  DownloadCloud,
  RefreshCw,
  Search,
  ChevronLeft,
  ChevronRight,
  Stethoscope,
  Building2,
  Truck,
  Accessibility,
  Tag
} from 'lucide-react';

const PAGE_SIZE = 25;

const CATEGORY_META = {
  doctor: { label: 'Doctor', icon: Stethoscope, className: 'bg-sky-50 text-sky-700 border-sky-200' },
  hospital: { label: 'Hospital', icon: Building2, className: 'bg-purple-50 text-purple-700 border-purple-200' },
  distributor: { label: 'Distributor', icon: Truck, className: 'bg-amber-50 text-amber-800 border-amber-200' },
  pwd: { label: 'PWD', icon: Accessibility, className: 'bg-rose-50 text-rose-700 border-rose-200' }
};

// Aug 27, 2026: this `category` tag (doctor/hospital/distributor/pwd) is a
// purely local, additive classification for the Clients Directory only. It
// is never sent to Zoho, and it is deliberately kept separate from `type`
// (credit/direct) below, which is what actually drives payment-workflow
// routing (credit bypasses Finance, direct is queued for payment
// verification) — that behavior is untouched by this page.
const ClientsPage = () => {
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['clients', page, search, categoryFilter, typeFilter],
    queryFn: () =>
      fetchClients({
        page,
        limit: PAGE_SIZE,
        search: search || undefined,
        category: categoryFilter || undefined,
        type: typeFilter || undefined
      }),
    keepPreviousData: true
  });

  // Aug 27, 2026 (2): one grouped-count request instead of four separate
  // `?limit=1` round trips — same numbers, a quarter of the network calls.
  const { data: statsData } = useQuery({
    queryKey: ['clients-stats'],
    queryFn: fetchClientStats
  });

  const syncMutation = useMutation({
    mutationFn: syncCustomersFromZoho,
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['clients-stats'] });
      toast.success(res.message || 'Clients synced from Zoho', { icon: '🔄' });
    },
    onError: (err) => {
      const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      toast.error(`Sync failed: ${msg}`);
    }
  });

  const categoryMutation = useMutation({
    mutationFn: ({ id, category }) => updateCustomerCategory(id, category),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['clients-stats'] });
      toast.success('Category updated');
    },
    onError: (err) => {
      const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      toast.error(`Could not update category: ${msg}`);
    }
  });

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    setSearch(searchInput.trim());
    setPage(1);
  };

  const handleCategoryFilterChange = (e) => {
    setCategoryFilter(e.target.value);
    setPage(1);
  };

  const handleTypeFilterChange = (e) => {
    setTypeFilter(e.target.value);
    setPage(1);
  };

  const clientsData = data?.data || {};
  const clients = clientsData.customers || [];
  const pagination = clientsData.pagination || { total: 0, page: 1, limit: PAGE_SIZE, pages: 1 };

  const stats = statsData?.data || {};
  const total = stats.total ?? 0;
  const creditTotal = stats.credit ?? 0;
  const directTotal = stats.direct ?? 0;
  const uncategorizedTotal = stats.uncategorized ?? 0;

  const pageStartIdx = (pagination.page - 1) * pagination.limit;

  return (
    <div className="space-y-6 pb-12">
      {/* Top Banner */}
      <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-xs">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-blue-50 text-getmeds-blue">
              <Users size={24} />
            </div>
            <div>
              <h1 className="text-xl font-bold text-ink-primary">Clients Directory</h1>
              <p className="text-xs text-ink-secondary mt-0.5">
                Every registered client, its Credit/Direct payment type, and its local classification.
                Category tags are local-only and never sent to Zoho.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-all shadow-2xs cursor-pointer disabled:opacity-50"
            >
              <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
              Refresh
            </button>

            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 transition-all shadow-xs cursor-pointer disabled:opacity-50"
              title="Pull all clients from Zoho (read-only — never writes to Zoho)"
            >
              <DownloadCloud size={15} className={syncMutation.isPending ? 'animate-bounce' : ''} />
              {syncMutation.isPending ? 'Syncing from Zoho...' : 'Sync All Clients from Zoho'}
            </button>
          </div>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 block">Total Clients</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-black text-slate-900">{total}</span>
            <span className="text-xs font-medium text-slate-400">Registered</span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-emerald-600 block">Credit Accounts</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-black text-emerald-700">{creditTotal}</span>
            <span className="text-xs text-emerald-600">Bypass payment</span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-blue-600 block">Direct Accounts</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-black text-blue-700">{directTotal}</span>
            <span className="text-xs text-blue-600">Finance queue</span>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 block">Uncategorized</span>
          <div className="flex items-baseline justify-between mt-1">
            <span className="text-2xl font-black text-slate-700">{uncategorizedTotal}</span>
            <span className="text-xs text-slate-400">Need a tag</span>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-xs overflow-hidden">
        <div className="p-4 border-b border-slate-100 flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-slate-50/50">
          <form onSubmit={handleSearchSubmit} className="relative flex-1 max-w-md">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by name, contact person, or number..."
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
            />
          </form>

          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={typeFilter}
              onChange={handleTypeFilterChange}
              className="text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
            >
              <option value="">All Types</option>
              <option value="credit">Credit</option>
              <option value="direct">Direct</option>
            </select>

            <select
              value={categoryFilter}
              onChange={handleCategoryFilterChange}
              className="text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
            >
              <option value="">All Categories</option>
              <option value="doctor">Doctor</option>
              <option value="hospital">Hospital</option>
              <option value="distributor">Distributor</option>
              <option value="pwd">PWD</option>
              <option value="uncategorized">Uncategorized</option>
            </select>

            <span className="text-xs text-slate-500">
              {pagination.total > 0 ? (
                <>
                  Showing <strong>{pageStartIdx + 1}–{Math.min(pageStartIdx + pagination.limit, pagination.total)}</strong> of{' '}
                  <strong>{pagination.total}</strong> clients
                </>
              ) : (
                <>Showing <strong>0</strong> clients</>
              )}
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 text-slate-600 uppercase text-[10.5px] font-bold tracking-wider border-b border-slate-200">
              <tr>
                <th className="py-3 px-4">Client</th>
                <th className="py-3 px-4">Type</th>
                <th className="py-3 px-4">Category</th>
                <th className="py-3 px-4">Contact</th>
                <th className="py-3 px-4">Address</th>
                <th className="py-3 px-4">Source</th>
                <th className="py-3 px-4">Zoho Contact ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 font-medium">
              {isLoading ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    <RefreshCw size={20} className="animate-spin mx-auto mb-2 text-getmeds-blue" />
                    Loading clients...
                  </td>
                </tr>
              ) : clients.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-slate-400">
                    No clients found. Try "Sync All Clients from Zoho" or adjust your filters.
                  </td>
                </tr>
              ) : (
                clients.map((cl) => {
                  const isCredit = cl.type === 'credit';
                  const meta = cl.category ? CATEGORY_META[cl.category] : null;
                  const CategoryIcon = meta?.icon || Tag;

                  return (
                    <tr key={cl.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="py-3 px-4">
                        <div className="font-bold text-slate-900">{cl.name}</div>
                        {cl.is_test_customer ? (
                          <div className="text-[10px] font-bold text-amber-700 bg-amber-50 inline-block px-1.5 py-0.5 rounded mt-0.5">
                            TEST customer
                          </div>
                        ) : null}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-2.5 py-1 rounded-md font-bold text-[11px] border ${
                            isCredit
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-blue-50 text-blue-700 border-blue-200'
                          }`}
                        >
                          {isCredit ? 'Credit' : 'Direct'}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center gap-1.5">
                          {meta && (
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-bold text-[10.5px] border ${meta.className}`}
                            >
                              <CategoryIcon size={11} /> {meta.label}
                            </span>
                          )}
                          <select
                            value={cl.category || ''}
                            onChange={(e) =>
                              categoryMutation.mutate({ id: cl.id, category: e.target.value || null })
                            }
                            disabled={categoryMutation.isPending}
                            className="text-[11px] px-1.5 py-1 bg-white border border-slate-200 rounded-md focus:outline-none focus:ring-2 focus:ring-getmeds-blue disabled:opacity-50"
                            title="Set this client's local category (never sent to Zoho)"
                          >
                            <option value="">{meta ? 'Change...' : 'Set category...'}</option>
                            <option value="doctor">Doctor</option>
                            <option value="hospital">Hospital</option>
                            <option value="distributor">Distributor</option>
                            <option value="pwd">PWD</option>
                          </select>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-slate-700">
                        <div>{cl.contact_person || <span className="text-slate-400">—</span>}</div>
                        <div className="text-[11px] text-slate-400">{cl.contact_number || ''}</div>
                      </td>
                      <td className="py-3 px-4 text-slate-600 max-w-xs truncate" title={cl.address || ''}>
                        {cl.address || <span className="text-slate-400">—</span>}
                      </td>
                      <td className="py-3 px-4">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-md font-bold text-[10.5px] ${
                            cl.source === 'zoho'
                              ? 'bg-purple-50 text-purple-700 border border-purple-200'
                              : 'bg-slate-100 text-slate-600 border border-slate-200'
                          }`}
                        >
                          {cl.source === 'zoho' ? 'Zoho' : 'Local'}
                        </span>
                      </td>
                      <td className="py-3 px-4 font-mono text-[11px] text-slate-500">
                        {cl.zoho_contact_id ? (
                          <span className="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                            {cl.zoho_contact_id}
                          </span>
                        ) : (
                          <span className="text-slate-400">—</span>
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
        {pagination.total > pagination.limit && (
          <div className="p-3 border-t border-slate-100 flex items-center justify-between gap-3 bg-slate-50/50">
            <span className="text-xs text-slate-500">
              Page <strong>{pagination.page}</strong> of <strong>{pagination.pages}</strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={pagination.page <= 1}
                className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 transition-all cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={14} /> Prev
              </button>
              <button
                onClick={() => setPage((p) => Math.min(pagination.pages, p + 1))}
                disabled={pagination.page >= pagination.pages}
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

export default ClientsPage;
