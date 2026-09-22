import React from 'react';
import { Trash2, AlertCircle } from 'lucide-react';
import ProductAutocomplete from './ProductAutocomplete';
import { TAX_OPTIONS, computeLineAmounts } from '../../utils/orderLines';

// Sep 22, 2026: mirrors OrderForm.jsx's own copy exactly — same two
// entities, enforced the same way server-side (orders.controller.js).
const INVOICING_FROM_OPTIONS = ['2mg Incorporated', 'Getmeds Philippines Inc.'];

/**
 * Edit an existing order's lines, in the same table the order form uses.
 *
 * Sep 14, 2026. The order page's editor was a stack of cards — a product
 * search per line, a quantity box, and (for Management) separate price and
 * discount boxes underneath — with a total that ignored tax. Editing an order
 * should look like raising one, so this is the form's table: search and add on
 * top, then Qty / Rate / Discount / Tax / Amount per line, and the same
 * Subtotal / Discount / Tax / Grand Total footer.
 *
 * Priced by utils/orderLines.js, the same arithmetic the form and the server
 * use, under the ORDER's own tax preference — the server re-prices an edit
 * that way (updateItems), so the preference is shown here, not offered as a
 * choice that would not stick.
 *
 * Stateless: the page owns the draft rows and passes changes back up, so the
 * existing keystroke rules (keep what is typed, settle on blur) and the save
 * path are untouched.
 */

const peso = (n) =>
  `₱${Number(n || 0).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const inputClass =
  'text-center border border-slate-300 rounded py-1 text-xs font-bold text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue';

const OrderItemsEditor = ({
  rows,
  products,
  inclusive,
  canEditPrice,
  activeProductIds,
  onChange,
  onBlurField,
  onRemove,
  onAdd,
  onCancel,
  onSave,
  saving,
  // Sep 19, 2026: true only for Management editing an order Zoho already
  // has — changes the banner below so it doesn't claim nothing reaches
  // Zoho when, for this caller, it actually does (orders.controller.js's
  // updateItems pushes the edit to the real Sales Order in that case).
  alreadySynced,
  // Sep 22, 2026: the order's own top-level Invoicing From — needed to
  // know what "follow the order" means for the per-row override below,
  // and to label the split banner. See services/orderSplitService.js.
  orderInvoicingFrom
}) => {
  const lines = rows.map((r) =>
    computeLineAmounts({ quantity: r.quantity, rate: r.rate, discount: r.discount, taxPercent: r.tax_percent }, inclusive)
  );
  const totals = lines.reduce(
    (acc, l) => ({
      subtotal: acc.subtotal + l.subtotal,
      discount: acc.discount + l.discount,
      tax: acc.tax + l.taxAmount,
      grand: acc.grand + l.amount
    }),
    { subtotal: 0, discount: 0, tax: 0, grand: 0 }
  );
  const hasInactive = rows.some((r) => !activeProductIds.has(String(r.product_id)));
  // Sep 18, 2026: the Tax select's tooltip needs the product's REAL current
  // Zoho tax — row.tax_percent/tax_label now hold whatever preset was picked
  // (they get overwritten the moment Tax is changed, same as the order
  // form), so they're no longer reliable evidence of what Zoho actually has.
  const productById = new Map(products.map((p) => [String(p.id), p]));
  // Sep 22, 2026: at least one row explicitly billed under the OTHER
  // entity — see services/orderSplitService.js on the backend. `null` for
  // every order that doesn't do this, which is unaffected by any of this.
  const splitEntity = rows.find((r) => r.invoicing_from && r.invoicing_from !== orderInvoicingFrom)?.invoicing_from;

  return (
    <div className="space-y-4">
      <div className={`border rounded-lg p-3 text-xs ${alreadySynced ? 'bg-state-warning-light border-state-warning/30 text-amber-950' : 'bg-getmeds-blue/5 border-getmeds-blue/20 text-ink-secondary'}`}>
        {alreadySynced
          ? 'This order already has a Zoho Sales Order — saving here also updates it there.'
          : 'Editing items here only — nothing is sent to Zoho until the order syncs.'}
        {hasInactive && ' A row in red is no longer an active product in Zoho: remove it and add a replacement before saving.'}
      </div>

      {splitEntity && (
        <div className="border border-getmeds-blue/30 bg-getmeds-blue/5 rounded-lg p-3 text-xs text-ink-secondary">
          <span className="font-bold text-getmeds-blue">Split order:</span>{' '}
          two Zoho Sales Orders — one under{' '}
          <span className="font-semibold text-ink-primary">{orderInvoicingFrom}</span> and one under{' '}
          <span className="font-semibold text-ink-primary">{splitEntity}</span>.
        </div>
      )}

      {/* Same search-and-add box as the order form. */}
      <div className="bg-surface p-4 rounded-xl border border-slate-200/80">
        <label className="block text-xs font-bold uppercase tracking-wider text-ink-primary mb-2">
          Quick Product Search &amp; Add
        </label>
        <ProductAutocomplete
          products={products}
          onSelect={onAdd}
          placeholder="Type to search medicine name, SKU, or category (e.g. Paracetamol, Amoxicillin)..."
        />
      </div>

      {/* The order's tax preference, shown rather than offered: an edit is
          re-priced under the preference the order was raised with. */}
      <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
        <span className="text-[11px] text-ink-secondary">
          {inclusive ? 'Rates already include VAT.' : 'VAT is added on top of the rates.'}
        </span>
        <span className="text-xs font-semibold text-ink-secondary">Item tax preference</span>
        <span
          title="Set when the order was raised"
          className="border border-slate-200 bg-surface rounded-md py-1 px-2 text-xs font-semibold text-ink-primary"
        >
          {inclusive ? 'Tax Inclusive' : 'Tax Exclusive'}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="text-center py-8 border-2 border-dashed border-slate-200 rounded-xl bg-white text-ink-secondary text-sm">
          No items. Use the search box above to add one.
        </div>
      ) : (
        <div className="border border-slate-200 rounded-xl overflow-x-auto shadow-2xs">
          <table className="min-w-full divide-y divide-slate-200 text-xs sm:text-sm">
            <thead className="bg-surface">
              <tr>
                <th className="px-4 py-3 text-left font-bold text-ink-secondary uppercase tracking-wider">Item Details</th>
                <th className="px-3 py-3 text-center font-bold text-ink-secondary uppercase tracking-wider">Qty</th>
                <th className="px-3 py-3 text-right font-bold text-ink-secondary uppercase tracking-wider">Price</th>
                <th className="px-3 py-3 text-right font-bold text-ink-secondary uppercase tracking-wider">Discount</th>
                <th
                  className="px-3 py-3 text-center font-bold text-ink-secondary uppercase tracking-wider"
                  title="Changes the price here only — Zoho still bills at the item's own configured tax once this order syncs, so the two can differ."
                >
                  Tax <span className="text-[9px] normal-case font-medium text-ink-secondary/70">(this order only)</span>
                </th>
                <th className="px-4 py-3 text-right font-bold text-ink-secondary uppercase tracking-wider">Amount</th>
                <th className="px-3 py-3 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
              {rows.map((row, idx) => {
                const inactive = !activeProductIds.has(String(row.product_id));
                return (
                  <tr key={idx} className={inactive ? 'bg-state-error-light/40' : 'hover:bg-surface/50 transition-colors'}>
                    <td className="px-4 py-3 min-w-[11rem]">
                      <p className="font-semibold text-ink-primary whitespace-nowrap">{row.name}</p>
                      <span className="text-[11px] font-mono text-ink-secondary">{row.sku}</span>
                      {inactive && (
                        <p className="text-[11px] text-red-700 mt-1 flex items-center gap-1 font-medium">
                          <AlertCircle className="w-3.5 h-3.5" /> No longer active in Zoho
                        </p>
                      )}
                      {/* Sep 18, 2026: why this line is priced this way — kept
                          editable here even for a MedRep who cannot touch
                          Rate/Discount (canEditPrice, Management-only below):
                          explaining a price is not the same as setting one. */}
                      <input
                        type="text"
                        value={row.price_remark || ''}
                        onChange={(e) => onChange(idx, 'price_remark', e.target.value)}
                        maxLength={300}
                        placeholder="Price remark (optional) — why this rate/discount"
                        title="Visible to Management and Finance"
                        className="mt-1 block w-full text-[11px] text-ink-secondary placeholder:text-ink-secondary/50 border border-transparent hover:border-slate-200 focus:border-getmeds-blue rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-getmeds-blue bg-transparent focus:bg-white"
                      />
                      {/* Sep 22, 2026: per-line override of the order's own
                          Invoicing From — same control and gating as the
                          order form's own (canEditPrice, Management/admin
                          only). Set to the other entity and this becomes a
                          split-invoicing order on save. */}
                      {canEditPrice && orderInvoicingFrom && (
                        <select
                          value={row.invoicing_from || ''}
                          onChange={(e) => onChange(idx, 'invoicing_from', e.target.value)}
                          title="Bill this line under a different entity than the order's own Invoicing From — creates a second Zoho Sales Order for it"
                          className="mt-1 block w-full text-[11px] font-semibold text-ink-secondary border border-transparent hover:border-slate-200 focus:border-getmeds-blue rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-getmeds-blue bg-transparent focus:bg-white"
                        >
                          <option value="">Invoicing From: {orderInvoicingFrom} (follows order)</option>
                          {INVOICING_FROM_OPTIONS.filter((v) => v !== orderInvoicingFrom).map((v) => (
                            <option key={v} value={v}>Invoicing From: {v} (split)</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <input
                        type="text"
                        inputMode="numeric"
                        value={row.quantity}
                        onChange={(e) => onChange(idx, 'quantity', e.target.value)}
                        onBlur={() => onBlurField(idx, 'quantity')}
                        onFocus={(e) => e.target.select()}
                        className={`w-16 ${inputClass}`}
                      />
                    </td>
                    {/* Price and discount: Management only. A MedRep sets the
                        price when raising the order; changing it afterwards is
                        Management's call. */}
                    <td className="px-3 py-3 text-right">
                      {canEditPrice ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={row.rate}
                          onChange={(e) => onChange(idx, 'rate', e.target.value)}
                          onBlur={() => onBlurField(idx, 'rate')}
                          onFocus={(e) => e.target.select()}
                          className={`w-24 !text-right px-1.5 ${inputClass}`}
                        />
                      ) : (
                        <span className="font-semibold text-ink-primary">{peso(row.rate)}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      {canEditPrice ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          value={row.discount}
                          onChange={(e) => onChange(idx, 'discount', e.target.value)}
                          onBlur={() => onBlurField(idx, 'discount')}
                          onFocus={(e) => e.target.select()}
                          className={`w-20 !text-right px-1.5 ${inputClass}`}
                        />
                      ) : (
                        <span className="text-ink-secondary">{peso(row.discount)}</span>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {/* Sep 14, 2026: used to be a read-only badge unless
                          nobody had pulled the product's tax from Zoho yet.
                          Sep 18, 2026: editable for every item on request —
                          picking a preset changes THIS order's price/total;
                          Zoho still bills at the item's own tax on sync (see
                          the column header). */}
                      {(() => {
                        const product = productById.get(String(row.product_id));
                        const zohoPct = product?.tax_percentage;
                        return (
                          <select
                            value={row.taxOption || 'none'}
                            onChange={(e) => onChange(idx, 'taxOption', e.target.value)}
                            title={
                              zohoPct != null
                                ? `Zoho has this item at ${product.tax_name || 'VAT'} (${zohoPct}%) — this only changes the price in this order`
                                : 'Not yet pulled from Zoho — this only changes the price in this order'
                            }
                            className="border border-slate-300 rounded py-1 px-1 text-[11px] font-semibold text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
                          >
                            {TAX_OPTIONS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </select>
                        );
                      })()}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-ink-primary font-mono whitespace-nowrap">
                      {peso(lines[idx].amount)}
                    </td>
                    <td className="px-3 py-3 text-center">
                      <button
                        type="button"
                        onClick={() => onRemove(idx)}
                        title="Remove this line"
                        className="text-slate-400 hover:text-red-600 p-1"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot className="bg-surface/80 border-t-2 border-slate-200">
              <tr>
                <td colSpan={5} className="px-4 py-2 text-right font-semibold text-ink-secondary text-xs">Subtotal</td>
                <td colSpan={2} className="px-4 py-2 text-right font-semibold text-ink-primary font-mono text-xs">{peso(totals.subtotal)}</td>
              </tr>
              {totals.discount > 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-2 text-right font-semibold text-ink-secondary text-xs">Total Discount</td>
                  <td colSpan={2} className="px-4 py-2 text-right font-semibold text-state-error font-mono text-xs">-{peso(totals.discount)}</td>
                </tr>
              )}
              {totals.tax > 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-2 text-right font-semibold text-ink-secondary text-xs">
                    {inclusive ? 'Tax (included in the rates above)' : 'Total Tax'}
                  </td>
                  <td colSpan={2} className={`px-4 py-2 text-right font-semibold font-mono text-xs ${inclusive ? 'text-ink-secondary' : 'text-ink-primary'}`}>
                    {inclusive ? '' : '+'}{peso(totals.tax)}
                  </td>
                </tr>
              )}
              <tr>
                <td colSpan={5} className="px-4 py-3.5 text-right font-bold text-ink-primary uppercase tracking-wider text-xs">Grand Total:</td>
                <td colSpan={2} className="px-4 py-3.5 text-right font-extrabold text-getmeds-blue text-base font-mono">{peso(totals.grand)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-xs border border-slate-300 text-ink-secondary rounded hover:bg-surface"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onSave}
          className="px-3 py-1.5 text-xs font-semibold bg-getmeds-blue text-white rounded hover:bg-getmeds-blue-dark disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>
    </div>
  );
};

export default OrderItemsEditor;
