import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Check, X } from 'lucide-react';

/**
 * Pick the Zoho Salesperson an order is filed under.
 *
 * Sep 11, 2026. Replaces a free-text field with suggestions. The difference
 * matters more here than it looks:
 *
 * Zoho does not reject a Salesperson name it has never seen — it CREATES one.
 * So a typo in a free-text box does not fail loudly, it quietly adds a junk
 * Salesperson to the company's Zoho org, and every order filed under it is
 * attributed to somebody who does not exist. A picker cannot produce a name
 * Zoho does not already have.
 *
 * Matching is on a SUBSTRING. Nearly every name in this org begins with a
 * division code — "HOS | LAGUNA", "B2B | Fritzie Mier" — so the part a person
 * remembers is in the middle, and a prefix match would find nothing and look
 * broken.
 *
 * `preferred` names are listed first and labelled: when an order is being
 * raised for a particular account, that account's own Salespersons are the
 * likeliest right answers and should not have to be searched for.
 */
const ZohoSalespersonCombo = ({ names, preferred = [], value, onSelect, disabled }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef(null);

  useEffect(() => {
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const options = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const n of [...preferred, ...names]) {
      const name = String(n || '').trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      out.push({ name, preferred: preferred.some((p) => String(p).trim() === name) });
    }
    return out;
  }, [names, preferred]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  // A filter that shortens the list must not leave the highlight past its end,
  // or Enter commits nothing and reads as a dead key.
  useEffect(() => setHighlight(0), [query]);

  const commit = (option) => {
    if (!option) return;
    onSelect(option.name);
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
          value={open ? query : value || query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search Zoho Salespersons…"
          className="w-full text-sm border border-slate-300 rounded-md pl-8 pr-8 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent"
        />
        {value && !open && (
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
              {options.length === 0
                ? 'Could not load Zoho’s Salesperson list.'
                : `No Zoho Salesperson matches “${query}”.`}
            </p>
          ) : (
            matches.map((o, i) => (
              <button
                key={o.name}
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commit(o)}
                className={`w-full text-left px-3 py-2 text-[13px] flex items-center gap-2 ${
                  i === highlight ? 'bg-getmeds-blue/10' : 'hover:bg-surface'
                }`}
              >
                {o.name === value ? (
                  <Check className="w-3.5 h-3.5 shrink-0 text-pharmacy-green" />
                ) : (
                  <span className="w-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate text-ink-primary">{o.name}</span>
                {o.preferred && (
                  <span className="text-[10px] font-bold uppercase text-getmeds-blue shrink-0">
                    theirs
                  </span>
                )}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default ZohoSalespersonCombo;
