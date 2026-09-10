import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { UserCheck, MapPin, Globe, HelpCircle, Ban, PlayCircle, RefreshCw, Sparkles } from 'lucide-react';
import client from '../../api/client';

/**
 * Sep 10, 2026: deciding who owns the 60,817 Sales Orders imported from Zoho.
 *
 * The system deliberately does not decide this — see
 * services/salespersonMappingService.js for why an automatic name join is
 * unsafe against this data. This screen exists to make the human decision
 * cheap: 171 names, sorted by how many orders ride on each, so the 40 rows
 * that cover 80% of the volume are the first 40 you see.
 */

const KINDS = [
  { value: 'undecided', label: 'Decide later', icon: HelpCircle, hint: 'Left alone. Nothing is assigned.' },
  { value: 'person', label: 'A person', icon: UserCheck, hint: 'Pick the account that owns these orders.' },
  { value: 'territory', label: 'Territory', icon: MapPin, hint: 'A branch or area. Stays Management-owned.' },
  { value: 'channel', label: 'Channel', icon: Globe, hint: 'WEB, Shopee, Lazada. Stays Management-owned.' },
  { value: 'vacant', label: 'Vacant', icon: Ban, hint: 'Explicitly nobody. Stays Management-owned.' }
];

const kindStyle = {
  undecided: 'bg-slate-100 text-slate-700 border-slate-200',
  person: 'bg-getmeds-blue/10 text-getmeds-blue-dark border-getmeds-blue/30',
  territory: 'bg-amber-50 text-amber-900 border-amber-200',
  channel: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  vacant: 'bg-slate-100 text-slate-500 border-slate-200'
};

const SalespersonMappingPage = () => {
  const qc = useQueryClient();
  const [plan, setPlan] = useState(null);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['salesperson-mappings'],
    queryFn: () => client.get('/api/salesperson-mappings').then((r) => r.data)
  });

  const rows = data?.data?.rows || [];
  const users = data?.data?.users || [];
  const summary = data?.data?.summary || {};

  const save = useMutation({
    mutationFn: (body) => client.patch('/api/salesperson-mappings', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['salesperson-mappings'] }),
    onError: (err) =>
      toast.error(err.response?.data?.error?.message || 'Could not save that decision.')
  });

  // Dry run and commit are the same endpoint with one flag, but they are two
  // very different actions, so they are two buttons and the plan is always
  // shown before the commit is offered.
  const preview = useMutation({
    mutationFn: () => client.post('/api/salesperson-mappings/apply'),
    onSuccess: (res) => setPlan(res.data.data),
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not build the preview.')
  });

  const commit = useMutation({
    mutationFn: () => client.post('/api/salesperson-mappings/apply?confirm=true'),
    onSuccess: (res) => {
      toast.success(`${res.data.data.total_orders.toLocaleString()} order(s) assigned.`);
      setPlan(null);
      qc.invalidateQueries({ queryKey: ['salesperson-mappings'] });
      qc.invalidateQueries({ queryKey: ['management-orders'] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || 'Could not assign the orders.')
  });

  const setKind = (row, kind) =>
    save.mutate({ zoho_salesperson: row.zoho_salesperson, kind, user_id: kind === 'person' ? row.user_id : null });

  const setUser = (row, userId) =>
    save.mutate({ zoho_salesperson: row.zoho_salesperson, kind: 'person', user_id: userId ? Number(userId) : null });

  const acceptSuggestion = (row) =>
    save.mutate({ zoho_salesperson: row.zoho_salesperson, kind: 'person', user_id: row.suggestion.user_id });

  if (isLoading) {
    return (
      <div className="flex justify-center py-16">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Order Ownership</h1>
          <p className="text-sm text-ink-secondary mt-1 max-w-3xl">
            Every Sales Order imported from Zoho carries a Salesperson name. Say what each name is,
            and the orders behind it are handed to the right account. Nothing moves until you press
            Assign.
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-1.5 px-3 py-2 border border-slate-200 rounded-md text-sm text-ink-secondary hover:bg-surface disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Salesperson names', value: summary.distinct_salespersons, sub: 'found on imported orders' },
          { label: 'Still to decide', value: summary.undecided, sub: 'sorted by order volume' },
          { label: 'Assigned to a person', value: summary.mapped_to_person, sub: 'ready to apply' },
          {
            label: 'No salesperson in Zoho',
            value: summary.orders_with_no_salesperson,
            sub: 'cannot be assigned — stays with Management'
          }
        ].map((c) => (
          <div key={c.label} className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 block">
              {c.label}
            </span>
            <span className="text-2xl font-black text-slate-900 block mt-1">
              {(c.value ?? 0).toLocaleString()}
            </span>
            <span className="text-[11px] text-ink-secondary">{c.sub}</span>
          </div>
        ))}
      </div>

      {/* The plan. Always shown before the commit button appears — moving tens
          of thousands of orders is not something to trigger blind. */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-2xs space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={() => preview.mutate()}
            disabled={preview.isPending}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            <PlayCircle size={15} />
            {preview.isPending ? 'Checking…' : 'Preview what would move'}
          </button>

          {plan && plan.total_orders > 0 && (
            <button
              onClick={() => commit.mutate()}
              disabled={commit.isPending}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-bold rounded-lg border border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              <UserCheck size={15} />
              {commit.isPending
                ? 'Assigning…'
                : `Assign ${plan.total_orders.toLocaleString()} order(s)`}
            </button>
          )}
        </div>

        {plan && (
          plan.total_orders === 0 ? (
            <p className="text-xs text-ink-secondary">
              Nothing to move — every decision made so far is already applied.
            </p>
          ) : (
            <div className="text-xs text-ink-secondary space-y-1">
              <p className="font-semibold text-ink-primary">
                {plan.total_orders.toLocaleString()} order(s) would change owner:
              </p>
              {plan.plan.slice(0, 12).map((p) => (
                <p key={p.zoho_salesperson}>
                  • <span className="font-mono">{p.zoho_salesperson}</span> →{' '}
                  <span className="font-semibold text-ink-primary">{p.user_name}</span>{' '}
                  ({p.orders.toLocaleString()})
                </p>
              ))}
              {plan.plan.length > 12 && <p>…and {plan.plan.length - 12} more.</p>}
            </div>
          )
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-2xs overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-200">
          <h2 className="text-sm font-semibold text-ink-primary">
            Salesperson names from Zoho
            <span className="ml-2 font-normal text-ink-secondary">
              highest order count first
            </span>
          </h2>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200">
            <thead className="bg-surface">
              <tr>
                {['Zoho Salesperson', 'Orders', 'What is it?', 'Assigned to', ''].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium text-ink-secondary uppercase">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((row) => (
                <tr key={row.zoho_salesperson} className="hover:bg-surface/60 align-top">
                  <td className="px-4 py-3 text-sm font-mono text-ink-primary max-w-xs break-words">
                    {row.zoho_salesperson}
                  </td>
                  <td className="px-4 py-3 text-sm font-semibold text-ink-primary tabular-nums">
                    {row.order_count.toLocaleString()}
                  </td>
                  <td className="px-4 py-3">
                    <select
                      value={row.kind}
                      onChange={(e) => setKind(row, e.target.value)}
                      className={`px-2 py-1 text-xs font-semibold rounded-lg border ${kindStyle[row.kind]}`}
                    >
                      {KINDS.map((k) => (
                        <option key={k.value} value={k.value}>{k.label}</option>
                      ))}
                    </select>
                  </td>
                  <td className="px-4 py-3">
                    {row.kind === 'person' ? (
                      <select
                        value={row.user_id || ''}
                        onChange={(e) => setUser(row, e.target.value)}
                        className="px-2 py-1 text-xs rounded-lg border border-slate-300 min-w-[12rem]"
                      >
                        <option value="">— No account yet —</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.display_name || u.name}
                            {u.division ? ` (${u.division})` : ''}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="text-xs text-ink-secondary">
                        {KINDS.find((k) => k.value === row.kind)?.hint}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {/* A suggestion is offered, never pre-applied. The
                        confidence is shown because 'name-only' means the
                        division disagrees, which is exactly when a human
                        should look rather than click. */}
                    {row.suggestion && (
                      <button
                        onClick={() => acceptSuggestion(row)}
                        title={row.suggestion.reason}
                        className={`inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-full border transition-colors ${
                          row.suggestion.confidence === 'exact'
                            ? 'border-pharmacy-green/40 bg-pharmacy-green/10 text-pharmacy-green-dark hover:bg-pharmacy-green/20'
                            : 'border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100'
                        }`}
                      >
                        <Sparkles size={12} />
                        {row.suggestion.user_name}
                        {row.suggestion.confidence === 'name-only' && ' — check division'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default SalespersonMappingPage;
