import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';
import ManagerAccessTable from './ManagerAccessTable';

/**
 * Accounts, by department — Sep 26, 2026.
 *
 *   Sales Department        the channels below, and MedReps outside any channel
 *   Admin
 *   Operation Department    Dispatch
 *   Finance Department
 *   Management (Approval)   with the channels each approves
 *   Team Lead               with their team size
 *
 * Inside Sales: one section per CHANNEL (B2B, BID, CLIDP, HOS, Telesales, each RX division…),
 * so each can be arranged on its own: who is its head, who approves it, which team
 * leads sit under it, and which salespeople hold its territories.
 *
 *   Approver(s)     who approves this channel's orders
 *   Head            the person this channel reports to
 *     Team Lead     managers under the head, with what they handle or are limited to
 *       Salesperson accounts, one row per territory they hold
 *
 * The buttons edit the STRUCTURE (the sales_* tables) only. They do not change an
 * account's role, its Team Lead, or what anyone can see or approve: that stays in
 * Manager Access and the account's own Team Lead setting.
 */

const chLabel = (n) => String(n).replace(/^RX · /, 'RX · ').replace('HOSP', 'HOS').replace('TELESALES', 'Telesales');
const peso = (n) => { const v = Number(n || 0); return `₱${v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${Math.round(v / 1e3)}K`}`; };
const errorText = (err, fallback) => err?.response?.data?.error?.message || err?.message || fallback;
const displayName = (u) => [u.first_name, u.last_name].filter(Boolean).join(' ') || u.name;

const KIND = {
  approver: { label: 'Manager · Approver', chip: 'bg-purple-50 text-purple-800 border-purple-200' },
  head: { label: 'Head · Team Lead', chip: 'bg-indigo-50 text-indigo-800 border-indigo-200' },
  lead: { label: 'Team Lead', chip: 'bg-sky-50 text-sky-800 border-sky-200' },
  rep: { label: 'Salesperson', chip: 'bg-slate-100 text-slate-700 border-slate-200' },
};
const TONE = {
  ok: 'bg-emerald-50 text-emerald-800 border-emerald-200',
  wait: 'bg-amber-50 text-amber-800 border-amber-200',
  vacant: 'bg-red-50 text-red-700 border-red-200',
  off: 'bg-slate-100 text-slate-600 border-slate-200',
};

/** The rows of ONE channel, each carrying what its action button needs. */
function channelRows(h, c, usersById) {
  const rows = [];
  const placed = new Set();
  const place = (u) => { if (u) placed.add(u.id); };
  const accStatus = (id) => {
    const u = usersById.get(id);
    if (!u) return { text: 'Active', tone: 'ok' };
    if (u.approval_status === 'pending') return { text: 'Awaiting approval', tone: 'wait' };
    if (!(u.is_active === 1 || u.is_active === true)) return { text: 'Inactive', tone: 'off' };
    return { text: 'Active', tone: 'ok' };
  };

  if (!c.approvers.length) {
    rows.push({ key: `c${c.id}-noappr`, level: 0, kind: 'approver', missing: true, note: 'No manager set', act: { type: 'approver-add' } });
  }
  for (const a of c.approvers) {
    place(a.user);
    rows.push({ key: `c${c.id}-appr-${a.id}`, level: 0, kind: 'approver', name: a.name, user: a.user, handles: 'Approves all orders for this channel', act: { type: 'approver', approver: a } });
  }

  place(h.user);
  rows.push({ key: `c${c.id}-head`, level: 1, kind: 'head', name: c.head_name, user: h.user, handles: `Head of ${chLabel(c.name)}`, act: { type: 'head' } });

  const repRows = (m, level) => {
    for (const t of m.territories) {
      const move = { type: 'rep', territory: t, from: m };
      if (t.accounts.length) {
        for (const a of t.accounts) {
          place({ id: a.id });
          rows.push({
            key: `c${c.id}-t${t.id}-${a.id}`, level, kind: 'rep', name: a.name, user: { id: a.id, name: a.name, role: a.role },
            handles: t.person_label || '', zoho: t.zoho_salesperson, hq: t.hq, status: accStatus(a.id),
            tl: a.team_lead_matches, tlName: a.team_lead_name, act: move,
          });
        }
      } else {
        rows.push({
          key: `c${c.id}-t${t.id}`, level, kind: 'rep', name: null, ghost: t.person_label || t.zoho_salesperson,
          zoho: t.zoho_salesperson, hq: t.hq, act: move,
          status: t.status === 'vacant' ? { text: 'Vacant', tone: 'vacant' } : { text: 'No account', tone: 'wait' },
        });
      }
    }
  };

  // A manager who IS the head keeps their territories directly under the head.
  c.managers.filter((m) => m.acts_as_head).forEach((m) => repRows(m, 2));
  for (const m of c.managers.filter((x) => !x.acts_as_head)) {
    place(m.user);
    rows.push({
      key: `c${c.id}-m${m.id}`, level: 2, kind: 'lead', name: m.name, user: m.user,
      handles: m.scope_note || `Team lead of ${chLabel(c.name)}`, act: { type: 'lead', manager: m },
    });
    repRows(m, 3);
  }
  return { rows, placed };
}

/* ── add / edit dialog ─────────────────────────────────────────────────────── */

const inputCls = 'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue';

const TITLES = {
  head: (c) => `Head of ${chLabel(c.name)}`,
  'manager-add': (c) => `Add a team lead to ${chLabel(c.name)}`,
  'manager-edit': (c) => `Edit team lead in ${chLabel(c.name)}`,
  'approver-add': (c) => `Add a manager (approver) to ${chLabel(c.name)}`,
};
const HELP = {
  head: 'Who this channel reports to. Pick their account if they have one, or just type the name.',
  'manager-add': 'A team lead under the head. Add the salespeople to them afterwards with "Move" on each row.',
  'manager-edit': 'Change the name, the linked account, or what this team lead is limited to.',
  'approver-add': 'The manager is the approver: they approve this channel\'s orders. This records who, and does not change Management approval settings.',
};

const EditorDialog = ({ editor, users, onClose, onSaved }) => {
  const { mode, channel, manager } = editor;
  const initial = mode === 'head'
    ? { name: channel.head_name || '', userId: editor.headUser ? editor.headUser.id : '' }
    : mode === 'manager-edit'
      ? { name: manager.name, userId: manager.user ? manager.user.id : '' }
      : { name: '', userId: '' };
  const [name, setName] = useState(initial.name);
  const [nameTouched, setNameTouched] = useState(Boolean(initial.name));
  const [userId, setUserId] = useState(initial.userId);
  const [note, setNote] = useState(mode === 'manager-edit' ? manager.scope_note || '' : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const options = useMemo(
    () => users
      .filter((u) => (u.is_active === 1 || u.is_active === true) && u.approval_status !== 'pending' && u.approval_status !== 'rejected')
      .sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [users]
  );

  const pickAccount = (value) => {
    setUserId(value);
    const u = options.find((x) => String(x.id) === String(value));
    // Fill the name from the account until the person types their own.
    if (u && !nameTouched) setName(displayName(u));
  };

  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('A name is required.');
    setSaving(true);
    setError(null);
    const uid = userId === '' ? null : Number(userId);
    try {
      if (mode === 'head') {
        await client.patch(`/api/admin/team-structure/channels/${channel.id}`, { head_name: name.trim(), head_user_id: uid });
      } else if (mode === 'manager-add') {
        await client.post('/api/admin/team-structure/managers', { channel_id: channel.id, name: name.trim(), user_id: uid, scope_note: note.trim() || null });
      } else if (mode === 'manager-edit') {
        await client.patch(`/api/admin/team-structure/managers/${manager.id}`, { name: name.trim(), user_id: uid, scope_note: note.trim() || null });
      } else {
        await client.post('/api/admin/team-structure/approvers', { channel_id: channel.id, name: name.trim(), user_id: uid });
      }
      toast.success('Saved.');
      await onSaved();
      onClose();
    } catch (err) {
      setError(errorText(err, 'Could not save.'));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-16" role="dialog" aria-modal="true" aria-labelledby="ts-editor-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={() => !saving && onClose()} aria-hidden="true" />
      <form onSubmit={save} className="relative w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="ts-editor-title" className="text-base font-semibold text-ink-primary">{TITLES[mode](channel)}</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{HELP[mode]}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label htmlFor="ts-account" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">Account (optional)</label>
            <select id="ts-account" className={inputCls} value={userId} onChange={(e) => pickAccount(e.target.value)} disabled={saving} autoFocus>
              <option value="">No account (just a name)</option>
              {options.map((u) => <option key={u.id} value={u.id}>{displayName(u)} · {String(u.role).replace('_', ' ')}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="ts-name" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">Name</label>
            <input id="ts-name" className={inputCls} value={name} disabled={saving} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} />
          </div>
          {(mode === 'manager-add' || mode === 'manager-edit') && (
            <div>
              <label htmlFor="ts-note" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">Limited to (optional)</label>
              <input id="ts-note" className={inputCls} value={note} disabled={saving} placeholder="e.g. Sees only B2B accounts" onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-medium text-ink-secondary hover:bg-surface">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-md text-sm font-semibold text-white bg-getmeds-blue hover:bg-getmeds-blue-hover disabled:opacity-60">{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </div>
  );
};

/* ── rows ──────────────────────────────────────────────────────────────────── */

const linkBtn = 'text-[12px] font-semibold text-getmeds-blue hover:text-getmeds-blue-dark disabled:opacity-50';

const Row = ({ r, onOpen, actions }) => {
  const clickable = Boolean(r.user);
  const k = KIND[r.kind];
  return (
    <tr
      onClick={clickable ? () => onOpen(r.user.id) : undefined}
      className={`${clickable ? 'cursor-pointer hover:bg-surface' : ''} ${r.kind === 'approver' || r.kind === 'head' ? 'bg-slate-50/70' : ''} transition-colors`}
    >
      <td className="py-2 pr-3" style={{ paddingLeft: 14 + r.level * 22 }}>
        <div className="flex items-center gap-2 min-w-0">
          {r.level > 1 && <span className="inline-block w-3 h-px bg-slate-300 shrink-0" aria-hidden="true" />}
          {r.name ? (
            <span className={`text-[13px] ${r.kind === 'rep' ? 'font-medium' : 'font-semibold'} text-ink-primary truncate`}>{r.name}</span>
          ) : (
            <span className={`text-[13px] italic truncate ${r.missing ? 'text-amber-800' : 'text-ink-secondary'}`}>{r.ghost || r.note}</span>
          )}
          {r.name && !r.user && <span className="text-[10.5px] text-ink-secondary shrink-0">no account</span>}
        </div>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {!r.missing && <span className={`inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${k.chip}`}>{k.label}</span>}
      </td>
      <td className="py-2 pr-3 text-[12.5px] text-ink-secondary">{r.handles}</td>
      <td className="py-2 pr-3 text-[12px] font-mono text-ink-secondary">
        {r.zoho ? <>{r.zoho}{r.hq ? <span className="text-slate-400"> · {r.hq}</span> : null}</> : null}
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {r.status && (
          <span className="inline-flex items-center gap-1.5">
            <span className={`inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${TONE[r.status.tone]}`}>{r.status.text}</span>
            {r.tl === true && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" aria-label="Team Lead matches the sheet" />}
            {r.tl === false && <span className="text-[10.5px] font-semibold text-amber-700" title={r.tlName ? `Team Lead set: ${r.tlName}` : 'No Team Lead set'}>TL differs</span>}
          </span>
        )}
      </td>
      <td className="py-2 pr-3 text-right whitespace-nowrap" onClick={(e) => e.stopPropagation()}>{actions(r)}</td>
    </tr>
  );
};

const HEADERS = ['Person', 'Role', 'Handles / limited to', 'Zoho territory', 'Status', ''];

// Sep 26, 2026: the departments, in the order the business lists them. Sales is
// built from the channels above; the rest are simply everyone holding that role.
const DEPTS = [
  { key: 'admin', title: 'Admin', sub: 'System administrators', roles: ['admin'] },
  { key: 'ops', title: 'Operation Department', sub: 'Dispatch', roles: ['dispatch'] },
  { key: 'finance', title: 'Finance Department', sub: 'Payment and account checks', roles: ['finance'] },
  { key: 'mgmt', title: 'Management (Approval)', sub: 'Approve orders', roles: ['management'] },
  { key: 'lead', title: 'Team Lead', sub: 'Lead a team of salespeople', roles: ['team_lead'] },
];

/** A department: a title bar that opens and closes its contents. */
const DeptCard = ({ title, sub, count, open, onToggle, children }) => (
  <section className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
    <button type="button" onClick={onToggle} aria-expanded={open}
      className="w-full flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3.5 text-left hover:bg-slate-50">
      <span className="flex items-center gap-2.5 min-w-0">
        {open ? <ChevronDown className="w-4 h-4 text-ink-secondary shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-secondary shrink-0" />}
        <span className="text-base font-semibold text-ink-primary">{title}</span>
        {sub && <span className="text-xs text-ink-secondary">{sub}</span>}
      </span>
      <span className="text-xs text-ink-secondary tabular-nums">{count}</span>
    </button>
    {open && <div className="border-t border-slate-100">{children}</div>}
  </section>
);

/** A plain list of accounts: who, role, a detail, Zoho salesperson, status. */
const AccountTable = ({ rows, onOpen, showDetail }) => (
  rows.length === 0 ? (
    <p className="px-4 py-4 text-sm text-ink-secondary">No accounts here.</p>
  ) : (
    <div className="overflow-x-auto thin-scroll">
      <table className="w-full min-w-[820px]">
        <thead className="bg-slate-50">
          <tr>{['Person', 'Role', showDetail ? 'Detail' : '', 'Zoho salesperson', 'Status'].map((h, i) => <th key={i} className="text-left px-3.5 py-2 text-[11px] uppercase tracking-wide text-ink-secondary font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r) => (
            <tr key={r.key} onClick={() => onOpen(r.user.id)} className="cursor-pointer hover:bg-surface">
              <td className="py-2 pr-3 pl-3.5 text-[13px] font-medium text-ink-primary">{r.name}</td>
              <td className="py-2 pr-3"><span className="inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border bg-slate-100 text-slate-700 border-slate-200 capitalize">{r.roleText}</span></td>
              <td className="py-2 pr-3 text-[12.5px] text-ink-secondary">{showDetail ? r.detail : ''}</td>
              <td className="py-2 pr-3 text-[12px] font-mono text-ink-secondary">{r.zoho}</td>
              <td className="py-2 pr-3"><span className={`inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${TONE[r.status.tone]}`}>{r.status.text}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
);

const AccountsByTeam = ({ users, onOpen, onShowList }) => {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['team-structure'],
    queryFn: () => client.get('/api/admin/team-structure').then((r) => r.data.data),
    retry: false,
  });
  // Departments: Sales opens by default, the rest start shut. Channels start shut too,
  // since each header already carries its head, counts and target.
  const [openDept, setOpenDept] = useState({});
  const toggleDept = (key, wasOpen) => setOpenDept((s) => ({ ...s, [key]: !wasOpen }));
  const [openCh, setOpenCh] = useState({});
  const [showOthers, setShowOthers] = useState(false);
  const [editor, setEditor] = useState(null);
  const [moving, setMoving] = useState(null); // territory id whose Move menu is open

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  // A change of manager (approver) also changes what Manager Access is compared against.
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['team-structure'] }),
    qc.invalidateQueries({ queryKey: ['manager-access-plan'] }),
  ]);

  const built = useMemo(() => {
    if (!data) return null;
    const sections = data.heads.flatMap((h) => h.channels.map((c) => ({ h, c, ...channelRows(h, c, usersById) })));
    const placed = new Set(sections.flatMap((s) => [...s.placed]));
    const others = users
      .filter((u) => !placed.has(u.id))
      .sort((a, b) => String(a.role).localeCompare(String(b.role)) || String(a.name).localeCompare(String(b.name)));
    return { sections, others };
  }, [data, users, usersById]);

  const run = async (fn, okMsg) => {
    try { await fn(); toast.success(okMsg); await refresh(); } catch (err) { toast.error(errorText(err, 'Could not do that.')); }
  };

  if (isLoading) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" /></div>;

  if (error || !data || data.heads.length === 0) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-5 space-y-2">
        <p className="flex items-center gap-2 font-semibold text-amber-900"><AlertTriangle className="w-4 h-4" /> The team view is not set up yet</p>
        <p className="text-sm text-amber-900">
          {error
            ? 'The team structure could not be loaded. If this is the first time, run npm run migrate:pg in getmeds-backend, then refresh.'
            : 'No team structure is loaded. Open the Team Structure tab and load the sales sheet.'}
        </p>
        <div className="flex gap-2">
          <button type="button" onClick={() => refetch()} className="px-3 py-1.5 rounded-md border border-amber-300 bg-white text-sm font-semibold text-amber-900 hover:bg-amber-100">Try again</button>
          <button type="button" onClick={onShowList} className="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-sm font-semibold text-slate-700 hover:bg-slate-50">Show all accounts</button>
        </div>
      </div>
    );
  }

  const actionsFor = (s) => (r) => {
    const a = r.act;
    if (!a) return null;
    if (a.type === 'head') return <button type="button" className={linkBtn} onClick={() => setEditor({ mode: 'head', channel: s.c, headUser: s.h.user })}>Change head</button>;
    if (a.type === 'approver-add') return <button type="button" className={linkBtn} onClick={() => setEditor({ mode: 'approver-add', channel: s.c })}>Add manager</button>;
    if (a.type === 'approver') {
      return <button type="button" className="text-[12px] font-semibold text-red-700 hover:text-red-800" onClick={() => run(() => client.delete(`/api/admin/team-structure/approvers/${a.approver.id}`), 'Manager removed.')}>Remove</button>;
    }
    if (a.type === 'lead') {
      return (
        <span className="inline-flex gap-3">
          <button type="button" className={linkBtn} onClick={() => setEditor({ mode: 'manager-edit', channel: s.c, manager: a.manager })}>Edit</button>
          <button type="button" className="text-[12px] font-semibold text-red-700 hover:text-red-800" onClick={() => run(() => client.delete(`/api/admin/team-structure/managers/${a.manager.id}`), 'Team lead removed.')}>Remove</button>
        </span>
      );
    }
    if (a.type === 'rep') {
      const targets = s.c.managers.filter((m) => m.id !== a.from.id);
      if (!targets.length) return null;
      if (moving !== a.territory.id) return <button type="button" className={linkBtn} onClick={() => setMoving(a.territory.id)}>Move</button>;
      return (
        <select
          autoFocus
          aria-label={`Move ${a.territory.zoho_salesperson} to`}
          defaultValue=""
          onBlur={() => setMoving(null)}
          onChange={(e) => {
            const id = Number(e.target.value);
            setMoving(null);
            if (id) run(() => client.patch(`/api/admin/team-structure/territories/${a.territory.id}`, { manager_id: id }), 'Moved.');
          }}
          className="text-[12px] border border-slate-300 rounded px-1.5 py-1 bg-white"
        >
          <option value="">Move to…</option>
          {targets.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      );
    }
    return null;
  };

  const statusOf = (u) => (u.approval_status === 'pending' ? { text: 'Awaiting approval', tone: 'wait' }
    : (u.is_active === 1 || u.is_active === true) ? { text: 'Active', tone: 'ok' } : { text: 'Inactive', tone: 'off' });

  // Which channels each Management account approves, from the structure.
  const approves = new Map();
  for (const s of built.sections) {
    for (const a of s.c.approvers) {
      if (!a.user) continue;
      if (!approves.has(a.user.id)) approves.set(a.user.id, []);
      approves.get(a.user.id).push(chLabel(s.c.name));
    }
  }
  const membersOf = (id) => users.filter((u) => u.team_lead_id === id).length;

  const rowsFor = (d) => users
    .filter((u) => d.roles.includes(String(u.role).toLowerCase()))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)))
    .map((u) => ({
      key: `d-${u.id}`, user: u, name: displayName(u), roleText: String(u.role).replace('_', ' '), zoho: u.salesperson || '', status: statusOf(u),
      detail: d.key === 'mgmt'
        ? (approves.get(u.id) ? `Approves: ${approves.get(u.id).join(', ')}` : '')
        : d.key === 'lead' ? `${membersOf(u.id)} team member${membersOf(u.id) === 1 ? '' : 's'}` : '',
    }));

  const unplacedReps = built.others.filter((u) => String(u.role).toLowerCase() === 'medrep').map((u) => ({
    key: `o-${u.id}`, user: u, name: displayName(u), roleText: 'medrep', zoho: u.salesperson || '', status: statusOf(u), detail: '',
  }));

  const totalTerritories = built.sections.reduce((s, x) => s + x.c.counts.territories, 0);
  const totalVacant = built.sections.reduce((s, x) => s + x.c.counts.vacant, 0);

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-secondary max-w-3xl">
        Every account, by department. Sales is arranged by channel, one section each, so each can be set up on its own: who heads it, which manager approves it, which team leads sit
        under it and who holds each territory. The buttons here change the structure only. What a manager sees and approves is shown beside it under Management (Approval), and changes only when you press "Apply from structure" on that person.
      </p>

      <DeptCard
        title="Sales Department" open={Boolean(openDept.sales ?? true)} onToggle={() => toggleDept('sales', openDept.sales ?? true)}
        sub={`${built.sections.length} channels`}
        count={<>{totalTerritories} territories{totalVacant ? <span className="text-red-700"> · {totalVacant} vacant</span> : ''}</>}
      >
        <div className="p-4 space-y-4 bg-slate-50/50">
          {built.sections.map((s) => {
            const isOpen = Boolean(openCh[s.c.id]);
            return (
              <section key={s.c.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
                  <button type="button" onClick={() => setOpenCh((c) => ({ ...c, [s.c.id]: !isOpen }))} aria-expanded={isOpen}
                    className="flex items-center gap-2 min-w-0 text-left">
                    {isOpen ? <ChevronDown className="w-4 h-4 text-ink-secondary shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-secondary shrink-0" />}
                    <span className="text-[15px] font-semibold text-ink-primary">{chLabel(s.c.name)}</span>
                    <span className="text-xs text-ink-secondary">Head: {s.c.head_name}</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="text-xs text-ink-secondary tabular-nums">
                      {s.c.counts.territories} territories{s.c.counts.vacant ? <span className="text-red-700"> · {s.c.counts.vacant} vacant</span> : ''} · {peso(s.c.counts.target)}
                    </span>
                    <button type="button" className={`${linkBtn} inline-flex items-center gap-1`} onClick={() => setEditor({ mode: 'manager-add', channel: s.c })}><Plus className="w-3.5 h-3.5" />Team lead</button>
                    <button type="button" className={`${linkBtn} inline-flex items-center gap-1`} onClick={() => setEditor({ mode: 'approver-add', channel: s.c })}><Plus className="w-3.5 h-3.5" />Manager</button>
                  </div>
                </div>
                {isOpen && (
                  <div className="overflow-x-auto thin-scroll border-t border-slate-100">
                    <table className="w-full min-w-[960px]">
                      <thead className="bg-slate-50">
                        <tr>{HEADERS.map((h, i) => <th key={i} className="text-left px-3.5 py-2 text-[11px] uppercase tracking-wide text-ink-secondary font-semibold">{h}</th>)}</tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {s.rows.map((r) => <Row key={r.key} r={r} onOpen={onOpen} actions={actionsFor(s)} />)}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            );
          })}

          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <button type="button" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50">
              <span className="flex items-center gap-2">
                {showOthers ? <ChevronDown className="w-4 h-4 text-ink-secondary" /> : <ChevronRight className="w-4 h-4 text-ink-secondary" />}
                <span className="font-semibold text-ink-primary">MedReps not in a channel</span>
              </span>
              <span className="text-xs text-ink-secondary tabular-nums">{unplacedReps.length} accounts · their Zoho salesperson is not a territory in any channel</span>
            </button>
            {showOthers && <AccountTable rows={unplacedReps} onOpen={onOpen} />}
          </section>
        </div>
      </DeptCard>

      {DEPTS.map((d) => {
        const rows = rowsFor(d);
        return (
          <DeptCard key={d.key} title={d.title} sub={d.sub} count={`${rows.length} account${rows.length === 1 ? '' : 's'}`}
            open={Boolean(openDept[d.key])} onToggle={() => toggleDept(d.key, Boolean(openDept[d.key]))}>
            {d.key === 'mgmt'
              ? <ManagerAccessTable rows={rows} onOpen={onOpen} />
              : <AccountTable rows={rows} onOpen={onOpen} showDetail />}
          </DeptCard>
        );
      })}

      {editor && <EditorDialog key={`${editor.mode}-${editor.channel.id}-${editor.manager ? editor.manager.id : ''}`} editor={editor} users={users} onClose={() => setEditor(null)} onSaved={refresh} />}
    </div>
  );
};

export default AccountsByTeam;
