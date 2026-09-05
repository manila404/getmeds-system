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
import ExceptionHubPage from './pages/management/ExceptionHubPage';
import ClientsPage from './pages/management/ClientsPage';
import UsersPage from './pages/admin/UsersPage';
import InventoryPage from './pages/admin/InventoryPage';
import TestModePage from './pages/TestModePage';

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
          <Route
            path="/orders/new"
            element={
              <ProtectedRoute allowedRoles={['medrep', 'management']}>
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
          <Route
            path="/management/exceptions"
            element={
              <ProtectedRoute allowedRoles={['management', 'admin']}>
                <ExceptionHubPage />
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
