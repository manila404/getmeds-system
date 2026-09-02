import React, { useState, useRef, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Search, X, Building2, User, Loader2 } from 'lucide-react';
import { fetchCustomers } from '../../api/queries';

/**
 * CustomerAutocomplete Component
 *
 * Aug 27, 2026: replaces the old plain <select> customer dropdown. As the
 * MedRep types, matching registered customers are suggested live (by name,
 * contact person, or contact number) instead of scrolling a long list.
 *
 * This still only ever selects an EXISTING registered customer — typing a
 * name that matches nobody shows "no match" rather than letting the order
 * proceed with a made-up customer. That's a hard requirement, not a UI
 * choice: every order needs a real customer_id, and a credit-terms Sales
 * Order additionally needs that customer already linked to a Zoho contact
 * (see LiveZohoAdapter.createSalesOrder, which never creates or searches
 * for a Zoho contact itself). If the person you're looking for isn't
 * appearing, they need to be added/synced first (see customers.controller.js
 * syncFromZoho) rather than typed in here.
 *
 * Sep 2, 2026: the search moved to the SERVER and this component owns it.
 *
 * It used to receive the entire customer list as a prop and filter it in
 * JavaScript. That was fine at a few hundred rows and fell over at ~95,000:
 * the whole table was serialised to the browser on page load, re-filtered on
 * every keystroke, and a one-letter query tried to render tens of thousands
 * of <li>. That is what the typing lag was.
 *
 * Now: a debounced, `limit`-bounded query per search — the same pattern the
 * Clients Directory has used since Aug 28. The parent no longer passes a
 * list at all, and the selected customer is held as an object rather than
 * looked up by id in an array that no longer exists.
 */

const SEARCH_DEBOUNCE_MS = 250;
const RESULT_LIMIT = 25;
// Below this, searching is more noise than help and the query is skipped —
// the unsearched default list is shown instead.
const MIN_SEARCH_LENGTH = 2;

// `is_active` mirrors Zoho's own contact status, kept up to date by the
// customer sync (customers.controller.js's reconcileContacts). Treated as
// active unless it is explicitly 0/false, so a row synced before that
// mirroring existed is never wrongly greyed out. Same rule, and the same
// reasoning, as ProductAutocomplete's inactive items.
const isInactive = (customer) => customer?.is_active === 0 || customer?.is_active === false;

const CustomerAutocomplete = ({
  selected = null,
  onSelect,
  onClear,
  includeInactive = false,
  placeholder = 'Type a customer, hospital, or contact name...',
  disabled = false
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [debouncedTerm, setDebouncedTerm] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedTerm(searchTerm.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(handle);
  }, [searchTerm]);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const effectiveTerm = debouncedTerm.length >= MIN_SEARCH_LENGTH ? debouncedTerm : '';

  const { data, isFetching } = useQuery({
    queryKey: ['customer-search', effectiveTerm, includeInactive],
    queryFn: () => fetchCustomers({ search: effectiveTerm, includeInactive, limit: RESULT_LIMIT }),
    enabled: isOpen && !disabled,
    keepPreviousData: true,
    staleTime: 1000 * 60
  });

  const payload = data?.data || {};
  const results = payload.customers || [];
  const totalMatching = payload.total_matching ?? results.length;

  const handleSelect = (customer) => {
    // Zoho rejects a Sales Order raised against an inactive contact, so an
    // inactive client is shown (better than vanishing, which reads as a
    // typo) but cannot be picked.
    if (isInactive(customer)) return;
    if (onSelect) onSelect(customer);
    setSearchTerm('');
    setIsOpen(false);
  };

  const handleClear = () => {
    setSearchTerm('');
    setIsOpen(false);
    if (onClear) onClear();
  };

  // Once a customer is selected, the input shows their name as a
  // read-looking chip; clicking the x reopens search.
  if (selected && !isOpen) {
    return (
      <div className="relative w-full" ref={containerRef}>
        <div className="w-full flex items-center justify-between gap-2 bg-white border border-slate-300 rounded-md pl-3.5 pr-2 py-2 shadow-2xs">
          <div className="flex items-center gap-2 min-w-0">
            {selected.type === 'credit' ? (
              <Building2 size={15} className="text-getmeds-blue shrink-0" />
            ) : (
              <User size={15} className="text-amber-600 shrink-0" />
            )}
            <span className="text-sm font-semibold text-ink-primary truncate">{selected.name}</span>
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full shrink-0 ${
              selected.type === 'credit' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : 'bg-state-warning-light text-amber-900'
            }`}>
              {selected.type === 'credit' ? 'Credit' : 'Direct'}
            </span>
          </div>
          {!disabled && (
            <button
              type="button"
              onClick={handleClear}
              className="p-1 text-slate-400 hover:text-ink-primary rounded-full transition-colors shrink-0"
              title="Change customer"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full" ref={containerRef}>
      <div className="relative">
        <Search className="w-4 h-4 text-ink-secondary absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          disabled={disabled}
          placeholder={placeholder}
          className="w-full bg-white border border-slate-300 rounded-md pl-9 pr-8 py-2 text-sm text-ink-primary font-medium placeholder-ink-secondary/50 focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue shadow-2xs transition-colors disabled:opacity-50"
        />
        {isFetching ? (
          <Loader2 size={14} className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-ink-secondary" />
        ) : searchTerm ? (
          <button
            type="button"
            onClick={() => setSearchTerm('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-ink-primary rounded-full transition-colors"
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      {isOpen && (
        <ul className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 shadow-lg rounded-md z-20 max-h-64 overflow-y-auto divide-y divide-slate-100 animate-in fade-in slide-in-from-top-1 duration-150">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-center text-xs text-ink-secondary">
              {isFetching ? (
                'Searching…'
              ) : searchTerm.trim() ? (
                <>
                  No registered customer matches <span className="font-semibold text-ink-primary">"{searchTerm}"</span>.
                  <br />
                  <span className="text-[11px]">Ask an Admin to add or sync them from Zoho first.</span>
                </>
              ) : (
                'Start typing to search clients…'
              )}
            </li>
          ) : (
            <>
              {results.map((customer) => {
                const inactive = isInactive(customer);
                return (
                  <li key={customer.id}>
                    <button
                      type="button"
                      onClick={() => handleSelect(customer)}
                      disabled={inactive}
                      aria-disabled={inactive}
                      title={inactive ? 'Inactive in Zoho — cannot be put on a Sales Order' : undefined}
                      className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 transition-colors focus:outline-none ${
                        inactive ? 'opacity-60 cursor-not-allowed' : 'hover:bg-surface focus:bg-surface'
                      }`}
                    >
                      <div className="min-w-0 flex items-center gap-2">
                        {customer.type === 'credit' ? (
                          <Building2 size={15} className={inactive ? 'text-slate-400 shrink-0' : 'text-getmeds-blue shrink-0'} />
                        ) : (
                          <User size={15} className={inactive ? 'text-slate-400 shrink-0' : 'text-amber-600 shrink-0'} />
                        )}
                        <div className="min-w-0">
                          <p className={`text-sm font-semibold truncate ${inactive ? 'text-ink-secondary' : 'text-ink-primary'}`}>
                            {customer.name}
                          </p>
                          {(customer.contact_person || customer.contact_number) && (
                            <p className="text-[11px] text-ink-secondary truncate">
                              {[customer.contact_person, customer.contact_number].filter(Boolean).join(' · ')}
                            </p>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {inactive && (
                          <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
                            Inactive
                          </span>
                        )}
                        <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full ${
                          customer.type === 'credit' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : 'bg-state-warning-light text-amber-900'
                        }`}>
                          {customer.type === 'credit' ? 'Credit' : 'Direct'}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })}
              {/* Honest about the cap: a truncated list that looks complete
                  is how someone concludes a client "isn't in the system". */}
              {totalMatching > results.length && (
                <li className="px-4 py-2 text-center text-[11px] text-ink-secondary bg-surface/60">
                  Showing {results.length} of {totalMatching.toLocaleString()} matches — keep typing to narrow it down.
                </li>
              )}
            </>
          )}
        </ul>
      )}
    </div>
  );
};

export default CustomerAutocomplete;
