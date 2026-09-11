import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Check, X } from 'lucide-react';

/**
 * Pick a Zoho Salesperson by typing.
 *
 * Sep 11, 2026. This was a native <select>. With 101 active names (198 once
 * inactive ones are shown) that is a list you scroll rather than a list you
 * choose from — and the names are not memorable strings, they are things like
 * "MSA | DIANA ROSE ALCANTARA" where the part you remember is in the middle.
 *
 * So matching is on a SUBSTRING, not a prefix. Nearly every name in this org
 * begins with a division code, so the part a person remembers is in the
 * middle: typing "fritzie" finds two B2B reps and "cebu" finds six across HOS
 * and STC, where a prefix match finds none of them and looks broken.
 *
 * It searches whatever is currently listed, which means an inactive
 * salesperson stays invisible until the toggle is used -- "MSA | DIANA ROSE
 * ALCANTARA" is a real name in this org that returns nothing by default,
 * because she has left. Hence the "search inactive too" prompt on an empty
 * result rather than a bare "no matches".
 *
 * It stays a picker, not a text box. The value committed is always one of
 * Zoho's own names — typing something Zoho does not have selects nothing.
 * That is the entire safety property: an unrecognised name is not rejected by
 * Zoho on the first order, it is CREATED there as a new Salesperson.
 */
const SalespersonCombo = ({
  value,
  options,
  inactiveCount = 0,
  showInactive,
  onToggleInactive,
  onSelect,
  onCancel,
  disabled
}) => {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Clicking anywhere else means "I changed my mind", which is what Cancel
  // does. Without this the row stays in edit mode after the user has visibly
  // moved on.
  useEffect(() => {
    const onDocClick = (e) => {
      if (boxRef.current && !boxRef.current.contains(e.target)) onCancel?.();
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [onCancel]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.name.toLowerCase().includes(q));
  }, [options, query]);

  // A filter that shortens the list must not leave the highlight pointing past
  // the end of it — Enter would then commit nothing and look like a dead key.
  useEffect(() => {
    setHighlight(0);
  }, [query, showInactive]);

  const commit = (option) => {
    if (!option) return;
    onSelect(option.name);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(matches[highlight]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel?.();
    }
  };

  return (
    <div ref={boxRef} className="relative w-[20rem]">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-secondary" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            disabled={disabled}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={value || 'Type a name…'}
            className="w-full text-[13px] border border-slate-300 rounded pl-7 pr-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-getmeds-blue"
          />
        </div>
        <button
          type="button"
          onClick={onCancel}
          title="Cancel"
          className="text-ink-secondary hover:text-ink-primary"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden">
        <div className="max-h-64 overflow-y-auto thin-scroll">
          {/* Clearing is a real choice, not an absence of one -- "this person
              has no Zoho Salesperson yet" is a state an admin sets on purpose. */}
          <button
            type="button"
            onClick={() => onSelect('')}
            className="w-full text-left px-3 py-2 text-[13px] text-ink-secondary hover:bg-surface border-b border-slate-100"
          >
            — not assigned —
          </button>

          {matches.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-ink-secondary">
              No Salesperson in Zoho matches “{query}”.
              {!showInactive && inactiveCount > 0 && (
                <>
                  {' '}
                  They may have left —{' '}
                  <button
                    type="button"
                    onClick={onToggleInactive}
                    className="font-semibold text-getmeds-blue hover:text-getmeds-blue-dark"
                  >
                    search inactive too
                  </button>
                  .
                </>
              )}
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
                {!o.is_active && (
                  <span className="text-[11px] text-amber-800 shrink-0">inactive</span>
                )}
                {o.assigned_to && (
                  <span className="text-[11px] text-ink-secondary shrink-0 truncate max-w-[7rem]">
                    {o.assigned_to.name}
                  </span>
                )}
              </button>
            ))
          )}
        </div>

        {inactiveCount > 0 && (
          <div className="border-t border-slate-100 px-3 py-1.5 bg-surface">
            <button
              type="button"
              onClick={onToggleInactive}
              className="text-[11px] font-semibold text-getmeds-blue hover:text-getmeds-blue-dark"
            >
              {showInactive
                ? `Hide inactive (${inactiveCount})`
                : `Show inactive (${inactiveCount})`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default SalespersonCombo;
