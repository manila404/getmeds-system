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

export const useCustomers = () => {
  return useQuery({
    queryKey: ['customers'],
    queryFn: async () => {
      const res = await fetchCustomers();
      const payload = res?.data || res || {};
      // Aug 31, 2026 (7): now also surfaces test_customer_gate_enabled
      // (orders.controller.js's getCustomers) alongside the customer list
      // itself — OrderForm.jsx uses it to detect "is a TEST customer
      // selected?" generically instead of hardcoding one customer's id.
      return {
        customers: payload.customers || res?.customers || (Array.isArray(res) ? res : []),
        testCustomerGateEnabled: !!payload.test_customer_gate_enabled
      };
    },
    staleTime: 1000 * 60 * 5,
  });
};
