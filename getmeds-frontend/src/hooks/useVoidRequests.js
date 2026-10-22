import { useQuery } from '@tanstack/react-query';
import client from '../api/client';

/**
 * Refunds waiting on Dispatch (Oct 22, 2026). One query, shared by the Void requests page, the attention banner on the
 * Dispatch page and the sidebar badge.
 *   requests  Management approved them: Dispatch acts (goods returned, void in Zoho, close the Sales Order)
 *   upcoming  still waiting for Management: a heads-up only
 */
export const useVoidRequests = ({ enabled = true } = {}) =>
  useQuery({
    queryKey: ['void-requests'],
    enabled,
    queryFn: () => client.get('/api/refund-requests/void-requests').then((r) => ({
      requests: r.data?.data?.requests || [],
      upcoming: r.data?.data?.upcoming || []
    })),
    refetchInterval: 60000,
    retry: false
  });

/** How many of them need Dispatch right now (for the sidebar badge). */
export const useVoidRequestsCount = (enabled) => {
  const { data } = useVoidRequests({ enabled });
  return (data?.requests || []).filter((r) => r.stage === 'so' || r.next === 'dispatch_goods' || r.next === 'dispatch_void').length;
};
