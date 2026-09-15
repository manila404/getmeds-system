import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Megaphone, X } from 'lucide-react';
import client from '../../api/client';
import { useProducts } from '../../hooks/useOrderData';
import ProductAutocomplete from '../orders/ProductAutocomplete';
import { STOCK_KINDS, StockAnnouncementLine, useStockAnnouncements } from './StockAnnouncements';

/**
 * Dispatch posts and resolves stock announcements (Sep 15, 2026).
 *
 * Pick the product, say what is happening (out of stock, back, low, an
 * update) and, optionally, a message. MedReps and Management see it on their
 * dashboards, and on the order form when they add that product, until it is
 * resolved here. Posting about a product replaces its earlier announcement.
 */
const StockAnnouncementsManager = () => {
  const qc = useQueryClient();
  const { data: open = [] } = useStockAnnouncements();
  const { data: products = [] } = useProducts();
  const [expanded, setExpanded] = useState(false);
  const [product, setProduct] = useState(null);
  const [kind, setKind] = useState('out_of_stock');
  const [message, setMessage] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: ['stock-announcements'] });
  const errorOf = (err, fallback) => err.response?.data?.error?.message || fallback;

  const post = useMutation({
    mutationFn: () =>
      client.post('/api/stock-announcements', { product_id: product.id, kind, message: message.trim() }).then((r) => r.data?.data),
    onSuccess: () => {
      toast.success(`Posted — MedReps and Management now see it for ${product.name}.`);
      setProduct(null);
      setMessage('');
      refresh();
    },
    onError: (err) => toast.error(errorOf(err, 'Could not post the announcement.'), { duration: 8000 })
  });
  const resolve = useMutation({
    mutationFn: (id) => client.post(`/api/stock-announcements/${id}/resolve`).then((r) => r.data?.data),
    onSuccess: () => {
      toast.success('Taken down.');
      refresh();
    },
    onError: (err) => toast.error(errorOf(err, 'Could not take it down.'))
  });

  return (
    <div className="bg-white shadow rounded-lg border border-slate-200">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-ink-primary flex items-center gap-2">
          <Megaphone className="w-4 h-4 text-getmeds-blue" />
          Stock announcements
          <span className={`min-w-[1.5rem] text-center rounded-full px-1.5 text-xs tabular-nums ${open.length ? 'bg-getmeds-blue text-white' : 'bg-slate-100 text-ink-secondary'}`}>
            {open.length}
          </span>
        </span>
        <span className="text-xs font-semibold text-getmeds-blue">{expanded ? 'Hide' : 'Announce stock / manage'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-slate-100 pt-3">
          <div className="rounded-lg border border-slate-200 bg-surface p-3 space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink-secondary">New announcement</p>
            {product ? (
              <div className="flex items-center justify-between gap-2 rounded border border-slate-200 bg-white px-2.5 py-1.5 text-sm">
                <span>
                  <span className="font-semibold">{product.name}</span>
                  {product.sku && <span className="ml-1 text-xs font-mono text-ink-secondary">{product.sku}</span>}
                </span>
                <button type="button" onClick={() => setProduct(null)} className="text-ink-secondary hover:text-ink-primary" title="Pick another product">
                  <X className="w-4 h-4" />
                </button>
              </div>
            ) : (
              <ProductAutocomplete products={products} onSelect={setProduct} placeholder="Search the product this is about…" />
            )}
            <div className="flex flex-wrap gap-2">
              {Object.entries(STOCK_KINDS).map(([key, k]) => (
                <label
                  key={key}
                  className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-semibold cursor-pointer ${kind === key ? k.className : 'border-slate-200 bg-white text-ink-secondary'}`}
                >
                  <input type="radio" name="stock-kind" className="sr-only" checked={kind === key} onChange={() => setKind(key)} />
                  {k.icon} {k.label}
                </label>
              ))}
            </div>
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              maxLength={300}
              placeholder="Message (optional) — e.g. Next delivery Sep 20; use CarboGet 450 instead"
              className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
            />
            <div className="flex justify-end">
              <button
                type="button"
                disabled={!product || post.isPending}
                onClick={() => post.mutate()}
                className="px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50"
              >
                {post.isPending ? 'Posting…' : 'Post to MedReps & Management'}
              </button>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-[11px] font-bold uppercase tracking-wide text-ink-secondary">Showing now ({open.length})</p>
            {open.length === 0 ? (
              <p className="text-sm text-ink-secondary">Nothing posted.</p>
            ) : (
              open.map((a) => (
                <StockAnnouncementLine
                  key={a.id}
                  a={a}
                  right={
                    <button
                      type="button"
                      disabled={resolve.isPending}
                      onClick={() => resolve.mutate(a.id)}
                      className="shrink-0 px-2.5 py-1 rounded-md border border-slate-300 bg-white text-xs font-semibold text-ink-secondary hover:bg-surface disabled:opacity-50"
                    >
                      Resolved — take down
                    </button>
                  }
                />
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default StockAnnouncementsManager;
