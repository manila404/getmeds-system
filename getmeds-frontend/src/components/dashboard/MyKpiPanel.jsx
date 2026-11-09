import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Target } from 'lucide-react';
import client from '../../api/client';
import { useAuth } from '../../hooks/useAuth';
import { useKpiStatus } from '../../hooks/useKpiStatus';

/**
 * My Own KPI and My Team KPI — Oct 6, 2026 (sales structure, Aaron sheet 12.13).
 *
 * My Own KPI: the orders this person owns, so an order a Leader entered for a MedRep counts
 * on the MedRep's own KPI. My Team KPI (anyone with people under them): the person plus
 * everyone below them in the Team Lead chain, or just the My Team tab that is open
 * (`teamGroup`). Same numbers as the Admin Sales KPIs page (one calculation on the server).
 *
 * Shows nothing unless KPIs are switched on (GETMEDS_KPI_PAGE). Loads when the page opens;
 * no automatic refresh.
 *
 * Nov 9, 2026 (Aaron): an order counts once it is INVOICED (on its first Zoho invoice date), not when
 * Finance verifies it; orders verified but not invoiced yet are shown as "waiting for invoice". And a
 * day filter (Today · Yesterday · Pick a date · This month) shows the sales invoiced on one day.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const int = (n) => (Number(n) || 0).toLocaleString('en-PH');
const manilaMonth = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
const shiftMonth = (m, by) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const manilaDay = (back = 0) => new Date(Date.now() + 8 * 3600 * 1000 - back * 86400000).toISOString().slice(0, 10);
const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-PH', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** Today · Yesterday · Pick a date · This month. `period` is 'month' or a 'YYYY-MM-DD' day. */
function PeriodPicker({ period, setPeriod }) {
  const today = manilaDay(), yesterday = manilaDay(1);
  const mode = period === 'month' ? 'month' : period === today ? 'today' : period === yesterday ? 'yesterday' : 'day';
  const btn = (k, label, onClick) => (
    <button type="button" onClick={onClick} className={`px-3 py-1.5 font-semibold ${mode === k ? 'bg-getmeds-blue text-white' : 'bg-white text-ink-secondary hover:bg-slate-50'}`}>{label}</button>
  );
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <div className="inline-flex rounded-lg border border-slate-300 overflow-hidden">
        {btn('today', 'Today', () => setPeriod(today))}
        {btn('yesterday', 'Yesterday', () => setPeriod(yesterday))}
        {btn('day', 'Pick a date', () => setPeriod(mode === 'day' ? period : manilaDay(2)))}
        {btn('month', 'This month', () => setPeriod('month'))}
      </div>
      {mode === 'day' && (
        <input type="date" value={period} max={today} onChange={(e) => e.target.value && e.target.value <= today && setPeriod(e.target.value)}
          className="rounded-lg border border-slate-300 px-2 py-1 bg-white" aria-label="Date" />
      )}
    </div>
  );
}

/** The orders invoiced on one day: order, invoice, customer, amount without VAT. */
function DayOrders({ orders, names }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
      <table className="w-full text-sm" style={{ minWidth: 560 }}>
        <thead className="border-b border-slate-200 bg-slate-50"><tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary">
          <th className="px-3 py-2">Order</th>{names && <th className="px-3 py-2">Salesperson</th>}<th className="px-3 py-2">Invoice</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2 text-right">Amount (without VAT)</th>
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {orders.length ? orders.map((o) => (
            <tr key={o.id}>
              <td className="px-3 py-2 font-semibold text-ink-primary">{o.order_no}</td>
              {names && <td className="px-3 py-2 text-ink-secondary">{names.get(o.user_id) || ''}</td>}
              <td className="px-3 py-2 text-ink-secondary">{o.invoice_numbers}</td>
              <td className="px-3 py-2 text-ink-secondary">{o.customer || '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums font-semibold">{peso(o.net_php)}</td>
            </tr>
          )) : <tr><td colSpan={names ? 5 : 4} className="px-3 py-4 text-ink-secondary">No invoiced orders on this day.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};

function Bar({ pct }) {
  if (pct === null || pct === undefined) return <p className="text-xs text-ink-secondary mt-2">No target set for this month</p>;
  const tone = pct >= 100 ? 'bg-pharmacy-green' : pct >= 70 ? 'bg-getmeds-blue' : 'bg-state-warning';
  return (
    <div className="mt-2">
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden"><div className={`h-full ${tone}`} style={{ width: `${Math.min(pct, 100)}%` }} /></div>
      <p className="text-xs text-ink-secondary mt-1"><b className="text-ink-primary">{pct}%</b> of target</p>
    </div>
  );
}

function KpiBlock({ title, sub, k, extra }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink-primary">{title}</p>
        {sub && <p className="text-xs text-ink-secondary">{sub}</p>}
      </div>
      <div className="mt-2 flex items-end gap-2 flex-wrap">
        {/* Oct 29, 2026 (Aaron): sales without VAT, as the Team Leads count them; with VAT shown below. */}
        <p className="text-2xl font-bold text-ink-primary tabular-nums">{peso(k.booked_net_php ?? k.booked_php)}</p>
        <p className="text-xs text-ink-secondary mb-1">invoiced, without VAT{k.target_php ? ` · of ${peso(k.target_php)} target` : ''}</p>
      </div>
      {k.booked_net_php !== undefined && (
        <p className="text-[11px] text-ink-secondary mt-0.5">With VAT {peso(k.booked_php)} · VAT {peso(k.vat_php)}</p>
      )}
      <Bar pct={k.pct_of_target} />
      {k.vacant_target_php > 0 && (
        <p className="text-[11px] text-ink-secondary mt-1" title={(k.vacant_territories || []).join(', ')}>
          Target includes {peso(k.vacant_target_php)} for vacant territories ({(k.vacant_territories || []).join(', ')})
        </p>
      )}
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3 text-center">
        {[['Orders invoiced', int(k.booked_orders)], ['New customers', int(k.new_customers)], ['Orders raised', int(k.orders)], ['Orders held', int(k.orders_held)]].map(([t, v]) => (
          <div key={t} className="rounded-lg bg-slate-50 py-2">
            <dd className="text-base font-semibold text-ink-primary tabular-nums">{v}</dd>
            <dt className="text-[11px] text-ink-secondary">{t}</dt>
          </div>
        ))}
      </dl>
      {k.waiting_invoice_orders > 0 && (
        <p className="text-[11px] mt-2 rounded-md bg-amber-50 text-amber-900 px-2 py-1">
          {int(k.waiting_invoice_orders)} order{k.waiting_invoice_orders > 1 ? 's' : ''} ({peso(k.waiting_invoice_php)}) verified, waiting for invoice — not counted yet
        </p>
      )}
      {extra}
    </div>
  );
}

const MyKpiPanel = ({ teamGroup = '' }) => {
  const { user } = useAuth();
  const status = useKpiStatus(user?.role, user?.id);
  const [monthPicked, setMonth] = useState(manilaMonth());
  // Nov 9, 2026: 'month' or one day ('YYYY-MM-DD'); a day shows that month's KPI plus the day's sales.
  const [period, setPeriod] = useState(manilaDay());
  const month = period === 'month' ? monthPicked : period.slice(0, 7);
  const { data, isLoading, isError } = useQuery({
    queryKey: ['kpi-me', user?.id, month, period, teamGroup], // per person: logout does not clear the page's memory
    queryFn: () => client.get('/api/kpi/me', { params: { month, ...(period !== 'month' ? { day: period } : {}), ...(teamGroup ? { team_group: teamGroup } : {}) } }).then((r) => r.data?.data),
    enabled: status.canViewOwn,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false
  });
  if (!status.canViewOwn) return null;
  const thisMonth = data?.currentMonth || manilaMonth();

  return (
    <section aria-label="My KPIs" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-ink-primary inline-flex items-center gap-2"><Target className="w-4 h-4 text-getmeds-blue" />My KPIs</h2>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <PeriodPicker period={period} setPeriod={setPeriod} />
          {period === 'month' && <>
          <button type="button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))} className="p-1 rounded-md border border-slate-300 bg-white"><ChevronLeft className="w-4 h-4" /></button>
          <span className={`px-2.5 py-1 rounded-full font-semibold border ${data?.partial ? 'bg-amber-50 text-amber-900 border-amber-300' : 'bg-slate-50 text-ink-secondary border-slate-300'}`}>
            {monthLabel(month)} · {data?.partial ? 'so far' : 'final'}
          </span>
          <button type="button" aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth(shiftMonth(month, 1))} className="p-1 rounded-md border border-slate-300 bg-white disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
          </>}
        </div>
      </div>
      {isLoading ? (
        <p className="text-sm text-ink-secondary">Loading your KPIs…</p>
      ) : isError || !data ? (
        <p className="text-sm text-ink-secondary">Your KPIs could not be loaded right now.</p>
      ) : (
        <div className={`grid gap-3 ${data.team ? 'md:grid-cols-2' : ''}`}>
          <KpiBlock title="My Own KPI" sub="orders that are yours" k={data.own}
            extra={(data.own.entered_for_others_php || data.own.by_channel) ? (
              <>
                {/* Oct 30, 2026: selling in two divisions (Nicka: CLIDP and MT): each one's share, by the Zoho
                    Salesperson on the order. */}
                {data.own.by_channel && (
                  <p className="text-xs text-ink-secondary mt-3">
                    By division:{' '}
                    {data.own.by_channel.map((c, i) => (
                      <span key={c.channel_id}>{i > 0 && ' · '}{c.channel.replace(/^RX · /, '')} <b className="text-ink-primary">{peso(c.booked_net_php)}</b></span>
                    ))}
                  </p>
                )}
                {data.own.entered_for_others_php ? (
                  <p className="text-xs text-ink-secondary mt-3">You also entered <b className="text-ink-primary">{peso(data.own.entered_for_others_php)}</b> for others (counted on their KPI).</p>
                ) : null}
              </>
            ) : null} />
          {data.team && (
            <KpiBlock title={data.team.label === 'My team' ? 'My Team KPI' : `My Team KPI · ${data.team.label}`}
              sub={`${int(data.team.people)} people · ${int(data.team.people_with_target)} with a target`} k={data.team} />
          )}
        </div>
      )}
      {data?.day && (
        <div className="space-y-3">
          <div className={`grid gap-3 ${data.day.team ? 'md:grid-cols-2' : ''}`}>
            {[['own', period === manilaDay() ? 'My sales today' : `My sales on ${dayLabel(period)}`], ['team', period === manilaDay() ? "My team's sales today" : `My team's sales on ${dayLabel(period)}`]]
              .filter(([k]) => data.day[k]).map(([k, label]) => (
                <div key={k} className="rounded-xl border border-slate-200 bg-white p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-ink-secondary">{label}</p>
                  <p className="text-2xl font-bold text-ink-primary tabular-nums mt-1">{peso(data.day[k].net_php)}</p>
                  <p className="text-xs text-ink-secondary">{int(data.day[k].orders.length)} order{data.day[k].orders.length === 1 ? '' : 's'} invoiced · without VAT{period === manilaDay() ? ' · so far today' : ''}</p>
                </div>
              ))}
          </div>
          <DayOrders orders={data.day.own.orders} />
        </div>
      )}
    </section>
  );
};

export { KpiBlock, PeriodPicker, DayOrders, manilaDay, dayLabel, peso as kpiPeso };
export default MyKpiPanel;
