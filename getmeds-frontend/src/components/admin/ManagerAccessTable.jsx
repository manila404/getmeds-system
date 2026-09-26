import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldCheck, AlertTriangle, Save, Globe, Layers } from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';

/**
 * Management (Approval), with what each manager can see — Sep 26, 2026.
 *
 * This replaces the separate Manager Access page: who a manager approves for, and
 * which divisions they can see, are now set in one place, on the manager's row.
 *
 *   Approves (structure)   the channels the team structure names them as approver of
 *   Sees now               what the app lets them see and approve today
 *   Match                  whether the two agree
 *   Edit access            Everything, or only the divisions ticked (with order counts),
 *                          and "Match the structure" to tick what their channels imply
 *
 * A manager restricted to divisions with none ticked sees NO orders, and the editor
 * says so. Orders with no division are seen only by a full-access manager.
 * Nothing changes until Save.
 */

const errorText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;
const chName = (n) => String(n).replace(/^RX · /, '');
const num = (v) => Number(v || 0).toLocaleString();

const MATCH = {
  matches: { text: 'Matches', chip: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  full_access: { text: 'Full access', chip: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  differs: { text: 'Differs', chip: 'bg-amber-50 text-amber-800 border-amber-200' },
  blocked: { text: 'Needs a division', chip: 'bg-red-50 text-red-700 border-red-200' },
  not_in_structure: { text: 'Not in structure', chip: 'bg-slate-100 text-slate-600 border-slate-200' },
};
const TONE = {
  ok: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  wait: 'bg-amber-50 text-amber-800 border-amber-200',
  off: 'bg-slate-100 text-slate-600 border-slate-200',
};

const accessNow = (it) => (it.current.mode === 'divisions'
  ? (it.current.divisions.length ? `Only ${it.current.divisions.join(', ')}` : 'Nothing (no divisions set)')
  : 'Everything');

const toggleCls = (on) => `px-3 py-1.5 rounded text-xs font-semibold border inline-flex items-center gap-1.5 ${
  on ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'bg-white text-ink-secondary border-slate-200 hover:border-slate-300'}`;

const ManagerAccessTable = ({ rows, onOpen }) => {
  const qc = useQueryClient();
  const plan = useQuery({
    queryKey: ['manager-access-plan'],
    queryFn: () => client.get('/api/admin/team-structure/manager-access-plan').then((r) => r.data.data),
    retry: false,
  });
  const scopes = useQuery({
    queryKey: ['manager-scopes'],
    queryFn: () => client.get('/api/manager-scopes').then((r) => r.data.data),
    retry: false,
  });
  const [editing, setEditing] = useState(null); // { id, order_scope, divisions, subRules }
  const [loading, setLoading] = useState(false);

  const items = new Map((plan.data?.items || []).map((i) => [i.user_id, i]));
  const scopeOf = new Map((scopes.data?.managers || []).map((m) => [m.id, m]));
  const divisions = scopes.data?.divisions || [];
  const counts = scopes.data?.orders_by_division || {};
  const unattributed = scopes.data?.unattributed_orders || 0;
  const total = divisions.reduce((s, d) => s + (counts[d] || 0), 0) + unattributed;

  const refetchAll = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['manager-access-plan'] }),
    qc.invalidateQueries({ queryKey: ['manager-scopes'] }),
  ]);

  const save = useMutation({
    mutationFn: (e) => client.put(`/api/manager-scopes/${e.id}`, {
      order_scope: e.order_scope,
      // The server replaces the whole set, so whole-division ticks and any
      // sub-division limits already held are sent together.
      rules: [...e.divisions.map((division) => ({ division })), ...e.subRules.map((r) => ({ division: r.division, sub_division: r.sub_division }))],
    }).then((r) => r.data),
    onSuccess: async (res) => {
      if (res?.data?.warning) toast(res.data.warning, { icon: '⚠️', duration: 6000 });
      else toast.success('Access saved.');
      setEditing(null);
      await refetchAll();
    },
    onError: (err) => toast.error(errorText(err, 'Could not save.')),
  });

  const startEdit = (id) => {
    const m = scopeOf.get(id);
    if (!m) return;
    setEditing({
      id,
      order_scope: m.order_scope === 'divisions' ? 'divisions' : 'all',
      divisions: m.rules.filter((r) => !r.sub_division).map((r) => r.division),
      subRules: m.rules.filter((r) => r.sub_division),
    });
  };
  const tick = (d) => setEditing((e) => ({ ...e, divisions: e.divisions.includes(d) ? e.divisions.filter((x) => x !== d) : [...e.divisions, d] }));

  // The sheet's approvers are added to the structure by "Load the sales sheet"; until
  // then every manager reads "Not in structure". Offer it here, additive only.
  const structureEmpty = plan.data && plan.data.items.length > 0 && plan.data.items.every((i) => i.status === 'not_in_structure');
  const loadSheet = async () => {
    setLoading(true);
    try {
      const res = await client.post('/api/admin/team-structure/import', {});
      const a = res.data.data?.approvers || {};
      toast.success(`Added ${a.created || 0} approver${a.created === 1 ? '' : 's'} from the sheet (${a.linked || 0} linked to an account).`);
      await Promise.all([refetchAll(), qc.invalidateQueries({ queryKey: ['team-structure'] })]);
    } catch (err) {
      toast.error(errorText(err, 'Could not load the sheet.'));
    } finally {
      setLoading(false);
    }
  };

  if (rows.length === 0) return <p className="px-4 py-4 text-sm text-ink-secondary">No accounts here.</p>;

  const differing = (plan.data?.items || []).filter((i) => i.status === 'differs' && rows.some((r) => r.user.id === i.user_id)).length;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 bg-slate-50/70 border-b border-slate-100 text-xs text-ink-secondary">
        <span>
          A manager is the approver. Set what each manager sees and approves on their row: everything, or only the divisions ticked.
          {plan.data && !structureEmpty && (differing
            ? <strong className="text-amber-800"> {differing} differ{differing === 1 ? 's' : ''} from the structure.</strong>
            : <strong className="text-emerald-800"> Everything agrees with the structure.</strong>)}
        </span>
        {structureEmpty && (
          <button type="button" onClick={loadSheet} disabled={loading} className="font-semibold text-getmeds-blue hover:text-getmeds-blue-dark disabled:opacity-60">
            {loading ? 'Loading…' : 'Add the approvers from the sheet'}
          </button>
        )}
      </div>

      {(plan.error || scopes.error) && (
        <div role="alert" className="mx-4 mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Could not load manager access: {errorText(plan.error || scopes.error, 'unknown error')}
        </div>
      )}

      <div className="overflow-x-auto thin-scroll">
        <table className="w-full min-w-[1040px]">
          <thead className="bg-slate-50">
            <tr>
              {['Person', 'Approves (structure)', 'Sees now', 'Match', 'Zoho salesperson', 'Status', ''].map((h, i) => (
                <th key={i} className="text-left px-3.5 py-2 text-[11px] uppercase tracking-wide text-ink-secondary font-semibold">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const it = items.get(r.user.id);
              const m = it ? MATCH[it.status] : null;
              const e = editing && editing.id === r.user.id ? editing : null;
              const restricted = e && e.order_scope === 'divisions';
              const empty = restricted && e.divisions.length === 0 && e.subRules.length === 0;
              const visible = e ? e.divisions.reduce((s, d) => s + (counts[d] || 0), 0) : 0;
              const canEdit = it && scopeOf.has(r.user.id);
              return (
                <React.Fragment key={r.key}>
                  <tr onClick={() => onOpen(r.user.id)} className="cursor-pointer hover:bg-surface">
                    <td className="py-2 pr-3 pl-3.5 text-[13px] font-medium text-ink-primary">{r.name}</td>
                    <td className="py-2 pr-3 text-[12.5px] text-ink-secondary">
                      {it ? (it.approves_channels.length ? it.approves_channels.map(chName).join(', ') : <span className="text-slate-400">None</span>) : (plan.isLoading ? '…' : '')}
                      {it && it.leads_channels.length > 0 && <div className="text-[11px] text-slate-500">Also team lead in {it.leads_channels.map(chName).join(', ')}</div>}
                    </td>
                    <td className="py-2 pr-3 text-[12.5px] text-ink-primary">
                      {it && (
                        <>
                          {accessNow(it)}
                          <div className="text-[11px] text-slate-500 tabular-nums">{num(it.orders_visible_now)} of {num(plan.data.orders_total)} orders</div>
                        </>
                      )}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      {m && <span className={`inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${m.chip}`}>{m.text}</span>}
                    </td>
                    <td className="py-2 pr-3 text-[12px] font-mono text-ink-secondary">{r.zoho}</td>
                    <td className="py-2 pr-3 whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${TONE[r.status.tone]}`}>{r.status.text}</span>
                    </td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap" onClick={(ev) => ev.stopPropagation()}>
                      {canEdit && !e && (
                        <button type="button" onClick={() => startEdit(r.user.id)} className="text-[12px] font-semibold text-getmeds-blue hover:text-getmeds-blue-dark">Edit access</button>
                      )}
                    </td>
                  </tr>

                  {e && (
                    <tr className="bg-slate-50/70">
                      <td colSpan={7} className="px-4 py-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="flex items-center gap-2">
                            <button type="button" onClick={() => setEditing({ ...e, order_scope: 'all' })} className={toggleCls(!restricted)}><Globe className="w-3.5 h-3.5" />Everything</button>
                            <button type="button" onClick={() => setEditing({ ...e, order_scope: 'divisions' })} className={toggleCls(restricted)}><Layers className="w-3.5 h-3.5" />Only these divisions</button>
                          </div>
                          {it && it.status === 'differs' && (
                            <button type="button" onClick={() => setEditing({ ...e, order_scope: 'divisions', divisions: it.proposed_divisions })}
                              className="text-[12px] font-semibold text-getmeds-blue hover:text-getmeds-blue-dark">
                              Match the structure ({it.proposed_divisions.join(', ')})
                            </button>
                          )}
                        </div>

                        {restricted ? (
                          <div className="mt-3">
                            <div className="flex flex-wrap gap-2">
                              {divisions.map((d) => {
                                const on = e.divisions.includes(d);
                                return (
                                  <button key={d} type="button" onClick={() => tick(d)}
                                    className={`px-2.5 py-1.5 rounded border text-xs font-medium inline-flex items-center gap-2 ${on ? 'bg-pharmacy-green/10 text-pharmacy-green border-pharmacy-green/40' : 'bg-white text-ink-secondary border-slate-200 hover:border-slate-300'}`}>
                                    {on && <ShieldCheck className="w-3.5 h-3.5" />}
                                    {d}
                                    {/* The count is the point: ticking B2B and ticking URO are not the same decision. */}
                                    <span className={on ? 'text-pharmacy-green/70' : 'text-ink-secondary/60'}>{num(counts[d])}</span>
                                  </button>
                                );
                              })}
                            </div>
                            {e.subRules.length > 0 && <p className="mt-2 text-[11px] text-ink-secondary">Also holds: {e.subRules.map((x) => `${x.division} / ${x.sub_division}`).join(', ')}</p>}
                            {empty ? (
                              <p className="mt-3 flex items-start gap-1.5 text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 max-w-xl">
                                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>No divisions ticked: this manager will see <strong>no orders at all</strong>.</span>
                              </p>
                            ) : (
                              <p className="mt-3 text-[12px] text-ink-secondary">
                                Will see <strong className="text-ink-primary">{num(visible)}</strong> of {num(total)} orders.
                                {' '}{num(unattributed)} orders carry no division and only a full-access manager sees them.
                              </p>
                            )}
                          </div>
                        ) : (
                          <p className="mt-3 text-[12px] text-ink-secondary">Sees every order, including the {num(unattributed)} with no division.</p>
                        )}

                        <div className="mt-3 flex justify-end gap-2">
                          <button type="button" disabled={save.isPending} onClick={() => setEditing(null)} className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-sm font-medium text-ink-secondary hover:bg-surface">Cancel</button>
                          <button type="button" disabled={save.isPending} onClick={() => save.mutate(e)} className="px-3.5 py-1.5 rounded-md text-sm font-semibold text-white bg-getmeds-blue hover:bg-getmeds-blue-hover disabled:opacity-60 inline-flex items-center gap-1.5">
                            <Save className="w-3.5 h-3.5" />{save.isPending ? 'Saving…' : 'Save'}
                          </button>
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
    </div>
  );
};

export default ManagerAccessTable;
