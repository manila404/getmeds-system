import React, { useState, useEffect } from 'react';
import client from '../../api/client';
import LoadingSpinner from '../../components/ui/LoadingSpinner';
import ErrorMessage from '../../components/ui/ErrorMessage';
import CreateUserModal from '../../components/admin/CreateUserModal';
import UserDetailsModal from '../../components/admin/UserDetailsModal';
import TeamStructurePanel from '../../components/admin/TeamStructurePanel';
import AccountsByTeam from '../../components/admin/AccountsByTeam';
import PaginationFooter from '../../components/finance/PaginationFooter';
import { Users, UserPlus, RefreshCw, Shield, Check, Ban, Clock, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';
import { roleLabel } from '../../constants/roles';
import { formatPHT } from '../../utils/dateUtils';

/**
 * Sep 11, 2026: hoisted out of the component.
 *
 * The sort below calls it from a useMemo, and a useMemo factory runs DURING
 * render — at the line it appears on, not later like an event handler. Left
 * near the bottom of the component it threw "Cannot access
 * 'getUserDisplayName' before initialization" on the first click of a column
 * header: clean build, page loads fine, breaks on one interaction.
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
 * Sep 11, 2026: the order roles sort in.
 *
 * By privilege, not alphabetically. This screen calls itself "View, audit, and
 * manage" — the accounts worth looking at first are the ones that can do the
 * most, and an alphabetical sort buries Admin between Dispatch and Finance for
 * no reason anybody cares about.
 *
 * Anything not listed sorts LAST rather than first, so a role added to the
 * system later shows up somewhere obvious instead of silently displacing
 * admins from the top.
 */
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
  team_lead: 'bg-indigo-100/60 text-indigo-700 border-indigo-200',
};

const PAGE_SIZE = 15;

const UsersPage = () => {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Sep 24, 2026: the account whose User Details modal is open. An id, not the
  // row: the list refreshes behind the modal after every save, and the modal
  // should show the refreshed account, not the one it was opened with. If the
  // account disappears (deleted) the modal simply has nothing to show.
  const [detailsUserId, setDetailsUserId] = useState(null);

  // Sep 11, 2026: sorting, opt-in.
  //
  // `null` means the server's own order, which is not arbitrary — it is the
  // list as the API chose to return it. Sorting is something you turn on by
  // clicking a column, and the third click turns it off again; without that,
  // clicking a header once is a one-way door.
  const [sort, setSort] = useState(null);

  const toggleSort = (key) => {
    setPage(1); // a new order starts at its top
    setSort((current) => {
      if (current?.key !== key) return { key, dir: 'asc' };
      if (current.dir === 'asc') return { key, dir: 'desc' };
      return null;
    });
  };
  // Sep 11, 2026: sign-up is gone, so this is where every account is made.
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  // Sep 26, 2026: 'accounts' (the table) or 'structure' (who leads what).
  const [tab, setTab] = useState('accounts');
  // Within Accounts: 'team' (where each person sits) or 'list' (the flat table).
  const [view, setView] = useState('team');

  // Sep 11, 2026: the Zoho Salesperson list the details modal picks from.
  //
  // A picker rather than a text box, and that is the whole point. A name Zoho
  // does not recognise is not rejected on the first order -- Zoho CREATES the
  // Salesperson -- so a typed name becomes a permanent junk record in the
  // company org that nobody traces back to this screen.
  const [salespersons, setSalespersons] = useState([]);
  const [salespersonError, setSalespersonError] = useState(null);
  const [salespersonCounts, setSalespersonCounts] = useState({ active: 0, inactive: 0 });
  // Sep 11, 2026: when Zoho's Salesperson list was last synced, and what
  // changed in it lately -- a rename in Zoho is carried to every account and
  // order holding the old name, and this is where an admin sees that happen.
  const [salespersonSync, setSalespersonSync] = useState(null);
  const [refreshingSalespersons, setRefreshingSalespersons] = useState(false);

  // Fetch users on component mount
  useEffect(() => {
    fetchUsers();
    fetchSalespersons();
  }, []);

  const fetchSalespersons = async (refresh = false) => {
    if (refresh) setRefreshingSalespersons(true);
    try {
      const res = await client.get('/api/admin/salespersons', {
        params: refresh ? { refresh: 'true' } : undefined
      });
      setSalespersons(res.data?.data?.salespersons || []);
      setSalespersonSync(res.data?.data?.sync || null);
      // A rename may have rewritten Salespersons on accounts in this table.
      if (refresh) await fetchUsers({ silent: true });
      setSalespersonCounts({
        active: res.data?.data?.active_count || 0,
        inactive: res.data?.data?.inactive_count || 0
      });
      setSalespersonError(null);
    } catch (err) {
      // Not fatal: the rest of user management works without it, and the
      // modal says plainly that the list could not be loaded rather than
      // rendering an empty picker that looks like Zoho has nobody.
      setSalespersonError(
        err.response?.data?.error?.message || 'Could not load the Zoho Salesperson list.'
      );
    } finally {
      setRefreshingSalespersons(false);
    }
  };

  const describeChange = (c) => {
    switch (c.change) {
      case 'renamed': return `Renamed: ${c.old_value} → ${c.new_value}${c.propagated ? ` (updated ${c.propagated} stored cop${c.propagated === 1 ? 'y' : 'ies'})` : ''}`;
      case 'added': return `Added: ${c.new_value}`;
      case 'removed': return `Removed from Zoho: ${c.old_value}`;
      case 'restored': return `Back in Zoho: ${c.new_value}`;
      case 'deactivated': return `Marked inactive: ${c.new_value}`;
      case 'reactivated': return `Active again: ${c.new_value}`;
      default: return `${c.change}: ${c.new_value || c.old_value}`;
    }
  };

  /**
   * `silent` refreshes the rows without swapping the table for a spinner. The
   * details modal calls it after every save, and a table that blanks out behind
   * an open dialog on each one reads as the page reloading.
   */
  const fetchUsers = async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
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
      if (!silent) setLoading(false);
    }
  };

  /**
   * The rows as displayed.
   *
   * Sorted in the browser rather than by refetching: the whole list is already
   * here, and a round trip per header click would make a sort feel like a page
   * load for no gain at this size.
   */
  const sortedUsers = React.useMemo(() => {
    // Sep 24, 2026: admins are always at the top, whatever the sort — the
    // accounts that can do the most stay where they are found first, and stay
    // on page 1. They are lifted out AFTER sorting, so admins are still in the
    // chosen order among themselves and so is everyone else.
    const adminsFirst = (list) => [
      ...list.filter((u) => (u.role || u.role_name || '').toLowerCase() === 'admin'),
      ...list.filter((u) => (u.role || u.role_name || '').toLowerCase() !== 'admin'),
    ];
    if (!sort) return adminsFirst(users);

    const value = (u) => {
      switch (sort.key) {
        case 'role':
          return rankOf(u);
        case 'name':
          return (getUserDisplayName(u) || '').toLowerCase();
        case 'status':
          return (u.is_active === 1 || u.is_active === true) ? 0 : 1;
        case 'modified':
          // ISO-8601 text sorts chronologically as it is.
          return u.updated_at || '';
        default:
          return 0;
      }
    };

    const dir = sort.dir === 'desc' ? -1 : 1;
    return adminsFirst([...users].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      // Stable tie-break, so equal roles do not shuffle between renders.
      return (getUserDisplayName(a) || '').localeCompare(getUserDisplayName(b) || '');
    }));
  }, [users, sort]);

  // Sep 24, 2026: 15 accounts a page. The list used to render every user at
  // once, which made the page as long as the company is big.
  //
  // In the browser, for the same reason the sort is: the whole list is already
  // here. Sorting happens BEFORE the slice, so "sort by Role" orders all the
  // accounts and page 1 is the top of that order, not a re-sort of one page.
  // The page is clamped rather than reset when the list changes underneath it
  // (a refresh, a deactivate), so editing a row on page 3 does not throw you
  // back to page 1.
  const [page, setPage] = useState(1);
  const pageCount = Math.max(1, Math.ceil(sortedUsers.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pagedUsers = React.useMemo(
    () => sortedUsers.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [sortedUsers, currentPage]
  );

  /** Every account that can be assigned as someone's Team Lead. */
  const teamLeads = React.useMemo(
    () => users.filter((u) => (u.role || '').toLowerCase() === 'team_lead'),
    [users]
  );

  const detailsUser = detailsUserId == null ? null : users.find((u) => u.id === detailsUserId) || null;

  /** A column heading you can click. */
  const SortableHeader = ({ label, sortKey }) => {
    const active = sort?.key === sortKey;
    const Icon = !active ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <th scope="col" className="px-4 py-3 text-left text-[13px] font-semibold text-white">
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

  // Helper to format username
  const getUsername = (user) => {
    if (user.username) return user.username;
    if (user.email) return user.email.split('@')[0];
    return `user_${user.id}`;
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
            Create accounts, assign Zoho Salespersons, and manage who can sign in. Select a row to open the account.
          </p>
          <p className="text-xs text-ink-secondary mt-1">
            Zoho Salesperson list{' '}
            {salespersonSync?.synced_at
              ? `synced ${new Date(salespersonSync.synced_at).toLocaleString()}`
              : 'not synced yet'}
            {' · '}
            <button
              type="button"
              onClick={() => fetchSalespersons(true)}
              disabled={refreshingSalespersons}
              className="font-semibold text-getmeds-blue hover:text-getmeds-blue-dark disabled:opacity-50"
            >
              {refreshingSalespersons ? 'Refreshing…' : 'Refresh from Zoho'}
            </button>
          </p>
          {salespersonSync?.changes?.length > 0 && (
            <details className="mt-1 text-xs text-ink-secondary">
              <summary className="cursor-pointer select-none">
                Recent changes in Zoho ({salespersonSync.changes.length})
              </summary>
              <ul className="mt-1 space-y-0.5 pl-4 list-disc">
                {salespersonSync.changes.map((c, i) => (
                  <li key={i}>
                    {describeChange(c)}
                    <span className="text-ink-secondary/70"> — {new Date(c.detected_at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchUsers()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 border border-slate-200 rounded-md text-sm font-medium text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary shadow-sm transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => setIsCreateOpen(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-sm font-semibold text-white bg-getmeds-blue hover:bg-getmeds-blue-hover shadow-sm transition-colors"
          >
            <UserPlus className="w-4 h-4" />
            Create account
          </button>
        </div>
      </div>

      {/* Sep 26, 2026: two views of the same people. Accounts is the table that
          was here; Team Structure is who leads what, from the sales sheet. */}
      <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5" role="tablist" aria-label="User management views">
        {[['accounts', 'Accounts'], ['structure', 'Team Structure']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`px-3.5 py-1.5 rounded text-sm font-semibold transition-colors ${tab === key ? 'bg-getmeds-blue text-white' : 'text-ink-secondary hover:bg-surface'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'structure' ? <TeamStructurePanel /> : (<>
      {/* Sep 26, 2026: the accounts, by team (where each person sits) or as the
          flat, paged list that was here before. */}
      <div className="inline-flex rounded-md border border-slate-200 bg-white p-0.5" role="group" aria-label="How to show accounts">
        {[['team', 'By team'], ['list', 'All accounts']].map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-pressed={view === key}
            onClick={() => setView(key)}
            className={`px-3 py-1 rounded text-[13px] font-semibold transition-colors ${view === key ? 'bg-slate-900 text-white' : 'text-ink-secondary hover:bg-surface'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Error state */}
      {error && <ErrorMessage message={error} />}

      {/* Loading state */}
      {loading ? (
        <div className="flex justify-center py-20">
          <LoadingSpinner size="lg" />
        </div>
      ) : view === 'team' ? (
        <AccountsByTeam users={users} onOpen={setDetailsUserId} onShowList={() => setView('list')} />
      ) : (
        /* Users Table */
        <div className="bg-white shadow rounded-lg overflow-hidden border border-slate-200">
          <div className="thin-scroll overflow-x-auto">
            <table className="w-full min-w-[820px] divide-y divide-slate-200">
              <thead className="bg-getmeds-blue">
                <tr>
                  <th scope="col" className="px-4 py-3 text-left text-[13px] font-semibold text-white">
                    ID
                  </th>
                  <SortableHeader label="Name" sortKey="name" />
                  <th scope="col" className="px-4 py-3 text-left text-[13px] font-semibold text-white">
                    Username
                  </th>
                  <th scope="col" className="px-4 py-3 text-left text-[13px] font-semibold text-white">
                    Email
                  </th>
                  <SortableHeader label="Role" sortKey="role" />
                  <SortableHeader label="Status" sortKey="status" />
                  <SortableHeader label="Date Modified" sortKey="modified" />
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-100">
                {sortedUsers.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-ink-secondary">
                      No user accounts found in the system.
                    </td>
                  </tr>
                ) : (
                  pagedUsers.map((user) => {
                    const isActive = user.is_active === 1 || user.is_active === true;
                    // Sep 9, 2026: undefined approval_status means an account
                    // that predates the column, which the migration backfilled
                    // as approved — so anything that is not literally
                    // 'pending'/'rejected' is approved.
                    const isPending = user.approval_status === 'pending';
                    const isRejected = user.approval_status === 'rejected';
                    const roleKey = (user.role || user.role_name || '').toLowerCase();
                    const badgeColor = roleBadgeColors[roleKey] || 'bg-slate-100 text-slate-800 border-slate-200';
                    const open = () => setDetailsUserId(user.id);

                    return (
                      // The whole row opens the account (the name is the
                      // keyboard-reachable way in). Everything on it is display
                      // only now: changes are made in the modal.
                      <tr key={user.id} onClick={open} className="cursor-pointer hover:bg-surface transition-colors">
                        <td className="px-4 py-4 whitespace-nowrap text-[13px] font-mono font-medium text-ink-secondary">
                          #{user.id}
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); open(); }}
                            title="Open user details"
                            className="text-[13px] font-semibold text-ink-primary hover:text-getmeds-blue text-left"
                          >
                            {getUserDisplayName(user)}
                          </button>
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap text-[13px] text-ink-secondary font-mono">
                          {getUsername(user)}
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap text-[13px] text-ink-secondary">
                          {user.email}
                        </td>
                        <td className="px-4 py-4 whitespace-nowrap">
                          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold border ${badgeColor}`}>
                            {roleKey === 'admin' && <Shield className="w-3 h-3 mr-1" />}
                            {roleLabel(roleKey)}
                          </span>
                        </td>
                        {/* Sep 24, 2026: the Zoho Salesperson and Team Lead
                            columns are gone from the list. Both are still on
                            the account, in the User Details modal. */}

                        {/* Sep 9, 2026: approval status wins the cell when it
                            is not 'approved'. "Pending" and "Inactive" both
                            mean "cannot log in", but they are different
                            situations with different fixes, and showing only
                            is_active would render a brand-new sign-up as
                            "Active" — which it is, and which is exactly the
                            wrong thing to tell an admin about an account
                            waiting on them. */}
                        <td className="px-4 py-4 whitespace-nowrap">
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
                        {/* Sep 24, 2026: when the account last changed — any
                            edit, role or Salesperson change, approval, or a
                            password change. Accounts that predate the column
                            show the day they were created. Manila time, like
                            the rest of the app. */}
                        <td className="px-4 py-4 whitespace-nowrap text-[13px] text-ink-secondary tabular-nums" title={user.updated_at || ''}>
                          {user.updated_at ? formatPHT(user.updated_at, 'datetime') : '—'}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <PaginationFooter
            pagination={{ page: currentPage, pages: pageCount, total: sortedUsers.length }}
            onPageChange={setPage}
            itemLabel="users"
          />
        </div>
      )}
      </>)}

      {/* The list refreshes as soon as the account exists, behind the modal,
          so the new row is there to open when it closes. */}
      <CreateUserModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={() => fetchUsers({ silent: true })}
      />

      {/* Sep 24, 2026: everything that used to be inline on the row —
          approve/reject, role, Salesperson, Team Lead, deactivate — plus edit
          and delete. `key` gives each account a fresh draft. */}
      {detailsUser && (
        <UserDetailsModal
          key={detailsUser.id}
          user={detailsUser}
          onClose={() => setDetailsUserId(null)}
          onChanged={async (result) => {
            await fetchUsers({ silent: true });
            if (result?.deletedId != null) setDetailsUserId(null);
          }}
          salespersons={salespersons}
          salespersonCounts={salespersonCounts}
          salespersonError={salespersonError}
          teamLeads={teamLeads}
        />
      )}
    </div>
  );
};

export default UsersPage;
