import React from 'react';
import { useAuth } from '../hooks/useAuth';
import { Navigate } from 'react-router-dom';

const DashboardPage = () => {
  const { user } = useAuth();

  if (!user) {
    return <Navigate to="/" replace />;
  }

  const role = (user.role || '').toLowerCase();

  switch (role) {
    case 'medrep':
      return <Navigate to="/medrep/dashboard" replace />;
    case 'finance':
      return <Navigate to="/finance" replace />;
    case 'dispatch':
      return <Navigate to="/dispatch" replace />;
    case 'management':
    case 'admin':
      return <Navigate to="/management" replace />;
    case 'team_lead':
      return <Navigate to="/team-lead" replace />;
    default:
      return <Navigate to="/orders" replace />;
  }
};

export default DashboardPage;
