import React, { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Shield, ShieldCheck, AlertTriangle, Save, Globe, Layers, Info } from 'lucide-react';
import client from '../../api/client';

/**
 * Sep 11, 2026: which divisions each manager covers.
 *
 * The enforcement already exists server-side — every list, every order, every
 * approve/reject. Without this screen the only way to configure it is SQL,
 * which means it gets set once by whoever built it and never adjusted again.
 *
 * Two things this page has to communicate, because both are easy to get wrong
 * and neither is visible from the database:
 *
 *   1. A manager restricted to divisions with NONE assigned sees NO orders.
 *      Deliberate, but it must never be a surprise.
 *   2. Divisions are wildly uneven — B2B holds ~8,900 orders and URO holds 6.
 *      "Assign a division" is not one decision repeated; the counts are shown
 *      so the difference is visible at the moment of choosing.
 */

const ManagerScopePage = () => {
  const qc = useQueryClient();
  const [draft, setDraft] = useState({});

  const { data, isLoading } = useQuery({
    queryKey: ['manager-scopes'],
    queryFn: () => client.get('/api/manager-scopes').then((r) => r.data)
  });

  const managers = data?.data?.managers || [];
  const divisions = data?.data?.divisions || [];
  const counts = data?.data?.orders_by_division || {};
  const unattributed = data?.data?.unattributed_orders || 0;

  const save = useMutation({
    mutationFn: ({ userId, body }) => client.put(`/api/manager-scopes/${userId}`, body).then((r) => r.data),
    onSuccess: (res, vars) => {
      // The server's warning is the authoritative one — it knows what actually
      // landed, which is not always what was sent.
      if (res?.data?.warning) toast(res.data.warning, { icon: '⚠️', duration: 6000 });
      else toast.success('Scope saved');
      setDraft((d) => {
        const next = { ...d };
        delete next[vars.userId];
        return next;
      });
      qc.invalidateQueries({ queryKey: ['manager-scopes'] });
    },
    onError: (err) => toast.error(err?.response?.data?.error?.message || 'Could not save')
  });

  /** The working copy for one manager — their saved state until edited. */
  const stateFor = (m) =>
    draft[m.id] || {
      order_scope: m.order_scope,
      divisions: m.rules.filter((r) => !r.sub_division).map((r) => r.division),
      subRules: m.rules.filter((r) => r.sub_division)
    };

  const edit = (m, patch) =>
    setDraft((d) => ({ ...d, [m.id]: { ...stateFor(m), ...patch } }));

  const toggleDivision = (m, division) => {
    const s = stateFor(m);
    const has = s.divisions.includes(division);
    edit(m, {
      divisions: has ? s.divisions.filter((x) => x !== division) : [...s.divisions, division]
    });
  };

  const submit = (m) => {
    const s = stateFor(m);
    save.mutate({
      userId: m.id,
      body: {
        order_scope: s.order_scope,
        // Whole-division grants plus any sub-division rules already held. The
        // server replaces the whole set, so both halves must be sent together
        // or the unsent half is silently revoked.
        rules: [
          ...s.divisions.map((division) => ({ division })),
          ...s.subRules.map((r) => ({ division: r.division, sub_division: r.sub_division }))
        ]
      }
    });
  };

  const totalScoped = useMemo(
    () => divisions.reduce((sum, d) => sum + (counts[d] || 0), 0),
    [divisions, counts]
  );

  if (isLoading) {
    return <p className="text-sm text-ink-secondary p-6">Loading…</p>;
  }

  return (
    <div className="p-6 max-w-5xl">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-ink-primary flex items-center gap-2">
          <Shield className="w-5 h-5 text-getmeds-blue" />
          Who covers which divisions
        </h1>
        <p className="text-sm text-ink-secondary mt-1">
          A manager with full access sees every order. A restricted manager sees only the divisions
          ticked for them — in the orders list, on the dashboard, and on every approve or reject.
        </p>
      </div>

      {/* The orders no division can claim. Stated up front because it is the
          largest single bucket and the reason a restricted manager's totals
          will never add up to the whole system. */}
      {unattributed > 0 && (
        <div className="mb-6 flex items-start gap-2 text-[13px] bg-surface border border-slate-200 rounded-lg px-3 py-2.5">
          <Info className="w-4 h-4 mt-0.5 shrink-0 text-ink-secondary" />
          <p className="text-ink-secondary">
            <strong className="text-ink-primary">{unattributed.toLocaleString()} orders</strong> carry no
            division — Zoho recorded no salesperson for them, so none can be worked out. Only a
            full-access manager sees these. {totalScoped.toLocaleString()} orders can be assigned by
            division.
          </p>
        </div>
      )}

      <div className="space-y-4">
        {managers.map((m) => {
          const s = stateFor(m);
          const dirty = !!draft[m.id];
          const restricted = s.order_scope === 'divisions';
          const emptyScope = restricted && s.divisions.length === 0 && s.subRules.length === 0;
          const visible = s.divisions.reduce((sum, d) => sum + (counts[d] || 0), 0);

          return (
            <div key={m.id} className="border border-slate-200 rounded-lg bg-white">
              <div className="flex items-start justify-between gap-4 px-4 py-3 border-b border-slate-100">
                <div className="min-w-0">
                  <p className="font-semibold text-ink-primary">{m.name}</p>
                  <p className="text-xs text-ink-secondary truncate">{m.email}</p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => edit(m, { order_scope: 'all' })}
                    className={`px-3 py-1.5 rounded text-xs font-semibold border inline-flex items-center gap-1.5 ${
                      !restricted
                        ? 'bg-getmeds-blue text-white border-getmeds-blue'
                        : 'bg-white text-ink-secondary border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <Globe className="w-3.5 h-3.5" />
                    Everything
                  </button>
                  <button
                    type="button"
                    onClick={() => edit(m, { order_scope: 'divisions' })}
                    className={`px-3 py-1.5 rounded text-xs font-semibold border inline-flex items-center gap-1.5 ${
                      restricted
                        ? 'bg-getmeds-blue text-white border-getmeds-blue'
                        : 'bg-white text-ink-secondary border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <Layers className="w-3.5 h-3.5" />
                    Only these divisions
                  </button>
                </div>
              </div>

              {restricted ? (
                <div className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    {divisions.map((d) => {
                      const on = s.divisions.includes(d);
                      const n = counts[d] || 0;
                      return (
                        <button
                          key={d}
                          type="button"
                          onClick={() => toggleDivision(m, d)}
                          className={`px-2.5 py-1.5 rounded border text-xs font-medium inline-flex items-center gap-2 ${
                            on
                              ? 'bg-pharmacy-green/10 text-pharmacy-green border-pharmacy-green/40'
                              : 'bg-white text-ink-secondary border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          {on && <ShieldCheck className="w-3.5 h-3.5" />}
                          {d}
                          {/* The count is the point: ticking B2B and ticking
                              URO are not remotely the same decision. */}
                          <span className={on ? 'text-pharmacy-green/70' : 'text-ink-secondary/60'}>
                            {n.toLocaleString()}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {s.subRules.length > 0 && (
                    <p className="mt-2 text-[11px] text-ink-secondary">
                      Also holds:{' '}
                      {s.subRules.map((r) => `${r.division} / ${r.sub_division}`).join(', ')}
                    </p>
                  )}

                  {emptyScope ? (
                    <p className="mt-3 flex items-start gap-1.5 text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                      <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>
                        No divisions ticked — this manager will see <strong>no orders at all</strong>.
                      </span>
                    </p>
                  ) : (
                    <p className="mt-3 text-[12px] text-ink-secondary">
                      Sees <strong className="text-ink-primary">{visible.toLocaleString()}</strong> of{' '}
                      {(totalScoped + unattributed).toLocaleString()} orders.
                    </p>
                  )}
                </div>
              ) : (
                <p className="px-4 py-3 text-[12px] text-ink-secondary">
                  Sees every order, including the {unattributed.toLocaleString()} with no division.
                </p>
              )}

              {dirty && (
                <div className="px-4 py-2.5 border-t border-slate-100 flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setDraft((d) => {
                        const next = { ...d };
                        delete next[m.id];
                        return next;
                      })
                    }
                    className="px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:text-ink-primary"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => submit(m)}
                    disabled={save.isPending}
                    className="px-3 py-1.5 rounded bg-getmeds-blue text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-60"
                  >
                    <Save className="w-3.5 h-3.5" />
                    {save.isPending ? 'Saving…' : 'Save'}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {managers.length === 0 && (
        <p className="text-sm text-ink-secondary">No management accounts yet.</p>
      )}
    </div>
  );
};

export default ManagerScopePage;
