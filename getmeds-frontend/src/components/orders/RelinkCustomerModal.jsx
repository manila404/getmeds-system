import React, { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X, Search, Loader2, RefreshCw, AlertTriangle } from 'lucide-react';
import client from '../../api/client';

/**
 * Management's fix for "Make sure that you have selected a contact of the
 * correct contact type (customer/vendor)". Oct 2, 2026.
 *
 * Zoho only accepts a Sales Order for a contact typed "customer". The customer
 * sync copies every Zoho contact, vendors included, so a business Zoho also
 * holds as a vendor can end up on an order and be refused. This moves the order
 * to the customer record for the same business and sends it to Zoho again.
 *
 * The backend checks the chosen customer against Zoho before anything changes,
 * so picking another vendor copy is refused with the reason. Nothing is written
 * to Zoho, and neither customer record is edited.
 *
 * Oct 5, 2026: when there is no customer record because the business is new to
 * Zoho as a customer, Management picks "This is a new customer". It is created in
 * Zoho as a customer, this customer record points at it, and the sync is retried.
 */
const RelinkCustomerModal = ({ order, onClose, onDone }) => {
  const [mode, setMode] = useState('existing'); // 'existing' | 'new'
  const [text, setText] = useState('');
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState(null);
  const [note, setNote] = useState('');
  const [contactNo, setContactNo] = useState(order.contact_number || order.intake_contact_no || '');

  // Typing is debounced so each keystroke is not a request.
  useEffect(() => {
    const t = setTimeout(() => setSearch(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const results = useQuery({
    queryKey: ['relink-customer-search', search],
    queryFn: () =>
      client.get('/api/customers', { params: { search, limit: 8, status: 'active' } }).then((r) => r.data?.data?.customers || []),
    enabled: search.length >= 3,
    staleTime: 30_000,
  });

  const candidates = (results.data || []).filter((c) => c.id !== order.customer_id && c.zoho_contact_id);

  const isNew = mode === 'new';
  const targetName = isNew ? order.customer_name : picked?.name;
  const canSubmit = isNew ? contactNo.trim().length > 0 : !!picked;

  const relink = useMutation({
    mutationFn: async () => {
      if (isNew) {
        await client.post(`/api/orders/${order.id}/relink-customer/new`, { contact_number: contactNo.trim(), note: note.trim() || undefined });
      } else {
        await client.post(`/api/orders/${order.id}/relink-customer`, { customer_id: picked.id, note: note.trim() || undefined });
      }
      // The retry rebuilds its payload from the live order, so it uses the new link.
      const retried = await client.post(`/api/orders/${order.id}/retry-zoho-sync`).then((r) => r.data);
      return retried?.data?.result;
    },
    onSuccess: (result) => {
      const done = isNew ? `${targetName} created in Zoho as a customer.` : `Linked to ${targetName}.`;
      if (result?.outcome === 'succeeded') {
        toast.success(`${done} Zoho Sales Order created.`);
      } else {
        toast(`${done} Zoho still said: ${result?.error || 'unknown error'}`, { icon: '⚠️', duration: 9000 });
      }
      onDone();
    },
    onError: (err) => {
      toast.error(err.response?.data?.error?.message || err.message || 'Could not change the customer.', { duration: 9000 });
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg my-12">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-bold text-ink-primary">Fix customer link</h2>
            <p className="text-xs text-ink-secondary mt-0.5">{order.getmeds_order_id}</p>
          </div>
          <button type="button" onClick={onClose} className="text-ink-secondary hover:text-ink-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-[12.5px] text-amber-900 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              This order is linked to <strong>{order.customer_name}</strong>. If Zoho keeps that business as a
              <strong> vendor</strong>, it refuses the Sales Order. Choose the same business’s <strong>customer</strong> record.
              Only the order’s link changes — nothing is edited in Zoho.
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Which fix">
            {[
              ['existing', 'Link to an existing customer', 'Zoho already has this business as a customer'],
              ['new', 'This is a new customer', 'Create it in Zoho as a customer'],
            ].map(([key, label, hint]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={mode === key}
                onClick={() => setMode(key)}
                className={`text-left rounded-lg border px-3 py-2 ${mode === key ? 'border-getmeds-blue bg-blue-50' : 'border-slate-200 hover:bg-surface'}`}
              >
                <span className="block text-[13px] font-semibold text-ink-primary">{label}</span>
                <span className="block text-[11px] text-ink-secondary">{hint}</span>
              </button>
            ))}
          </div>

          {isNew ? (
            <div className="space-y-3">
              <p className="text-[12.5px] text-ink-secondary">
                <strong>{order.customer_name}</strong> will be created in Zoho as a new <strong>customer</strong> with the same name.
                This customer record will use it from now on, so later orders sync too. The vendor in Zoho is not changed.
              </p>
              <div>
                <label className="block text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1" htmlFor="relink-contact">
                  Contact number (Zoho requires one)
                </label>
                <input
                  id="relink-contact"
                  value={contactNo}
                  onChange={(e) => setContactNo(e.target.value)}
                  maxLength={40}
                  className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent"
                />
              </div>
            </div>
          ) : (
          <div>
            <label className="block text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1" htmlFor="relink-search">
              Find the customer
            </label>
            <div className="relative">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                id="relink-search"
                autoFocus
                value={text}
                onChange={(e) => { setText(e.target.value); setPicked(null); }}
                placeholder="Type at least 3 letters of the name"
                className="w-full text-sm border border-slate-300 rounded-md pl-9 pr-3 py-2 focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent"
              />
            </div>

            {search.length >= 3 && (
              <div className="mt-2 border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-56 overflow-y-auto">
                {results.isLoading ? (
                  <p className="px-3 py-3 text-xs text-ink-secondary flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" />Searching…</p>
                ) : candidates.length === 0 ? (
                  <p className="px-3 py-3 text-xs text-ink-secondary">No other customer in Zoho matches “{search}”.</p>
                ) : (
                  candidates.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setPicked(c)}
                      className={`w-full text-left px-3 py-2 text-[13px] hover:bg-surface ${picked?.id === c.id ? 'bg-blue-50' : ''}`}
                    >
                      <span className="font-semibold text-ink-primary">{c.name}</span>
                      <span className="block text-[11px] text-ink-secondary">
                        {c.tin ? `TIN ${c.tin} · ` : ''}Zoho id …{String(c.zoho_contact_id).slice(-6)}
                      </span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
          )}

          {(isNew || picked) && (
            <div>
              <label className="block text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1" htmlFor="relink-note">
                Note (optional)
              </label>
              <input
                id="relink-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={500}
                placeholder={isNew ? 'e.g. New hospital account' : 'e.g. Zoho had the old record as a vendor'}
                className="w-full text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent"
              />
              <p className="mt-2 text-[12px] text-ink-secondary">
                {isNew
                  ? <>The customer will be created in Zoho, then the Zoho Sales Order will be sent straight away.</>
                  : <>The order will move to <strong>{picked.name}</strong>, and the Zoho Sales Order will be sent straight away.</>}
                {' '}The change is recorded in the order’s timeline.
              </p>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-slate-200">
          <button type="button" onClick={onClose} disabled={relink.isPending} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-medium text-ink-secondary hover:bg-surface">
            Cancel
          </button>
          <button
            type="button"
            onClick={() => relink.mutate()}
            disabled={!canSubmit || relink.isPending}
            className="px-4 py-2 rounded-md bg-getmeds-blue text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"
          >
            {relink.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            {relink.isPending ? (isNew ? 'Creating…' : 'Linking…') : (isNew ? 'Create customer and retry Zoho sync' : 'Link and retry Zoho sync')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RelinkCustomerModal;
