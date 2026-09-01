import React, { useState, useRef, useEffect } from 'react';
import { Search, X, Check } from 'lucide-react';

/**
 * ProductAutocomplete Component
 * 
 * @param {Array} products - Master product list cached via React Query
 * @param {Function} onSelect - Callback when user selects a product: onSelect(product)
 * @param {string} placeholder - Input placeholder text
 * @param {boolean} disabled - Whether the input is disabled
 */
// `is_active` mirrors Zoho's own item status, kept up to date by the
// inventory sync. Treated as active unless it is explicitly 0/false, so a
// product from an older row that predates the column is never wrongly
// greyed out.
const isInactive = (product) => product?.is_active === 0 || product?.is_active === false;

const ProductAutocomplete = ({ 
  products = [], 
  onSelect, 
  placeholder = "Search product by name, SKU, or category...", 
  disabled = false 
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Derived filtered array based on searchTerm
  const filteredProducts = products.filter((product) => {
    if (!searchTerm.trim()) return true;
    const term = searchTerm.toLowerCase();
    return (
      product.name?.toLowerCase().includes(term) ||
      product.sku?.toLowerCase().includes(term) ||
      product.category?.toLowerCase().includes(term)
    );
  });

  const handleSelect = (product) => {
    // Sep 1, 2026: an inactive item is shown but cannot be picked. Zoho
    // refuses one on a Sales Order ("Inactive items cannot be added to the
    // sales order"), so allowing the selection would only mean the order
    // failed later, at submit, after the MedRep had filled the rest in.
    if (isInactive(product)) return;
    if (onSelect) {
      onSelect(product);
    }
    setSearchTerm('');
    setIsOpen(false);
  };

  const handleClear = () => {
    setSearchTerm('');
    setIsOpen(false);
  };

  return (
    <div className="relative w-full" ref={containerRef}>
      {/* Search Input Field */}
      <div className="relative">
        <Search className="w-4 h-4 text-ink-secondary absolute left-3 top-3 pointer-events-none" />
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
            onClick={handleClear}
            className="absolute right-2.5 top-2.5 p-0.5 text-slate-400 hover:text-ink-primary rounded-full transition-colors"
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Floating Dropdown Panel */}
      {isOpen && (
        <ul className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 shadow-lg rounded-md z-20 max-h-60 overflow-y-auto divide-y divide-slate-100 animate-in fade-in slide-in-from-top-1 duration-150">
          {filteredProducts.length === 0 ? (
            <li className="px-4 py-3 text-center text-xs text-ink-secondary">
              No products found matching <span className="font-semibold text-ink-primary">"{searchTerm}"</span>
            </li>
          ) : (
            filteredProducts.map((product) => {
              const inactive = isInactive(product);
              return (
                <li key={product.id}>
                  <button
                    type="button"
                    onClick={() => handleSelect(product)}
                    disabled={inactive}
                    aria-disabled={inactive}
                    title={inactive ? 'Inactive in Zoho — cannot be added to a Sales Order' : undefined}
                    className={`w-full text-left px-4 py-2.5 flex items-center justify-between transition-colors focus:outline-none ${
                      inactive
                        ? 'bg-slate-50/60 cursor-not-allowed'
                        : 'hover:bg-surface focus:bg-surface'
                    }`}
                  >
                    <div className="min-w-0 pr-3">
                      <div className="flex items-center gap-2">
                        <p className={`text-sm font-semibold truncate ${inactive ? 'text-slate-400' : 'text-ink-primary'}`}>
                          {product.name}
                        </p>
                        <span
                          className={`text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                            inactive
                              ? 'bg-slate-200 text-slate-600 border-slate-300'
                              : 'bg-pharmacy-green/10 text-pharmacy-green-dark border-pharmacy-green/30'
                          }`}
                        >
                          {inactive ? 'Inactive' : 'Active'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className={`text-[11px] font-mono px-1.5 py-0.5 rounded border ${
                          inactive
                            ? 'text-slate-400 bg-slate-100 border-slate-200'
                            : 'text-ink-secondary bg-slate-100 border-slate-200/60'
                        }`}>
                          {product.sku}
                        </span>
                        {product.category && (
                          <span className="text-[11px] text-ink-secondary/70">
                            {product.category}
                          </span>
                        )}
                        {inactive && (
                          <span className="text-[11px] text-slate-500">
                            Not available in Zoho
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="text-right flex-shrink-0">
                      <p className={`text-sm font-bold font-mono ${inactive ? 'text-slate-400' : 'text-getmeds-blue'}`}>
                        ₱{Number(product.unit_price || 0).toFixed(2)}
                      </p>
                      <span className="text-[10px] text-ink-secondary uppercase">
                        per {product.unit || 'unit'}
                      </span>
                    </div>
                  </button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
};

export default ProductAutocomplete;
