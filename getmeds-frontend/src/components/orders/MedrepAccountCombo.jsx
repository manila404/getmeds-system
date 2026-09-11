import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Check, X } from 'lucide-react';

/**
 * Pick the MedRep ACCOUNT an order belongs to.
 *
 * Sep 11, 2026. Deliberately not the same thing as the form's Salesperson
 * field, and deliberately not sourced from the same place:
 *
 *   this picker      accounts in THIS system (Supabase `users`), the people
 *                    who can log in and own an order
 *   Salesperson      a name from ZOHO's list of ~198, which is what goes on
 *                    the Sales Order
 *
 * They do not correspond one to one — an account can hold several Zoho
 * Salespersons, and plenty of Zoho Salespersons are territories or channels
 * with no account behind them at all. An earlier version listed both in one
 * dropdown, which invited reading a Zoho Salesperson as if it were somebody
 * who could be handed an order.
 *
 * So rows show the ACCOUNT: name and email, nothing else. The Salesperson that
 * will actually be sent is shown by the form's own field, sourced from the
 * chosen account.
 */
const MedrepAccountCombo = ({ accounts, value, onSelect, disabled, placeholder }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef(null);

  const selected = accounts.find((a) => String(a.id) === String(value)) || null;

  useEffect(() => {
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return accounts;
    // Name OR email — people search by whichever they happen to know.
    return accounts.filter(
      (a) =>
        String(a.display_name || a.name || '').toLowerCase().includes(q) ||
        String(a.email || '').toLowerCase().includes(q)
    );
  }, [accounts, query]);

  // A filter that shortens the list must not leave the highlight past its end,
  // or Enter commits nothing and reads as a dead key.
  useEffect(() => setHighlight(0), [query]);

  const commit = (account) => {
    if (!account) return;
    onSelect(String(account.id));
    setQuery('');
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(matches[highlight]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div ref={boxRef} className="relative">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-secondary" />
        <input
          type="text"
          disabled={disabled}
          value={open ? query : selected ? (selected.display_name || selected.name) : query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={placeholder || 'Search by name or email…'}
          className="w-full text-sm border border-slate-300 rounded-md pl-8 pr-8 py-2 focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent"
        />
        {selected && !open && (
          <button
            type="button"
            onClick={() => onSelect('')}
            title="Clear"
            className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-secondary hover:text-ink-primary"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-30 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-64 overflow-y-auto thin-scroll">
          {matches.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-ink-secondary">
              No account matches “{query}”. Only people with an account here can be given an order.
            </p>
          ) : (
            matches.map((a, i) => (
              <button
                key={a.id}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(a)}
                className={`w-full text-left px-3 py-2 flex items-center gap-2 ${
                  i === highlight ? 'bg-getmeds-blue/10' : 'hover:bg-surface'
                }`}
              >
                {String(a.id) === String(value) ? (
                  <Check className="w-3.5 h-3.5 shrink-0 text-pharmacy-green" />
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className="min-w-0">
                  <span className="block text-[13px] text-ink-primary truncate">
                    {a.display_name || a.name}
                  </span>
                  <span className="block text-[11px] text-ink-secondary truncate">{a.email}</span>
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default MedrepAccountCombo;
