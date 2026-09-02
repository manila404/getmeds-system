import { useQuery } from '@tanstack/react-query';
import { fetchProducts, fetchCustomers } from '../api/queries';

export const useProducts = () => {
  return useQuery({
    queryKey: ['products'],
    queryFn: async () => {
      const res = await fetchProducts();
      return res?.data?.products || res?.products || res || [];
    },
    staleTime: 1000 * 60 * 5, // Cache for 5 minutes
  });
};

// Sep 2, 2026: `includeInactive` is part of the query key, so switching the
// order form's "show inactive" toggle fetches (and caches) the wider list
// separately instead of serving the active-only one from cache.
export const useCustomers = (includeInactive = false) => {
  return useQuery({
    queryKey: ['customers', includeInactive],
    queryFn: async () => {
      const res = await fetchCustomers({ includeInactive });
      const payload = res?.data || res || {};
      // Aug 31, 2026 (7): now also surfaces test_customer_gate_enabled
      // (orders.controller.js's getCustomers) alongside the customer list
      // itself — OrderForm.jsx uses it to detect "is a TEST customer
      // selected?" generically instead of hardcoding one customer's id.
      return {
        customers: payload.customers || res?.customers || (Array.isArray(res) ? res : []),
        testCustomerGateEnabled: !!payload.test_customer_gate_enabled,
        inactiveCount: payload.inactive_count ?? 0,
        includesInactive: !!payload.includes_inactive
      };
    },
    staleTime: 1000 * 60 * 5,
  });
};
