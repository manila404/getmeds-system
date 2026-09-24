import React, { useState } from 'react';
import { NavLink, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useDebug } from '../../context/DebugContext';
import { LayoutDashboard, PlusCircle, ClipboardList, CreditCard, History, Truck, MapPin, AlertTriangle, ClipboardCheck, Users, UserCog, Package, X, FlaskConical, BarChart3, Layers, Zap, PanelLeftClose, PanelLeftOpen, UserCheck, Shield, CloudOff, ChevronDown, ShieldCheck } from 'lucide-react';
import getmedsLogo from '../../assets/GETMEDS PHILIPPINES LOGO.png';
import { FINANCE_STAGES } from '../../constants/financeStages';

const Sidebar = ({ isOpen = false, onClose, isCollapsed = false, onToggleCollapse }) => {
  const { user } = useAuth();
  const { isDebug } = useDebug();
  const location = useLocation();
  const [searchParams] = useSearchParams();

  // Open when you are already looking at the Finance page, so arriving from a
  // stage link does not hide the group that link came from.
  const onFinancePage = location.pathname === '/finance';
  const [financeOpen, setFinanceOpen] = useState(onFinancePage);
  const activeStage = onFinancePage ? searchParams.get('stage') : null;

  // Sep 24, 2026: which nav groups the person has toggled by hand. Anything not
  // in here follows the default (open if it holds the page you're on).
  const [openGroups, setOpenGroups] = useState({});

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
    team_lead: 'Team Lead',
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
        { to: '/finance', icon: <CreditCard size={18} />, label: 'Finance Overview', exact: true },
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
        { to: '/management/clients', icon: <Users size={18} />, label: 'Clients Directory' },
        { to: '/management/order-ownership', icon: <UserCheck size={18} />, label: 'Order Ownership' },
        { to: '/management/manager-scopes', icon: <Shield size={18} />, label: 'Manager Access' },
        { to: '/management/pending-customers', icon: <CloudOff size={18} />, label: 'Pending Customers' }
      ]
    },
    {
      title: 'Team Lead',
      badge: 'Team Lead',
      badgeClass: 'bg-indigo-100/60 text-indigo-700',
      links: [
        // Sep 22, 2026: a team lead can now raise an order too — for
        // themselves or for one of their own team's MedReps, scoped
        // server-side (see orders.controller.js's resolveOrderMedrep /
        // getMedreps). Same route and form as everyone else's.
        { to: '/orders/new', icon: <PlusCircle size={18} />, label: 'Create New Order', primaryAction: true },
        { to: '/team-lead', icon: <BarChart3 size={18} />, label: 'My Team', exact: true }
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
  // Sep 24, 2026: collapsible groups (Management/Admin). Empty for every other
  // role, whose short menus render exactly as before.
  const navGroups = [];

  /**
   * Sep 12, 2026: "Finance Confirmation" — one nav item per stage.
   *
   * The stages were reachable only as cards on the dashboard, which meant
   * knowing to go there first. As nav items they are where someone looks for
   * a place to go, and each is a real URL: bookmarkable, shareable, and
   * restored on a refresh rather than reset.
   *
   * Built from constants/financeStages.js so the sidebar cannot end up
   * offering a stage the dashboard does not have, or vice versa.
   */
  // Mirrors the /finance route guard in App.jsx. Showing the group to someone
  // ProtectedRoute would bounce is worse than not showing it at all.
  const canSeeFinance = ['finance', 'management', 'admin'].includes(role);

  const financeStageLinks = FINANCE_STAGES.map((g) => ({
    to: `/finance?stage=${g.key}`,
    stage: g.key,
    label: g.navLabel,
  }));

  if (role === 'medrep') {
    mainLinks.push(
      { to: '/medrep/dashboard', icon: <LayoutDashboard size={19} />, label: 'Dashboard' },
      { to: '/orders/new', icon: <PlusCircle size={19} />, label: 'Create New Order', primaryAction: true },
      { to: '/orders', icon: <ClipboardList size={19} />, label: 'My Orders' }
    );
  } else if (role === 'team_lead') {
    // Sep 21, 2026: one link — the same dashboard component /management
    // uses, scoped server-side to this account's assigned MedReps instead
    // of a division, and with nothing on it that writes anything. Nothing
    // else this role reaches: no Approval Queue, Exception Hub, Finance,
    // Dispatch, Clients, or Inventory — see App.jsx's route table.
    // Sep 22, 2026: "Create New Order" added — a team lead can now raise
    // one for themselves or for their own team, same form everyone else
    // uses (see OrderForm.jsx's isRepChoosing). Everything else about this
    // role's reach is unchanged.
    mainLinks.push(
      { to: '/orders/new', icon: <PlusCircle size={19} />, label: 'Create New Order', primaryAction: true },
      { to: '/team-lead', icon: <LayoutDashboard size={19} />, label: 'My Team' }
    );
  } else if (role === 'finance') {
    // Sep 12, 2026: /finance is no longer a four-status queue — it is Finance's
    // dashboard over every order, mirroring what the MedRep sees. Named
    // "Dashboard" to match, and listed first for the same reason the MedRep's
    // is. 'All Orders Log' is gone from here: it pointed at MyOrdersPage,
    // which is worded for a MedRep ("orders you have submitted") and listed
    // all 60,958 orders unscoped. /finance answers that need properly now.
    mainLinks.push(
      { to: '/finance', icon: <LayoutDashboard size={19} />, label: 'Dashboard' },
      { to: '/finance/history', icon: <History size={19} />, label: 'Payment History' }
    );
  } else if (role === 'dispatch') {
    mainLinks.push(
      { to: '/dispatch', icon: <Truck size={19} />, label: 'Zoho Dispatch Status' },
      // Sep 15, 2026: the orders this person caters (the page's other tab is
      // the full log that "All Orders Log" used to be).
      { to: '/orders', icon: <ClipboardList size={19} />, label: 'My Catered Orders' },
      { to: '/dispatch/history', icon: <MapPin size={19} />, label: 'Dispatched / Tracking Log' },
      { to: '/inventory', icon: <Package size={19} />, label: 'Inventory & Stock' }
    );
  } else if (role === 'management' || role === 'admin') {
    // Sep 24, 2026: Management and Admin used to get 11-12 flat links plus a
    // "System Records" footer — 13 items in one scroll, none of them telling
    // you what kind of thing it was. They're now four collapsible groups by
    // what the person is doing: running orders, Finance, customers and stock,
    // and administering the system. Same links, same routes, same role rules
    // as before — only where they sit changed. (The 'All Orders Log' that
    // lived under "System Records" now sits with the other order pages.)
    //
    // Create New Order stays outside the groups as the one primary action.
    mainLinks.push(
      // Sep 5, 2026: management can raise an order on a MedRep's behalf (see
      // OrderForm.jsx's medrep picker + orders.controller.js's
      // resolveOrderMedrep). Sep 9, 2026: admin can too — same form, same
      // MedRep / Division / Salesperson controls.
      { to: '/orders/new', icon: <PlusCircle size={19} />, label: 'Create New Order', primaryAction: true }
    );
    navGroups.push(
      {
        key: 'operations',
        title: 'Operations',
        links: [
          { to: '/management', icon: <LayoutDashboard size={19} />, label: 'Global Dashboard' },
          // Sep 7, 2026: MedRep orders wait here for Management approval before
          // they sync to Zoho — see orders.controller.js's submit().
          { to: '/management/approvals', icon: <ClipboardCheck size={19} />, label: 'Approval Queue' },
          { to: '/management/exceptions', icon: <AlertTriangle size={19} />, label: 'Exception Hub' },
          { to: '/orders', icon: <ClipboardList size={19} />, label: 'All Orders Log' }
        ]
      },
      // The existing Finance Confirmation accordion, in its natural place
      // between running orders and managing records.
      { key: 'finance', special: 'finance' },
      {
        key: 'customers',
        title: 'Customers & Stock',
        links: [
          { to: '/management/clients', icon: <Users size={19} />, label: 'Clients Directory' },
          { to: '/management/pending-customers', icon: <CloudOff size={19} />, label: 'Pending Customers' },
          { to: '/inventory', icon: <Package size={19} />, label: 'Inventory & Stock' }
        ]
      },
      {
        key: 'administration',
        title: 'Administration',
        links: [
          // Admin only. (Was sharing the Users icon with Clients Directory.)
          ...(role === 'admin' ? [{ to: '/admin/users', icon: <UserCog size={19} />, label: 'User Management' }] : []),
          { to: '/management/order-ownership', icon: <UserCheck size={19} />, label: 'Order Ownership' },
          { to: '/management/manager-scopes', icon: <Shield size={19} />, label: 'Manager Access' },
          // Sep 9, 2026: the Zoho sync retry outbox — see ZohoSyncHealthPage.jsx.
          ...(role === 'admin' ? [{ to: '/admin/zoho-sync', icon: <Zap size={19} />, label: 'Zoho Sync Health' }] : [])
        ]
      }
    );
  }

  // Is the page you're on inside this link? Exact for the two routes that
  // other links live underneath ('/management' → '/management/approvals'),
  // prefix for the rest.
  const isLinkActive = (l) =>
    l.to === '/management' || l.to === '/orders'
      ? location.pathname === l.to
      : location.pathname.startsWith(l.to);
  // Hand-toggled state wins; otherwise Operations starts open and any other
  // group opens when it holds the page you're on.
  const groupIsOpen = (g) => openGroups[g.key] ?? (g.key === 'operations' || g.links.some(isLinkActive));

  /* Sep 12, 2026: the stages as navigation.
     Collapsed by default unless you are already on the page — six always-open
     items would crowd out everything else in the sidebar for the roles that
     also do other work. */
  const financeBlock =
    financeStageLinks.length > 0 && canSeeFinance ? (
      <div className={hideWhenCollapsed}>
        <button
          type="button"
          onClick={() => setFinanceOpen((v) => !v)}
          aria-expanded={financeOpen}
          className={
            navGroups.length
              ? 'w-full flex items-center px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-ink-secondary hover:text-ink-primary transition-colors'
              : 'w-full flex items-center px-3 py-2.5 rounded-lg text-sm font-medium text-ink-primary hover:bg-surface transition-all'
          }
        >
          {!navGroups.length && <span className="mr-2.5"><ShieldCheck size={19} /></span>}
          <span className="truncate flex-1 text-left">{navGroups.length ? 'Finance' : 'Finance Confirmation'}</span>
          {/* Says there is work behind a group that is shut. */}
          {!financeOpen && activeStage && (
            <span className="mr-1.5 w-1.5 h-1.5 rounded-full bg-getmeds-blue shrink-0" />
          )}
          <ChevronDown
            size={navGroups.length ? 14 : 16}
            className={`shrink-0 transition-transform ${financeOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {financeOpen && (
          <ul className="mt-0.5 space-y-0.5 pl-4">
            {financeStageLinks.map((link) => {
              // NavLink's own isActive ignores the query string, so every stage
              // would light up at once on /finance.
              const isActive = activeStage === link.stage;
              return (
                <li key={link.stage}>
                  <NavLink
                    to={link.to}
                    title={link.label}
                    onClick={handleLinkClick}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-[13px] transition-all border-l-2 ${
                      isActive
                        ? 'bg-getmeds-blue/10 text-ink-primary font-semibold border-getmeds-blue'
                        : 'text-ink-secondary hover:bg-surface hover:text-ink-primary border-transparent'
                    }`}
                  >
                    <span className="truncate">{link.label}</span>
                  </NavLink>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    ) : null;

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
                  {navGroups.length === 0 && (
                    <div className={`px-3 pb-2 text-xs font-medium text-ink-primary ${hideWhenCollapsed}`}>
                      Navigation Menu
                    </div>
                  )}
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

                {/* Sep 24, 2026: Management/Admin's collapsible groups. The
                    Finance accordion (below, unchanged) sits in this run as
                    one of them. */}
                {navGroups.map((g) =>
                  g.special === 'finance' ? (
                    <React.Fragment key="finance">{financeBlock}</React.Fragment>
                  ) : (
                    <div key={g.key}>
                      <button
                        type="button"
                        onClick={() => setOpenGroups((s) => ({ ...s, [g.key]: !groupIsOpen(g) }))}
                        aria-expanded={groupIsOpen(g)}
                        className={`w-full flex items-center px-3 py-1.5 rounded-lg text-[11px] font-bold uppercase tracking-wider text-ink-secondary hover:text-ink-primary transition-colors ${hideWhenCollapsed}`}
                      >
                        <span className="flex-1 text-left">{g.title}</span>
                        {/* A shut group still says the page you're on is inside it. */}
                        {!groupIsOpen(g) && g.links.some(isLinkActive) && (
                          <span className="mr-1.5 w-1.5 h-1.5 rounded-full bg-getmeds-blue shrink-0" />
                        )}
                        <ChevronDown size={14} className={`shrink-0 transition-transform ${groupIsOpen(g) ? 'rotate-180' : ''}`} />
                      </button>
                      {/* In the collapsed desktop rail there are no headers, so
                          the icons show regardless of open/shut. */}
                      <ul className={`mt-0.5 space-y-0.5 ${groupIsOpen(g) ? '' : isCollapsed ? 'hidden lg:block' : 'hidden'}`}>
                        {g.links.map((link) => (
                          <li key={link.to}>
                            <NavLink
                              to={link.to}
                              title={link.label}
                              onClick={handleLinkClick}
                              end={link.to === '/orders' || link.to === '/management'}
                              className={({ isActive }) =>
                                `flex items-center px-3 py-2.5 rounded-lg text-sm font-medium transition-all ${centerWhenCollapsed} ${
                                  isActive
                                    ? 'bg-getmeds-blue/10 text-ink-primary font-medium border-r-4 border-getmeds-blue'
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
                  )
                )}

                {/* Sep 12, 2026: the stages as navigation, for the roles that
                    aren't grouped (Finance). */}
                {navGroups.length === 0 && financeBlock}

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
