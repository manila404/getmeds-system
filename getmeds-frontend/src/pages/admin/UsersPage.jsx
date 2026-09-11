import React, { useState, useEffect } from 'react';
import client from '../../api/client';
import LoadingSpinner from '../../components/ui/LoadingSpinner';
import ErrorMessage from '../../components/ui/ErrorMessage';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import SalespersonCombo from '../../components/admin/SalespersonCombo';
import { Users, UserX, RefreshCw, Shield, Check, UserCheck, Ban, Clock, Briefcase, AlertTriangle, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import toast from 'react-hot-toast';

/**
 * Sep 11, 2026: the order roles sort in.
 *
 * By privilege, not alphabetically. This screen calls itself "View, audit, and
 * manage" — the accounts worth looking at first are the ones that can do the
 * most, and an alphabetical sort buries Admin between Dispatch and Finance for
 * no reason anybody cares about.
 *
 * Anything not listed sorts last rather than first, so a role added to the
 * system later shows up somewhere obvious instead of silently displacing
 * admins from the top.
 */
/**
 * Sep 11, 2026: hoisted out of the component.
 *
 * It used to be declared near the bottom, which was fine while it was only
 * called from JSX. The sort below calls it from a useMemo — and a useMemo
 * factory runs DURING render, at the line it appears on, not later like an
 * event handler. Left where it was, the first click on a column header threw
 * "Cannot access 'getUserDisplayName' before initialization": the build was
 * clean, the page loaded fine, and it broke only on the one interaction.
 *
 * It needs no component state, so module scope removes the hazard rather than
 * relying on nobody reordering the file.
 */
const getUserDisplayName = (user) => {
  if (user.first_name || user.last_name) {
    return `${user.first_name || ''} ${user.last_name || ''}`.trim();
  }
  return user.name || '—';
};

/**
 * How long ago, in the roughest useful terms.
 *
 * "3 hours ago" is what makes a queue feel urgent or stale; an ISO timestamp
 * makes the reader do that arithmetic themselves and most will not bother.
 */
const timeAgo = (iso) => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const ROLE_RANK = { admin: 0, management: 1, finance: 2, dispatch: 3, medrep: 4 };
const rankOf = (user) => {
  const r = (user.role || user.role_name || '').toLowerCase();
  return r in ROLE_RANK ? ROLE_RANK[r] : 99;
};

const roleBadgeColors = {
  admin: 'bg-purple-100 text-purple-800 border-purple-200',
  management: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  finance: 'bg-pharmacy-green/15 text-pharmacy-green-dark border-pharmacy-green/30',
  dispatch: 'bg-getmeds-blue/15 text-getmeds-blue-dark border-getmeds-blue/30',
  medrep: 'bg-getmeds-blue/10 text-getmeds-blue-dark border-getmeds-blue/30',
};

const UsersPage = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedUser, setSelectedUser] = useState(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);

  // Sep 11, 2026: the Zoho Salesperson list, and which row is being edited.
  //
  // A picker rather than a text box, and that is the whole point. A name Zoho
  // does not recognise is not rejected on the first order -- Zoho CREATES the
  // Salesperson -- so a typed name becomes a permanent junk record in the
  // company org that nobody traces back to this screen.
  const [salespersons, setSalespersons] = useState([]);
  const [salespersonError, setSalespersonError] = useState(null);
  const [editingSalesperson, setEditingSalesperson] = useState(null);
  const [savingSalesperson, setSavingSalesperson] = useState(false);
  // Sep 11, 2026: the picker shows CURRENT salespersons by default.
  //
  // Zoho marks a Salesperson inactive when the person leaves, and this org's
  // list is 101 active to 97 inactive -- so showing everything made the
  // dropdown twice as long as it needed to be, with half of it former staff
  // whose names sit right next to the people actually being assigned.
  //
  // Kept as a toggle rather than a hard filter because assigning one is still
  // legitimate: correcting a historical record, or a rep coming back.
  const [showInactive, setShowInactive] = useState(false);
  const [salespersonCounts, setSalespersonCounts] = useState({ active: 0, inactive: 0 });

  // Sep 11, 2026: sorting, with the approval queue preserved.
  //
  // `null` means the server's own order, which is NOT arbitrary: pending
  // sign-ups first, then by name. That ordering is a queue — a list that
  // buries three people waiting on an admin among eighty alphabetised names is
  // a queue nobody works — so it stays the default, and sorting is something
  // you opt into by clicking a column.
  const [sort, setSort] = useState(null);

  const toggleSort = (key) =>
    setSort((current) => {
      if (current?.key !== key) return { key, dir: 'asc' };
      // asc -> desc -> back to the queue. The third click is the way out;
      // without it, clicking a header once is a one-way door.
      if (current.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });

  // Fetch users on component mount
  useEffect(() => {
    fetchUsers();
    fetchSalespersons();
  }, []);

  const fetchSalespersons = async () => {
    try {
      const res = await client.get('/api/admin/salespersons');
      setSalespersons(res.data?.data?.salespersons || []);
      setSalespersonCounts({
        active: res.data?.data?.active_count || 0,
        inactive: res.data?.data?.inactive_count || 0
      });
      setSalespersonError(null);
    } catch (err) {
      // Not fatal: the rest of user management works without it, and the
      // column below says plainly that the list could not be loaded rather
      // than rendering an empty picker that looks like Zoho has nobody.
      setSalespersonError(
        err.response?.data?.error?.message || 'Could not load the Zoho Salesperson list.'
      );
    }
  };

  /**
   * Who is waiting to be let in, newest first.
   *
   * Derived from the rows already fetched rather than a second request: the
   * list is right here, and a separate call could disagree with the table
   * directly underneath it.
   */
  const awaitingApproval = React.useMemo(
    () =>
      users
        .filter((u) => u.approval_status === 'pending')
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0)),
    [users]
  );

  /**
   * The rows as displayed.
   *
   * Sorted in the browser rather than by refetching: the whole list is already
   * here, and a round trip per header click would make a sort feel like a page
   * load for no gain at this size.
   */
  const sortedUsers = React.useMemo(() => {
    if (!sort) return users;

    const value = (u) => {
      switch (sort.key) {
        case 'role':
          return rankOf(u);
        case 'name':
          return (getUserDisplayName(u) || '').toLowerCase();
        case 'salesperson':
          // Unassigned sorts last in both directions rather than clumping at
          // whichever end empty strings happen to land — "not set yet" is not
          // a value, and it is the thing being looked for.
          return (u.salesperson || '').toLowerCase();
        case 'status':
          return u.approval_status === 'pending' ? 0 : u.approval_status === 'rejected' ? 1 : (u.is_active === 1 || u.is_active === true) ? 2 : 3;
        default:
          return 0;
      }
    };

    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...users].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (sort.key === 'salesperson') {
        if (!av && bv) return 1;
        if (av && !bv) return -1;
      }
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // A stable tie-break, so equal roles do not shuffle between renders.
      return (getUserDisplayName(a) || '').localeCompare(getUserDisplayName(b) || '');
    });
  }, [users, sort]);

  /** A column heading you can click. */
  const SortableHeader = ({ label, sortKey, align = 'left' }) => {
    const active = sort?.key === sortKey;
    const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <th scope="col" className={`px-6 py-3 text-${align} text-[13px] font-semibold text-white`}>
        <button
          type="button"
          onClick={() => toggleSort(sortKey)}
          title={
            active
              ? sort.dir === 'asc'
                ? `Sorted by ${label} — click for reverse`
                : `Sorted by ${label} — click to clear`
              : `Sort by ${label}`
          }
          className="inline-flex items-center gap-1.5 font-semibold hover:text-white/80 transition-colors"
        >
          {label}
          <Icon className={`w-3.5 h-3.5 ${active ? 'opacity-100' : 'opacity-50'}`} />
        </button>
      </th>
    );
  };

  /**
   * Which salespersons this row may pick from.
   *
   * Active ones, plus -- always -- whatever this account is already set to.
   * Without that second half, opening the picker on somebody assigned to a
   * now-departed salesperson would show their current value missing from the
   * list, and a stray change would silently clear it.
   */
  const optionsFor = (user) =>
    salespersons.filter(
      (sp) => showInactive || sp.is_active || sp.name === user.salesperson
    );

  /**
   * Assign (or clear) the Zoho Salesperson for one account.
   *
   * The server checks the name against Zoho as well -- this picker is the
   * convenience, not the guarantee.
   */
  const saveSalesperson = async (user, value) => {
    setSavingSalesperson(true);
    try {
      await client.patch(`/api/admin/users/${user.id}`, { salesperson: value || null });
      toast.success(
        value
          ? `${getUserDisplayName(user)} will order as "${value}" in Zoho.`
          : `Cleared the Salesperson for ${getUserDisplayName(user)}.`
      );
      setEditingSalesperson(null);
      await fetchUsers();
    } catch (err) {
      toast.error(
        err.response?.data?.error?.message ||
          err.response?.data?.message ||
          'Could not save the Salesperson.'
      );
    } finally {
      setSavingSalesperson(false);
    }
  };

  const fetchUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.get('/api/admin/users');
      const data = Array.isArray(res.data) ? res.data : (res.data?.data || []);
      setUsers(data);
    } catch (err) {
      const errorMsg =
        err.response?.data?.message ||
        err.response?.data?.error?.message ||
        err.message ||
        'Failed to retrieve users';
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  // Sep 9, 2026: the sign-up approval queue.
  //
  // POST /api/auth/register now creates an account with approval_status
  // 'pending' that cannot log in at all, so these two are what let anyone in.
  // Approving is not gated behind a confirmation dialog — it is the expected,
  // reversible action (an approved account can still be deactivated), and a
  // modal on the common path trains people to click through modals.
  const [busyId, setBusyId] = useState(null);

  const decide = async (user, action) => {
    setBusyId(user.id);
    try {
      const res = await client.post(`/api/admin/users/${user.id}/${action}`);
      const updated = res.data?.data?.user;
      setUsers((prev) =>
        prev.map((u) =>
          u.id === user.id ? { ...u, approval_status: updated?.approval_status || action + 'd' } : u
        )
      );
      toast.success(
        action === 'approve'
          ? `${getUserDisplayName(user)} can now sign in.`
          : `${getUserDisplayName(user)}'s sign-up was rejected.`
      );
    } catch (err) {
      toast.error(
        err.response?.data?.error?.message || err.message || `Could not ${action} this account.`
      );
    } finally {
      setBusyId(null);
    }
  };

  // Open confirmation modal
  const handleDeactivateClick = (user) => {
    setSelectedUser(user);
    setIsConfirmOpen(true);
  };

  // Confirm and send PATCH request to soft-delete
  const handleConfirmDeactivate = async () => {
    if (!selectedUser) return;

    try {
      await client.patch(`/api/admin/users/${selectedUser.id}/deactivate`);
      // Update local state without refreshing page
      setUsers((prevUsers) =>
        prevUsers.map((u) =>
          u.id === selectedUser.id ? { ...u, is_active: 0 } : u
        )
      );
      toast.success(
        `User ${selectedUser.name || selectedUser.username || selectedUser.email} deactivated successfully.`
      );
    } catch (err) {
      const errorMsg =
        err.response?.data?.message ||
        err.response?.data?.error?.message ||
        'Failed to deactivate user';
      toast.error(errorMsg);
    } finally {
      setIsConfirmOpen(false);
      setSelectedUser(null);
    }
  };

  // Helper to format username
  const getUsername = (user) => {
    if (user.username) return user.username;
    if (user.email) return user.email.split('@')[0];
    return `user_${user.id}`;
  };

  // Helper to format role name
  const getRoleName = (user) => {
    return user.role_name || user.role || 'User';
  };

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Users className="w-7 h-7 text-getmeds-blue" />
            <h1 className="text-2xl font-semibold text-ink-primary">User Management</h1>
          </div>
          <p className="text-sm text-ink-secondary mt-1">
            View, audit, and manage system user accounts and role permissions.
          </p>
        </div>
        <button
          onClick={fetchUsers}
          disabled={loading}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-slate-200 rounded-md text-sm font-medium text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary shadow-sm transition-colors disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* Error state */}
      {error && <ErrorMessage message={error} />}

      {/* Sep 11, 2026: the approval queue, said out loud.
          The table already sorts pending accounts first and badges them
          "Awaiting approval", which is enough once you are looking at the
          right row. This is for the moment before that -- landing on a page of
          eleven accounts and not registering that two of them are people
          unable to log in. It names them and says how long they have waited,
          because "signed up 3 days ago" reads differently from "signed up 4
          minutes ago" and the row badge says neither. */}
      {!loading && awaitingApproval.length > 0 && (
        <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <div className="flex items-start gap-2.5">
            <Clock className="w-4 h-4 mt-0.5 shrink-0 text-amber-700" />
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-amber-900">
                {awaitingApproval.length} sign-up{awaitingApproval.length === 1 ? '' : 's'} waiting for approval
              </p>
              <ul className="mt-1 space-y-0.5">
                {awaitingApproval.slice(0, 5).map((u) => (
                  <li key={u.id} className="text-[13px] text-amber-900/90">
                    <span className="font-medium">{getUserDisplayName(u)}</span>
                    <span className="text-amber-900/70"> · {u.email}</span>
                    {u.created_at && (
                      <span className="text-amber-900/70"> · signed up {timeAgo(u.created_at)}</span>
                    )}
                  </li>
                ))}
                {awaitingApproval.length > 5 && (
                  <li className="text-[13px] text-amber-900/70">
                    …and {awaitingApproval.length - 5} more, listed first in the table below.
                  </li>
                )}
              </ul>
              <p className="mt-1.5 text-[12px] text-amber-900/70">
                They cannot sign in until approved.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Loading state */}
      {loading ? (
        <div className="flex justify-center py-20">
          <LoadingSpinner size="lg" />
        </div>
      ) : (
        /* Users Table */
        <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full min-w-[900px] divide-y divide-slate-200">
              <thead className="bg-getmeds-blue">
                <tr>
                  <th scope="col" className="px-6 py-3 text-left text-[13px] font-semibold text-white">
                    ID
                  </th>
                  <SortableHeader label="Name" sortKey="name" />
                  <th scope="col" className="px-6 py-3 text-left text-[13px] font-semibold text-white">
                    Username
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-[13px] font-semibold text-white">
                    Email
                  </th>
                  <SortableHeader label="Role" sortKey="role" />
                  <SortableHeader label="Zoho Salesperson" sortKey="salesperson" />
                  <SortableHeader label="Status" sortKey="status" />
                  <th scope="col" className="px-6 py-3 text-center text-[13px] font-semibold text-white">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-100">
                {sortedUsers.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-6 py-12 text-center text-ink-secondary">
                      No user accounts found in the system.
                    </td>
                  </tr>
                ) : (
                  sortedUsers.map((user) => {
                    const isActive = user.is_active === 1 || user.is_active === true;
                    // Sep 9, 2026: undefined approval_status means an account
                    // that predates the column, which the migration backfilled
                    // as approved — so anything that is not literally
                    // 'pending'/'rejected' is approved.
                    const isPending = user.approval_status === 'pending';
                    const isRejected = user.approval_status === 'rejected';
                    const roleKey = (user.role || user.role_name || '').toLowerCase();
                    const badgeColor = roleBadgeColors[roleKey] || 'bg-slate-100 text-slate-800 border-slate-200';

                    return (
                      <tr key={user.id} className="hover:bg-surface transition-colors">
                        <td className="px-6 py-4 whitespace-nowrap text-[13px] font-mono font-medium text-ink-secondary">
                          #{user.id}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <div className="text-[13px] font-semibold text-ink-primary">
                            {getUserDisplayName(user)}
                          </div>
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-[13px] text-ink-secondary font-mono">
                          {getUsername(user)}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-[13px] text-ink-secondary">
                          {user.email}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badgeColor}`}>
                            <Shield className="w-3 h-3 mr-1" />
                            {getRoleName(user)}
                          </span>
                        </td>
                        {/* Sep 11, 2026: the name Zoho files this account's
                            orders under. Not derived from anything -- an admin
                            picks it from Zoho's own list.

                            A MedRep without one cannot place an order at all,
                            since Salesperson is mandatory on a Sales Order in
                            this org, so the empty state is a warning rather
                            than a dash. It sits beside Approve because
                            approving a new sign-up is the moment somebody
                            actually knows the answer. */}
                        <td className="px-6 py-4 text-[13px]">
                          {editingSalesperson === user.id ? (
                            <SalespersonCombo
                              value={user.salesperson || ''}
                              options={optionsFor(user)}
                              inactiveCount={salespersonCounts.inactive}
                              showInactive={showInactive}
                              onToggleInactive={() => setShowInactive((v) => !v)}
                              disabled={savingSalesperson}
                              onSelect={(name) => saveSalesperson(user, name)}
                              onCancel={() => setEditingSalesperson(null)}
                            />
                          ) : (
                            <button
                              type="button"
                              onClick={() => setEditingSalesperson(user.id)}
                              disabled={!!salespersonError}
                              title={salespersonError || 'Pick the name Zoho knows this person by'}
                              className="text-left group disabled:cursor-not-allowed"
                            >
                              {user.salesperson ? (
                                <span className="inline-flex items-center gap-1.5 text-ink-primary group-hover:text-getmeds-blue">
                                  <Briefcase className="w-3.5 h-3.5 text-ink-secondary" />
                                  {user.salesperson}
                                  {/* Assigned once, since marked inactive in
                                      Zoho -- worth surfacing, because nothing
                                      else would ever mention it. */}
                                  {salespersons.some(
                                    (sp) => sp.name === user.salesperson && !sp.is_active
                                  ) && (
                                    <span className="text-[11px] text-amber-800">(inactive in Zoho)</span>
                                  )}
                                </span>
                              ) : salespersonError ? (
                                <span className="text-ink-secondary">-</span>
                              ) : (
                                <span className="inline-flex items-center gap-1.5 text-amber-800">
                                  <AlertTriangle className="w-3.5 h-3.5" />
                                  {roleKey === 'medrep' ? 'Not set - cannot order' : 'Not set'}
                                </span>
                              )}
                            </button>
                          )}
                        </td>

                        {/* Sep 9, 2026: approval status wins the cell when it
                            is not 'approved'. "Pending" and "Inactive" both
                            mean "cannot log in", but they are different
                            situations with different fixes, and showing only
                            is_active would render a brand-new sign-up as
                            "Active" — which it is, and which is exactly the
                            wrong thing to tell an admin about an account
                            waiting on them. */}
                        <td className="px-6 py-4 whitespace-nowrap">
                          {isPending ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300">
                              <Clock className="w-3 h-3" />
                              Awaiting approval
                            </span>
                          ) : isRejected ? (
                            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-50 text-red-800 border border-red-200">
                              <Ban className="w-3 h-3" />
                              Rejected
                            </span>
                          ) : isActive ? (
                            <span className="inline-flex items-center gap-1.5 pl-1 pr-3 py-1 rounded-full text-xs font-semibold bg-pharmacy-green/10 text-pharmacy-green">
                              <span className="flex items-center justify-center w-4 h-4 rounded-full bg-pharmacy-green text-white flex-shrink-0">
                                <Check className="w-2.5 h-2.5" strokeWidth={4} />
                              </span>
                              Active
                            </span>
                          ) : (
                            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-200">
                              Inactive
                            </span>
                          )}
                        </td>
                        <td className="px-6 py-4 whitespace-nowrap text-right text-[13px] font-medium">
                          {isPending ? (
                            <div className="inline-flex items-center gap-2">
                              <button
                                type="button"
                                disabled={busyId === user.id}
                                onClick={() => decide(user, 'approve')}
                                className="inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-semibold rounded-full text-pharmacy-green-dark bg-pharmacy-green/10 hover:bg-pharmacy-green/20 border border-pharmacy-green/30 transition-colors disabled:opacity-50"
                              >
                                <UserCheck className="w-3.5 h-3.5" />
                                Approve
                              </button>
                              <button
                                type="button"
                                disabled={busyId === user.id}
                                onClick={() => decide(user, 'reject')}
                                className="inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-semibold rounded-full text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 transition-colors disabled:opacity-50"
                              >
                                <Ban className="w-3.5 h-3.5" />
                                Reject
                              </button>
                            </div>
                          ) : isRejected ? (
                            <button
                              type="button"
                              disabled={busyId === user.id}
                              onClick={() => decide(user, 'approve')}
                              className="inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-semibold rounded-full text-pharmacy-green-dark bg-pharmacy-green/10 hover:bg-pharmacy-green/20 border border-pharmacy-green/30 transition-colors disabled:opacity-50"
                              title="Reverses the rejection — the account can sign in again."
                            >
                              <UserCheck className="w-3.5 h-3.5" />
                              Approve after all
                            </button>
                          ) : isActive ? (
                            <button
                              type="button"
                              onClick={() => handleDeactivateClick(user)}
                              className="inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-semibold rounded-full text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-1"
                            >
                              <UserX className="w-3.5 h-3.5" />
                              Deactivate
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled
                              className="inline-flex items-center gap-1 px-3.5 py-1.5 text-xs font-medium rounded-full text-gray-400 bg-gray-50 border border-gray-200 cursor-not-allowed opacity-60"
                            >
                              Deactivated
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Confirmation Dialog */}
      <ConfirmDialog
        isOpen={isConfirmOpen}
        onClose={() => {
          setIsConfirmOpen(false);
          setSelectedUser(null);
        }}
        onConfirm={handleConfirmDeactivate}
        title="Confirm User Deactivation"
        message={
          selectedUser
            ? `Are you sure you want to deactivate ${getUserDisplayName(selectedUser)} (${selectedUser.email})? This user will immediately lose access to the system.`
            : 'Are you sure you want to deactivate this user?'
        }
        confirmText="Deactivate User"
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
};

export default UsersPage;
