import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, Download, AlertTriangle, CheckCircle2, ChevronDown } from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';

/**
 * Team Structure — Sep 26, 2026.
 *
 * Who leads what: Head → Channel → Manager → Territory, from the September sales
 * sheet, with each territory matched to the real accounts that hold it (by Zoho
 * salesperson name). Read-only here: this screen shows, it does not change accounts.
 * The API also has editing and a Team Lead preview/apply (see
 * controllers/salesStructure.controller.js); only the preview is shown.
 *
 * Territory status:
 *   covered      an active account holds it
 *   vacant       no account, and the sheet says vacant
 *   no_account   no account, but the sheet names a person: worth chasing
 */

const STATUS = {
  covered: { label: 'Covered', chip: 'bg-emerald-50 text-emerald-800 border-emerald-200', dot: { fill: '#1D9FDA', stroke: '#1D9FDA' } },
  vacant: { label: 'Vacant', chip: 'bg-red-50 text-red-700 border-red-200', dot: { fill: '#FDE8E8', stroke: '#C62828', dash: '2 1.5' } },
  no_account: { label: 'No account', chip: 'bg-amber-50 text-amber-800 border-amber-200', dot: { fill: '#FEF3C7', stroke: '#B45309', dash: '2 1.5' } },
};

const REASONS = {
  manager_has_no_account: "The sheet's manager has no account linked",
  manager_not_team_lead: "The manager's account is not a Team Lead account",
  multiple_managers: 'Holds territories under different managers',
  not_in_structure: 'Not in the structure',
};

const peso = (n) => {
  const v = Number(n || 0);
  return `₱${v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${Math.round(v / 1e3)}K`}`;
};

const errorText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;

/* ── the org chart ─────────────────────────────────────────────────────────── */

const RH = 62;
const NH = 48;
const TOP = 10;
const X = { root: 10, head: 190, ch: 370, mgr: 580 };
const W = { root: 150, head: 150, ch: 190, mgr: 350 };

const OrgChart = ({ heads, summary, onPick }) => {
  // Give every manager a row, then centre each parent on its children.
  let row = 0;
  const lay = heads.map((h) => {
    const chs = h.channels.map((c) => {
      const mgrs = c.managers.map((m) => ({ m, y: TOP + (row++) * RH }));
      const y = mgrs.length ? (mgrs[0].y + mgrs[mgrs.length - 1].y) / 2 : TOP + (row++) * RH;
      return { c, mgrs, y };
    });
    const y = chs.length ? (chs[0].y + chs[chs.length - 1].y) / 2 : TOP;
    return { h, chs, y };
  });
  if (!lay.length) return null;
  const rootY = (lay[0].y + lay[lay.length - 1].y) / 2;
  const height = TOP + row * RH;
  const width = X.mgr + W.mgr + 10;

  const edge = (x1, y1, x2, y2) => {
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1 + NH / 2} C${mx} ${y1 + NH / 2} ${mx} ${y2 + NH / 2} ${x2} ${y2 + NH / 2}`;
  };

  return (
    <div className="overflow-x-auto thin-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full h-auto" style={{ minWidth: 900 }} role="img"
        aria-label="Sales team structure: heads, channels and managers, with one dot per territory">
        {lay.map(({ h, chs, y }) => (
          <g key={h.name}>
            <path d={edge(X.root + W.root, rootY, X.head, y)} fill="none" stroke="#AFC1D1" strokeWidth="1.4" />
            {chs.map(({ c, mgrs, y: cy }) => (
              <g key={c.id}>
                <path d={edge(X.head + W.head, y, X.ch, cy)} fill="none" stroke="#AFC1D1" strokeWidth="1.4" />
                {mgrs.map(({ m, y: my }) => (
                  <path key={m.id} d={edge(X.ch + W.ch, cy, X.mgr, my)} fill="none" stroke="#AFC1D1" strokeWidth="1.4" />
                ))}
              </g>
            ))}
          </g>
        ))}

        <rect x={X.root} y={rootY} width={W.root} height={NH} rx="10" fill="#1E293B" />
        <text x={X.root + 14} y={rootY + 21} fill="#fff" fontSize="14" fontWeight="600">GetMeds Sales</text>
        <text x={X.root + 14} y={rootY + 38} fill="#fff" opacity=".75" fontSize="11">{peso(summary.total_target)} target</text>

        {lay.map(({ h, chs, y }) => {
          const all = chs.flatMap(({ c }) => c.managers.flatMap((m) => m.territories));
          return (
            <g key={`h-${h.name}`}>
              <rect x={X.head} y={y} width={W.head} height={NH} rx="10" fill="#EDF1F6" stroke="#AFC1D1" />
              <text x={X.head + 14} y={y + 21} fill="#1E293B" fontSize="13.5" fontWeight="600">{h.name}</text>
              <text x={X.head + 14} y={y + 38} fill="#56657A" fontSize="11">Head · {all.length} terr.</text>
              {chs.map(({ c, mgrs, y: cy }) => (
                <g key={`c-${c.id}`}>
                  <rect x={X.ch} y={cy} width={W.ch} height={NH} rx="10" fill="#E0F3FB" stroke="#1D9FDA" strokeWidth="1.3" />
                  <text x={X.ch + 14} y={cy + 21} fill="#1E293B" fontSize="13.5" fontWeight="600">{c.name.replace(/^RX · /, '')}</text>
                  <text x={X.ch + 14} y={cy + 38} fill="#56657A" fontSize="11">
                    {c.counts.territories} terr.{c.counts.vacant ? ` · ${c.counts.vacant} vacant` : ''} · {peso(c.counts.target)}
                  </text>
                  {mgrs.map(({ m, y: my }) => (
                    <g key={`m-${m.id}`} onClick={() => onPick(m.id)} style={{ cursor: 'pointer' }} tabIndex={0} role="button"
                      aria-label={`${m.name}: ${m.counts.territories} territories. Jump to the list.`}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(m.id); } }}>
                      <rect x={X.mgr} y={my} width={W.mgr} height={NH} rx="10" fill="#fff" stroke="#AFC1D1" />
                      <text x={X.mgr + 14} y={my + 21} fill="#1E293B" fontSize="13.5" fontWeight="600">
                        {m.name}
                        <tspan fill="#56657A" fontSize="10" fontWeight="500">{m.acts_as_head ? '  HEAD + TL' : '  TL'}</tspan>
                      </text>
                      <text x={X.mgr + 14} y={my + 38} fill="#56657A" fontSize="11">
                        {m.counts.territories}
                        {m.counts.vacant ? <tspan fill="#C62828"> · {m.counts.vacant} vacant</tspan> : ' · 0 vacant'}
                        {m.user ? '' : ' · no account'}
                      </text>
                      {m.territories.slice(0, 22).map((t, i) => {
                        const d = STATUS[t.status].dot;
                        return (
                          <circle key={t.id} cx={X.mgr + 150 + i * 8.6} cy={my + NH / 2} r="3.5"
                            fill={d.fill} stroke={d.stroke} strokeWidth="1.2" strokeDasharray={d.dash}>
                            <title>{`${t.person_label || t.zoho_salesperson} · ${STATUS[t.status].label}`}</title>
                          </circle>
                        );
                      })}
                    </g>
                  ))}
                </g>
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
};

/* ── territory cards ───────────────────────────────────────────────────────── */

const needsAttention = (t) =>
  t.status === 'no_account' || t.sheet_vacant_but_covered || t.accounts.some((a) => a.team_lead_matches === false);

const ManagerCard = ({ channel, m, filter, focused }) => {
  const rows = m.territories.filter((t) =>
    filter === 'all' ? true : filter === 'vacant' ? t.status === 'vacant' : needsAttention(t));
  if (!rows.length) return null;
  return (
    <article id={`team-mgr-${m.id}`} className={`bg-white rounded-xl border overflow-hidden ${focused ? 'border-getmeds-blue ring-2 ring-getmeds-blue/30' : 'border-slate-200'}`}>
      <header className="px-4 py-3 border-b border-slate-100 space-y-0.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wide text-getmeds-blue">{channel.name.replace(/^RX · /, '')}</span>
          <span className="text-[11px] text-ink-secondary">{m.acts_as_head ? 'Head, acting as team lead' : 'Team lead'}</span>
        </div>
        <p className="text-[15px] font-semibold text-ink-primary">{m.name}</p>
        <p className="text-xs text-ink-secondary">
          {m.user ? `Account: ${m.user.name} (${String(m.user.role).replace('_', ' ')})` : 'No account linked'}
        </p>
        {m.scope_note && <p className="text-xs font-medium text-ink-primary">{m.scope_note}</p>}
        <p className="text-xs text-ink-secondary tabular-nums">
          {m.counts.territories} territories · {m.counts.vacant} vacant · {peso(m.counts.target)}
        </p>
      </header>
      <ul className="divide-y divide-slate-100">
        {rows.map((t) => (
          <li key={t.id} className={`px-4 py-2.5 text-[13px] ${t.status === 'vacant' ? 'bg-red-50/60' : ''}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-ink-primary break-words">{t.person_label || t.zoho_salesperson}</p>
                <p className="text-[11.5px] text-ink-secondary font-mono break-words">
                  {t.zoho_salesperson}{t.hq ? ` · ${t.hq}` : ''}
                </p>
                {t.zoho_alias && <p className="text-[11px] text-ink-secondary">Zoho still calls it <span className="font-mono">{t.zoho_alias}</span></p>}
              </div>
              <div className="text-right shrink-0">
                <span className={`inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${STATUS[t.status].chip}`}>{STATUS[t.status].label}</span>
                <p className="text-xs font-mono text-ink-secondary mt-0.5 tabular-nums">{t.target_amount ? peso(t.target_amount) : '₱0'}</p>
              </div>
            </div>
            {t.accounts.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {t.accounts.map((a) => (
                  <span key={a.id} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11.5px] text-ink-primary"
                    title={a.team_lead_name ? `Team Lead: ${a.team_lead_name}` : 'No Team Lead set'}>
                    {a.name}
                    {a.team_lead_matches === true && <CheckCircle2 className="w-3 h-3 text-emerald-600" aria-label="Team Lead matches the sheet" />}
                    {a.team_lead_matches === false && <span className="text-amber-700 font-semibold">TL differs</span>}
                  </span>
                ))}
              </div>
            )}
            {t.sheet_vacant_but_covered && (
              <p className="mt-1 text-[11.5px] text-amber-800">The sheet says vacant, but an account holds this territory.</p>
            )}
          </li>
        ))}
      </ul>
    </article>
  );
};

/* ── Team Lead preview ─────────────────────────────────────────────────────── */

const PlanTable = () => {
  const { data, isLoading, error } = useQuery({
    queryKey: ['team-structure-plan'],
    queryFn: () => client.get('/api/admin/team-structure/team-lead-plan').then((r) => r.data.data),
  });
  if (isLoading) return <p className="text-sm text-ink-secondary py-3">Working it out…</p>;
  if (error) return <p className="text-sm text-red-700 py-3">{errorText(error, 'Could not build the preview.')}</p>;
  const order = { change: 0, blocked: 1, already_correct: 2 };
  const items = [...data.items].sort((a, b) => order[a.status] - order[b.status] || a.account_name.localeCompare(b.account_name));
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-secondary">
        A preview only: nothing here changes an account. It shows which MedReps' Team Lead would change to match the sheet.
        <b className="text-ink-primary"> {data.counts.change}</b> would change, <b className="text-ink-primary">{data.counts.already_correct}</b> already match,
        <b className="text-ink-primary"> {data.counts.blocked}</b> cannot be applied.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-ink-secondary">No MedRep account holds a territory in the structure yet.</p>
      ) : (
        <div className="overflow-x-auto thin-scroll rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-[13px] min-w-[720px]">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-ink-secondary">
              <tr><th className="text-left px-3 py-2">Account</th><th className="text-left px-3 py-2">Territories</th><th className="text-left px-3 py-2">Team Lead now</th><th className="text-left px-3 py-2">Sheet says</th><th className="text-left px-3 py-2">Result</th></tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((i) => (
                <tr key={i.account_id}>
                  <td className="px-3 py-2 font-medium">{i.account_name}</td>
                  <td className="px-3 py-2 text-ink-secondary font-mono text-[12px]">{i.territories.join(', ')}</td>
                  <td className="px-3 py-2">{i.current_team_lead_name || <span className="text-ink-secondary">None</span>}</td>
                  <td className="px-3 py-2">{i.proposed_team_lead_name || <span className="text-ink-secondary">{i.manager || '—'}</span>}</td>
                  <td className="px-3 py-2">
                    {i.status === 'change' && <span className="text-getmeds-blue font-semibold">Would change</span>}
                    {i.status === 'already_correct' && <span className="text-emerald-700">Already correct</span>}
                    {i.status === 'blocked' && <span className="text-amber-800">Blocked: {REASONS[i.reason] || i.reason}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

/* ── the panel ─────────────────────────────────────────────────────────────── */

const Stat = ({ label, value, tone }) => (
  <div className={`rounded-lg border px-4 py-3 ${tone === 'red' ? 'border-red-200 bg-red-50' : tone === 'amber' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}>
    <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-secondary">{label}</p>
    <p className={`text-xl font-bold tabular-nums ${tone === 'red' ? 'text-red-700' : tone === 'amber' ? 'text-amber-800' : 'text-ink-primary'}`}>{value}</p>
  </div>
);

const TeamStructurePanel = () => {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('all');
  const [focusId, setFocusId] = useState(null);
  const [showPlan, setShowPlan] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['team-structure'],
    queryFn: () => client.get('/api/admin/team-structure').then((r) => r.data.data),
    retry: false,
  });

  const load = useMutation({
    mutationFn: () => client.post('/api/admin/team-structure/import', {}).then((r) => r.data.data),
    onSuccess: (s) => {
      toast.success(`Loaded ${s.territories.created} territories from the sheet.`);
      qc.invalidateQueries({ queryKey: ['team-structure'] });
    },
    onError: (err) => toast.error(errorText(err, 'Could not load the sheet.')),
  });

  const pick = (id) => {
    setFocusId(id);
    setFilter('all');
    setTimeout(() => document.getElementById(`team-mgr-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
  };

  if (isLoading) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 space-y-2">
        <p className="flex items-center gap-2 font-semibold text-amber-900"><AlertTriangle className="w-4 h-4" /> The team structure could not be loaded</p>
        <p className="text-sm text-amber-900">{errorText(error, 'Something went wrong.')}</p>
        <p className="text-sm text-amber-900">
          If this is the first time, the database update has probably not been run yet: run <code className="font-mono bg-white/60 px-1 rounded">npm run migrate:pg</code> in
          getmeds-backend, then refresh.
        </p>
        <button type="button" onClick={() => refetch()} className="px-3 py-1.5 rounded-md border border-amber-300 bg-white text-sm font-semibold text-amber-900 hover:bg-amber-100">Try again</button>
      </div>
    );
  }

  if (!data.heads.length) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-8 text-center space-y-3">
        <p className="text-base font-semibold text-ink-primary">No team structure loaded yet</p>
        <p className="text-sm text-ink-secondary max-w-xl mx-auto">
          Load the September sales sheet: 4 heads, 10 channels and 65 territories. It adds three new lists and does not change any account, order or setting.
        </p>
        <button type="button" onClick={() => load.mutate()} disabled={load.isPending}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold text-white bg-getmeds-blue hover:bg-getmeds-blue-hover disabled:opacity-60">
          <Download className="w-4 h-4" /> {load.isPending ? 'Loading…' : 'Load the sales sheet'}
        </button>
      </div>
    );
  }

  const s = data.summary;
  const issues = data.issues;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-secondary max-w-3xl">
          Who leads what, from the September sales sheet. Each dot is a territory: blue when an active account holds it, red and dashed when it is vacant,
          amber when the sheet names a person but no account holds it. Select a manager to jump to their territories.
        </p>
        <button type="button" onClick={() => refetch()} className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-slate-200 rounded-md text-sm text-ink-secondary bg-white hover:bg-surface shrink-0">
          <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Stat label="Territories" value={s.territories} />
        <Stat label="With an account" value={s.covered} />
        <Stat label="Vacant" value={s.vacant} tone={s.vacant ? 'red' : undefined} />
        <Stat label="No account" value={s.no_account} tone={s.no_account ? 'amber' : undefined} />
        <Stat label="Sep target" value={peso(s.total_target)} />
        <Stat label="Vacant target" value={peso(s.vacant_target)} tone={s.vacant_target ? 'red' : undefined} />
      </div>

      <section className="bg-white border border-slate-200 rounded-xl p-4">
        <OrgChart heads={data.heads} summary={s} onPick={pick} />
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-ink-secondary">
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full" style={{ background: '#1D9FDA' }} />Covered by an account</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full border border-dashed" style={{ background: '#FDE8E8', borderColor: '#C62828' }} />Vacant</span>
          <span className="inline-flex items-center gap-1.5"><span className="inline-block w-2.5 h-2.5 rounded-full border border-dashed" style={{ background: '#FEF3C7', borderColor: '#B45309' }} />Named in the sheet, no account</span>
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-lg font-semibold text-ink-primary">Territories by team lead</h2>
          <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5" role="group" aria-label="Filter territories">
            {[['all', 'All'], ['vacant', 'Vacancies'], ['attention', 'Needs attention']].map(([k, label]) => (
              <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}
                className={`px-3 py-1 rounded text-[13px] font-semibold ${filter === k ? 'bg-slate-900 text-white' : 'text-ink-secondary hover:bg-surface'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {data.heads.map((h) => (
          <div key={h.name} className="space-y-3">
            <h3 className="text-sm font-semibold text-ink-primary">{h.name} <span className="font-normal text-ink-secondary">· Head</span></h3>
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 items-start">
              {h.channels.flatMap((c) => c.managers.map((m) => (
                <ManagerCard key={m.id} channel={c} m={m} filter={filter} focused={focusId === m.id} />
              )))}
            </div>
          </div>
        ))}
      </section>

      <section className="bg-white border border-slate-200 rounded-xl divide-y divide-slate-100">
        <details className="p-4 group" open={issues.territories_without_account.length > 0 && issues.territories_without_account.length <= 8}>
          <summary className="cursor-pointer select-none flex items-center justify-between font-semibold text-ink-primary">
            <span>Territories the sheet names, with no account holding them <span className="text-amber-800">({issues.territories_without_account.length})</span></span>
            <ChevronDown className="w-4 h-4 text-ink-secondary group-open:rotate-180 transition-transform" />
          </summary>
          <p className="text-sm text-ink-secondary mt-2">Either the person has no account yet, or their account holds a different Zoho salesperson name than the sheet.</p>
          <ul className="mt-2 flex flex-wrap gap-2">
            {issues.territories_without_account.map((t) => (
              <li key={t.id} className="rounded-md bg-amber-50 border border-amber-200 px-2 py-1 text-[12px] font-mono text-amber-900">{t.zoho_salesperson}</li>
            ))}
            {issues.territories_without_account.length === 0 && <li className="text-sm text-ink-secondary">None.</li>}
          </ul>
        </details>

        <details className="p-4 group">
          <summary className="cursor-pointer select-none flex items-center justify-between font-semibold text-ink-primary">
            <span>Accounts outside the structure <span className="text-amber-800">({issues.accounts_outside_structure.length})</span></span>
            <ChevronDown className="w-4 h-4 text-ink-secondary group-open:rotate-180 transition-transform" />
          </summary>
          <p className="text-sm text-ink-secondary mt-2">
            Active MedReps and Team Leads whose Zoho salesperson is not a territory in the sheet.
            {issues.medreps_without_salesperson > 0 && ` A further ${issues.medreps_without_salesperson} active MedRep account${issues.medreps_without_salesperson === 1 ? ' has' : 's have'} no Zoho salesperson set at all.`}
          </p>
          <div className="mt-2 overflow-x-auto thin-scroll">
            <table className="w-full text-[13px] min-w-[520px]">
              <tbody className="divide-y divide-slate-100">
                {issues.accounts_outside_structure.map((a) => (
                  <tr key={a.id}>
                    <td className="py-1.5 pr-3 font-medium">{a.name}</td>
                    <td className="py-1.5 pr-3 text-ink-secondary">{String(a.role).replace('_', ' ')}{a.division ? ` · ${a.division}` : ''}</td>
                    <td className="py-1.5 font-mono text-[12px] text-ink-secondary">{a.salespersons.join(', ')}</td>
                  </tr>
                ))}
                {issues.accounts_outside_structure.length === 0 && <tr><td className="py-1.5 text-ink-secondary">None.</td></tr>}
              </tbody>
            </table>
          </div>
        </details>

        <details className="p-4 group" onToggle={(e) => setShowPlan(e.currentTarget.open)}>
          <summary className="cursor-pointer select-none flex items-center justify-between font-semibold text-ink-primary">
            <span>Team Lead check</span>
            <ChevronDown className="w-4 h-4 text-ink-secondary group-open:rotate-180 transition-transform" />
          </summary>
          <div className="mt-3">{showPlan && <PlanTable />}</div>
        </details>
      </section>
    </div>
  );
};

export default TeamStructurePanel;
