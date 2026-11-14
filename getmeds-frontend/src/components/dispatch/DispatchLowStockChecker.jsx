import React, { useState, useMemo } from 'react';
import { useQueryClient, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  Search,
  Package,
  XCircle,
  CheckCircle2,
  Megaphone,
  Sparkles,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  SlidersHorizontal,
  Info
} from 'lucide-react';
import client from '../../api/client';
import { useProducts } from '../../hooks/useOrderData';

/**
 * Realistic Mock Low Stock Items for Dispatch end testing & simulation
 */
const MOCK_LOW_STOCK_ITEMS = [
  {
    id: 'mock-1',
    name: 'Amoxicillin Trihydrate 500mg Capsule',
    sku: 'GM-AMOX-500 (100s/Box)',
    category: 'Antibacterial / Antibiotics',
    stock: 3,
    zoho_stock: 3,
    unit: 'box',
    unit_price: 380.00,
    is_mock: true,
    warning: 'Critical: Only 3 boxes remaining across all warehouses'
  },
  {
    id: 'mock-2',
    name: 'Meropenem 1g IV Powder for Injection',
    sku: 'GM-MERO-1000 (Vial)',
    category: 'Hospital Critical Care',
    stock: 0,
    zoho_stock: 0,
    unit: 'vial',
    unit_price: 1250.00,
    is_mock: true,
    warning: 'Stockout: 0 vials available. Pending supplier delivery.'
  },
  {
    id: 'mock-3',
    name: 'Ceftriaxone Sodium 1g Powder for Injection',
    sku: 'GM-CEFT-1000 (Vial)',
    category: 'Hospital Injectable',
    stock: 4,
    zoho_stock: 4,
    unit: 'vial',
    unit_price: 450.00,
    is_mock: true,
    warning: 'Low: 4 vials remaining in Main Warehouse'
  },
  {
    id: 'mock-4',
    name: 'Paracetamol 500mg Tablet (Box of 100)',
    sku: 'GM-PARA-500 (100s/Box)',
    category: 'Analgesic / Antipyretic',
    stock: 6,
    zoho_stock: 6,
    unit: 'box',
    unit_price: 180.00,
    is_mock: true,
    warning: 'High dispatch demand: 6 boxes left'
  },
  {
    id: 'mock-5',
    name: 'Omeprazole 40mg IV Powder for Injection',
    sku: 'GM-OMEP-40 (Vial)',
    category: 'Gastrointestinal',
    stock: 7,
    zoho_stock: 8,
    unit: 'vial',
    unit_price: 320.00,
    is_mock: true,
    warning: 'Low stock: 7 vials on hand'
  },
  {
    id: 'mock-6',
    name: 'Sodium Chloride 0.9% 500mL IV Infusion',
    sku: 'GM-NACL-500 (Bag)',
    category: 'IV Fluids & Electrolytes',
    stock: 11,
    zoho_stock: 11,
    unit: 'bag',
    unit_price: 95.00,
    is_mock: true,
    warning: '11 bags left (reorder point: 20)'
  },
  {
    id: 'mock-7',
    name: 'Ciprofloxacin 500mg Film-Coated Tablet',
    sku: 'GM-CIPRO-500 (100s/Box)',
    category: 'Antibiotics',
    stock: 0,
    zoho_stock: 0,
    unit: 'box',
    unit_price: 520.00,
    is_mock: true,
    warning: 'Out of stock in all branches'
  },
  {
    id: 'mock-8',
    name: 'Ketorolac Tromethamine 30mg/mL Ampoule',
    sku: 'GM-KETO-30 (Ampoule)',
    category: 'Injectable Analgesic',
    stock: 5,
    zoho_stock: 5,
    unit: 'ampoule',
    unit_price: 145.00,
    is_mock: true,
    warning: '5 ampoules left'
  }
];

const LOW_STOCK_THRESHOLD = 15;

/**
 * DispatchLowStockChecker
 * Allows Dispatch to quickly check low-stock and out-of-stock items,
 * search any medicine instantly, toggle realistic mock simulation data,
 * and announce stock warnings to MedReps & Management with 1 click.
 */
const DispatchLowStockChecker = ({ onAnnounceProduct }) => {
  const qc = useQueryClient();
  const { data: realProducts = [], isLoading: productsLoading } = useProducts();

  // Nov 14, 2026 (Aaron): collapsed until opened, so it does not push the Dispatch list down. And the
  // made-up demo items are on only in local development: on live they were listed as real stock
  // (tagged "SIMULATED MOCK") for everyone. The toggle still turns them on by hand.
  const [expanded, setExpanded] = useState(false);
  const [useMockSimulation, setUseMockSimulation] = useState(Boolean(import.meta.env.DEV));
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState('all_low'); // 'all_low' | 'out_of_stock' | 'low_stock' | 'search_all'
  const [customThreshold, setCustomThreshold] = useState(LOW_STOCK_THRESHOLD);
  const [showSettings, setShowSettings] = useState(false);

  // Combine real database products with mock simulation items if enabled
  const allAvailableItems = useMemo(() => {
    const list = [...realProducts];
    if (useMockSimulation) {
      // Place mock low stock items at the top or merged
      return [...MOCK_LOW_STOCK_ITEMS, ...list];
    }
    return list;
  }, [realProducts, useMockSimulation]);

  // Derived low stock items
  const { outOfStockItems, lowStockItems, totalLowCount } = useMemo(() => {
    const out = [];
    const low = [];

    allAvailableItems.forEach((p) => {
      const stockNum = Number(p.stock ?? p.local_stock ?? 0);
      if (stockNum <= 0) {
        out.push(p);
      } else if (stockNum <= customThreshold) {
        low.push(p);
      }
    });

    return {
      outOfStockItems: out,
      lowStockItems: low,
      totalLowCount: out.length + low.length
    };
  }, [allAvailableItems, customThreshold]);

  // Items to display based on active tab and search query
  const displayedItems = useMemo(() => {
    let items = [];
    if (activeTab === 'all_low') {
      items = [...outOfStockItems, ...lowStockItems];
    } else if (activeTab === 'out_of_stock') {
      items = outOfStockItems;
    } else if (activeTab === 'low_stock') {
      items = lowStockItems;
    } else {
      items = allAvailableItems;
    }

    if (!searchQuery.trim()) return items.slice(0, 50);

    const q = searchQuery.toLowerCase();
    return items
      .filter((p) =>
        (p.name && p.name.toLowerCase().includes(q)) ||
        (p.sku && p.sku.toLowerCase().includes(q)) ||
        (p.category && p.category.toLowerCase().includes(q))
      )
      .slice(0, 50);
  }, [activeTab, outOfStockItems, lowStockItems, allAvailableItems, searchQuery]);

  // Quick announcement mutation
  const announceMutation = useMutation({
    mutationFn: async ({ product, kind, message }) => {
      // If product has a numeric DB id, post to backend
      if (typeof product.id === 'number') {
        return client.post('/api/stock-announcements', {
          product_id: product.id,
          kind,
          message: message || `Dispatch notice: Only ${product.stock ?? 0} ${product.unit || 'units'} left.`
        }).then(r => r.data?.data);
      }
      // For mock simulation items, simulate success
      await new Promise(r => setTimeout(r, 400));
      return { success: true, mock: true, product_name: product.name };
    },
    onSuccess: (data, vars) => {
      toast.success(
        `Announced to MedReps & Management: ${vars.product.name} is marked ${vars.kind === 'out_of_stock' ? 'Out of Stock' : 'Low Stock'}!`,
        { icon: '📢', duration: 5000 }
      );
      qc.invalidateQueries({ queryKey: ['stock-announcements'] });
      if (onAnnounceProduct) {
        onAnnounceProduct(vars.product, vars.kind);
      }
    },
    onError: (err) => {
      toast.error(err?.response?.data?.error?.message || 'Could not post announcement.');
    }
  });

  const getStockStatus = (stock) => {
    const s = Number(stock || 0);
    if (s <= 0) {
      return {
        label: 'Out of Stock',
        badgeClass: 'bg-red-100 text-red-800 border-red-200',
        barClass: 'bg-red-500',
        kind: 'out_of_stock',
        icon: XCircle
      };
    }
    if (s <= customThreshold) {
      return {
        label: `Low Stock (${s} left)`,
        badgeClass: 'bg-amber-100 text-amber-900 border-amber-300 font-semibold',
        barClass: 'bg-amber-500',
        kind: 'low_stock',
        icon: AlertTriangle
      };
    }
    return {
      label: `In Stock (${s})`,
      badgeClass: 'bg-emerald-50 text-emerald-800 border-emerald-200',
      barClass: 'bg-emerald-500',
      kind: 'back_in_stock',
      icon: CheckCircle2
    };
  };

  return (
    <div className="bg-white shadow rounded-lg border border-slate-200 overflow-hidden">
      {/* Top Banner / Accordion Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 bg-gradient-to-r from-amber-50/60 via-white to-slate-50 border-b border-slate-200">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-amber-100 text-amber-800 border border-amber-200">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-ink-primary flex items-center gap-2">
                Dispatch Low Stock Checker
                {useMockSimulation && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-100 text-purple-800 border border-purple-200">
                    <Sparkles className="w-3 h-3 text-purple-600" />
                    Mock Simulation Active
                  </span>
                )}
              </h2>
            </div>
            <p className="text-xs text-ink-secondary mt-0.5">
              Check warehouse stock levels easily before dispatching & notify MedReps immediately
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Quick metric pill */}
          <div className="flex items-center gap-1.5 text-xs bg-white px-2.5 py-1 rounded-md border border-slate-200 shadow-2xs font-mono">
            <span className="text-red-700 font-bold">{outOfStockItems.length}</span>
            <span className="text-slate-400">out of stock</span>
            <span className="text-slate-300">•</span>
            <span className="text-amber-700 font-bold">{lowStockItems.length}</span>
            <span className="text-slate-400">low</span>
          </div>

          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-md border border-slate-200 bg-white text-ink-secondary hover:bg-slate-50 hover:text-ink-primary transition-colors cursor-pointer"
          >
            {expanded ? (
              <>
                Hide <ChevronUp className="w-3.5 h-3.5" />
              </>
            ) : (
              <>
                Check Stock <ChevronDown className="w-3.5 h-3.5" />
              </>
            )}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="p-4 space-y-4">
          {/* Controls: Search, Tabs, Mock Mode Toggle */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            {/* Search Input */}
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Quick check any medicine or SKU (e.g. Paracetamol, Amoxicillin, GM-1001)..."
                className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-9 pr-8 py-2 text-xs font-medium text-ink-primary focus:bg-white focus:outline-none focus:ring-1 focus:ring-getmeds-blue focus:border-getmeds-blue transition-all"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 p-0.5"
                >
                  <XCircle className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Simulation Switch & Settings */}
            <div className="flex items-center gap-2 shrink-0">
              <label
                className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                  useMockSimulation
                    ? 'bg-purple-50 text-purple-800 border-purple-200 shadow-2xs'
                    : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                }`}
                title="Toggle simulated low-stock demo items for Dispatch testing"
              >
                <input
                  type="checkbox"
                  checked={useMockSimulation}
                  onChange={(e) => setUseMockSimulation(e.target.checked)}
                  className="sr-only"
                />
                <Sparkles className="w-3.5 h-3.5 text-purple-600" />
                Mock Demo Data: <span className="font-bold">{useMockSimulation ? 'ON' : 'OFF'}</span>
              </label>

              <button
                type="button"
                onClick={() => setShowSettings((v) => !v)}
                className={`p-1.5 rounded-lg border text-xs transition-colors ${
                  showSettings ? 'bg-slate-200 text-slate-800 border-slate-300' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'
                }`}
                title="Adjust low stock threshold"
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Optional Threshold Setting Drawer */}
          {showSettings && (
            <div className="flex items-center gap-3 p-2.5 bg-slate-50 rounded-lg border border-slate-200 text-xs text-ink-secondary">
              <Info className="w-4 h-4 text-getmeds-blue shrink-0" />
              <span>Mark items as <strong>Low Stock</strong> when quantity is at or below:</span>
              <input
                type="number"
                min="1"
                max="100"
                value={customThreshold}
                onChange={(e) => setCustomThreshold(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="w-16 px-2 py-1 text-xs font-mono font-bold bg-white border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-getmeds-blue"
              />
              <span className="text-[11px] text-slate-400">units (Default: 15)</span>
            </div>
          )}

          {/* Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            {[
              { key: 'all_low', label: 'All Low & Out of Stock', count: totalLowCount, tone: 'amber' },
              { key: 'low_stock', label: '⚠️ Low Stock (≤ 15)', count: lowStockItems.length, tone: 'amber' },
              { key: 'out_of_stock', label: '⛔ Out of Stock (0)', count: outOfStockItems.length, tone: 'red' },
              { key: 'search_all', label: 'Search All Catalog', count: allAvailableItems.length, tone: 'default' }
            ].map((tab) => {
              const active = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setActiveTab(tab.key)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap border transition-all cursor-pointer ${
                    active
                      ? tab.tone === 'red'
                        ? 'bg-red-50 text-red-900 border-red-300 shadow-2xs'
                        : tab.tone === 'amber'
                        ? 'bg-amber-50 text-amber-900 border-amber-300 shadow-2xs'
                        : 'bg-getmeds-blue text-white border-getmeds-blue shadow-2xs'
                      : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}
                >
                  {tab.label}
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] tabular-nums font-mono ${
                      active ? 'bg-black/10 text-inherit font-bold' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {tab.count}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Items List Grid */}
          <div className="border border-slate-200 rounded-lg overflow-hidden bg-white">
            {displayedItems.length === 0 ? (
              <div className="text-center py-10 px-4 space-y-2">
                <CheckCircle2 className="w-8 h-8 text-emerald-500 mx-auto" />
                <p className="text-sm font-semibold text-slate-800">No items match your criteria</p>
                <p className="text-xs text-slate-400">
                  {searchQuery ? `No medicine found for "${searchQuery}"` : 'All items are currently well-stocked.'}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100 max-h-80 overflow-y-auto">
                {displayedItems.map((item) => {
                  const stockNum = Number(item.stock ?? item.local_stock ?? 0);
                  const status = getStockStatus(stockNum);
                  const isBusy = announceMutation.isPending && announceMutation.variables?.product?.id === item.id;
                  const percent = Math.min(100, Math.max(0, Math.round((stockNum / 30) * 100)));

                  return (
                    <div
                      key={item.id}
                      className="p-3 hover:bg-slate-50/70 transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                    >
                      {/* Medicine Info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-slate-900 text-[13px]">{item.name}</span>
                          {item.is_mock && (
                            <span className="text-[10px] uppercase font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200">
                              Simulated Mock
                            </span>
                          )}
                          <span className={`inline-flex items-center gap-1 text-[10px] uppercase font-bold px-2 py-0.5 rounded-full border ${status.badgeClass}`}>
                            <status.icon className="w-3 h-3" />
                            {status.label}
                          </span>
                        </div>

                        <div className="flex items-center gap-2 mt-1 text-slate-500 flex-wrap">
                          <span className="font-mono text-[11px] bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200/60">
                            {item.sku}
                          </span>
                          {item.category && (
                            <>
                              <span>•</span>
                              <span>{item.category}</span>
                            </>
                          )}
                          {item.warning && (
                            <>
                              <span>•</span>
                              <span className="text-amber-800 font-medium">{item.warning}</span>
                            </>
                          )}
                        </div>

                        {/* Stock gauge bar */}
                        <div className="mt-2 w-48 max-w-full">
                          <div className="flex items-center justify-between text-[10px] text-slate-400 mb-0.5">
                            <span>Stock on hand</span>
                            <span className="font-bold text-slate-700">{stockNum} {item.unit || 'units'}</span>
                          </div>
                          <div className="w-full bg-slate-100 h-1.5 rounded-full overflow-hidden">
                            <div
                              className={`h-full rounded-full ${status.barClass}`}
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Stock Counts & Quick Actions */}
                      <div className="flex items-center gap-2 shrink-0 self-end sm:self-center">
                        <div className="text-right pr-2">
                          <div className="font-mono text-sm font-bold text-slate-900">
                            {stockNum} <span className="text-xs font-normal text-slate-500">{item.unit || 'units'}</span>
                          </div>
                          {item.zoho_stock !== undefined && (
                            <div className="text-[10px] text-slate-400">
                              Zoho: {item.zoho_stock}
                            </div>
                          )}
                        </div>

                        {/* One-click Announce Stock Button */}
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            announceMutation.mutate({
                              product: item,
                              kind: stockNum <= 0 ? 'out_of_stock' : 'low_stock'
                            })
                          }
                          className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-bold transition-all shadow-2xs cursor-pointer disabled:opacity-50 ${
                            stockNum <= 0
                              ? 'bg-red-600 hover:bg-red-700 text-white'
                              : 'bg-amber-600 hover:bg-amber-700 text-white'
                          }`}
                          title="Post an immediate stock announcement so MedReps and Management are alerted"
                        >
                          <Megaphone className="w-3.5 h-3.5" />
                          {isBusy ? 'Posting…' : stockNum <= 0 ? 'Announce Out of Stock' : 'Announce Low Stock'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default DispatchLowStockChecker;
