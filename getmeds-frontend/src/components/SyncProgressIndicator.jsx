import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Aug 28, 2026: shared progress display for the Quick Sync / Full Resync
 * background jobs (Clients Directory + Inventory pages) — one component,
 * one look, for both. `job` is the `data.data` shape returned by
 * GET /api/sync-jobs/:jobId (see services/syncJobs.js):
 *   { status: 'running'|'done'|'error', mode: 'quick'|'full',
 *     processed, total, percent, ... }
 *
 * When `job.total` is known (an estimate from a prior Full Resync), shows
 * a real percentage bar. Otherwise (a Quick Sync, or the very first Full
 * Resync with no prior estimate to go on) shows an indeterminate "N found
 * so far" counter instead of a fake/misleading percentage.
 */
const SyncProgressIndicator = ({ job }) => {
  if (!job || job.status !== 'running') return null;

  const modeLabel = job.mode === 'full' ? 'Full Resync' : 'Quick Sync';
  const hasPercent = job.percent !== null && job.percent !== undefined;

  return (
    <div className="w-full max-w-sm">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-600 mb-1">
        <Loader2 size={12} className="animate-spin" />
        {modeLabel} in progress
        {hasPercent ? (
          <span className="text-slate-400 font-medium">— {job.percent}%</span>
        ) : (
          <span className="text-slate-400 font-medium">— {job.processed} found so far...</span>
        )}
      </div>
      {hasPercent ? (
        <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-getmeds-blue transition-all duration-300 ease-out rounded-full"
            style={{ width: `${Math.max(4, job.percent)}%` }}
          />
        </div>
      ) : (
        <div className="h-1.5 w-full bg-slate-100 rounded-full overflow-hidden relative">
          <div className="h-full w-1/3 bg-getmeds-blue rounded-full absolute animate-[indeterminate_1.2s_ease-in-out_infinite]" />
        </div>
      )}
      <style>{`
        @keyframes indeterminate {
          0% { left: -33%; }
          100% { left: 100%; }
        }
      `}</style>
    </div>
  );
};

export default SyncProgressIndicator;
