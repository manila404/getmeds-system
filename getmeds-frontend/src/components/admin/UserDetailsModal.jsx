import React, { useEffect, useMemo, useState } from 'react';
import client from '../../api/client';
import { X, Shield, Pencil, Trash2, UserCheck, Ban, UserX, Clock, Check, Briefcase, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { ROLES, roleLabel, roleCan } from '../../constants/roles';
import { useAuth } from '../../hooks/useAuth';

/**
 * User Details — Sep 24, 2026.
 *
 * One place to manage an account. The Users table used to carry an inline
 * editor for every field and a different button per row state; that is now here,
 * opened by clicking a row, and the table is read-only.
 *
 *   view mode  — the account's fields, and the buttons its status allows:
 *                  Awaiting approval  → Approve, Reject, Edit
 *                  Rejected           → Approve after all, Edit
 *                  Active / Inactive  → Edit
 *   edit mode  — the fields become editable, and Delete appears (with
 *                Deactivate beside it for an active account).
 *
 * Nothing destructive happens on the first click. Delete, Deactivate and a role
 * change each ask once, in place, saying what it costs.
 *
 * Delete is permanent, and the server only allows it for an account with no
 * history (see admin.controller.js's deleteUser); for anyone else the answer it
 * gives is "deactivate instead", shown here verbatim.
 *
 * Username is editable (its own column since Sep 24, 2026). An account that has
 * never been given one shows the part of its email before the @, and that is
 * what the field starts with. It is a label: sign-in is still by email.
 */

const inputClass =
  'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue disabled:bg-slate-50 disabled:text-ink-secondary';
const btn = 'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-md text-sm font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
const btnPrimary = `${btn} text-white bg-getmeds-blue hover:bg-getmeds-blue-hover shadow-sm`;
const btnGhost = `${btn} border border-slate-200 bg-white text-ink-secondary hover:bg-surface hover:text-ink-primary`;
const btnGreen = `${btn} text-pharmacy-green-dark bg-pharmacy-green/10 hover:bg-pharmacy-green/20 border border-pharmacy-green/30`;
const btnRed = `${btn} text-red-700 bg-red-50 hover:bg-red-100 border border-red-200`;

const roleBadgeColors = {
  admin: 'bg-purple-100 text-purple-800 border-purple-200',
  management: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  finance: 'bg-pharmacy-green/15 text-pharmacy-green-dark border-pharmacy-green/30',
  dispatch: 'bg-getmeds-blue/15 text-getmeds-blue-dark border-getmeds-blue/30',
  medrep: 'bg-getmeds-blue/10 text-getmeds-blue-dark border-getmeds-blue/30',
  team_lead: 'bg-indigo-100/60 text-indigo-700 border-indigo-200',
};

const errorText = (err, fallback) =>
  err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || fallback;

/** A label above its value (or its input). */
const Field = ({ label, htmlFor, children, hint }) => (
  <div>
    <label htmlFor={htmlFor} className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">
      {label}
    </label>
    {children}
    {hint && <p className="text-[11px] text-ink-secondary mt-1">{hint}</p>}
  </div>
);

const StatusPill = ({ status }) => {
  if (status === 'pending') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300">
        <Clock className="w-3 h-3" /> Awaiting approval
      </span>
    );
  }
  if (status === 'rejected') {
    return (
      <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-50 text-red-800 border border-red-200">
        <Ban className="w-3 h-3" /> Rejected
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span className="inline-flex items-center gap-1.5 pl-1 pr-3 py-0.5 rounded-full text-xs font-semibold bg-pharmacy-green/10 text-pharmacy-green">
        <span className="flex items-center justify-center w-4 h-4 rounded-full bg-pharmacy-green text-white">
          <Check className="w-2.5 h-2.5" strokeWidth={4} />
        </span>
        Active
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
      Inactive
    </span>
  );
};

/** Every Salesperson on an account, primary first. */
const salespersonsOf = (user) =>
  user.salespersons?.length
    ? user.salespersons
    : user.salesperson
      ? [{ salesperson: user.salesperson, is_primary: true }]
      : [];

const usernameOf = (user) => user.username || (user.email ? user.email.split('@')[0] : `user_${user.id}`);

const UserDetailsModal = ({
  user,
  onClose,
  onChanged,
  salespersons,
  salespersonCounts,
  salespersonError,
  teamLeads,
}) => {
  const { user: me } = useAuth();

  const status =
    user.approval_status === 'pending'
      ? 'pending'
      : user.approval_status === 'rejected'
        ? 'rejected'
        : user.is_active === 1 || user.is_active === true
          ? 'active'
          : 'inactive';
  const roleKey = (user.role || user.role_name || '').toLowerCase();
  const isAdminAccount = roleKey === 'admin';
  const isMe = me?.id === user.id;

  const held = useMemo(() => salespersonsOf(user), [user]);
  const initialDraft = () => ({
    first_name: user.first_name || '',
    last_name: user.last_name || '',
    username: usernameOf(user),
    email: user.email || '',
    role: roleKey,
    team_lead_id: user.team_lead_id ? String(user.team_lead_id) : '',
    salespersons: held.map((s) => s.salesperson),
    primary: (held.find((s) => s.is_primary) || held[0] || {}).salesperson || null,
  });

  const [mode, setMode] = useState('view'); // 'view' | 'edit'
  const [draft, setDraft] = useState(initialDraft);
  const [confirm, setConfirm] = useState(null); // null | 'delete' | 'deactivate' | 'role'
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showInactive, setShowInactive] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy]);

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const editing = mode === 'edit';
  const displayName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.name || '—';

  // What Zoho names this picker offers: active ones, plus whatever the account
  // already holds, so opening it never shows a current value as missing.
  const options = useMemo(() => {
    const mine = new Set(held.map((s) => s.salesperson));
    return salespersons.filter((sp) => showInactive || sp.is_active || mine.has(sp.name));
  }, [salespersons, held, showInactive]);

  const addSalesperson = (name) => {
    if (!name || draft.salespersons.includes(name)) return;
    set({ salespersons: [...draft.salespersons, name], primary: draft.primary || name });
  };
  const removeSalesperson = (name) => {
    const next = draft.salespersons.filter((n) => n !== name);
    set({ salespersons: next, primary: draft.primary === name ? next[0] || null : draft.primary });
  };

  const startEdit = () => {
    setDraft(initialDraft());
    setError(null);
    setConfirm(null);
    setMode('edit');
  };
  const cancelEdit = () => {
    setError(null);
    setConfirm(null);
    setMode('view');
  };

  /** Run one server call; report a failure in the modal instead of losing it. */
  const run = async (fn, fallback) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (err) {
      setError(errorText(err, fallback));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const decide = async (action) => {
    const done = await run(() => client.post(`/api/admin/users/${user.id}/${action}`).then(() => true), `Could not ${action} this account.`);
    if (!done) return;
    toast.success(action === 'approve' ? `${displayName} can now sign in.` : `${displayName}'s sign-up was rejected.`);
    await onChanged();
  };

  const roleChanged = draft.role !== roleKey;

  const changes = () => {
    const body = {};
    if (draft.first_name.trim() !== (user.first_name || '') || draft.last_name.trim() !== (user.last_name || '')) {
      body.first_name = draft.first_name.trim();
      body.last_name = draft.last_name.trim();
    }
    if (draft.username.trim() !== usernameOf(user)) body.username = draft.username.trim();
    if (draft.email.trim().toLowerCase() !== String(user.email || '').toLowerCase()) body.email = draft.email.trim();
    if (roleChanged) body.role = draft.role;
    if (draft.role === 'medrep' && draft.team_lead_id !== (user.team_lead_id ? String(user.team_lead_id) : '')) {
      body.team_lead_id = draft.team_lead_id ? parseInt(draft.team_lead_id, 10) : null;
    }
    const before = held.map((s) => s.salesperson).join('\u0000');
    const primaryBefore = (held.find((s) => s.is_primary) || held[0] || {}).salesperson || null;
    if (draft.salespersons.join('\u0000') !== before || (draft.primary || null) !== primaryBefore) {
      body.salespersons = draft.salespersons;
      body.primary_salesperson = draft.primary;
    }
    return body;
  };

  const save = async () => {
    const body = changes();
    if (Object.keys(body).length === 0) return cancelEdit();
    if (!draft.first_name.trim()) return setError('First name is required.');
    const done = await run(() => client.patch(`/api/admin/users/${user.id}`, body).then(() => true), 'Could not save the changes.');
    if (!done) return;
    toast.success('Account updated.');
    setConfirm(null);
    setMode('view');
    await onChanged();
  };

  // A role decides what someone can see across the whole system, so it is
  // confirmed once, in place, before it is saved with everything else.
  const onSaveClick = () => {
    setError(null);
    if (roleChanged && confirm !== 'role') {
      if (!draft.first_name.trim()) return setError('First name is required.');
      return setConfirm('role');
    }
    save();
  };

  const deactivate = async () => {
    const done = await run(() => client.patch(`/api/admin/users/${user.id}/deactivate`).then(() => true), 'Could not deactivate this account.');
    if (!done) return;
    toast.success(`${displayName} deactivated.`);
    await onChanged();
  };

  const remove = async () => {
    const done = await run(() => client.delete(`/api/admin/users/${user.id}`).then(() => true), 'Could not delete this account.');
    if (!done) return setConfirm(null); // the reason stays on screen
    toast.success(`${displayName} was permanently deleted.`);
    await onChanged({ deletedId: user.id });
  };

  const badge = roleBadgeColors[roleKey] || 'bg-slate-100 text-slate-800 border-slate-200';
  const inputsDisabled = busy;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-10" role="dialog" aria-modal="true" aria-labelledby="user-details-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={() => !busy && onClose()} aria-hidden="true" />

      <div className="relative w-full max-w-2xl rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="user-details-title" className="text-base font-semibold text-ink-primary truncate">
              User Details
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-ink-secondary">
              <span className="font-mono">#{user.id}</span>
              <StatusPill status={status} />
              {editing && <span className="font-semibold text-getmeds-blue">Editing</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-ink-primary disabled:opacity-50">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Fields */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4 px-5 py-5">
          <Field label="First name" htmlFor="ud-first">
            {editing ? (
              <input id="ud-first" className={inputClass} value={draft.first_name} disabled={inputsDisabled} onChange={(e) => set({ first_name: e.target.value })} autoFocus />
            ) : (
              <p className="text-sm font-semibold text-ink-primary">{user.first_name || '—'}</p>
            )}
          </Field>

          <Field label="Last name" htmlFor="ud-last">
            {editing ? (
              <input id="ud-last" className={inputClass} value={draft.last_name} disabled={inputsDisabled} onChange={(e) => set({ last_name: e.target.value })} />
            ) : (
              <p className="text-sm font-semibold text-ink-primary">{user.last_name || '—'}</p>
            )}
          </Field>

          <Field label="Username" htmlFor="ud-username" hint={editing ? 'Must be unique. Letters, numbers, dots, dashes, underscores. They still sign in with their email.' : undefined}>
            {editing ? (
              <input id="ud-username" className={`${inputClass} font-mono`} value={draft.username} disabled={inputsDisabled} autoComplete="off" onChange={(e) => set({ username: e.target.value })} />
            ) : (
              <p className="text-sm font-mono text-ink-secondary">{usernameOf(user)}</p>
            )}
          </Field>

          <Field label="Email" htmlFor="ud-email" hint={editing ? 'This is what they sign in with.' : undefined}>
            {editing ? (
              <input id="ud-email" type="email" className={inputClass} value={draft.email} disabled={inputsDisabled} onChange={(e) => set({ email: e.target.value })} />
            ) : (
              <p className="text-sm text-ink-primary break-all">{user.email}</p>
            )}
          </Field>

          <Field label="Role" htmlFor="ud-role" hint={editing && isAdminAccount ? 'Admin accounts cannot be changed to another role.' : undefined}>
            {editing && !isAdminAccount ? (
              <select id="ud-role" className={inputClass} value={draft.role} disabled={inputsDisabled} onChange={(e) => set({ role: e.target.value })}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            ) : (
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badge}`}>
                {isAdminAccount && <Shield className="w-3 h-3 mr-1" />}
                {roleLabel(roleKey)}
              </span>
            )}
          </Field>

          <Field label="Team Lead" htmlFor="ud-teamlead" hint={editing && draft.role === 'medrep' ? 'Decides whose team dashboard shows this MedRep’s orders.' : undefined}>
            {editing && draft.role === 'medrep' ? (
              <select id="ud-teamlead" className={inputClass} value={draft.team_lead_id} disabled={inputsDisabled} onChange={(e) => set({ team_lead_id: e.target.value })}>
                <option value="">— None —</option>
                {teamLeads.map((tl) => (
                  <option key={tl.id} value={tl.id}>{[tl.first_name, tl.last_name].filter(Boolean).join(' ') || tl.name}</option>
                ))}
              </select>
            ) : (
              <p className="text-sm text-ink-primary">
                {roleKey === 'medrep' ? user.team_lead_name || 'None' : <span className="text-ink-secondary">Only MedReps have a Team Lead</span>}
              </p>
            )}
          </Field>

          <div className="sm:col-span-2">
            <Field label="Zoho Salesperson">
              {editing ? (
                <div className="space-y-2">
                  {draft.salespersons.length ? (
                    <ul className="space-y-1">
                      {draft.salespersons.map((name) => (
                        <li key={name} className="flex items-center gap-2 text-sm">
                          <button
                            type="button"
                            onClick={() => set({ primary: name })}
                            title={name === draft.primary ? 'Primary' : 'Make this the primary'}
                            className={`text-sm leading-none ${name === draft.primary ? 'text-getmeds-blue' : 'text-slate-300 hover:text-getmeds-blue'}`}
                          >
                            ★
                          </button>
                          <span className="text-ink-primary">{name}</span>
                          <button type="button" onClick={() => removeSalesperson(name)} aria-label={`Remove ${name}`} className="text-xs text-red-600 hover:text-red-800">
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-amber-800">No Salesperson: this account cannot place orders.</p>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      aria-label="Add a Zoho Salesperson"
                      value=""
                      disabled={inputsDisabled || !!salespersonError}
                      onChange={(e) => addSalesperson(e.target.value)}
                      className="max-w-full text-sm border border-slate-300 rounded-lg px-2.5 py-1.5 focus:outline-none focus:ring-2 focus:ring-getmeds-blue disabled:bg-slate-50"
                    >
                      <option value="">{salespersonError ? 'Zoho list unavailable' : '+ Add a Salesperson…'}</option>
                      {options
                        .filter((sp) => !draft.salespersons.includes(sp.name))
                        .map((sp) => {
                          const others = (sp.assigned_to || []).filter((a) => a.email !== user.email);
                          return (
                            <option key={sp.name} value={sp.name}>
                              {sp.name}
                              {sp.is_active ? '' : ' (inactive)'}
                              {others.length ? ` - also ${others.map((a) => a.name).join(', ')}` : ''}
                            </option>
                          );
                        })}
                    </select>
                    {salespersonCounts.inactive > 0 && (
                      <button type="button" onClick={() => setShowInactive((v) => !v)} className="text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark whitespace-nowrap">
                        {showInactive ? `Hide inactive (${salespersonCounts.inactive})` : `Show inactive (${salespersonCounts.inactive})`}
                      </button>
                    )}
                  </div>
                  {salespersonError && <p className="text-xs text-red-700">{salespersonError}</p>}
                </div>
              ) : held.length ? (
                <ul className="space-y-1">
                  {held.map((s) => (
                    <li key={s.salesperson} className="flex flex-wrap items-center gap-1.5 text-sm text-ink-primary">
                      <Briefcase className="w-3.5 h-3.5 text-ink-secondary" />
                      {s.salesperson}
                      {s.is_primary && held.length > 1 && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-getmeds-blue">primary</span>
                      )}
                      {salespersons.some((sp) => sp.name === s.salesperson && !sp.is_active) && (
                        <span className="text-[11px] text-amber-800">(inactive in Zoho)</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="inline-flex items-center gap-1.5 text-sm text-amber-800">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {roleKey === 'medrep' ? 'Not set: cannot order' : 'Not set'}
                </p>
              )}
            </Field>
          </div>
        </div>

        {/* Messages */}
        {error && (
          <div role="alert" className="mx-5 mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
            {error}
          </div>
        )}

        {/* In-place confirmation: replaces the footer so it cannot be missed. */}
        {confirm ? (
          <div className="border-t border-slate-200 bg-slate-50 px-5 py-4 space-y-3 rounded-b-xl">
            {confirm === 'delete' && (
              <p className="text-sm text-ink-primary">
                <span className="font-semibold">Permanently delete {displayName}?</span> This cannot be undone. It only works for an account with no orders,
                approvals or other activity on record; otherwise nothing is removed and you will be pointed at Deactivate.
              </p>
            )}
            {confirm === 'deactivate' && (
              <p className="text-sm text-ink-primary">
                <span className="font-semibold">Deactivate {displayName}?</span> They lose access immediately. Their history stays.
              </p>
            )}
            {confirm === 'role' && (
              <p className="text-sm text-ink-primary">
                <span className="font-semibold">Change {displayName}’s role to {roleLabel(draft.role)}?</span> {roleCan(draft.role)} They keep their orders and
                history, but what they can see and do changes as soon as they next sign in.
                {draft.role === 'admin' && (
                  <span className="block mt-1 font-semibold text-red-700">
                    This one cannot be undone here: an admin account cannot afterwards be changed to another role or deactivated from this screen.
                  </span>
                )}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" className={btnGhost} disabled={busy} onClick={() => setConfirm(null)}>Back</button>
              {confirm === 'delete' && (
                <button type="button" className={`${btn} text-white bg-red-600 hover:bg-red-700`} disabled={busy} onClick={remove}>
                  <Trash2 className="w-4 h-4" /> {busy ? 'Deleting…' : 'Yes, delete permanently'}
                </button>
              )}
              {confirm === 'deactivate' && (
                <button type="button" className={`${btn} text-white bg-red-600 hover:bg-red-700`} disabled={busy} onClick={deactivate}>
                  <UserX className="w-4 h-4" /> {busy ? 'Deactivating…' : 'Yes, deactivate'}
                </button>
              )}
              {confirm === 'role' && (
                <button type="button" className={btnPrimary} disabled={busy} onClick={save}>
                  {busy ? 'Saving…' : 'Change role and save'}
                </button>
              )}
            </div>
          </div>
        ) : (
          /* Footer: what the account's status and the current mode allow. */
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 px-5 py-4">
            <div className="flex flex-wrap gap-2">
              {editing && !isAdminAccount && !isMe && (
                <>
                  <button type="button" className={btnRed} disabled={busy} onClick={() => setConfirm('delete')}>
                    <Trash2 className="w-4 h-4" /> Delete
                  </button>
                  {status === 'active' && (
                    <button type="button" className={btnGhost} disabled={busy} onClick={() => setConfirm('deactivate')}>
                      <UserX className="w-4 h-4" /> Deactivate
                    </button>
                  )}
                </>
              )}
            </div>

            <div className="flex flex-wrap justify-end gap-2">
              {editing ? (
                <>
                  <button type="button" className={btnGhost} disabled={busy} onClick={cancelEdit}>Cancel</button>
                  <button type="button" className={btnPrimary} disabled={busy} onClick={onSaveClick}>
                    {busy ? 'Saving…' : 'Save changes'}
                  </button>
                </>
              ) : (
                <>
                  {status === 'pending' && (
                    <>
                      <button type="button" className={btnGreen} disabled={busy} onClick={() => decide('approve')}>
                        <UserCheck className="w-4 h-4" /> Approve
                      </button>
                      <button type="button" className={btnRed} disabled={busy} onClick={() => decide('reject')}>
                        <Ban className="w-4 h-4" /> Reject
                      </button>
                    </>
                  )}
                  {status === 'rejected' && (
                    <button type="button" className={btnGreen} disabled={busy} onClick={() => decide('approve')} title="Reverses the rejection: the account can sign in again.">
                      <UserCheck className="w-4 h-4" /> Approve after all
                    </button>
                  )}
                  <button type="button" className={btnPrimary} disabled={busy} onClick={startEdit}>
                    <Pencil className="w-4 h-4" /> Edit
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default UserDetailsModal;
