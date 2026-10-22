import { useQuery } from '@tanstack/react-query';
import client from '../api/client';

/**
 * Refunds waiting on Dispatch (Oct 22, 2026; reworked Oct 23, 2026: no void). One query, shared by the Return checks page,
 * the attention banner on the Dispatch page and the sidebar badge.
 *   requests  Management approved them, the goods are coming back: Dispatch checks the items when they arrive
 *   upcoming  still waiting for Management: a heads-up only
 */
export const RETURN_CHECKS_KEY = ['return-checks'];

export const useReturnChecks = ({ enabled = true } = {}) =>
  useQuery({
    queryKey: RETURN_CHECKS_KEY,
    enabled,
    queryFn: () => client.get('/api/refund-requests/return-checks').then((r) => ({
      requests: r.data?.data?.requests || [],
      upcoming: r.data?.data?.upcoming || []
    })),
    refetchInterval: 60000,
    retry: false
  });

/** How many of them need Dispatch right now (for the sidebar badge). */
export const useReturnChecksCount = (enabled) => {
  const { data } = useReturnChecks({ enabled });
  return (data?.requests || []).length;
};
