import React, { useState, useRef, useEffect } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useNotifications } from '../../hooks/useNotifications';
import NotificationBell from '../ui/NotificationBell';
import ConfirmDialog from '../ui/ConfirmDialog';
import { 
  LogOut, 
  User, 
  CheckCheck, 
  Package, 
  Clock, 
  AlertTriangle, 
  Menu,
  Search
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { formatPHT } from '../../utils/dateUtils';

const roleBadgeStyles = {
  medrep: 'bg-getmeds-blue/10 text-getmeds-blue-dark border-getmeds-blue/30',
  finance: 'bg-pharmacy-green/15 text-pharmacy-green-dark border-pharmacy-green/30',
  dispatch: 'bg-indigo-50 text-indigo-800 border-indigo-200',
  management: 'bg-purple-50 text-purple-800 border-purple-200',
  admin: 'bg-slate-900 text-white border-slate-900',
};

const Topbar = ({ onToggleSidebar }) => {
  const { user, logout } = useAuth();
  const { notifications, unreadCount, markAsRead, markAllAsRead } = useNotifications();
  const [isLogoutDialogOpen, setIsLogoutDialogOpen] = useState(false);
  const [isNotificationsOpen, setIsNotificationsOpen] = useState(false);
  const dropdownRef = useRef(null);
  const navigate = useNavigate();

  // Close notification popover on outside click
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setIsNotificationsOpen(false);
      }
    };
    if (isNotificationsOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isNotificationsOpen]);

  const handleNotificationClick = (n) => {
    if (!n.is_read) {
      markAsRead(n.id);
    }
    setIsNotificationsOpen(false);
    if (n.order_id) {
      navigate(`/orders/${n.order_id}`);
    }
  };

  const formatTimestamp = (dateStr) => {
    return formatPHT(dateStr, 'timeline');
  };

  const roleKey = (user?.role || '').toLowerCase();
  const roleBadgeStyle = roleBadgeStyles[roleKey] || 'bg-slate-100 text-slate-800 border-slate-200';
  const hasExceptionAlert = notifications?.some(n => !n.is_read && (n.message?.toLowerCase().includes('exception') || n.message?.toLowerCase().includes('hold')));

  return (
    <header className="relative h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 sm:px-6 shadow-2xs z-20 flex-shrink-0">
      {/* Left Area: Mobile Hamburger Button */}
      <div className="flex items-center space-x-2 sm:space-x-3">
        {/* Hamburger Menu Button (visible on mobile / tablet < lg) */}
        <button
          type="button"
          onClick={onToggleSidebar}
          className="lg:hidden p-2 rounded-lg text-ink-secondary hover:text-ink-primary hover:bg-surface focus:outline-none focus:ring-2 focus:ring-getmeds-blue transition-colors"
          aria-label="Open sidebar navigation"
          title="Toggle Navigation Menu"
        >
          <Menu size={22} />
        </button>

      </div>

      {/* Right Area: Notification Bell & User Identity */}
      <div className="flex items-center space-x-2 sm:space-x-4">
        {/* Global Search */}
        <div className="relative hidden md:block">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none"
          />
          <input
            type="search"
            placeholder="Search orders, clients, products..."
            aria-label="Search"
            className="w-48 lg:w-72 pl-9 pr-4 py-2 rounded-full border border-slate-100 bg-slate-50 text-xs text-ink-primary placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-getmeds-blue/40 focus:border-getmeds-blue/40 focus:bg-white transition-colors"
          />
        </div>

        {/* Notification Bell & Dropdown */}
        <div ref={dropdownRef}>
          <NotificationBell
            count={unreadCount}
            hasException={hasExceptionAlert}
            onClick={() => setIsNotificationsOpen(!isNotificationsOpen)}
          />

          {isNotificationsOpen && (
            <div className="absolute top-full right-4 sm:right-6 w-72 sm:w-96 bg-white rounded-b-xl shadow-xl border border-t-0 border-slate-200 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
              <div className="px-4 py-2.5 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-ink-primary">Alerts & Notifications</h4>
                  {unreadCount > 0 && (
                    <span className="bg-getmeds-blue/15 text-getmeds-blue-dark text-xs px-2 py-0.5 rounded-full font-semibold">
                      {unreadCount} new
                    </span>
                  )}
                </div>
                {unreadCount > 0 && (
                  <button
                    onClick={() => markAllAsRead()}
                    className="text-xs text-getmeds-blue hover:text-getmeds-blue-dark flex items-center gap-1 font-medium"
                  >
                    <CheckCheck size={14} /> Mark all
                  </button>
                )}
              </div>

              <div className="max-h-80 overflow-y-auto divide-y divide-slate-100">
                {notifications && notifications.length > 0 ? (
                  notifications.map((n) => {
                    const isException = n.message?.toLowerCase().includes('exception') || n.message?.toLowerCase().includes('hold');
                    return (
                      <div
                        key={n.id}
                        onClick={() => handleNotificationClick(n)}
                        className={`p-3 hover:bg-surface cursor-pointer transition-colors flex items-start gap-3 ${
                          !n.is_read ? (isException ? 'bg-state-error-light/50' : 'bg-getmeds-blue/5') : ''
                        }`}
                      >
                        <div className={`mt-0.5 p-1.5 rounded-full ${
                          !n.is_read 
                            ? (isException ? 'bg-state-error-light text-state-error' : 'bg-getmeds-blue/15 text-getmeds-blue')
                            : 'bg-slate-100 text-ink-secondary'
                        }`}>
                          {isException ? <AlertTriangle size={14} /> : <Package size={14} />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-xs ${!n.is_read ? 'font-semibold text-ink-primary' : 'text-ink-secondary'} leading-snug`}>
                            {n.message}
                          </p>
                          <div className="flex items-center gap-1 mt-1 text-[11px] text-ink-secondary/70">
                            <Clock size={11} />
                            <span>{formatTimestamp(n.sent_at)}</span>
                          </div>
                        </div>
                        {!n.is_read && (
                          <div className={`w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ${isException ? 'bg-state-error' : 'bg-getmeds-blue'}`} />
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="py-8 text-center text-xs text-ink-secondary">
                    No active notifications or alerts
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        
        {/* User Identity Display */}
        <div className="flex items-center space-x-2 sm:space-x-3 border-l pl-3 sm:pl-4 border-slate-200">
          <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-getmeds-blue/15 border border-getmeds-blue/30 flex items-center justify-center text-getmeds-blue flex-shrink-0">
            <User size={16} />
          </div>
          <div className="flex flex-col">
            <span className="text-xs sm:text-sm font-medium text-ink-primary leading-tight truncate max-w-[100px] sm:max-w-[160px]">
              {user?.name}
            </span>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className={`inline-flex items-center px-1.5 sm:px-2 py-0.5 rounded text-[9px] sm:text-[10px] font-bold uppercase tracking-wider border ${roleBadgeStyle}`}>
                {user?.role}
              </span>
            </div>
          </div>

          <button 
            onClick={() => setIsLogoutDialogOpen(true)}
            className="p-1.5 sm:p-2 text-ink-secondary hover:text-state-error rounded-full hover:bg-slate-100 transition-colors"
            title="Sign Out"
          >
            <LogOut size={16} />
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={isLogoutDialogOpen}
        onClose={() => setIsLogoutDialogOpen(false)}
        onConfirm={logout}
        title="Sign Out Confirmation"
        message="Are you sure you want to sign out of the Getmeds system?"
        confirmText="Sign Out"
        cancelText="Cancel"
        variant="danger"
      />
    </header>
  );
};

export default Topbar;
