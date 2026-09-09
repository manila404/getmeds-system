import React from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useDebug } from '../../context/DebugContext';
import {
  LayoutDashboard,
  PlusCircle,
  ClipboardList,
  CreditCard,
  History,
  Truck,
  MapPin,
  AlertTriangle,
  ClipboardCheck,
  Users,
  Package,
  X,
  FlaskConical,
  BarChart3,
  Layers,
  Zap,
  PanelLeftClose,
  PanelLeftOpen
} from 'lucide-react';
import getmedsLogo from '../../assets/GETMEDS PHILIPPINES LOGO.png';

const Sidebar = ({ isOpen = false, onClose, isCollapsed = false, onToggleCollapse }) => {
  const { user } = useAuth();
  const { isDebug } = useDebug();

  if (!user) return null;

  const role = (user.role || '').toLowerCase();
  const isTestMode = import.meta.env.VITE_TEST_MODE === 'true' || isDebug;

  // Desktop rail helpers - scoped to lg: so the mobile drawer keeps full labels
  const hideWhenCollapsed = isCollapsed ? 'lg:hidden' : '';
  const centerWhenCollapsed = isCollapsed ? 'lg:justify-center lg:px-0' : '';

  const handleLinkClick = () => {
    if (onClose) {
      onClose();
    }
  };

  const roleLabelMap = {
    medrep: 'Medical Representative',
    finance: 'Finance & Payments',
    dispatch: 'Logistics & Dispatch',
    management: 'Operations Management',
    admin: 'System Administrator',
  };

  // Test Mode: Categorized transactions across ALL roles
  const testModeSections = [
    {
      title: 'MedRep Pipeline',
      badge: 'MedRep',
      badgeClass: 'bg-getmeds-blue/15 text-getmeds-blue-dark',
      links: [
        { to: '/medrep/dashboard', icon: <LayoutDashboard size={18} />, label: 'MedRep Overview' },
        { to: '/orders/new', icon: <PlusCircle size={18} />, label: 'Create New Order', primaryAction: true },
        { to: '/orders', icon: <ClipboardList size={18} />, label: 'My Submissions', exact: true }
      ]
    },
    {
      title: 'Finance & Payments',
      badge: 'Finance',
      badgeClass: 'bg-pharmacy-green/15 text-pharmacy-green-dark',
      links: [
        { to: '/finance', icon: <CreditCard size={18} />, label: 'Zoho Finance Status', exact: true },
        { to: '/finance/history', icon: <History size={18} />, label: 'Payment History' }
      ]
    },
    {
      title: 'Logistics & Dispatch',
      badge: 'Dispatch',
      badgeClass: 'bg-indigo-100 text-indigo-800',
      links: [
        { to: '/dispatch', icon: <Truck size={18} />, label: 'Zoho Dispatch Status', exact: true },
        { to: '/dispatch/history', icon: <MapPin size={18} />, label: 'Tracking Log' }
      ]
    },
    {
      title: 'Management Operations',
      badge: 'Management',
      badgeClass: 'bg-purple-100 text-purple-800',
      links: [
        { to: '/management', icon: <BarChart3 size={18} />, label: 'Global Dashboard', exact: true },
        // Sep 5, 2026: management can raise an order on a MedRep's behalf
        // (see OrderForm.jsx's medrep picker) — this was the only role with
        // that ability but no sidebar entry to reach it.
        { to: '/orders/new', icon: <PlusCircle size={18} />, label: 'Create New Order', primaryAction: true },
        // Sep 7, 2026: MedRep orders wait here for Management approval
        // before they sync to Zoho — see orders.controller.js's submit().
        { to: '/management/approvals', icon: <ClipboardCheck size={18} />, label: 'Approval Queue' },
        { to: '/management/exceptions', icon: <AlertTriangle size={18} />, label: 'Exception Hub' },
        { to: '/inventory', icon: <Package size={18} />, label: 'Inventory & Stock Sync' },
        { to: '/management/clients', icon: <Users size={18} />, label: 'Clients Directory' }
      ]
    },
    {
      title: 'System Administration',
      badge: 'Admin',
      badgeClass: 'bg-slate-900 text-white',
      links: [
        // Sep 9, 2026: admin raises orders from the MedRep Pipeline section's
        // "Create New Order" above — it is the same form and the same route,
        // so a second entry here would be two links to one page.
        { to: '/admin/users', icon: <Users size={18} />, label: 'User Management' },
        // Sep 9, 2026: the Zoho sync retry outbox — was API-only until now,
        // see ZohoSyncHealthPage.jsx.
        { to: '/admin/zoho-sync', icon: <Zap size={18} />, label: 'Zoho Sync Health' },
        { to: '/test-mode', icon: <FlaskConical size={18} />, label: 'Test Mode Hub' }
      ]
    }
  ];

  // Standard Mode: Single-role restricted links
  const mainLinks = [];
  const secondaryLinks = [];

  if (role === 'medrep') {
    mainLinks.push(
      { to: '/medrep/dashboard', icon: <LayoutDashboard size={19} />, label: 'Dashboard' },
      { to: '/orders/new', icon: <PlusCircle size={19} />, label: 'Create New Order', primaryAction: true },
      { to: '/orders', icon: <ClipboardList size={19} />, label: 'My Orders' }
    );
  } else if (role === 'finance') {
    mainLinks.push(
      { to: '/finance', icon: <CreditCard size={19} />, label: 'Zoho Finance Status' },
      { to: '/finance/history', icon: <History size={19} />, label: 'Payment History' }
    );
    secondaryLinks.push(
      { to: '/orders', icon: <ClipboardList size={19} />, label: 'All Orders Log' }
    );
  } else if (role === 'dispatch') {
    mainLinks.push(
      { to: '/dispatch', icon: <Truck size={19} />, label: 'Zoho Dispatch Status' },
      { to: '/dispatch/history', icon: <MapPin size={19} />, label: 'Dispatched / Tracking Log' },
      { to: '/inventory', icon: <Package size={19} />, label: 'Inventory & Stock' }
    );
    secondaryLinks.push(
      { to: '/orders', icon: <ClipboardList size={19} />, label: 'All Orders Log' }
    );
  } else if (role === 'management') {
    mainLinks.push(
      { to: '/management', icon: <LayoutDashboard size={19} />, label: 'Global Dashboard' },
      // Sep 5, 2026: management can raise an order on a MedRep's behalf (see
      // OrderForm.jsx's medrep picker + orders.controller.js's
      // resolveOrderMedrep) — that was built without a way to reach it from
      // here, so management had the access but no link to it.
      { to: '/orders/new', icon: <PlusCircle size={19} />, label: 'Create New Order', primaryAction: true },
      // Sep 7, 2026: MedRep orders wait here for Management approval before
      // they sync to Zoho — see orders.controller.js's submit().
      { to: '/management/approvals', icon: <ClipboardCheck size={19} />, label: 'Approval Queue' },
      { to: '/management/exceptions', icon: <AlertTriangle size={19} />, label: 'Exception Hub' },
      { to: '/inventory', icon: <Package size={19} />, label: 'Inventory & Stock' },
      { to: '/management/clients', icon: <Users size={19} />, label: 'Clients Directory' }
    );
    secondaryLinks.push(
      { to: '/orders', icon: <ClipboardList size={19} />, label: 'All Orders Log' }
    );
  } else if (role === 'admin') {
    mainLinks.push(
      { to: '/management', icon: <LayoutDashboard size={19} />, label: 'Global Dashboard' },
      // Sep 9, 2026: admin can raise an order too, on the same form and with
      // the same MedRep / Division / Salesperson controls management has —
      // see orders.controller.js's resolveOrderMedrep.
      { to: '/orders/new', icon: <PlusCircle size={19} />, label: 'Create New Order', primaryAction: true },
      { to: '/management/approvals', icon: <ClipboardCheck size={19} />, label: 'Approval Queue' },
      { to: '/management/exceptions', icon: <AlertTriangle size={19} />, label: 'Exception Hub' },
      { to: '/inventory', icon: <Package size={19} />, label: 'Inventory & Stock' },
      { to: '/management/clients', icon: <Users size={19} />, label: 'Clients Directory' },
      { to: '/admin/users', icon: <Users size={19} />, label: 'User Management' },
      // Sep 9, 2026: the Zoho sync retry outbox — was API-only until now,
      // see ZohoSyncHealthPage.jsx.
      { to: '/admin/zoho-sync', icon: <Zap size={19} />, label: 'Zoho Sync Health' }
    );
    secondaryLinks.push(
      { to: '/orders', icon: <ClipboardList size={19} />, label: 'All Orders Log' }
    );
  }

  return (
    <>
      {/* Mobile / Tablet Backdrop Overlay */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 bg-slate-900/50 backdrop-blur-xs z-40 lg:hidden transition-opacity duration-300"
          aria-hidden="true"
        />
      )}

      {/* Sidebar Container: Fixed on Desktop, Slide-Over Drawer on Mobile */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 bg-white border-r border-slate-200 h-full flex flex-col justify-between flex-shrink-0 select-none transform transition-all duration-300 ease-in-out lg:static lg:translate-x-0 ${isCollapsed ? 'lg:w-20' : 'lg:w-64'} ${
          isOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full lg:shadow-none'
        }`}
      >
        <div className="flex flex-col h-full overflow-hidden">
          {/* Brand Logo Header */}
          <div className={`h-16 flex items-center justify-between px-6 border-b border-slate-100 bg-white flex-shrink-0 ${centerWhenCollapsed}`}>
            <div className="flex items-center min-w-0">
              <img
                src={getmedsLogo}
                alt="GetMeds Philippines - Your Compassionate Health Ally"
                className={`w-auto object-contain object-left transition-all duration-300 ${isCollapsed ? 'lg:h-7 h-12' : 'h-12'}`}
              />
            </div>

            {/* Mobile Close Button */}
            <button
              onClick={onClose}
              className="lg:hidden p-1.5 rounded-md text-ink-secondary hover:text-ink-primary hover:bg-slate-100 transition-colors"
              title="Close Navigation"
            >
              <X size={20} />
            </button>
          </div>

          {/* Active Workspace Header */}
          <div className={`px-4 py-2.5 bg-white border-b border-slate-100 flex-shrink-0 flex items-center justify-between gap-2 ${isCollapsed ? 'lg:px-2 lg:justify-center' : ''}`}>
            <span className={`text-[11px] font-semibold text-ink-primary flex items-center gap-1.5 ${hideWhenCollapsed}`}>
              <Layers size={13} className="text-ink-primary" />
              Active Workspace
            </span>

            {/* Collapse / Expand Rail (desktop only) */}
            <button
              type="button"
              onClick={onToggleCollapse}
              className="hidden lg:inline-flex p-1 rounded-md text-ink-secondary hover:text-ink-primary hover:bg-slate-100 transition-colors flex-shrink-0"
              aria-label={isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!isCollapsed}
              title={isCollapsed ? 'Expand Sidebar' : 'Collapse Sidebar'}
            >
              {isCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
            </button>
          </div>

          {/* Navigation Menu */}
          <nav className="sidebar-scroll flex-1 overflow-y-auto py-3 px-3 space-y-5">
            {isTestMode ? (
              /* TEST MODE: Categorized navigation for ALL users' transactions */
              testModeSections.map((section, idx) => (
                <div key={idx} className="space-y-1">
                  <div className={`px-2 pb-1.5 flex items-center justify-between ${hideWhenCollapsed}`}>
                    <span className="text-xs font-medium text-ink-primary">
                      {section.title}
                    </span>
                    <span className={`text-[9px] font-bold px-1.5 py-0.2 rounded border ${section.badgeClass}`}>
                      {section.badge}
                    </span>
                  </div>
                  <ul className="space-y-0.5">
                    {section.links.map((link) => (
                      <li key={link.to + link.label}>
                        <NavLink
                          to={link.to}
                          title={link.label}
                          onClick={handleLinkClick}
                          end={link.exact}
                          className={({ isActive }) =>
                            `flex items-center px-2.5 py-2 rounded-lg text-[13px] font-medium transition-all ${centerWhenCollapsed} ${
                              isActive
                                ? 'bg-getmeds-blue/10 text-ink-primary font-medium border-r-3 border-getmeds-blue'
                                : link.primaryAction
                                ? 'text-ink-primary bg-getmeds-blue/5 hover:bg-getmeds-blue/10 font-medium'
                                : 'text-ink-primary hover:bg-surface'
                            }`
                          }
                        >
                          <span className={`mr-2.5 ${isCollapsed ? 'lg:mr-0' : ''}`}>
                            {link.icon}
                          </span>
                          <span className={`truncate ${hideWhenCollapsed}`}>{link.label}</span>
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            ) : (
              /* STANDARD MODE: Role-restricted links */
              <>
                <div>
                  <div className={`px-3 pb-2 text-xs font-medium text-ink-primary ${hideWhenCollapsed}`}>
                    Navigation Menu
                  </div>
                  <ul className="space-y-1">
                    {mainLinks.map((link) => (
                      <li key={link.to}>
                        <NavLink
                          to={link.to}
                          title={link.label}
                          onClick={handleLinkClick}
                          end={link.to === '/orders' || link.to === '/finance' || link.to === '/dispatch' || link.to === '/management'}
                          className={({ isActive }) =>
                            `flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${centerWhenCollapsed} ${
                              isActive
                                ? 'bg-getmeds-blue/10 text-ink-primary font-medium border-r-4 border-getmeds-blue'
                                : link.primaryAction
                                ? 'text-ink-primary bg-getmeds-blue/5 hover:bg-getmeds-blue/10 font-medium'
                                : 'text-ink-primary hover:bg-surface'
                            }`
                          }
                        >
                          <span className={`mr-3 ${isCollapsed ? 'lg:mr-0' : ''}`}>{link.icon}</span>
                          <span className={`truncate ${hideWhenCollapsed}`}>{link.label}</span>
                        </NavLink>
                      </li>
                    ))}
                  </ul>
                </div>

                {secondaryLinks.length > 0 && (
                  <div className="pt-2 border-t border-slate-100">
                    <div className={`px-3 pb-2 text-xs font-medium text-ink-primary ${hideWhenCollapsed}`}>
                      System Records
                    </div>
                    <ul className="space-y-1">
                      {secondaryLinks.map((link) => (
                        <li key={link.to}>
                          <NavLink
                            to={link.to}
                            title={link.label}
                            onClick={handleLinkClick}
                            className={({ isActive }) =>
                              `flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${centerWhenCollapsed} ${
                                isActive
                                  ? 'bg-getmeds-blue/10 text-ink-primary font-medium'
                                  : 'text-ink-primary hover:bg-surface'
                              }`
                            }
                          >
                            <span className={`mr-3 ${isCollapsed ? 'lg:mr-0' : ''}`}>{link.icon}</span>
                            <span className={`truncate ${hideWhenCollapsed}`}>{link.label}</span>
                          </NavLink>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </nav>

          {/* User Role Footer Card */}
          <div className="p-3 border-t border-slate-100 bg-surface/50 flex-shrink-0">
            <div className={`py-2 bg-white rounded-lg border border-slate-200 text-xs ${isCollapsed ? 'lg:px-0 lg:text-center px-3' : 'px-3'}`}>
              <div className={`flex items-center justify-between ${centerWhenCollapsed}`}>
                <p className={`font-semibold text-ink-primary truncate ${hideWhenCollapsed}`}>{user.name}</p>
                <p className={`font-semibold text-ink-primary ${isCollapsed ? 'hidden lg:block' : 'hidden'}`}>{(user.name || '?').charAt(0)}</p>
                {isDebug && (
                  <span className={`text-[9px] font-bold text-amber-700 bg-amber-50 px-1 py-0.2 rounded border border-amber-200 ${hideWhenCollapsed}`}>
                    TEST
                  </span>
                )}
              </div>
              <p className={`text-[11px] text-ink-primary truncate ${hideWhenCollapsed}`}>{roleLabelMap[role] || role}</p>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
};

export default Sidebar;
