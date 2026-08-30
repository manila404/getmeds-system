import React, { useState, useRef, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  fetchClients,
  fetchClientStats,
  startCustomersSyncJob,
  fetchSyncJobStatus,
  updateCustomerCategory
} from '../../api/queries';
import SyncProgressIndicator from '../../components/SyncProgressIndicator';
import toast from 'react-hot-toast';
import {
  Users,
  DownloadCloud,
  Zap,
  RefreshCw,
  Search,
  X,
  ChevronLeft,
  ChevronRight,
  Stethoscope,
  Building2,
  Truck,
  Accessibility,
  Tag
} from 'lucide-react';

const PAGE_SIZE = 25;

// Aug 28, 2026: how many live suggestions to show under the search box while
// typing. Kept small and server-side on purpose — this directory now holds
// 35,000+ real synced clients, so suggestions are their own small (`limit`-
// bounded) query, never a client-side filter over the full list.
const SUGGESTION_LIMIT = 8;
// One debounce feeds both the suggestion dropdown and the table filter below
// it, so neither fires on every keystroke.
const SEARCH_DEBOUNCE_MS = 300;

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
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [isSuggestOpen, setIsSuggestOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [categoryFilter, setCategoryFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const searchContainerRef = useRef(null);

  // Aug 28, 2026: debounce the raw input into `search` instead of requiring
  // a form submit — this is what actually makes both the suggestion
  // dropdown and the table below "live" as you type.
  useEffect(() => {
    const handle = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchInput]);

  // Close the suggestion dropdown on an outside click, same pattern as
  // CustomerAutocomplete.jsx.
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (searchContainerRef.current && !searchContainerRef.current.contains(e.target)) {
        setIsSuggestOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

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

  // Aug 28, 2026: the live suggestion dropdown — a separate, small query
  // (LIMIT 8) keyed off the same debounced `search`, so it never re-fetches
  // on every keystroke and never pulls the full client list into the
  // browser just to suggest a few names.
  const showSuggestions = isSuggestOpen && search.length >= 2;
  const { data: suggestData, isFetching: isSuggestFetching } = useQuery({
    queryKey: ['clients-suggest', search, categoryFilter, typeFilter],
    queryFn: () =>
      fetchClients({
        page: 1,
        limit: SUGGESTION_LIMIT,
        search,
        category: categoryFilter || undefined,
        type: typeFilter || undefined
      }),
    enabled: showSuggestions,
    keepPreviousData: true
  });

  // Aug 27, 2026 (2): one grouped-count request instead of four separate
  // `?limit=1` round trips — same numbers, a quarter of the network calls.
  const { data: statsData } = useQuery({
    queryKey: ['clients-stats'],
    queryFn: fetchClientStats
  });

  // Aug 28, 2026: replaced the old single blocking "Sync All Clients from
  // Zoho" button with two background jobs — Quick Sync (only contacts
  // changed since the last run — fast) and Full Resync (everyone,
  // registered here or not, guaranteed complete) — plus a live progress
  // indicator, since a full pull of Getmeds' real (35,000+ contact) Zoho
  // org was reported as taking a long time with no feedback in between.
  // Both still ONLY read from Zoho (POST .../sync-from-zoho/start) —
  // nothing here writes anything to Zoho.
  const [syncJobId, setSyncJobId] = useState(null);

  const startSyncMutation = useMutation({
    mutationFn: (mode) => startCustomersSyncJob(mode),
    onSuccess: (res) => setSyncJobId(res.data.job_id),
    onError: (err) => {
      const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      toast.error(`Could not start sync: ${msg}`);
    }
  });

  const { data: syncJobData } = useQuery({
    queryKey: ['customers-sync-job', syncJobId],
    queryFn: () => fetchSyncJobStatus(syncJobId),
    enabled: !!syncJobId,
    // Keep polling every 1.2s while the job is still running; stop the
    // moment it's done/errored (or if it 404s because the server restarted
    // mid-job — no `data` to read a status off of, so this just stops).
    refetchInterval: (query) => (query.state.data?.data?.status === 'running' ? 1200 : false)
  });

  const syncJob = syncJobData?.data || null;

  // Fires exactly once per job, the moment its status flips away from
  // "running" — invalidates the table/stats so the new/updated contacts
  // show up, surfaces a toast (persistent + ⚠️ if the pull hit its own
  // safety cap or Zoho errored), and clears syncJobId so the progress bar
  // disappears and the buttons re-enable.
  useEffect(() => {
    if (!syncJob) return;
    if (syncJob.status === 'running') return;

    const modeLabel = syncJob.mode === 'full' ? 'Full Resync' : 'Quick Sync';

    if (syncJob.status === 'done') {
      qc.invalidateQueries({ queryKey: ['clients'] });
      qc.invalidateQueries({ queryKey: ['clients-stats'] });
      const r = syncJob.result || {};
      if (r.truncated) {
        toast.error(
          `⚠️ ${modeLabel} pulled ${r.total_from_zoho ?? 0} contact(s), but Zoho reported even more beyond this ` +
            `pull's safety limit — incomplete (${r.created ?? 0} new, ${r.updated ?? 0} refreshed). Nothing was ` +
            'written to Zoho.',
          { icon: '⚠️', duration: 15000 }
        );
      } else {
        toast.success(
          `${modeLabel} complete — ${r.created ?? 0} new, ${r.updated ?? 0} refreshed` +
            (r.skipped ? `, ${r.skipped} skipped` : '') + '.',
          { icon: '🔄' }
        );
      }
    } else if (syncJob.status === 'error') {
      toast.error(`${modeLabel} failed: ${syncJob.error || 'unknown error'}`);
    }

    setSyncJobId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncJob?.status]);

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

  // Enter commits immediately instead of waiting out the debounce, and
  // always closes the dropdown — same "pick or press enter" feel as
  // CustomerAutocomplete.
  const handleSearchKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      setSearch(searchInput.trim());
      setPage(1);
      setIsSuggestOpen(false);
    } else if (e.key === 'Escape') {
      setIsSuggestOpen(false);
    }
  };

  const handleSuggestionClick = (client) => {
    setSearchInput(client.name);
    setSearch(client.name);
    setPage(1);
    setIsSuggestOpen(false);
  };

  const handleClearSearch = () => {
    setSearchInput('');
    setSearch('');
    setPage(1);
    setIsSuggestOpen(false);
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

  const suggestions = suggestData?.data?.customers || [];
  const suggestTotal = suggestData?.data?.pagination?.total ?? suggestions.length;

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
              <h1 className="text-xl font-semibold text-ink-primary">Clients Directory</h1>
              <p className="text-xs text-ink-secondary mt-0.5">
                Every registered client, its Credit/Direct payment type, and its local classification.
                Category tags are local-only and never sent to Zoho.
              </p>
            </div>
          </div>

          <div className="flex flex-col items-end gap-1.5">
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
                onClick={() => startSyncMutation.mutate('quick')}
                disabled={!!syncJobId || startSyncMutation.isPending}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg border border-blue-600 bg-blue-600 text-white hover:bg-blue-700 transition-all shadow-xs cursor-pointer disabled:opacity-50"
                title="Fast — pulls only contacts created or changed in Zoho since the last sync (read-only)"
              >
                <Zap size={15} />
                Quick Sync
              </button>

              <button
                onClick={() => startSyncMutation.mutate('full')}
                disabled={!!syncJobId || startSyncMutation.isPending}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 transition-all shadow-xs cursor-pointer disabled:opacity-50"
                title="Slower, but guaranteed — pulls every contact in Zoho, registered here or not (read-only)"
              >
                <DownloadCloud size={15} />
                Full Resync
              </button>
            </div>
            <SyncProgressIndicator job={syncJob} />
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
          <div className="relative flex-1 max-w-md" ref={searchContainerRef}>
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search by name, contact person, or number..."
              value={searchInput}
              onChange={(e) => {
                setSearchInput(e.target.value);
                setIsSuggestOpen(true);
              }}
              onFocus={() => setIsSuggestOpen(true)}
              onKeyDown={handleSearchKeyDown}
              className="w-full pl-9 pr-8 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
            />
            {searchInput && (
              <button
                type="button"
                onClick={handleClearSearch}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-slate-700 rounded-full transition-colors"
                title="Clear search"
              >
                <X size={13} />
              </button>
            )}

            {showSuggestions && (
              <ul className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 shadow-lg rounded-lg z-20 max-h-72 overflow-y-auto divide-y divide-slate-100">
                {isSuggestFetching && suggestions.length === 0 ? (
                  <li className="px-4 py-3 text-center text-xs text-slate-400">
                    <RefreshCw size={13} className="animate-spin inline-block mr-1.5 align-[-2px]" />
                    Searching...
                  </li>
                ) : suggestions.length === 0 ? (
                  <li className="px-4 py-3 text-center text-xs text-slate-400">
                    No client matches <span className="font-semibold text-slate-600">"{search}"</span>.
                  </li>
                ) : (
                  <>
                    {suggestions.map((cl) => {
                      const isCredit = cl.type === 'credit';
                      const meta = cl.category ? CATEGORY_META[cl.category] : null;
                      return (
                        <li key={cl.id}>
                          <button
                            type="button"
                            onClick={() => handleSuggestionClick(cl)}
                            className="w-full text-left px-3.5 py-2.5 hover:bg-slate-50 flex items-center justify-between gap-3 transition-colors focus:bg-slate-50 focus:outline-none"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <p className="text-xs font-bold text-slate-900 truncate">{cl.name}</p>
                                {meta && (
                                  <span
                                    className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full font-bold text-[9.5px] border shrink-0 ${meta.className}`}
                                  >
                                    {meta.label}
                                  </span>
                                )}
                              </div>
                              {(cl.contact_person || cl.contact_number) && (
                                <p className="text-[10.5px] text-slate-400 truncate">
                                  {[cl.contact_person, cl.contact_number].filter(Boolean).join(' · ')}
                                </p>
                              )}
                            </div>
                            <span
                              className={`inline-block px-2 py-0.5 rounded-md font-bold text-[10px] border shrink-0 ${
                                isCredit
                                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                  : 'bg-blue-50 text-blue-700 border-blue-200'
                              }`}
                            >
                              {isCredit ? 'Credit' : 'Direct'}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                    {suggestTotal > suggestions.length && (
                      <li className="px-3.5 py-2 text-center text-[10.5px] text-slate-400 bg-slate-50/60">
                        +{suggestTotal - suggestions.length} more match{suggestTotal - suggestions.length === 1 ? '' : 'es'} — showing the table below
                      </li>
                    )}
                  </>
                )}
              </ul>
            )}
          </div>

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

        <div className="thin-scroll overflow-x-auto">
          <table className="w-full text-left text-[13px]">
            <thead className="bg-getmeds-blue text-white text-[13px] font-semibold border-b border-slate-200">
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
                    No clients found. Try a Quick Sync or Full Resync above, or adjust your filters.
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
                        <div className="font-semibold text-slate-900">{cl.name}</div>
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
