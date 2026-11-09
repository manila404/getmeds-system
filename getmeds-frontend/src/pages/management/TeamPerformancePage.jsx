/**
 * Team performance — Nov 9, 2026 (Aaron). The Team Lead's view of each person under them, from the
 * approved mock (getmeds-documents/getmeds-system-mock/team-lead-member-performance-mock.html).
 *
 * Each member is shown with the SAME KPI card they see on their own dashboard (KpiBlock from
 * MyKpiPanel, same numbers from /api/kpi/team-performance), so a Team Lead and their MedRep never see
 * two different figures. Clicking a card opens that member's dashboard: their KPI, their pipeline this
 * month, flagged orders and their latest orders. View only; only people under this user (the same
 * reach as My Team). Loads when opened; no automatic refresh.
 */
import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, ArrowLeft, AlertCircle, LayoutGrid, Table2 } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { KpiBlock, kpiPeso as peso } from '../../components/dashboard/MyKpiPanel';
import OrderStatusBadge from '../../components/ui/OrderStatusBadge';

const manilaNow = () => new Date(Date.now() + 8 * 3600 * 1000);
const manilaMonth = () => manilaNow().toISOString().slice(0, 7);
const shiftMonth = (m, by) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' }); };
const int = (n) => (Number(n) || 0).toLocaleString('en-PH');
const roleLabel = (r) => (r === 'team_lead' ? 'Team Lead' : 'MedRep');
const tone = (p) => (p === null || p === undefined ? 'bg-slate-100 text-ink-secondary' : p >= 100 ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : p >= 70 ? 'bg-getmeds-blue/15 text-getmeds-blue-dark' : 'bg-state-warning-light text-amber-900');

function MonthPicker({ month, setMonth, thisMonth, partial }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <button type="button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))} className="p-1 rounded-md border border-slate-300 bg-white"><ChevronLeft className="w-4 h-4" /></button>
      <span className={`px-2.5 py-1 rounded-full font-semibold border ${partial ? 'bg-amber-50 text-amber-900 border-amber-300' : 'bg-slate-50 text-ink-secondary border-slate-300'}`}>
        {monthLabel(month)} · {partial ? 'so far' : 'final'}
      </span>
      <button type="button" aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth(shiftMonth(month, 1))} className="p-1 rounded-md border border-slate-300 bg-white disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
    </div>
  );
}

function MemberCard({ m, onOpen }) {
  return (
    <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      className="text-left rounded-xl cursor-pointer transition-shadow hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-getmeds-blue">
      <KpiBlock title={m.name} sub={`${roleLabel(m.role)}${m.channel && m.channel !== '(unplaced)' ? ` · ${m.channel}` : ''}`} k={m.kpi}
        extra={(
          <div className="flex items-center justify-between mt-3">
            <span className="text-xs font-semibold text-getmeds-blue-dark">Open dashboard →</span>
            {m.flagged > 0 && <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-state-error-light text-state-error">{m.flagged} flagged</span>}
          </div>
        )} />
    </div>
  );
}

function MembersTable({ members, onOpen }) {
  const [sort, setSort] = useState({ k: 'pct', dir: -1 });
  const val = (m) => ({ name: m.name, net: m.kpi.booked_net_php, target: m.kpi.target_php, pct: m.kpi.pct_of_target ?? -1, booked: m.kpi.booked_orders, newc: m.kpi.new_customers, held: m.kpi.orders_held, flagged: m.flagged }[sort.k]);
  const rows = [...members].sort((a, b) => { const x = val(a), y = val(b); return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir; });
  const th = (k, label, right) => (
    <th className={`px-3 py-2 text-[11px] font-semibold uppercase tracking-wide text-ink-secondary cursor-pointer select-none whitespace-nowrap ${right ? 'text-right' : 'text-left'}`}
      onClick={() => setSort((s) => ({ k, dir: s.k === k ? -s.dir : (k === 'name' ? 1 : -1) }))}>{label}</th>
  );
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: 760 }}>
        <thead className="border-b border-slate-200 bg-slate-50"><tr>{th('name', 'Member')}{th('net', 'Booked (without VAT)', true)}{th('target', 'Target', true)}{th('pct', '% of target', true)}{th('booked', 'Booked orders', true)}{th('newc', 'New customers', true)}{th('held', 'Held', true)}{th('flagged', 'Flagged', true)}</tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((m) => (
            <tr key={m.user_id} onClick={() => onOpen(m.user_id)} className="cursor-pointer hover:bg-slate-50">
              <td className="px-3 py-2"><b className="text-ink-primary">{m.name}</b><span className="block text-[11px] text-ink-secondary">{roleLabel(m.role)}</span></td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold">{peso(m.kpi.booked_net_php)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{m.kpi.target_php ? peso(m.kpi.target_php) : '—'}</td>
              <td className="px-3 py-2 text-right"><span className={`text-[11px] font-semibold rounded-full px-2 py-0.5 ${tone(m.kpi.pct_of_target)}`}>{m.kpi.pct_of_target === null ? 'No target' : `${m.kpi.pct_of_target}%`}</span></td>
              <td className="px-3 py-2 text-right tabular-nums">{int(m.kpi.booked_orders)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{int(m.kpi.new_customers)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{int(m.kpi.orders_held)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{m.flagged || 0}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MemberView({ userId, month, list, onBack, onGo }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['team-member', userId, month],
    queryFn: () => client.get(`/api/kpi/team-performance/${userId}`, { params: { month } }).then((r) => r.data?.data),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false
  });
  const at = list.findIndex((m) => m.user_id === userId);
  const days = (() => { const n = manilaNow(); const [y, mo] = month.split('-').map(Number); const last = new Date(Date.UTC(y, mo, 0)).getUTCDate(); return month === manilaMonth() ? last - n.getUTCDate() : 0; })();
  const k = data?.kpi;
  const p = data?.pipeline;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={onBack} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-slate-300 bg-white text-sm font-semibold"><ArrowLeft className="w-4 h-4" />All members</button>
        <span className="text-xs text-ink-secondary bg-slate-100 rounded-full px-2.5 py-1">Read-only · what they see on their dashboard</span>
        <div className="ml-auto flex gap-2">
          <button type="button" disabled={at <= 0} onClick={() => onGo(list[at - 1].user_id)} className="px-3 py-1.5 rounded-full border border-slate-300 bg-white text-sm font-semibold disabled:opacity-40">‹ Previous</button>
          <button type="button" disabled={at < 0 || at >= list.length - 1} onClick={() => onGo(list[at + 1].user_id)} className="px-3 py-1.5 rounded-full border border-slate-300 bg-white text-sm font-semibold disabled:opacity-40">Next ›</button>
        </div>
      </div>
      {isLoading ? <p className="text-sm text-ink-secondary">Loading…</p>
        : isError || !data ? <p className="text-sm text-ink-secondary">This member's dashboard could not be loaded.</p>
          : (
            <>
              <div>
                <h2 className="text-xl font-semibold text-ink-primary">{data.member.name}</h2>
                <p className="text-sm text-ink-secondary">{roleLabel(data.member.role)}{data.member.channel && data.member.channel !== '(unplaced)' ? ` · ${data.member.channel}` : ''}</p>
              </div>
              <div className="grid gap-3 lg:grid-cols-3">
                <div className="lg:col-span-2"><KpiBlock title="My Own KPI" sub={`${monthLabel(month)} · ${data.partial ? 'so far' : 'final'}`} k={k} /></div>
                <div className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-sm font-semibold text-ink-primary">For the coaching talk</p>
                  <ul className="mt-2 space-y-1.5 text-sm text-ink-secondary list-disc pl-5">
                    {k.target_php ? (
                      <li>{k.booked_net_php >= k.target_php ? <>Target reached.</> : <>Needs <b className="text-ink-primary">{peso(k.target_php - k.booked_net_php)}</b> more to reach the target{days ? ` (${days} days left)` : ''}.</>}</li>
                    ) : <li>No target set for this month.</li>}
                    <li>{data.flagged ? <><b className="text-state-error">{data.flagged} order{data.flagged > 1 ? 's' : ''}</b> on hold or with an exception.</> : 'No orders on hold or flagged.'}</li>
                    <li>{int(p.drafts)} draft{p.drafts === 1 ? '' : 's'} not yet submitted this month.</li>
                    <li>{int(k.new_customers)} new customer{k.new_customers === 1 ? '' : 's'} this month.</li>
                  </ul>
                </div>
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[['Total submissions', p.submissions, `${peso(p.volume_php)} volume this month`], ['Pending & validation', p.pending, `${int(p.drafts)} draft orders`], ['In fulfillment', p.fulfilment, 'processing & courier'], ['Completed orders', p.completed, 'delivered']].map(([t, v, s]) => (
                  <div key={t} className="bg-white rounded-xl border border-slate-200 p-4">
                    <p className="text-xs font-semibold uppercase text-ink-secondary tracking-wider">{t}</p>
                    <p className="text-3xl font-bold text-ink-primary mt-1">{int(v)}</p>
                    <p className="text-xs text-ink-secondary mt-1">{s}</p>
                  </div>
                ))}
              </div>
              {data.flagged > 0 && (
                <div className="bg-state-error-light border border-state-error/30 rounded-xl p-4 flex items-center gap-3">
                  <AlertCircle className="w-5 h-5 text-state-error flex-shrink-0" />
                  <p className="text-sm font-semibold text-red-950">{data.member.name.split(' ')[0]} has {data.flagged} order{data.flagged > 1 ? 's' : ''} on hold or flagged with an exception.</p>
                </div>
              )}
              <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
                <table className="w-full text-sm" style={{ minWidth: 620 }}>
                  <thead className="border-b border-slate-200 bg-slate-50"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary"><th className="px-3 py-2">Recent orders</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Status</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Date</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.recent.length ? data.recent.map((o) => (
                      <tr key={o.id}>
                        <td className="px-3 py-2"><Link to={`/orders/${o.id}`} className="font-semibold text-getmeds-blue-dark hover:underline">{o.order_no}</Link></td>
                        <td className="px-3 py-2 text-ink-secondary">{o.customer || '—'}</td>
                        <td className="px-3 py-2"><OrderStatusBadge status={o.status} /></td>
                        <td className="px-3 py-2 text-right tabular-nums">{peso(o.total_php)}</td>
                        <td className="px-3 py-2 text-ink-secondary">{new Date(o.created_at).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' })}</td>
                      </tr>
                    )) : <tr><td colSpan={5} className="px-3 py-4 text-ink-secondary">No orders yet.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
    </div>
  );
}

const TeamPerformancePage = () => {
  const { user } = useAuth();
  const [month, setMonth] = useState(manilaMonth());
  const [group, setGroup] = useState('all');
  const [layout, setLayout] = useState('cards');
  const [open, setOpen] = useState(null);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['team-performance', user?.id, month],
    queryFn: () => client.get('/api/kpi/team-performance', { params: { month } }).then((r) => r.data?.data),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    retry: false
  });
  const thisMonth = data?.currentMonth || manilaMonth();
  const groups = data?.groups || [];
  const current = groups.find((g) => g.key === group) || null;
  const members = useMemo(() => {
    if (!data) return [];
    if (!current) return data.members;
    const ids = new Set(current.ids);
    return data.members.filter((m) => ids.has(m.user_id));
  }, [data, current]);
  const teamKpi = current ? current.kpi : data?.team;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold text-ink-primary">Team performance</h1>
        <p className="text-sm text-ink-secondary mt-1">How each person in your team is doing this month — view only. Click a member to see their dashboard.</p>
      </div>

      {isLoading ? <p className="text-sm text-ink-secondary">Loading your team…</p>
        : isError ? (
          <p className="text-sm text-ink-secondary">{error?.response?.status === 403 || error?.response?.status === 404 ? 'KPIs are not open to the sales teams yet.' : 'Your team could not be loaded right now.'}</p>
        ) : !data?.members?.length ? <p className="text-sm text-ink-secondary">Nobody is on your team yet.</p>
          : open ? (
            <MemberView userId={open} month={month} list={members} onBack={() => setOpen(null)} onGo={setOpen} />
          ) : (
            <>
              {groups.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {[{ key: 'all', label: 'All', n: data.members.length }, ...groups.map((g) => ({ key: g.key, label: g.label, n: g.ids.length }))].map((g) => (
                    <button key={g.key} type="button" onClick={() => setGroup(g.key)}
                      className={`px-3 py-1.5 rounded-full border text-sm font-medium ${group === g.key ? 'bg-getmeds-blue border-getmeds-blue text-white' : 'bg-white border-slate-300 text-ink-primary'}`}>
                      {g.label} <span className="opacity-70">({g.n})</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex justify-end"><MonthPicker month={month} setMonth={setMonth} thisMonth={thisMonth} partial={data.partial} /></div>
              {teamKpi && (
                <KpiBlock title={current ? `${current.label} · Team KPI` : 'My Team KPI'}
                  sub={`${int(teamKpi.people)} people · ${int(teamKpi.people_with_target)} with a target${(current ? current.flagged : data.team.flagged) ? ` · ${current ? current.flagged : data.team.flagged} flagged` : ''}`} k={teamKpi} />
              )}
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-ink-primary">{current ? 'Members' : 'Your members'}</h2>
                <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden text-xs font-semibold">
                  <button type="button" onClick={() => setLayout('cards')} className={`inline-flex items-center gap-1 px-2.5 py-1.5 ${layout === 'cards' ? 'bg-ink-primary text-white' : 'bg-white text-ink-secondary'}`}><LayoutGrid className="w-3.5 h-3.5" />KPI cards</button>
                  <button type="button" onClick={() => setLayout('table')} className={`inline-flex items-center gap-1 px-2.5 py-1.5 ${layout === 'table' ? 'bg-ink-primary text-white' : 'bg-white text-ink-secondary'}`}><Table2 className="w-3.5 h-3.5" />Table</button>
                </div>
              </div>
              {layout === 'cards' ? (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {members.map((m) => <MemberCard key={m.user_id} m={m} onOpen={() => setOpen(m.user_id)} />)}
                </div>
              ) : <MembersTable members={members} onOpen={setOpen} />}
              <p className="text-xs text-ink-secondary">Each card is the member's own KPI, exactly as they see it: orders Finance verified this month, without VAT, against their target. Sorted by % of target.</p>
            </>
          )}
    </div>
  );
};

export default TeamPerformancePage;
