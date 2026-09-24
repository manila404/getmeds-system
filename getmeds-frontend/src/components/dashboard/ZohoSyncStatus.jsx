import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Zap, DownloadCloud, ChevronDown } from 'lucide-react';
import { formatPHT } from '../../utils/dateUtils';
import SyncProgressIndicator from '../SyncProgressIndicator';

/**
 * The dashboard's whole Zoho story in one compact block: is it healthy, how
 * much imported history has its full detail, and the one Sync control.
 *
 * Sep 24, 2026: replaces two coloured buttons and a paragraph of run-on text
 * ("61,008 order(s) imported from Zoho, N Zoho log entries on file — last full
 * import …, 60,214 still awaiting full detail (line items + Zoho history) — 500
 * per run, or pulled on demand…") that read as backend debug output. The same
 * numbers are all still here, but as a status dot and a progress bar, with the
 * explanation available on hover instead of always printed.
 */
const SyncMenu = ({ disabled, perRunLimit, onSync }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const pick = (mode) => { setOpen(false); onSync(mode); };

  return (
    <div className="relative" ref={ref}>
      <div className="inline-flex rounded-lg shadow-sm">
        <button
          type="button"
          onClick={() => pick('quick')}
          disabled={disabled}
          className="inline-flex items-center gap-1.5 pl-3.5 pr-3 py-2 text-xs font-bold rounded-l-lg bg-getmeds-blue text-white hover:bg-getmeds-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          title="Fast — only the Sales Orders created or changed in Zoho since the last import (read-only)"
        >
          <Zap size={14} /> Sync from Zoho
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="More sync options"
          className="inline-flex items-center px-2 py-2 rounded-r-lg bg-getmeds-blue text-white border-l border-white/25 hover:bg-getmeds-blue-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <ChevronDown size={14} />
        </button>
      </div>

      {open && (
        <div role="menu" className="absolute right-0 z-20 mt-1.5 w-72 rounded-xl border border-slate-200 bg-white p-1.5 shadow-lg">
          <button type="button" role="menuitem" onClick={() => pick('quick')} className="w-full text-left rounded-lg px-3 py-2 hover:bg-surface">
            <span className="flex items-center gap-2 text-sm font-semibold text-ink-primary"><Zap size={14} className="text-getmeds-blue" /> Quick sync</span>
            <span className="block text-xs text-ink-secondary mt-0.5 pl-[22px]">Only orders created or changed since the last import.</span>
          </button>
          <button type="button" role="menuitem" onClick={() => pick('full')} className="w-full text-left rounded-lg px-3 py-2 hover:bg-surface">
            <span className="flex items-center gap-2 text-sm font-semibold text-ink-primary"><DownloadCloud size={14} className="text-pharmacy-green" /> Retrieve all Sales Orders</span>
            <span className="block text-xs text-ink-secondary mt-0.5 pl-[22px]">
              Rebuilds each order's trail from Zoho's history — up to {(perRunLimit || 500).toLocaleString()} per run; run again to continue. Read-only.
            </span>
          </button>
        </div>
      )}
    </div>
  );
};

const ZohoSyncStatus = ({ importStatus = {}, importJob, importBusy, failedSyncs, canViewHealth, onSync }) => {
  const imported = importStatus.imported_orders || 0;
  const awaiting = importStatus.awaiting_detail || 0;
  const withDetail = Math.max(0, imported - awaiting);
  const pct = imported > 0 ? Math.round((withDetail / imported) * 100) : 100;

  // failedSyncs is null for anyone who can't see the retry queue — unknown is
  // not "healthy", so it doesn't get the green dot.
  const failing = failedSyncs > 0;
  const state = importBusy ? 'syncing' : failing ? 'failing' : failedSyncs == null ? 'unknown' : 'healthy';
  const STATE = {
    syncing: { dot: 'bg-getmeds-blue animate-pulse', label: 'Syncing with Zoho…' },
    // The count itself is in the Action Needed strip below; repeating it here
    // just said the same thing twice.
    failing: { dot: 'bg-state-error', label: 'Zoho sync needs attention' },
    unknown: { dot: 'bg-state-neutral', label: 'Zoho connection' },
    healthy: { dot: 'bg-pharmacy-green', label: 'Zoho in sync' }
  }[state];

  const statusBlock = (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATE.dot}`} />
      <div className="min-w-0">
        <p className="text-xs font-semibold text-ink-primary leading-tight">{STATE.label}</p>
        <p className="text-[11px] text-ink-secondary leading-tight truncate">
          {importStatus.last_full_import_at
            ? `Last full import ${formatPHT(importStatus.last_full_import_at, 'date')}`
            : 'No full import yet'}
        </p>
      </div>
    </div>
  );

  return (
    <div className="flex flex-col items-stretch md:items-end gap-2">
      <div className="flex items-center gap-3 flex-wrap md:justify-end">
        <div className="rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm">
          {canViewHealth ? (
            <Link to="/admin/zoho-sync" className="block hover:opacity-80 transition-opacity" title="Open Zoho Sync Health">
              {statusBlock}
            </Link>
          ) : statusBlock}
        </div>

        {imported > 0 && awaiting > 0 && (
          <div
            className="w-44 rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm"
            title={
              `${withDetail.toLocaleString()} of ${imported.toLocaleString()} imported orders have their full detail ` +
              `(line items + Zoho history). The rest are summaries from Zoho's list — opening an order pulls its detail ` +
              `on demand, and each Retrieve run fills in up to ${(importStatus.per_run_limit || 500).toLocaleString()} more.`
            }
          >
            <p className="flex justify-between text-[11px] text-ink-secondary leading-tight">
              <span>Imported detail</span>
              <span className="font-semibold text-ink-primary tabular-nums">{pct}%</span>
            </p>
            <div className="mt-1.5 h-1.5 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full rounded-full bg-getmeds-blue transition-all" style={{ width: `${Math.max(pct, 2)}%` }} />
            </div>
          </div>
        )}

        <SyncMenu disabled={importBusy} perRunLimit={importStatus.per_run_limit} onSync={onSync} />
      </div>

      <SyncProgressIndicator
        job={importJob}
        labels={{ full: 'Retrieving Sales Orders from Zoho', quick: 'Quick Sync (Sales Orders)' }}
      />
    </div>
  );
};

export default ZohoSyncStatus;
