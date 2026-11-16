import React, { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CheckCircle2, AlertTriangle, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';
import ManagerAccessTable from './ManagerAccessTable';
import { roleLabel } from '../../constants/roles';

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

const chLabel = (n) => String(n).replace(/^RX · /, '').replace('HOSP', 'HOS').replace('TELESALES', 'Telesales');
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

// The order the business lists the channels in. A channel added later goes after these.
const CHANNEL_ORDER = ['HOS', 'Telesales', 'B&B', 'STC', 'URO', 'B2C', 'B2B', 'CLIDP', 'BID', 'MT'];
const sortChannels = (list) => {
  const rank = (x) => { const i = CHANNEL_ORDER.indexOf(chLabel(x.c.name)); return i === -1 ? CHANNEL_ORDER.length : i; };
  return [...list].sort((p, q) => rank(p) - rank(q));
};

/**
 * Nov 16, 2026 (Aaron): Sales (CHC) is Division > Sub-division. A channel is one sub-division:
 *   HOS    Field Representatives (channel HOSP), Telesales (channel TELESALES)
 *   RX     STC, BNB, URO, B2C     (channels "RX · STC" …)
 *   B2B    NBD (channel "B2B"), CRR (channel "B2B · CRR")
 *   BID, CLIDP, MT                one channel each, no sub-division
 * A channel named "<Division> · <Sub>" lands under that Division, so a new sub-division is just a
 * new channel. Channel names are unchanged in the database.
 */
const DIVISION_ORDER = ['HOS', 'RX', 'B2B', 'BID', 'CLIDP', 'MT'];
const SUB_ORDER = { HOS: ['Field Representatives', 'Telesales'], RX: ['STC', 'BNB', 'URO', 'B2C'], B2B: ['NBD', 'CRR'] };
const DIVISION_NAME = { HOS: 'Hospital', RX: 'RX Business', B2B: 'Business to Business', BID: 'Bidding', CLIDP: 'CLIDP', MT: 'Modern Trade' };
const divisionOf = (channelName) => {
  const n = String(channelName || '').trim();
  if (/^hosp?$/i.test(n)) return { div: 'HOS', sub: 'Field Representatives' };
  if (/^telesales$/i.test(n)) return { div: 'HOS', sub: 'Telesales' };
  const m = n.match(/^(.+?)\s*·\s*(.+)$/);
  if (m) {
    const div = m[1].trim().toUpperCase() === 'HOSP' ? 'HOS' : m[1].trim().toUpperCase();
    const sub = m[2].trim();
    return { div, sub: sub === 'B&B' ? 'BNB' : sub };
  }
  // Nov 16, 2026 (Aaron): the original B2B channel is NBD (everyone but Fritzie). It keeps the name
  // "B2B" in the database: the KPI scorecard finds B2B's channel by that name.
  if (/^b2b$/i.test(n)) return { div: 'B2B', sub: 'NBD' };
  return { div: n.toUpperCase(), sub: null };
};
const groupDivisions = (sections) => {
  const map = new Map();
  for (const s of sections) {
    const { div, sub } = divisionOf(s.c.name);
    if (!map.has(div)) map.set(div, { div, subs: [] });
    map.get(div).subs.push({ ...s, sub });
  }
  const rankDiv = (d) => { const i = DIVISION_ORDER.indexOf(d); return i === -1 ? DIVISION_ORDER.length : i; };
  const list = [...map.values()].sort((a, b) => rankDiv(a.div) - rankDiv(b.div) || a.div.localeCompare(b.div));
  for (const d of list) {
    const order = SUB_ORDER[d.div] || [];
    const rankSub = (x) => (x.sub == null ? 999 : (order.indexOf(x.sub) === -1 ? 500 : order.indexOf(x.sub)));
    d.subs.sort((a, b) => rankSub(a) - rankSub(b));
    const hasNamedSubs = d.subs.some((x) => x.sub);
    // The plain "B2B" channel next to NBD / CRR holds the people not yet placed in either.
    for (const x of d.subs) x.label = x.sub || (hasNamedSubs ? `${d.div} · not yet placed` : d.div);
    d.inList = DIVISION_ORDER.includes(d.div);
    d.heads = [...new Set(d.subs.map((x) => x.c.head_name).filter(Boolean))];
    d.territories = d.subs.reduce((n, x) => n + x.c.counts.territories, 0);
    d.vacant = d.subs.reduce((n, x) => n + x.c.counts.vacant, 0);
  }
  return list;
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
            alsoIn: a.also_in || [],
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
    // Oct 12, 2026: Team Leads who share this lead's team (users.shares_team_with) sit right
    // under them, so the same members read as led by both.
    if (m.user) {
      for (const u of usersById.values()) {
        if (u.shares_team_with !== m.user.id) continue;
        place(u);
        rows.push({
          key: `c${c.id}-m${m.id}-shared-${u.id}`, level: 2, kind: 'lead', shared: true,
          name: displayName(u), user: { id: u.id, name: u.name, role: u.role },
          handles: `Shares ${m.name}'s team: the same members below`, status: accStatus(u.id), act: null,
        });
      }
    }
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
              {options.map((u) => <option key={u.id} value={u.id}>{displayName(u)} · {roleLabel(u.role)}</option>)}
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
          {/* Oct 30, 2026: also sells in another division (Nicka: CLIDP and MT). */}
          {r.alsoIn?.length > 0 && <span className="text-[10.5px] font-semibold text-sky-700 shrink-0">also in {r.alsoIn.map(chLabel).join(', ')}</span>}
        </div>
      </td>
      <td className="py-2 pr-3 whitespace-nowrap">
        {!r.missing && <span className={`inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${k.chip}`}>{k.label}{r.shared ? ' · shared' : ''}</span>}
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

// Nov 16, 2026 (Aaron): the four main departments, in his order: Admin, Finance, Sales (CHC),
// Operation. Management (approvers) and Team Leads now sit INSIDE Sales (CHC); Operation is split
// into Pharmacy and Dispatcher. Departments an admin adds (PAP first) follow these.
const ADMIN_DEPT = { key: 'admin', title: 'Admin', sub: 'System administrators', roles: ['admin'] };
const FINANCE_DEPT = { key: 'finance', title: 'Finance', sub: 'Payment and account checks', roles: ['finance'] };
const OPERATION_UNITS = ['Pharmacy', 'Dispatcher'];

/** One name (and an optional note) for a new sub-division or department. */
const NameDialog = ({ title, help, label, placeholder, withNote, onClose, onSave }) => {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('A name is required.');
    setSaving(true);
    setError(null);
    try {
      await onSave(name.trim(), note.trim());
      onClose();
    } catch (err) {
      setError(errorText(err, 'Could not save.'));
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-16" role="dialog" aria-modal="true" aria-labelledby="ts-name-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={() => !saving && onClose()} aria-hidden="true" />
      <form onSubmit={save} className="relative w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="ts-name-title" className="text-base font-semibold text-ink-primary">{title}</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{help}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label htmlFor="ts-new-name" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">{label}</label>
            <input id="ts-new-name" autoFocus className={inputCls} value={name} disabled={saving} placeholder={placeholder} onChange={(e) => setName(e.target.value)} />
          </div>
          {withNote && (
            <div>
              <label htmlFor="ts-new-note" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">What it does (optional)</label>
              <input id="ts-new-note" className={inputCls} value={note} disabled={saving} placeholder="e.g. Orders with a GL from PCSO, DSWD or the Office of the President" onChange={(e) => setNote(e.target.value)} />
            </div>
          )}
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-medium text-ink-secondary hover:bg-surface">Cancel</button>
          <button type="submit" disabled={saving} className="px-4 py-2 rounded-md text-sm font-semibold text-white bg-getmeds-blue hover:bg-getmeds-blue-hover disabled:opacity-60">{saving ? 'Saving…' : 'Add'}</button>
        </div>
      </form>
    </div>
  );
};

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

/* ── add a new person (territory) under a team lead ───────────────────────── */

const AddPersonDialog = ({ manager, channel, candidates, onClose, onDone }) => {
  const [userId, setUserId] = useState('');
  const [zoho, setZoho]     = useState('');
  const [name, setName]     = useState('');
  const [hq, setHq]         = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  const picked = candidates.find((u) => String(u.id) === String(userId));
  const held = picked ? heldOf(picked) : [];

  const pick = (value) => {
    setUserId(value);
    const u = candidates.find((x) => String(x.id) === String(value));
    if (u) {
      const list = heldOf(u);
      setZoho(list[0] || '');
      setName(displayName(u));
    } else {
      setZoho('');
      setName('');
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!zoho.trim()) return setError('Zoho salesperson name is required — it is the unique key that links this slot to an account.');
    setSaving(true);
    setError(null);
    try {
      await client.post('/api/admin/team-structure/territories', {
        manager_id:       manager.id,
        zoho_salesperson: zoho.trim(),
        person_label:     name.trim() || null,
        hq:               hq.trim() || null,
      });
      toast.success(`${name.trim() || zoho.trim()} added under ${manager.name}.`);
      await onDone();
      onClose();
    } catch (err) {
      setError(errorText(err, 'Could not add person.'));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-16" role="dialog" aria-modal="true" aria-labelledby="ts-addperson-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={() => !saving && onClose()} aria-hidden="true" />
      <form onSubmit={save} className="relative w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="ts-addperson-title" className="text-base font-semibold text-ink-primary">
              Add person under {manager.name}
            </h2>
            <p className="text-xs text-ink-secondary mt-0.5">
              {chLabel(channel.name)} · Pick a MedRep account to fill in their details automatically.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Account picker */}
          <div>
            <label htmlFor="ts-ap-account" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">
              MedRep account
            </label>
            <select
              id="ts-ap-account"
              className={inputCls}
              value={userId}
              onChange={(e) => pick(e.target.value)}
              disabled={saving}
              autoFocus
            >
              <option value="">No account — fill in manually</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id} disabled={!heldOf(u).length}>
                  {displayName(u)}{heldOf(u).length ? ` · ${heldOf(u).join(', ')}` : ' · no Zoho salesperson yet'}
                </option>
              ))}
            </select>
            {candidates.length === 0 && (
              <p className="mt-1 text-[11px] text-amber-800">Every active MedRep is already placed in a channel.</p>
            )}
          </div>

          {/* If the picked account has multiple salespersons, let user choose which */}
          {picked && held.length > 1 && (
            <div>
              <label htmlFor="ts-ap-sp-pick" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">
                Which Zoho salesperson
              </label>
              <select
                id="ts-ap-sp-pick"
                className={inputCls}
                value={zoho}
                onChange={(e) => setZoho(e.target.value)}
                disabled={saving}
              >
                {held.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          )}

          {/* Zoho name — editable, auto-filled when account is picked */}
          <div>
            <label htmlFor="ts-ap-zoho" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">
              Zoho salesperson <span className="text-red-600">*</span>
            </label>
            <input
              id="ts-ap-zoho"
              className={inputCls}
              value={zoho}
              onChange={(e) => setZoho(e.target.value)}
              placeholder="e.g. TeleSales | Ana"
              disabled={saving}
            />
            <p className="mt-1 text-[11px] text-ink-secondary">Must match exactly the Zoho salesperson name. Must be unique across all channels.</p>
          </div>

          {/* Person name — editable, auto-filled when account is picked */}
          <div>
            <label htmlFor="ts-ap-name" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">
              Person name <span className="font-normal">(optional)</span>
            </label>
            <input
              id="ts-ap-name"
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Display name shown in the structure"
              disabled={saving}
            />
          </div>

          <div>
            <label htmlFor="ts-ap-hq" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">
              HQ / Branch <span className="font-normal">(optional)</span>
            </label>
            <input
              id="ts-ap-hq"
              className={inputCls}
              value={hq}
              onChange={(e) => setHq(e.target.value)}
              placeholder="e.g. ON SITE"
              disabled={saving}
            />
          </div>

          {error && (
            <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-medium text-ink-secondary hover:bg-surface">
            Cancel
          </button>
          <button type="submit" disabled={saving || !zoho.trim()} className="px-4 py-2 rounded-md text-sm font-semibold text-white bg-getmeds-blue hover:bg-getmeds-blue-hover disabled:opacity-60">
            {saving ? 'Adding…' : 'Add person'}
          </button>
        </div>
      </form>
    </div>
  );
};

/* ── assign an account to a territory nobody holds ─────────────────────────── */

const heldOf = (u) => (u.salespersons?.length ? u.salespersons.map((s) => s.salesperson) : (u.salesperson ? [u.salesperson] : []));

/**
 * A territory is held by whichever account carries its Zoho salesperson name. The
 * sheet's short names ("B2B | DHON") are often not the name Zoho holds ("B2B | DHON
 * VALLEJOS"), so "assign" points the territory at the MedRep's OWN Zoho salesperson:
 * it is saved as the territory's Zoho name in the structure. The account is not
 * touched, so nothing about their orders changes. The candidates are the MedReps
 * that are not in any channel.
 */
const AssignDialog = ({ assigning, candidates, onClose, onDone }) => {
  const { territory, channel } = assigning;
  const [userId, setUserId] = useState('');
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const picked = candidates.find((u) => String(u.id) === String(userId));
  const held = picked ? heldOf(picked) : [];

  const pick = (value) => {
    setUserId(value);
    const u = candidates.find((x) => String(x.id) === String(value));
    const list = u ? heldOf(u) : [];
    setName(list[0] || '');
  };

  const save = async (e) => {
    e.preventDefault();
    if (!picked || !name) return setError('Pick an account that has a Zoho salesperson.');
    setSaving(true);
    setError(null);
    try {
      await client.patch(`/api/admin/team-structure/territories/${territory.id}`, { zoho_alias: name });
      toast.success(`${territory.zoho_salesperson} now belongs to ${displayName(picked)}.`);
      await onDone();
      onClose();
    } catch (err) {
      setError(errorText(err, 'Could not assign.'));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-16" role="dialog" aria-modal="true" aria-labelledby="ts-assign-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={() => !saving && onClose()} aria-hidden="true" />
      <form onSubmit={save} className="relative w-full max-w-md rounded-xl bg-white shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div>
            <h2 id="ts-assign-title" className="text-base font-semibold text-ink-primary">Assign an account to {territory.zoho_salesperson}</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{chLabel(channel.name)}. Choose from the MedReps that are not in a channel.</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100"><X className="h-5 w-5" /></button>
        </div>
        <div className="px-5 py-4 space-y-4">
          <div>
            <label htmlFor="ts-assign-account" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">MedRep account</label>
            <select id="ts-assign-account" className={inputCls} value={userId} onChange={(e) => pick(e.target.value)} disabled={saving} autoFocus>
              <option value="">Pick an account…</option>
              {candidates.map((u) => (
                <option key={u.id} value={u.id} disabled={!heldOf(u).length}>
                  {displayName(u)}{heldOf(u).length ? ` · ${heldOf(u).join(', ')}` : ' · no Zoho salesperson yet'}
                </option>
              ))}
            </select>
            {candidates.length === 0 && <p className="mt-1.5 text-xs text-amber-800">Every active MedRep is already in a channel.</p>}
          </div>

          {picked && held.length > 1 && (
            <div>
              <label htmlFor="ts-assign-sp" className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">Which of their Zoho salespersons</label>
              <select id="ts-assign-sp" className={inputCls} value={name} onChange={(e) => setName(e.target.value)} disabled={saving}>
                {held.map((h) => <option key={h} value={h}>{h}</option>)}
              </select>
            </div>
          )}

          {picked && name && (
            <p className="text-sm text-ink-primary">
              {territory.zoho_salesperson} will match to <strong>{displayName(picked)}</strong> through their Zoho salesperson <strong>{name}</strong>.
              {territory.zoho_alias && territory.zoho_alias !== name ? <span className="text-ink-secondary"> It replaces the old name {territory.zoho_alias}.</span> : null}
            </p>
          )}
          <p className="text-xs text-ink-secondary">This changes the team structure only. The account and its Zoho salesperson are not touched.</p>
          {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div>}
        </div>
        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <button type="button" onClick={onClose} disabled={saving} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-medium text-ink-secondary hover:bg-surface">Cancel</button>
          <button type="submit" disabled={saving || !picked || !name} className="px-4 py-2 rounded-md text-sm font-semibold text-white bg-getmeds-blue hover:bg-getmeds-blue-hover disabled:opacity-60">{saving ? 'Assigning…' : 'Assign'}</button>
        </div>
      </form>
    </div>
  );
};

const AccountsByTeam = ({ users, onOpen, onShowList, onUsersChanged }) => {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['team-structure'],
    queryFn: () => client.get('/api/admin/team-structure').then((r) => r.data.data),
    retry: false,
  });
  // Departments: Sales opens by default, the rest start shut. Channels start shut too,
  // since each header already carries its head and counts.
  const [openDept, setOpenDept] = useState({});
  const toggleDept = (key, wasOpen) => setOpenDept((s) => ({ ...s, [key]: !wasOpen }));
  const [openCh, setOpenCh] = useState({});
  const [showOthers, setShowOthers] = useState(false);
  const [editor, setEditor] = useState(null);
  const [moving, setMoving] = useState(null); // territory id whose Move menu is open
  const [assigning, setAssigning] = useState(null); // { territory, channel } awaiting an account
  const [addingPerson, setAddingPerson] = useState(null); // { manager, channel } for new territory
  // Nov 16, 2026: divisions inside Sales (CHC), the "add sub-division / department" dialog, and
  // the person picker open on an added department.
  const [openDiv, setOpenDiv] = useState({});
  const [naming, setNaming] = useState(null); // { kind: 'sub', division } | { kind: 'dept' }
  const [addingMember, setAddingMember] = useState(null); // department id

  // Nov 16, 2026: departments added by an admin (PAP first). Empty until the migration has run.
  const { data: deptData } = useQuery({
    queryKey: ['departments'],
    queryFn: () => client.get('/api/admin/departments').then((r) => r.data.data),
    retry: false,
  });
  const addedDepts = deptData?.departments || [];
  const deptsReady = Boolean(deptData?.ready);

  const usersById = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  // A change of manager (approver) also changes what Manager Access is compared against.
  const refresh = () => Promise.all([
    qc.invalidateQueries({ queryKey: ['team-structure'] }),
    qc.invalidateQueries({ queryKey: ['manager-access-plan'] }),
    qc.invalidateQueries({ queryKey: ['departments'] }),
  ]);

  const built = useMemo(() => {
    if (!data) return null;
    const sections = sortChannels( data.heads.flatMap((h) => h.channels.map((c) => ({ h, c, ...channelRows(h, c, usersById) }))));
    const placed = new Set(sections.flatMap((s) => [...s.placed]));
    const others = users
      .filter((u) => !placed.has(u.id))
      .sort((a, b) => String(a.role).localeCompare(String(b.role)) || String(a.name).localeCompare(String(b.name)));
    return { sections, others, divisions: groupDivisions(sections) };
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
    if (a.type === 'head') {
      const headManager = s.c.managers.find((m) => m.acts_as_head);
      return (
        <span className="inline-flex gap-3">
          {headManager && (
            <button type="button" className={`${linkBtn} inline-flex items-center gap-0.5`} onClick={() => setAddingPerson({ manager: headManager, channel: s.c })}>
              <Plus className="w-3 h-3" />Person
            </button>
          )}
          <button type="button" className={linkBtn} onClick={() => setEditor({ mode: 'head', channel: s.c, headUser: s.h.user })}>Change head</button>
        </span>
      );
    }
    if (a.type === 'approver-add') return <button type="button" className={linkBtn} onClick={() => setEditor({ mode: 'approver-add', channel: s.c })}>Add manager</button>;
    if (a.type === 'approver') {
      return <button type="button" className="text-[12px] font-semibold text-red-700 hover:text-red-800" onClick={() => run(() => client.delete(`/api/admin/team-structure/approvers/${a.approver.id}`), 'Manager removed.')}>Remove</button>;
    }
    if (a.type === 'lead') {
      return (
        <span className="inline-flex gap-3">
          <button type="button" className={`${linkBtn} inline-flex items-center gap-0.5`} onClick={() => setAddingPerson({ manager: a.manager, channel: s.c })}>
            <Plus className="w-3 h-3" />Person
          </button>
          <button type="button" className={linkBtn} onClick={() => setEditor({ mode: 'manager-edit', channel: s.c, manager: a.manager })}>Edit</button>
          <button type="button" className="text-[12px] font-semibold text-red-700 hover:text-red-800" onClick={() => run(() => client.delete(`/api/admin/team-structure/managers/${a.manager.id}`), 'Team lead removed.')}>Remove</button>
        </span>
      );
    }
    if (a.type === 'rep') {
      // Nov 16, 2026: any team lead (or head) in the same Division, so a person can move to another
      // sub-division (B2B NBD -> CRR). Labelled with the sub-division when it is not this one.
      const div = built.divisions.find((d) => d.subs.some((x) => x.c.id === s.c.id));
      const targets = (div ? div.subs : [{ c: s.c, label: '' }]).flatMap((x) => x.c.managers
        .filter((m) => m.id !== a.from.id)
        .map((m) => ({ ...m, where: x.c.id === s.c.id ? '' : x.label })));
      const isVacant = !r.name;
      const assign = isVacant
        ? <button type="button" className={linkBtn} onClick={() => setAssigning({ territory: a.territory, channel: s.c })}>Assign account</button>
        : null;
      const remove = isVacant
        ? <button type="button" className="text-[12px] font-semibold text-red-700 hover:text-red-800" onClick={() => run(() => client.delete(`/api/admin/team-structure/territories/${a.territory.id}`), 'Slot removed.')}>Remove</button>
        : null;
      if (!targets.length) return assign || remove ? <span className="inline-flex gap-3">{assign}{remove}</span> : null;
      if (moving !== a.territory.id) {
        return (
          <span className="inline-flex gap-3">
            {assign}
            <button type="button" className={linkBtn} onClick={() => setMoving(a.territory.id)}>Move</button>
            {remove}
          </span>
        );
      }
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
          {targets.map((m) => <option key={m.id} value={m.id}>{m.name}{m.acts_as_head ? ' (head)' : ''}{m.where ? ` · ${m.where}` : ''}</option>)}
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
  // Oct 12, 2026: a lead who shares another lead's team (shares_team_with) counts that team too.
  const directOf = (id) => users.filter((u) => u.team_lead_id === id).length;
  const membersOf = (id) => {
    const me = users.find((u) => u.id === id);
    return directOf(id) + (me && me.shares_team_with ? directOf(me.shares_team_with) : 0);
  };
  const sharedNote = (id) => {
    const me = users.find((u) => u.id === id);
    return me && me.shares_team_with ? ` (shares ${me.shares_team_with_name || 'another lead'}'s team)` : '';
  };

  const rowsFor = (roles, detailOf = () => '') => users
    .filter((u) => roles.includes(String(u.role).toLowerCase()))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)))
    .map((u) => ({
      key: `d-${u.id}`, user: u, name: displayName(u), roleText: roleLabel(u.role), zoho: u.salesperson || '', status: statusOf(u),
      detail: detailOf(u),
    }));

  const mgmtRows = rowsFor(['management'], (u) => (approves.get(u.id) ? `Approves: ${approves.get(u.id).join(', ')}` : ''));

  const unplacedReps = built.others.filter((u) => String(u.role).toLowerCase() === 'medrep').map((u) => ({
    key: `o-${u.id}`, user: u, name: displayName(u), roleText: 'medrep', zoho: u.salesperson || '', status: statusOf(u), detail: '',
  }));
  // Nov 16, 2026: Team Leads are part of Sales (CHC) now; the ones the structure does not place yet.
  const unplacedLeads = built.others.filter((u) => String(u.role).toLowerCase() === 'team_lead').map((u) => ({
    key: `ol-${u.id}`, user: u, name: displayName(u), roleText: roleLabel(u.role), zoho: u.salesperson || '', status: statusOf(u),
    detail: `${u.sales_title ? `${u.sales_title} · ` : ''}${membersOf(u.id)} team member${membersOf(u.id) === 1 ? '' : 's'}${sharedNote(u.id)}`,
  }));

  const totalTerritories = built.sections.reduce((s, x) => s + x.c.counts.territories, 0);
  const totalVacant = built.sections.reduce((s, x) => s + x.c.counts.vacant, 0);

  // Operation: Pharmacy, Dispatcher, and whoever is not marked yet.
  const opsUsers = users.filter((u) => String(u.role).toLowerCase() === 'dispatch')
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  const unitReady = users.some((u) => Object.prototype.hasOwnProperty.call(u, 'operation_unit'));
  const opsGroups = [
    ...OPERATION_UNITS.map((unit) => ({ unit, people: opsUsers.filter((u) => u.operation_unit === unit) })),
    { unit: null, people: opsUsers.filter((u) => !OPERATION_UNITS.includes(u.operation_unit)) },
  ];
  const setUnit = (u, unit) => run(async () => {
    await client.patch(`/api/admin/users/${u.id}/operation-unit`, { operation_unit: unit || null });
    if (onUsersChanged) await onUsersChanged();
  }, unit ? `${displayName(u)} is in ${unit}.` : `${displayName(u)} is no longer placed.`);

  const activeUsers = users.filter((u) => (u.is_active === 1 || u.is_active === true) && u.approval_status !== 'pending' && u.approval_status !== 'rejected')
    .sort((a, b) => displayName(a).localeCompare(displayName(b)));

  const subHeadLabel = 'text-[10.5px] font-bold uppercase tracking-wide text-ink-secondary';

  const channelSection = (s, label) => {
    const isOpen = Boolean(openCh[s.c.id]);
    return (
      <section key={s.c.id} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
          <button type="button" onClick={() => setOpenCh((c) => ({ ...c, [s.c.id]: !isOpen }))} aria-expanded={isOpen}
            className="flex items-center gap-2 min-w-0 text-left">
            {isOpen ? <ChevronDown className="w-4 h-4 text-ink-secondary shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-secondary shrink-0" />}
            <span className="text-[15px] font-semibold text-ink-primary">{label}</span>
            <span className="text-xs text-ink-secondary">Head: {s.c.head_name}</span>
          </button>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <span className="text-xs text-ink-secondary tabular-nums">
              {s.c.counts.territories} territories{s.c.counts.vacant ? <span className="text-red-700"> · {s.c.counts.vacant} vacant</span> : ''}
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
  };

  const foldCard = (key, title, sub, count, body, startOpen = false) => {
    const isOpen = Boolean(openDiv[key] ?? startOpen);
    return (
      <section key={key} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <button type="button" onClick={() => setOpenDiv((s) => ({ ...s, [key]: !isOpen }))} aria-expanded={isOpen}
          className="w-full flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-3 text-left hover:bg-slate-50">
          <span className="flex items-center gap-2 min-w-0">
            {isOpen ? <ChevronDown className="w-4 h-4 text-ink-secondary shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-secondary shrink-0" />}
            <span className="font-semibold text-ink-primary">{title}</span>
            {sub && <span className="text-xs text-ink-secondary">{sub}</span>}
          </span>
          <span className="text-xs text-ink-secondary tabular-nums">{count}</span>
        </button>
        {isOpen && <div className="border-t border-slate-100">{body}</div>}
      </section>
    );
  };

  const adminRows = rowsFor(ADMIN_DEPT.roles);
  const financeRows = rowsFor(FINANCE_DEPT.roles);

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-secondary max-w-3xl">
        Every account, by department: Admin, Finance, Sales (CHC) and Operation, then any department added below. Sales (CHC) is arranged by Division and Sub-division,
        with the managers who approve each one. The buttons here change the structure only; what a manager sees and approves changes only when you press Save under
        Management (Approval).
      </p>

      <DeptCard title="Admin" sub={ADMIN_DEPT.sub} count={`${adminRows.length} account${adminRows.length === 1 ? '' : 's'}`}
        open={Boolean(openDept.admin)} onToggle={() => toggleDept('admin', Boolean(openDept.admin))}>
        <AccountTable rows={adminRows} onOpen={onOpen} />
      </DeptCard>

      <DeptCard title="Finance" sub={FINANCE_DEPT.sub} count={`${financeRows.length} account${financeRows.length === 1 ? '' : 's'}`}
        open={Boolean(openDept.finance)} onToggle={() => toggleDept('finance', Boolean(openDept.finance))}>
        <AccountTable rows={financeRows} onOpen={onOpen} />
      </DeptCard>

      <DeptCard
        title="Sales (CHC)" sub={`Customer Happiness Coachee · ${built.divisions.filter((d) => d.inList).length} divisions`}
        open={Boolean(openDept.sales ?? true)} onToggle={() => toggleDept('sales', openDept.sales ?? true)}
        count={<>{totalTerritories} territories{totalVacant ? <span className="text-red-700"> · {totalVacant} vacant</span> : ''}</>}
      >
        <div className="p-4 space-y-3 bg-slate-50/50">
          {foldCard('mgmt', 'Management (Approval)', 'Approve the orders of the divisions they hold', `${mgmtRows.length} account${mgmtRows.length === 1 ? '' : 's'}`,
            <ManagerAccessTable rows={mgmtRows} onOpen={onOpen} />)}

          {built.divisions.map((d) => {
            const single = d.subs.length === 1 && !d.subs[0].sub;
            const subCount = d.subs.filter((x) => x.sub).length;
            const key = `div-${d.div}`;
            const isOpen = Boolean(openDiv[key]);
            return (
              <section key={key} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 hover:bg-slate-50">
                  <button type="button" onClick={() => setOpenDiv((s) => ({ ...s, [key]: !isOpen }))} aria-expanded={isOpen}
                    className="flex flex-wrap items-center gap-x-2 gap-y-0.5 min-w-0 text-left">
                    {isOpen ? <ChevronDown className="w-4 h-4 text-ink-secondary shrink-0" /> : <ChevronRight className="w-4 h-4 text-ink-secondary shrink-0" />}
                    <span className="text-[15px] font-bold text-ink-primary">{d.div}</span>
                    {DIVISION_NAME[d.div] && DIVISION_NAME[d.div] !== d.div && <span className="text-xs text-ink-secondary">{DIVISION_NAME[d.div]}</span>}
                    {!d.inList && <span className="text-[10.5px] font-semibold text-amber-700">not in the division list</span>}
                    <span className="text-xs text-ink-secondary">· Head: {d.heads.join(', ') || '—'}</span>
                  </button>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                    <span className="text-xs text-ink-secondary tabular-nums">
                      {subCount ? `${subCount} sub-division${subCount === 1 ? '' : 's'} · ` : ''}{d.territories} territories
                      {d.vacant ? <span className="text-red-700"> · {d.vacant} vacant</span> : ''}
                    </span>
                    <button type="button" className={`${linkBtn} inline-flex items-center gap-1`} onClick={() => setNaming({ kind: 'sub', division: d })}>
                      <Plus className="w-3.5 h-3.5" />Sub-division
                    </button>
                  </div>
                </div>
                {isOpen && (
                  <div className="border-t border-slate-100 p-3 space-y-3 bg-slate-50/40">
                    {single
                      ? channelSection(d.subs[0], d.div)
                      : d.subs.map((x) => channelSection(x, x.label))}
                  </div>
                )}
              </section>
            );
          })}

          {foldCard('leads-out', 'Team leads not in a division', 'Their account is a Team Lead, but no division lists them yet', `${unplacedLeads.length} account${unplacedLeads.length === 1 ? '' : 's'}`,
            <AccountTable rows={unplacedLeads} onOpen={onOpen} showDetail />)}

          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <button type="button" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50">
              <span className="flex items-center gap-2">
                {showOthers ? <ChevronDown className="w-4 h-4 text-ink-secondary" /> : <ChevronRight className="w-4 h-4 text-ink-secondary" />}
                <span className="font-semibold text-ink-primary">Salespersons not in a division</span>
              </span>
              <span className="text-xs text-ink-secondary tabular-nums">{unplacedReps.length} accounts · their Zoho salesperson is not a territory in any division</span>
            </button>
            {showOthers && <AccountTable rows={unplacedReps} onOpen={onOpen} />}
          </section>
        </div>
      </DeptCard>

      <DeptCard title="Operation" sub="Pharmacy and Dispatcher" count={`${opsUsers.length} account${opsUsers.length === 1 ? '' : 's'}`}
        open={Boolean(openDept.ops)} onToggle={() => toggleDept('ops', Boolean(openDept.ops))}>
        {!unitReady && (
          <p className="px-4 pt-3 text-xs text-amber-800">Pharmacy / Dispatcher cannot be saved on this database yet: the departments migration has not run.</p>
        )}
        <div className="p-4 space-y-3 bg-slate-50/50">
          {opsGroups.filter((g) => g.unit || g.people.length).map((g) => (
            <section key={g.unit || 'none'} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2.5 flex items-center justify-between">
                <span className={`font-semibold ${g.unit ? 'text-ink-primary' : 'text-amber-800'}`}>{g.unit || 'Not yet placed'}</span>
                <span className="text-xs text-ink-secondary tabular-nums">{g.people.length} account{g.people.length === 1 ? '' : 's'}</span>
              </div>
              {g.people.length === 0 ? (
                <p className="px-4 pb-3 text-sm text-ink-secondary">No one yet. Use the menu on a row below to place someone here.</p>
              ) : (
                <table className="w-full border-t border-slate-100">
                  <tbody className="divide-y divide-slate-100">
                    {g.people.map((u) => (
                      <tr key={u.id} className="hover:bg-surface">
                        <td className="py-2 pl-4 pr-3 text-[13px] font-medium text-ink-primary cursor-pointer" onClick={() => onOpen(u.id)}>{displayName(u)}</td>
                        <td className="py-2 pr-3 text-[12px] text-ink-secondary">{u.email}</td>
                        <td className="py-2 pr-3"><span className={`inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border ${TONE[statusOf(u).tone]}`}>{statusOf(u).text}</span></td>
                        <td className="py-2 pr-4 text-right">
                          <select
                            aria-label={`Unit for ${displayName(u)}`}
                            value={u.operation_unit || ''}
                            disabled={!unitReady}
                            onChange={(e) => setUnit(u, e.target.value)}
                            className="text-[12px] border border-slate-300 rounded px-1.5 py-1 bg-white disabled:opacity-50"
                          >
                            <option value="">Not placed</option>
                            {OPERATION_UNITS.map((x) => <option key={x} value={x}>{x}</option>)}
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ))}
        </div>
      </DeptCard>

      {addedDepts.map((dep) => {
        const memberIds = new Set(dep.members.map((m) => m.id));
        return (
          <DeptCard key={`dep-${dep.id}`} title={dep.name} sub={dep.note || 'Added department'}
            count={`${dep.members.length} account${dep.members.length === 1 ? '' : 's'}`}
            open={Boolean(openDept[`dep-${dep.id}`])} onToggle={() => toggleDept(`dep-${dep.id}`, Boolean(openDept[`dep-${dep.id}`]))}>
            <div className="p-4 space-y-3">
              {dep.members.length === 0 ? (
                <p className="text-sm text-ink-secondary">No one in this department yet.</p>
              ) : (
                <table className="w-full">
                  <tbody className="divide-y divide-slate-100">
                    {dep.members.map((m) => (
                      <tr key={m.id} className="hover:bg-surface">
                        <td className="py-2 pr-3 text-[13px] font-medium text-ink-primary cursor-pointer" onClick={() => onOpen(m.id)}>{m.name}</td>
                        <td className="py-2 pr-3"><span className="inline-block px-2 py-0.5 rounded-full text-[10.5px] font-bold border bg-slate-100 text-slate-700 border-slate-200">{roleLabel(m.role)}</span></td>
                        <td className="py-2 pr-3 text-[12px] font-mono text-ink-secondary">{m.salesperson || ''}</td>
                        <td className="py-2 text-right">
                          <button type="button" className="text-[12px] font-semibold text-red-700 hover:text-red-800"
                            onClick={() => run(() => client.delete(`/api/admin/departments/${dep.id}/members/${m.id}`), `${m.name} removed from ${dep.name}.`)}>Remove</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="flex flex-wrap items-center gap-3">
                {addingMember === dep.id ? (
                  <select
                    autoFocus
                    aria-label={`Add a person to ${dep.name}`}
                    defaultValue=""
                    onBlur={() => setAddingMember(null)}
                    onChange={(e) => {
                      const id = Number(e.target.value);
                      setAddingMember(null);
                      if (id) run(() => client.post(`/api/admin/departments/${dep.id}/members`, { user_id: id }), `Added to ${dep.name}.`);
                    }}
                    className="text-[12px] border border-slate-300 rounded px-1.5 py-1 bg-white"
                  >
                    <option value="">Pick an account…</option>
                    {activeUsers.filter((u) => !memberIds.has(u.id)).map((u) => (
                      <option key={u.id} value={u.id}>{displayName(u)} · {roleLabel(u.role)}{u.salesperson ? ` · ${u.salesperson}` : ''}</option>
                    ))}
                  </select>
                ) : (
                  <button type="button" className={`${linkBtn} inline-flex items-center gap-1`} onClick={() => setAddingMember(dep.id)}><Plus className="w-3.5 h-3.5" />Person</button>
                )}
                {dep.members.length === 0 && (
                  <button type="button" className="text-[12px] font-semibold text-red-700 hover:text-red-800"
                    onClick={() => run(() => client.delete(`/api/admin/departments/${dep.id}`), `${dep.name} removed.`)}>Remove department</button>
                )}
              </div>
            </div>
          </DeptCard>
        );
      })}

      <div>
        <button type="button" disabled={!deptsReady} onClick={() => setNaming({ kind: 'dept' })}
          title={deptsReady ? '' : 'The departments migration has not run on this database yet'}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-dashed border-slate-300 bg-white text-sm font-semibold text-getmeds-blue hover:bg-slate-50 disabled:opacity-50">
          <Plus className="w-4 h-4" />Add department
        </button>
      </div>

      {naming && naming.kind === 'sub' && (
        <NameDialog
          title={`Add a sub-division to ${naming.division.div}`}
          help={`Headed by ${naming.division.heads[0] || 'the division head'}. Then use Move on a person in ${naming.division.div} to place them here, or add a team lead.`}
          label="Sub-division name" placeholder={naming.division.div === 'B2B' ? 'e.g. NBD' : 'e.g. STC'}
          onClose={() => setNaming(null)}
          onSave={async (name) => {
            const first = naming.division.subs[0];
            const div = naming.division.div;
            const headName = first?.c.head_name || div;
            const headUserId = first?.h?.head_user_id ?? null;
            const created = await client.post('/api/admin/team-structure/channels', {
              name: `${div} · ${name}`, head_name: headName, head_user_id: headUserId,
            });
            // The head as its first lead, so people can be moved here before it has a team lead.
            const channelId = created.data?.data?.id;
            if (channelId) {
              await client.post('/api/admin/team-structure/managers', {
                channel_id: channelId, name: headName, user_id: headUserId, acts_as_head: true,
              });
              // Same managers (approvers) as the rest of the Division, so its orders still go to them.
              for (const ap of first?.c.approvers || []) {
                await client.post('/api/admin/team-structure/approvers', { channel_id: channelId, name: ap.name, user_id: ap.user ? ap.user.id : null });
              }
            }
            toast.success(`${div} · ${name} added.`);
            await refresh();
          }}
        />
      )}
      {naming && naming.kind === 'dept' && (
        <NameDialog
          title="Add a department"
          help="A department next to Admin, Finance, Sales (CHC) and Operation, e.g. PAP. Adding people to it does not change their role, Zoho salesperson or what they can see."
          label="Department name" placeholder="e.g. PAP" withNote
          onClose={() => setNaming(null)}
          onSave={async (name, note) => {
            await client.post('/api/admin/departments', { name, note: note || null });
            toast.success(`${name} added.`);
            await refresh();
          }}
        />
      )}

      {assigning && (
        <AssignDialog
          key={assigning.territory.id}
          assigning={assigning}
          candidates={unplacedReps.map((r) => r.user).filter((u) => (u.is_active === 1 || u.is_active === true) && u.approval_status !== 'pending' && u.approval_status !== 'rejected')}
          onClose={() => setAssigning(null)}
          onDone={async () => { if (onUsersChanged) await onUsersChanged(); await refresh(); }}
        />
      )}

      {addingPerson && (
        <AddPersonDialog
          key={addingPerson.manager.id}
          manager={addingPerson.manager}
          channel={addingPerson.channel}
          candidates={unplacedReps.map((r) => r.user).filter((u) => (u.is_active === 1 || u.is_active === true) && u.approval_status !== 'pending' && u.approval_status !== 'rejected')}
          onClose={() => setAddingPerson(null)}
          onDone={refresh}
        />
      )}

      {editor && <EditorDialog key={`${editor.mode}-${editor.channel.id}-${editor.manager ? editor.manager.id : ''}`} editor={editor} users={users} onClose={() => setEditor(null)} onSaved={refresh} />}
    </div>
  );
};

export default AccountsByTeam;
