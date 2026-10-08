import { useQuery } from '@tanstack/react-query';
import client from '../api/client';

/**
 * Is the KPI page switched on for this person? Oct 5, 2026 (Aaron sheet 13.1.2).
 *
 * The backend answers 404 on every /api/kpi route while GETMEDS_KPI_PAGE is off, and 403
 * to anyone who may not see KPIs, so either answer simply means "nothing to show". Asked
 * once per session and only for roles that could ever see KPIs — keep this list in step
 * with services/kpiPermissions.js.
 *
 * Oct 6, 2026: MedReps and team leads too (My Own KPI / My Team KPI, sheet 12.13).
 * canViewAll = the Admin Sales KPIs page; canViewOwn = the KPI panel on their own dashboard.
 */
const KPI_ROLES = ['admin', 'medrep', 'team_lead'];

// Oct 8, 2026: the answer is remembered PER PERSON (userId in the key). It used to be one answer
// per browser session, so logging out as Admin and in as a Team Lead kept Admin's answer
// ("no personal KPIs") and the My KPIs panel never appeared.
export function useKpiStatus(role, userId) {
  const { data } = useQuery({
    queryKey: ['kpi-status', userId || null],
    queryFn: () => client.get('/api/kpi/status').then((r) => r.data?.data),
    enabled: KPI_ROLES.includes(String(role || '').toLowerCase()),
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false
  });
  return {
    enabled: !!data?.enabled,
    canViewAll: !!data?.canViewAll,
    canViewOwn: !!data?.canViewOwn,
    canSetTargets: !!data?.canSetTargets
  };
}
