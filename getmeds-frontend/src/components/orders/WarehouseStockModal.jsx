import React, { useState } from 'react';
import { X } from 'lucide-react';

/**
 * Zoho's "Warehouses" popup for one order line. Oct 9, 2026.
 *
 * The same table Zoho shows when you click a line's stock: every warehouse with Stock on Hand,
 * Committed Stock and Available for Sale, on an Accounting / Physical toggle, and a radio to pick
 * the warehouse this line is sent from. The numbers are Zoho's own, read when the editor opened
 * (GET /api/orders/:id/stock-check), so what is shown here is what Zoho shows.
 *
 * `view` only decides which column is emphasised, as Zoho's "View" box does.
 */

const fmt = (n) => Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const VIEWS = [
  { value: 'on_hand', label: 'Stock on Hand' },
  { value: 'committed', label: 'Committed Stock' },
  { value: 'available', label: 'Available for Sale' }
];

const WarehouseStockModal = ({ itemName, perWarehouse, selectedId, needed, onSelect, onClose }) => {
  const [basis, setBasis] = useState('accounting');
  const [view, setView] = useState('on_hand');

  const figures = (p) =>
    basis === 'accounting'
      ? { on_hand: p.on_hand, committed: p.committed, available: p.available }
      : { on_hand: p.physical_on_hand, committed: p.physical_committed, available: p.physical_available };
  const cell = (col, value) =>
    `px-4 py-3 text-right tabular-nums ${view === col ? 'font-bold text-ink-primary' : 'text-ink-secondary'}`;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full max-w-3xl my-10" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-5 py-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-ink-primary">Warehouses</h2>
          <label className="flex items-center gap-2 text-xs text-ink-secondary">
            View:
            <select
              value={view}
              onChange={(e) => setView(e.target.value)}
              className="border border-dashed border-slate-400 rounded px-2 py-1 text-xs font-medium text-ink-primary focus:outline-none"
            >
              {VIEWS.map((v) => <option key={v.value} value={v.value}>{v.label}</option>)}
            </select>
          </label>
          <div className="inline-flex rounded overflow-hidden border border-getmeds-blue text-xs font-semibold">
            {[['accounting', 'Accounting Stock'], ['physical', 'Physical Stock']].map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setBasis(k)}
                className={`px-4 py-1.5 ${basis === k ? 'bg-getmeds-blue text-white' : 'bg-white text-getmeds-blue'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto text-red-500 hover:text-red-700">
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="px-5 pt-3 text-xs text-ink-secondary">
          {itemName}{needed != null ? <> — this order needs <span className="font-semibold text-ink-primary">{needed}</span></> : null}
        </p>

        <div className="p-5 pt-3 max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm border border-slate-200">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-ink-secondary">
              <tr>
                <th rowSpan={2} className="text-left px-4 py-2 font-semibold align-bottom border-r border-slate-200">Warehouse Name</th>
                <th colSpan={3} className="text-center px-4 py-2 font-semibold border-b border-slate-200">
                  {basis === 'accounting' ? 'Accounting Stock' : 'Physical Stock'}
                </th>
              </tr>
              <tr>
                <th className="text-right px-4 py-2 font-semibold">Stock on Hand</th>
                <th className="text-right px-4 py-2 font-semibold">Committed Stock</th>
                <th className="text-right px-4 py-2 font-semibold">Available for Sale</th>
              </tr>
            </thead>
            <tbody>
              {perWarehouse.map((p) => {
                const f = figures(p);
                const chosen = p.warehouse_id === selectedId;
                return (
                  <tr
                    key={p.warehouse_id}
                    onClick={() => onSelect(p.warehouse_id, p.warehouse_name)}
                    className={`border-t border-slate-200 cursor-pointer hover:bg-slate-50 ${chosen ? 'bg-blue-50/50' : ''}`}
                  >
                    <td className="px-4 py-3 border-r border-slate-200">
                      <label className="flex items-center gap-3 cursor-pointer">
                        <input
                          type="radio"
                          name="line-warehouse"
                          checked={chosen}
                          onChange={() => onSelect(p.warehouse_id, p.warehouse_name)}
                        />
                        <span className="text-ink-primary">{p.warehouse_name}</span>
                        {needed != null && !p.enough && <span className="text-[10px] font-semibold text-red-700">short</span>}
                      </label>
                    </td>
                    <td className={cell('on_hand')}>{fmt(f.on_hand)}</td>
                    <td className={cell('committed')}>{fmt(f.committed)}</td>
                    <td className={cell('available')}>{fmt(f.available)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex justify-end px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-lg">
          <button type="button" onClick={onClose} className="px-4 py-1.5 rounded-md bg-getmeds-blue text-white text-sm font-semibold">
            Done
          </button>
        </div>
      </div>
    </div>
  );
};

export default WarehouseStockModal;
