import { useQuery } from '@tanstack/react-query';
import client from '../api/client';

/**
 * Is the KPI page switched on for this person? Oct 5, 2026 (Aaron sheet 13.1.2).
 *
 * The backend answers 404 on every /api/kpi route while GETMEDS_KPI_PAGE is off, and 403
 * to anyone who may not see KPIs, so either answer simply means "no menu item". Asked once
 * per session and only for roles that could ever see the page (Admin for now — keep this
 * list in step with services/kpiPermissions.js).
 */
const KPI_ROLES = ['admin'];

export function useKpiStatus(role) {
  const { data } = useQuery({
    queryKey: ['kpi-status'],
    queryFn: () => client.get('/api/kpi/status').then((r) => r.data?.data),
    enabled: KPI_ROLES.includes(String(role || '').toLowerCase()),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false
  });
  return { enabled: !!data?.enabled, canSetTargets: !!data?.canSetTargets };
}
