import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useDebug } from './context/DebugContext';
import Layout from './components/layout/Layout';

// Pages
import LoginPage from './pages/LoginPage';
import SignupPage from './pages/SignupPage';
import DashboardPage from './pages/DashboardPage';
import MedrepDashboardPage from './pages/medrep/MedrepDashboardPage';
import NewOrderPage from './pages/medrep/NewOrderPage';
import MyOrdersPage from './pages/medrep/MyOrdersPage';
import OrderDetailPage from './pages/OrderDetailPage';
import FinanceQueuePage from './pages/finance/FinanceQueuePage';
import PaymentHistoryPage from './pages/finance/PaymentHistoryPage';
import DispatchQueuePage from './pages/dispatch/DispatchQueuePage';
import DispatchHistoryPage from './pages/dispatch/DispatchHistoryPage';
import ManagementDashboardPage from './pages/management/ManagementDashboardPage';
import ApprovalQueuePage from './pages/management/ApprovalQueuePage';
import ExceptionHubPage from './pages/management/ExceptionHubPage';
import ClientsPage from './pages/management/ClientsPage';
import SalespersonMappingPage from './pages/management/SalespersonMappingPage';
import UsersPage from './pages/admin/UsersPage';
import ZohoSyncHealthPage from './pages/admin/ZohoSyncHealthPage';
import InventoryPage from './pages/admin/InventoryPage';
import TestModePage from './pages/TestModePage';
import ProfilePage from './pages/ProfilePage';

const ProtectedRoute = ({ children, allowedRoles }) => {
  const { user } = useAuth();
  const { isDebug } = useDebug();
  
  if (!user) {
    return <Navigate to="/" replace />;
  }
  
  const role = (user.role || '').toLowerCase();
  const isTestMode = import.meta.env.VITE_TEST_MODE === 'true' || isDebug;

  // In Test Mode, allow simultaneous access to all views and transaction pages
  if (isTestMode) {
    return children;
  }
  
  const normalizedAllowedRoles = allowedRoles ? allowedRoles.map(r => r.toLowerCase()) : [];

  if (allowedRoles && !normalizedAllowedRoles.includes(role)) {
    return <Navigate to="/dashboard" replace />;
  }
  
  return children;
};

function App() {
  const { user } = useAuth();

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={user ? <Navigate to="/dashboard" replace /> : <LoginPage />} />

        {/* Sep 2, 2026: public self-service sign-up. Outside <Layout /> and
            outside ProtectedRoute for the same reason as the login page —
            there is no session yet. Signing up creates a MedRep and logs the
            user straight in, so an already-signed-in visitor is bounced to
            the dashboard rather than shown the form again. */}
        <Route path="/signup" element={user ? <Navigate to="/dashboard" replace /> : <SignupPage />} />

        <Route element={<Layout />}>
          {/* Sep 2, 2026: was reachable by URL to anyone, signed in or not.
              Not exploitable — the backend refuses /api/test/* whenever
              NODE_ENV=production — but an anonymous visitor could still load
              the page and read what it describes. ProtectedRoute with no
              allowedRoles requires a session and nothing more, deliberately:
              restricting it by role would lock out the MedReps who run the
              gated test flow, which is what the page is for. */}
          <Route
            path="/test-mode"
            element={
              <ProtectedRoute>
                <TestModePage />
              </ProtectedRoute>
            }
          />
          <Route path="/dashboard" element={<DashboardPage />} />

          {/* Sep 5, 2026: Profile Settings — every signed-in role edits
              their own account here, so no allowedRoles restriction: the
              only requirement is a session, same as /test-mode above. */}
          <Route
            path="/profile"
            element={
              <ProtectedRoute>
                <ProfilePage />
              </ProtectedRoute>
            }
          />

          {/* MedRep Routes */}
          <Route 
            path="/medrep/dashboard" 
            element={
              <ProtectedRoute allowedRoles={['medrep']}>
                <MedrepDashboardPage />
              </ProtectedRoute>
            } 
          />
          {/* Sep 5, 2026: management can create a real order for a
              registered MedRep (pilot use) — see orders.controller.js's
              resolveOrderMedrep. Without 'management' here, ProtectedRoute
              silently bounced them to /dashboard and the form never
              rendered, even though the backend was already wired for it. */}
          {/* Sep 9, 2026: 'admin' added — see orders.routes.js. This route
              guard is the one that decides whether the page renders at all, so
              opening the backend without it would have looked, from the
              browser, exactly like nothing had changed. */}
          <Route
            path="/orders/new"
            element={
              <ProtectedRoute allowedRoles={['medrep', 'management', 'admin']}>
                <NewOrderPage />
              </ProtectedRoute>
            }
          />
          <Route path="/orders" element={<MyOrdersPage />} />
          <Route path="/orders/:id" element={<OrderDetailPage />} />
          
          {/* Finance Routes */}
          <Route 
            path="/finance" 
            element={
              <ProtectedRoute allowedRoles={['finance', 'management', 'admin']}>
                <FinanceQueuePage />
              </ProtectedRoute>
            } 
          />
          <Route
            path="/finance/history"
            element={
              <ProtectedRoute allowedRoles={['finance', 'management', 'admin']}>
                <PaymentHistoryPage />
              </ProtectedRoute>
            }
          />
          {/* Dispatch Routes */}
          <Route 
            path="/dispatch" 
            element={
              <ProtectedRoute allowedRoles={['dispatch', 'management', 'admin']}>
                <DispatchQueuePage />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/dispatch/history" 
            element={
              <ProtectedRoute allowedRoles={['dispatch', 'management', 'admin']}>
                <DispatchHistoryPage />
              </ProtectedRoute>
            } 
          />
          
          {/* Management Routes */}
          <Route 
            path="/management" 
            element={
              <ProtectedRoute allowedRoles={['management', 'admin']}>
                <ManagementDashboardPage />
              </ProtectedRoute>
            } 
          />
          {/* Sep 7, 2026: MedRep-submitted orders wait here for Management
              to approve/reject before syncing to Zoho — see
              orders.controller.js's submit()/approve()/reject(). */}
          <Route
            path="/management/approvals"
            element={
              <ProtectedRoute allowedRoles={['management', 'admin']}>
                <ApprovalQueuePage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/management/exceptions"
            element={
              <ProtectedRoute allowedRoles={['management', 'admin']}>
                <ExceptionHubPage />
              </ProtectedRoute>
            }
          />
          {/* Sep 10, 2026: who owns the Sales Orders imported from Zoho.
              Management AND admin — the sales leads are the ones who know
              which rep is which, so this is deliberately not admin-only. */}
          <Route
            path="/management/order-ownership"
            element={
              <ProtectedRoute allowedRoles={['management', 'admin']}>
                <SalespersonMappingPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/management/clients"
            element={
              <ProtectedRoute allowedRoles={['management', 'admin']}>
                <ClientsPage />
              </ProtectedRoute>
            }
          />

          {/* Admin Routes */}
          <Route
            path="/admin/users"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <UsersPage />
              </ProtectedRoute>
            }
          />
          {/* Sep 9, 2026: surfaces the Zoho sync retry outbox that
              admin.controller.js's getZohoQueue/retryZohoQueue already
              exposed but nothing in the app ever showed — see
              ZohoSyncHealthPage.jsx. Admin-only, matching admin.routes.js's
              isAdmin gate on the underlying API. */}
          <Route
            path="/admin/zoho-sync"
            element={
              <ProtectedRoute allowedRoles={['admin']}>
                <ZohoSyncHealthPage />
              </ProtectedRoute>
            }
          />
          <Route
            path="/inventory"
            element={
              <ProtectedRoute allowedRoles={['admin', 'management', 'dispatch']}>
                <InventoryPage />
              </ProtectedRoute>
            } 
          />
          <Route 
            path="/admin/inventory" 
            element={
              <ProtectedRoute allowedRoles={['admin', 'management', 'dispatch']}>
                <InventoryPage />
              </ProtectedRoute>
            } 
          />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
