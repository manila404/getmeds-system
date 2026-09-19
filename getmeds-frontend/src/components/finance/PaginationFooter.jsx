import React from 'react';

/**
 * Sep 19, 2026: "always paginate tables into 25 entry" — one Previous/Next
 * footer, shared by My Confirmations, the Reports tab and (in spirit) the
 * main queue's own, so "page" means the same thing everywhere on this page.
 */
const PaginationFooter = ({ pagination, onPageChange, isFetching, itemLabel = 'entries' }) => {
  if (!pagination || pagination.pages <= 1) return null;
  const { page, pages, total } = pagination;

  return (
    <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-slate-200 bg-surface">
      <p className="text-xs text-ink-secondary">
        Page {page} of {pages.toLocaleString('en-PH')} · {total.toLocaleString('en-PH')} {itemLabel}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={page <= 1 || isFetching}
          onClick={() => onPageChange(Math.max(1, page - 1))}
          className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= pages || isFetching}
          onClick={() => onPageChange(page + 1)}
          className="px-3 py-1.5 rounded-md border border-slate-200 bg-white text-xs font-semibold text-ink-secondary hover:bg-surface hover:text-ink-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Next
        </button>
      </div>
    </div>
  );
};

export default PaginationFooter;
