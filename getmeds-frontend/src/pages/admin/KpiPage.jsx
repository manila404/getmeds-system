import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ChevronLeft, ChevronRight, RefreshCw, CheckCircle2, AlertTriangle, Search, Copy, Save } from 'lucide-react';
import client from '../../api/client';

/**
 * Sales KPIs — Aaron sheet 13.1.2 (phases 1 and 2, shipped together). Oct 5, 2026.
 *
 * Every salesperson, team lead, head and channel for one month: booked vs target, orders and
 * orders held. Team / head / channel rows are always the sum of the people under them. The
 * numbers come from the same calculation as the monthly CSV export, and "booked" follows the
 * Finance Sales Summary rule, so the three always agree (the banner checks it every time).
 *
 * The running month is shown "so far". The page loads when opened and when Refresh is pressed —
 * there is no automatic refresh, to keep load off the database.
 */
const peso = (n) => `₱${(Number(n) || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pesoShort = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 1e6) return `₱${(v / 1e6).toLocaleString('en-PH', { maximumFractionDigits: 2 })}M`;
  if (Math.abs(v) >= 1e3) return `₱${(v / 1e3).toLocaleString('en-PH', { maximumFractionDigits: 1 })}K`;
  return peso(v);
};
const int = (n) => (Number(n) || 0).toLocaleString('en-PH');
const shiftMonth = (m, by) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-PH', { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const manilaMonth = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);

const TABS = [
  ['people', 'People'], ['teams', 'Team leads'], ['heads', 'Heads'], ['channels', 'Channels'],
  ['routing', 'Raised for others'], ['unplaced', 'No territory'], ['checks', 'Checks'],
  ['targets', 'Set targets'], ['history', 'Target changes']
];

const Pct = ({ value }) => {
  if (value === '' || value === null || value === undefined) return <span className="text-ink-secondary">—</span>;
  const v = Number(value);
  const tone = v >= 100 ? 'bg-pharmacy-green' : v >= 70 ? 'bg-getmeds-blue' : 'bg-state-warning';
  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <div className="h-1.5 flex-1 rounded-full bg-slate-100 overflow-hidden">
        <div className={`h-full ${tone}`} style={{ width: `${Math.min(v, 100)}%` }} />
      </div>
      <span className="text-xs font-semibold tabular-nums w-12 text-right">{v}%</span>
    </div>
  );
};
const NotTracked = () => <span className="text-[11px] text-slate-400 italic">Not tracked yet</span>;
const Th = ({ children, right }) => <th className={`px-3 py-2.5 ${right ? 'text-right' : ''}`}>{children}</th>;
const Td = ({ children, right, className = '' }) => <td className={`px-3 py-2 ${right ? 'text-right tabular-nums' : ''} ${className}`}>{children}</td>;
const Table = ({ minWidth = 900, head, children }) => (
  <table className="w-full text-sm" style={{ minWidth }}>
    <thead>
      <tr className="text-left text-[11px] uppercase tracking-wide text-ink-secondary border-b border-slate-200">{head}</tr>
    </thead>
    <tbody className="divide-y divide-slate-100">{children}</tbody>
  </table>
);

function GroupTable({ rows, label }) {
  const sorted = [...rows].sort((a, b) => b.booked_php - a.booked_php);
  return (
    <Table head={<><Th>{label}</Th><Th right>People</Th><Th right>Target</Th><Th right>Booked</Th><Th>% of target</Th><Th right>Booked orders</Th><Th right>Delivered</Th><Th right>Orders</Th><Th right>Held</Th><Th right>Raised by others</Th></>}>
      {sorted.map((r) => (
        <tr key={r[Object.keys(r)[0]]} className="hover:bg-slate-50">
          <Td className="font-medium text-ink-primary">{r[Object.keys(r)[0]]}</Td>
          <Td right>{r.people}</Td>
          <Td right>{r.target_php ? peso(r.target_php) : '—'}{r.targets_missing ? <div className="text-[11px] text-state-warning">{r.targets_missing} without target</div> : null}</Td>
          <Td right className="font-semibold">{peso(r.booked_php)}</Td>
          <Td><Pct value={r.pct_of_target} /></Td>
          <Td right>{int(r.booked_orders)}</Td>
          <Td right>{peso(r.delivered_php)}</Td>
          <Td right>{int(r.orders)}</Td>
          <Td right>{int(r.orders_held)}</Td>
          <Td right>{peso(r.booked_raised_by_others_php)}</Td>
        </tr>
      ))}
    </Table>
  );
}

function TargetsPanel({ month }) {
  const qc = useQueryClient();
  const [edits, setEdits] = useState({});
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['kpi-targets', month],
    queryFn: () => client.get('/api/kpi/targets', { params: { month } }).then((r) => r.data?.data),
    staleTime: 30_000
  });
  const people = data?.people || [];
  const dirty = Object.keys(edits).length;
  const after = async (text) => {
    setEdits({}); setMsg(text);
    await Promise.all([refetch(), qc.invalidateQueries({ queryKey: ['kpi', month] }), qc.invalidateQueries({ queryKey: ['kpi-history', month] })]);
  };
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const targets = Object.entries(edits).map(([user_id, target_php]) => ({ user_id: Number(user_id), target_php }));
      const r = await client.put(`/api/kpi/targets/${month}`, { targets });
      await after(`Saved — ${r.data.data.changed} target(s) changed.`);
    } catch (e) {
      setMsg(e.response?.data?.error?.message || 'Could not save the targets.');
    } finally { setBusy(false); }
  };
  const copy = async () => {
    setBusy(true); setMsg(null);
    try {
      const r = await client.post(`/api/kpi/targets/${month}/copy`, { from: data.prevMonth });
      await after(`Copied ${r.data.data.added} target(s) from ${monthLabel(data.prevMonth)}. Targets already set for ${monthLabel(month)} were left as they are.`);
    } catch (e) {
      setMsg(e.response?.data?.error?.message || 'Could not copy the targets.');
    } finally { setBusy(false); }
  };

  if (isLoading) return <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>;
  if (isError) return <p className="p-6 text-sm text-red-700">Could not load the targets. <button className="underline" onClick={() => refetch()}>Try again</button></p>;
  const missing = people.filter((p) => p.active && p.target_php === null).length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 p-4 border-b border-slate-200">
        <p className="text-sm text-ink-secondary flex-1 min-w-[240px]">
          One monthly target per person, in pesos booked. Team, head and channel targets are the sum of their people.
          Leave a box empty to remove a target. {missing ? <b className="text-state-warning">{missing} active people have no target for {monthLabel(month)}.</b> : null}
        </p>
        <button type="button" onClick={copy} disabled={busy}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-sm font-semibold text-ink-primary bg-white disabled:opacity-50">
          <Copy className="w-4 h-4" />Copy {monthLabel(data.prevMonth)}'s targets
        </button>
        <button type="button" onClick={save} disabled={busy || !dirty}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-getmeds-blue text-white text-sm font-semibold disabled:opacity-50">
          {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}Save {dirty ? `${dirty} change${dirty > 1 ? 's' : ''}` : 'changes'}
        </button>
      </div>
      {msg && <p className="px-4 py-2 text-sm bg-slate-50 border-b border-slate-200">{msg}</p>}
      <Table minWidth={760} head={<><Th>Person</Th><Th>Role</Th><Th right>{monthLabel(data.prevMonth)}</Th><Th right>Target for {monthLabel(month)}</Th><Th>Last set</Th></>}>
        {people.map((p) => {
          const value = p.user_id in edits ? edits[p.user_id] : (p.target_php ?? '');
          return (
            <tr key={p.user_id} className={p.user_id in edits ? 'bg-amber-50' : ''}>
              <Td className="font-medium text-ink-primary">{p.name}{!p.active && <span className="ml-2 text-[11px] text-ink-secondary">(inactive)</span>}<div className="text-[11px] text-ink-secondary">{p.email}</div></Td>
              <Td>{p.role === 'team_lead' ? 'Team lead' : 'MedRep'}</Td>
              <Td right className="text-ink-secondary">{p.prev_target_php === null ? '—' : peso(p.prev_target_php)}</Td>
              <Td right>
                <input type="text" inputMode="decimal" value={value} placeholder="—" aria-label={`Target for ${p.name}`}
                  onChange={(e) => {
                    const v = e.target.value;
                    setEdits((x) => {
                      const n = { ...x };
                      if (String(v) === String(p.target_php ?? '')) delete n[p.user_id]; else n[p.user_id] = v;
                      return n;
                    });
                  }}
                  className="w-36 text-right rounded-md border border-slate-300 px-2 py-1 text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-getmeds-blue/40" />
              </Td>
              <Td className="text-xs text-ink-secondary">{p.set_at ? `${p.set_by_name || '—'} · ${new Date(p.set_at).toLocaleString('en-PH')}` : '—'}</Td>
            </tr>
          );
        })}
      </Table>
    </div>
  );
}

function HistoryPanel({ month }) {
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ['kpi-history', month],
    queryFn: () => client.get('/api/kpi/target-changes', { params: { month } }).then((r) => r.data?.data),
    staleTime: 30_000
  });
  if (isLoading) return <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>;
  if (isError) return <p className="p-6 text-sm text-red-700">Could not load the changes. <button className="underline" onClick={() => refetch()}>Try again</button></p>;
  const rows = data?.changes || [];
  if (!rows.length) return <p className="p-6 text-sm text-ink-secondary">No target changes for {monthLabel(month)}.</p>;
  const how = { set: 'Set', clear: 'Removed', copy: 'Copied from last month' };
  return (
    <Table minWidth={720} head={<><Th>When</Th><Th>Person</Th><Th right>Before</Th><Th right>After</Th><Th>How</Th><Th>Changed by</Th></>}>
      {rows.map((c) => (
        <tr key={c.id}>
          <Td className="text-xs whitespace-nowrap">{new Date(c.changed_at).toLocaleString('en-PH')}</Td>
          <Td className="font-medium text-ink-primary">{c.person}</Td>
          <Td right>{c.old_target_php === null ? '—' : peso(c.old_target_php)}</Td>
          <Td right>{c.new_target_php === null ? '—' : peso(c.new_target_php)}</Td>
          <Td>{how[c.source] || c.source}</Td>
          <Td>{c.changed_by_name || '—'}</Td>
        </tr>
      ))}
    </Table>
  );
}

const KpiPage = () => {
  const [month, setMonth] = useState(manilaMonth());
  const [tab, setTab] = useState('people');
  const [search, setSearch] = useState('');
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['kpi', month],
    queryFn: () => client.get('/api/kpi', { params: { month } }).then((r) => r.data?.data),
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false
  });
  const thisMonth = data?.currentMonth || manilaMonth();
  const canSet = !!data?.canSetTargets;
  const tabs = TABS.filter(([k]) => canSet || !['targets', 'history'].includes(k));

  const people = useMemo(() => {
    const s = search.trim().toLowerCase();
    const rows = data?.people || [];
    return rows
      .filter((p) => !s || [p.person, p.email, p.team_lead, p.channel, p.head].some((x) => String(x || '').toLowerCase().includes(s)))
      .sort((a, b) => b.booked_php - a.booked_php || String(a.person).localeCompare(String(b.person)));
  }, [data, search]);

  if (isError && error?.response?.status === 404) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10">
        <h1 className="text-2xl font-semibold text-ink-primary">Sales KPIs</h1>
        <p className="text-sm text-ink-secondary mt-2">The KPI page is switched off.</p>
      </div>
    );
  }

  const totals = data && (() => {
    const p = data.people;
    const target = p.reduce((a, r) => a + (r.target_php === '' ? 0 : Number(r.target_php)), 0);
    return {
      target,
      withTarget: p.filter((r) => r.target_php !== '').length,
      orders: p.reduce((a, r) => a + r.orders, 0),
      held: p.reduce((a, r) => a + r.orders_held, 0),
      pct: target ? Math.round((data.totalBooked / target) * 1000) / 10 : ''
    };
  })();
  const matches = data && Math.abs(data.exportedBooked - data.totalBooked) < 0.005;

  return (
    <div className="max-w-7xl mx-auto px-4 py-6">
      <div className="flex flex-wrap items-end gap-3 justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-ink-primary">Sales KPIs</h1>
          <p className="text-sm text-ink-secondary mt-1 max-w-3xl">
            Booked sales against monthly targets for every salesperson, team lead, head and channel. Booked follows the Finance Sales Summary rule;
            an order counts for the MedRep who owns it. New customers and follow-ups on time are not tracked yet.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))} className="p-1.5 rounded-lg border border-slate-300 bg-white"><ChevronLeft className="w-4 h-4" /></button>
          <input type="month" value={month} max={thisMonth} onChange={(e) => e.target.value && e.target.value <= thisMonth && setMonth(e.target.value)}
            className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm bg-white" aria-label="Month" />
          <button type="button" aria-label="Next month" disabled={month >= thisMonth} onClick={() => setMonth(shiftMonth(month, 1))} className="p-1.5 rounded-lg border border-slate-300 bg-white disabled:opacity-40"><ChevronRight className="w-4 h-4" /></button>
          <button type="button" onClick={() => refetch()} disabled={isFetching} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-sm font-semibold disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />Refresh
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mt-3 text-xs">
        <span className={`px-2.5 py-1 rounded-full font-semibold border ${data?.partial ? 'bg-amber-50 text-amber-900 border-amber-300' : 'bg-slate-50 text-ink-secondary border-slate-300'}`}>
          {monthLabel(month)} · {data?.partial ? 'so far' : 'final'}
        </span>
        {data?.generatedAt && <span className="text-ink-secondary">as of {new Date(data.generatedAt).toLocaleString('en-PH')}</span>}
        {data && (matches
          ? <span className="inline-flex items-center gap-1 text-pharmacy-green-dark"><CheckCircle2 className="w-3.5 h-3.5" />Totals match the Finance rule</span>
          : <span className="inline-flex items-center gap-1 text-state-error font-semibold"><AlertTriangle className="w-3.5 h-3.5" />Totals do not match the Finance rule — see Checks</span>)}
        {data?.unplaced?.length ? (
          <button type="button" onClick={() => setTab('unplaced')} className="inline-flex items-center gap-1 text-state-warning font-semibold underline">
            <AlertTriangle className="w-3.5 h-3.5" />{data.unplaced.length} people have no territory
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mt-4">
        {[
          ['Booked', data ? pesoShort(data.totalBooked) : '—', data ? (() => { const n = Number(data.checks.find((c) => c.check === 'Booked orders (count)')?.value) || 0; return `${int(n)} order${n === 1 ? '' : 's'}`; })() : ''],
          ['Target', totals ? (totals.target ? pesoShort(totals.target) : 'Not set') : '—', totals ? `${totals.withTarget} of ${data.people.length} people have one` : ''],
          ['% of target', totals ? (totals.pct === '' ? '—' : `${totals.pct}%`) : '—', totals?.target ? 'booked ÷ target' : 'set targets to see this'],
          ['Orders raised', totals ? int(totals.orders) : '—', 'submitted this month'],
          ['Orders held', totals ? int(totals.held) : '—', 'put on hold this month']
        ].map(([t, v, sub]) => (
          <div key={t} className="rounded-xl border border-slate-200 bg-white p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{t}</p>
            <p className="text-2xl font-bold mt-1 text-ink-primary tabular-nums">{v}</p>
            <p className="text-xs text-ink-secondary mt-0.5">{sub}</p>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 mt-5">
        {tabs.map(([k, t]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${tab === k ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'border-slate-300 text-ink-secondary bg-white'}`}>
            {t}{k === 'unplaced' && data?.unplaced?.length ? ` (${data.unplaced.length})` : ''}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-xl border border-slate-200 bg-white overflow-x-auto">
        {tab === 'targets' ? <TargetsPanel month={month} />
          : tab === 'history' ? <HistoryPanel month={month} />
          : isLoading ? <p className="p-6 text-sm text-ink-secondary flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" />Loading…</p>
          : isError ? <p className="p-6 text-sm text-red-700">{error?.response?.data?.error?.message || 'Could not load the KPIs.'} <button className="underline" onClick={() => refetch()}>Try again</button></p>
          : tab === 'people' ? (
            <>
              <div className="p-3 border-b border-slate-200">
                <label className="relative block max-w-sm">
                  <Search className="w-4 h-4 absolute left-2.5 top-2 text-slate-400" />
                  <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search person, team lead, channel…"
                    className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-300 text-sm" />
                </label>
              </div>
              <Table minWidth={1250} head={<><Th>Person</Th><Th>Team lead</Th><Th>Channel</Th><Th right>Target</Th><Th right>Booked</Th><Th>% of target</Th><Th right>Booked orders</Th><Th right>Delivered</Th><Th right>Orders</Th><Th right>Held</Th><Th right>Raised by others</Th><Th>New customers</Th><Th>Follow-ups</Th></>}>
                {people.map((p) => (
                  <tr key={p.email} className="hover:bg-slate-50">
                    <Td className="font-medium text-ink-primary">{p.person}<div className="text-[11px] text-ink-secondary">{p.rep_type}{p.active === 'no' ? ' · inactive' : ''}</div></Td>
                    <Td>{p.team_lead}</Td>
                    <Td>{p.channel}{p.channel_source !== 'territory' && <div className="text-[11px] text-state-warning">{p.channel_source === 'none' ? 'no territory' : 'by order division'}</div>}</Td>
                    <Td right>{p.target_php === '' ? '—' : peso(p.target_php)}</Td>
                    <Td right className="font-semibold">{peso(p.booked_php)}</Td>
                    <Td><Pct value={p.pct_of_target} /></Td>
                    <Td right>{int(p.booked_orders)}</Td>
                    <Td right>{peso(p.delivered_php)}</Td>
                    <Td right>{int(p.orders)}</Td>
                    <Td right>{int(p.orders_held)}</Td>
                    <Td right>{p.booked_raised_by_others_php ? <>{peso(p.booked_raised_by_others_php)}<div className="text-[11px] text-ink-secondary">{p.booked_raised_by_others_orders} orders</div></> : '—'}</Td>
                    <Td><NotTracked /></Td>
                    <Td><NotTracked /></Td>
                  </tr>
                ))}
              </Table>
            </>
          )
          : tab === 'teams' ? <GroupTable rows={data.teams} label="Team lead" />
          : tab === 'heads' ? <GroupTable rows={data.heads} label="Head" />
          : tab === 'channels' ? <GroupTable rows={data.channels} label="Channel" />
          : tab === 'routing' ? (
            <>
              <p className="p-4 text-sm text-ink-secondary border-b border-slate-200">Booked orders raised by one person for another. The owner gets the credit; this keeps the raiser's part visible.</p>
              <Table minWidth={700} head={<><Th>Credited to (owner)</Th><Th>Owner type</Th><Th>Raised by</Th><Th>Raiser type</Th><Th right>Booked orders</Th><Th right>Booked</Th></>}>
                {data.routing.map((r) => (
                  <tr key={`${r.owner_credited}|${r.raised_by}`}><Td className="font-medium">{r.owner_credited}</Td><Td>{r.owner_rep_type}</Td><Td>{r.raised_by}</Td><Td>{r.raiser_rep_type}</Td><Td right>{int(r.booked_orders)}</Td><Td right>{peso(r.booked_php)}</Td></tr>
                ))}
              </Table>
            </>
          )
          : tab === 'unplaced' ? (
            <>
              <p className="p-4 text-sm text-ink-secondary border-b border-slate-200">
                People with no territory in the sales structure. Until they are mapped (User Management → By team), they are placed by the division of their own orders.
              </p>
              <Table minWidth={860} head={<><Th>Person</Th><Th>Team lead</Th><Th right>Booked</Th><Th right>Booked orders</Th><Th>Order divisions</Th><Th>Shown under</Th><Th>How</Th></>}>
                {data.unplaced.map((p) => (
                  <tr key={p.email}><Td className="font-medium">{p.person}<div className="text-[11px] text-ink-secondary">{p.email}</div></Td><Td>{p.team_lead}</Td><Td right>{peso(p.booked_php)}</Td><Td right>{int(p.booked_orders)}</Td><Td>{p.order_divisions || '—'}</Td><Td>{p.placed_in_export_as}</Td><Td>{p.how_placed}</Td></tr>
                ))}
              </Table>
            </>
          )
          : (
            <Table minWidth={700} head={<><Th>Check</Th><Th>Value</Th><Th>Note</Th></>}>
              {data.checks.map((c) => (
                <tr key={c.check}><Td className="font-medium">{c.check}</Td><Td className="tabular-nums">{typeof c.value === 'number' && /total|pesos/i.test(c.check) ? peso(c.value) : String(c.value)}</Td><Td className="text-ink-secondary">{c.note}</Td></tr>
              ))}
            </Table>
          )}
      </div>
    </div>
  );
};

export default KpiPage;
