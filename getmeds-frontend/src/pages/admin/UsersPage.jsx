import React, { useState, useEffect } from 'react';
import client from '../../api/client';
import LoadingSpinner from '../../components/ui/LoadingSpinner';
import ErrorMessage from '../../components/ui/ErrorMessage';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import { Users, UserX, RefreshCw, Shield, Check } from 'lucide-react';
import toast from 'react-hot-toast';

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

  // Fetch users on component mount
  useEffect(() => {
    fetchUsers();
  }, []);

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

  // Helper to format user display name
  const getUserDisplayName = (user) => {
    if (user.first_name || user.last_name) {
      return `${user.first_name || ''} ${user.last_name || ''}`.trim();
    }
    return user.name || '—';
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
                  <th scope="col" className="px-6 py-3 text-left text-[13px] font-semibold text-white">
                    Name
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-[13px] font-semibold text-white">
                    Username
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-[13px] font-semibold text-white">
                    Email
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-[13px] font-semibold text-white">
                    Role
                  </th>
                  <th scope="col" className="px-6 py-3 text-left text-[13px] font-semibold text-white">
                    Status
                  </th>
                  <th scope="col" className="px-6 py-3 text-center text-[13px] font-semibold text-white">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-slate-100">
                {users.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-ink-secondary">
                      No user accounts found in the system.
                    </td>
                  </tr>
                ) : (
                  users.map((user) => {
                    const isActive = user.is_active === 1 || user.is_active === true;
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
                        <td className="px-6 py-4 whitespace-nowrap">
                          {isActive ? (
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
                          {isActive ? (
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
