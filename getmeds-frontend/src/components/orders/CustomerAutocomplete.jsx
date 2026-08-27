import React, { useState, useRef, useEffect } from 'react';
import { Search, X, Building2, User } from 'lucide-react';

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
 * @param {Array} customers - Master customer list cached via React Query
 * @param {string|number} value - Currently selected customer id (controlled)
 * @param {Function} onSelect - Callback when user picks a customer: onSelect(customer)
 * @param {Function} onClear - Callback when the selection is cleared
 * @param {string} placeholder
 */
const CustomerAutocomplete = ({
  customers = [],
  value,
  onSelect,
  onClear,
  placeholder = 'Type a customer, hospital, or contact name...',
  disabled = false
}) => {
  const selected = customers.find((c) => String(c.id) === String(value)) || null;
  const [searchTerm, setSearchTerm] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredCustomers = customers.filter((c) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase();
    return (
      c.name?.toLowerCase().includes(term) ||
      c.contact_person?.toLowerCase().includes(term) ||
      c.contact_number?.toLowerCase().includes(term)
    );
  });

  const handleSelect = (customer) => {
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
  // read-looking chip; typing again (or clicking the x) reopens search.
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
        {searchTerm && (
          <button
            type="button"
            onClick={() => setSearchTerm('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 p-0.5 text-slate-400 hover:text-ink-primary rounded-full transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {isOpen && (
        <ul className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 shadow-lg rounded-md z-20 max-h-64 overflow-y-auto divide-y divide-slate-100 animate-in fade-in slide-in-from-top-1 duration-150">
          {filteredCustomers.length === 0 ? (
            <li className="px-4 py-3 text-center text-xs text-ink-secondary">
              No registered customer matches <span className="font-semibold text-ink-primary">"{searchTerm}"</span>.
              <br />
              <span className="text-[11px]">Ask an Admin to add or sync them from Zoho first.</span>
            </li>
          ) : (
            filteredCustomers.map((customer) => (
              <li key={customer.id}>
                <button
                  type="button"
                  onClick={() => handleSelect(customer)}
                  className="w-full text-left px-4 py-2.5 hover:bg-surface flex items-center justify-between gap-3 transition-colors focus:bg-surface focus:outline-none"
                >
                  <div className="min-w-0 flex items-center gap-2">
                    {customer.type === 'credit' ? (
                      <Building2 size={15} className="text-getmeds-blue shrink-0" />
                    ) : (
                      <User size={15} className="text-amber-600 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink-primary truncate">{customer.name}</p>
                      {(customer.contact_person || customer.contact_number) && (
                        <p className="text-[11px] text-ink-secondary truncate">
                          {[customer.contact_person, customer.contact_number].filter(Boolean).join(' · ')}
                        </p>
                      )}
                    </div>
                  </div>
                  <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded-full shrink-0 ${
                    customer.type === 'credit' ? 'bg-pharmacy-green/15 text-pharmacy-green-dark' : 'bg-state-warning-light text-amber-900'
                  }`}>
                    {customer.type === 'credit' ? 'Credit' : 'Direct'}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
};

export default CustomerAutocomplete;
