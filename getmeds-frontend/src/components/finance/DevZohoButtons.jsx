import React from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import client from '../../api/client';

/**
 * LOCALHOST ONLY (shown only in `npm run dev`, and the server route exists only against the mock Zoho).
 * The refund walkthrough needs "record the customer's payment in Zoho" and "create the credit note in Zoho" to
 * happen somewhere; against the mock Zoho these buttons are that. They change what the MOCK says for a sample
 * order (sales order id ZSO-DEV-*) and nothing else.
 */
const DevZohoButtons = ({ soId, actions, amount }) => {
  const set = useMutation({
    mutationFn: ({ path, body }) => client.post(`/api/dev-zoho/${path}`, { so_id: soId, ...body }).then((r) => r.data),
    onSuccess: (res) => {
      const d = res?.data;
      toast.success(d?.credit_note ? `Mock Zoho: credit note ${d.credit_note.creditnote_number} for ${d.credit_note.total}` : `Mock Zoho: invoice is now ${d?.invoice?.status}, balance ${d?.invoice?.balance}`);
    },
    onError: (err) => toast.error(err?.response?.data?.error?.message || 'Mock Zoho refused that (only sample orders)')
  });
  if (!import.meta.env.DEV || !String(soId || '').startsWith('ZSO-DEV-')) return null;
  const ALL = {
    unpay: ['Zoho has no payment yet', { path: 'invoice', body: { status: 'sent', balance: 3589 } }],
    pay: ['Record the payment in Zoho', { path: 'invoice', body: { status: 'paid', balance: 0 } }],
    credit: ['Create the credit note in Zoho', { path: 'credit-note', body: { total: amount } }],
    wrongcredit: ['Create a wrong-size credit note', { path: 'credit-note', body: { total: 1 } }]
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-md border border-dashed border-violet-300 bg-violet-50 px-2 py-1.5 text-[11px] text-violet-900">
      <span className="font-semibold">Localhost only · pretend to be Zoho:</span>
      {actions.map((k) => (
        <button key={k} type="button" disabled={set.isPending} onClick={() => set.mutate(ALL[k][1])}
          className="rounded border border-violet-300 bg-white px-2 py-0.5 font-semibold hover:bg-violet-100">{ALL[k][0]}</button>
      ))}
    </div>
  );
};

export default DevZohoButtons;
