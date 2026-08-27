import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';
import { useDebug } from './context/DebugContext';
import Layout from './components/layout/Layout';

// Pages
import LoginPage from './pages/LoginPage';
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
        
        <Route element={<Layout />}>
          <Route path="/test-mode" element={<TestModePage />} />
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
          <Route 
            path="/orders/new" 
            element={
              <ProtectedRoute allowedRoles={['medrep']}>
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
