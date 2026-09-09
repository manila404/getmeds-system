import React, { createContext, useContext, useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  startCustomersSyncJob,
  startInventorySyncJob,
  startSalesOrdersImportJob,
  fetchSyncJobStatus
} from '../api/queries';

/**
 * Quick Sync / Full Resync progress, tracked ABOVE the router.
 *
 * Sep 2, 2026. The pull itself was always a background job on the server —
 * POST .../start returns 202 + a job_id immediately and the work carries on
 * (see services/syncJobs.js). What was NOT background was the watching of
 * it: `syncJobId` lived in useState inside ClientsPage/InventoryPage, so
 * clicking any other tab unmounted the page and took the job id with it.
 *
 * The consequences all looked like "the sync stopped", and none of them were:
 *   - polling ended, so the progress bar vanished;
 *   - the completion toast never fired;
 *   - the table/stats were never invalidated, so coming back showed the OLD
 *     numbers even though the rows had landed;
 *   - the buttons re-enabled, inviting a second identical pull on an org
 *     with a daily API budget.
 *
 * Hoisting the id here — one provider, mounted for the whole session —
 * fixes all four, because the poll no longer depends on which page is on
 * screen. The id is also mirrored into sessionStorage, so a browser refresh
 * mid-pull reattaches to the same job rather than losing it. (Per tab, like
 * the auth token; see api/client.js for that reasoning.)
 *
 * What this does NOT survive is the SERVER restarting: the job registry is
 * in-memory by design, so `npm run dev:test`'s nodemon reloading on a file
 * save ends any pull in flight. The poll then 404s, which is reported as
 * such rather than left spinning forever.
 */

const STORAGE_KEY = 'getmeds.syncJobs';

// Everything that differs between the two pulls, in one place, so the
// polling/completion machinery below is written once.
const KINDS = {
  customers: {
    start: startCustomersSyncJob,
    invalidate: [['clients'], ['clients-stats']],
    noun: 'contact',
    truncatedNoun: 'contact',
    done: (r) => `${r.created ?? 0} new, ${r.updated ?? 0} refreshed`
  },
  inventory: {
    start: startInventorySyncJob,
    invalidate: [['inventoryStatus'], ['products']],
    noun: 'item',
    truncatedNoun: 'item',
    done: (r) => `${r.created ?? 0} new product(s), ${r.updated ?? 0} updated`
  },
  // Sep 9, 2026: the Sales Order import. Same machinery, one difference worth
  // noting — `truncated` here does NOT mean the pull broke. This import is
  // capped per run on purpose (each order costs two Zoho reads, against a
  // rate-limited API), so hitting the cap is the expected way a large history
  // is imported: repeated runs. The completion message below says how many
  // are left rather than reporting a warning for normal operation.
  salesorders: {
    start: startSalesOrdersImportJob,
    invalidate: [['management-orders'], ['management-summary'], ['orders'], ['zoho-import-status']],
    noun: 'Sales Order',
    truncatedNoun: 'Sales Order',
    done: (r) =>
      `${r.imported ?? 0} imported` +
      (r.already_present ? `, ${r.already_present} refreshed` : '') +
      (r.linked ? `, ${r.linked} re-linked` : '') +
      (r.log_entries ? `, ${r.log_entries} Zoho log entr${r.log_entries === 1 ? 'y' : 'ies'} added` : '') +
      (r.salespersons_backfilled ? `, ${r.salespersons_backfilled} salesperson(s) filled in` : '') +
      (r.failed ? `, ${r.failed} failed` : '')
  }
};

const SyncJobsContext = createContext(null);

const readStored = () => {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY)) || {};
  } catch (e) {
    return {};
  }
};

const writeStored = (ids) => {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch (e) {
    /* private mode / storage disabled — the in-memory copy still works */
  }
};

/**
 * One kind's poll. A component rather than a loop because hooks cannot be
 * called in one, and a component per kind keeps each poll's lifecycle its
 * own. Renders nothing.
 */
const JobWatcher = ({ kind, jobId, onSettled }) => {
  const qc = useQueryClient();
  const config = KINDS[kind];

  const { data, isError } = useQuery({
    queryKey: ['sync-job', kind, jobId],
    queryFn: () => fetchSyncJobStatus(jobId),
    enabled: !!jobId,
    retry: false,
    // Poll while running; stop the moment it is done, errored, or gone.
    refetchInterval: (query) => (query.state.data?.data?.status === 'running' ? 1200 : false)
  });

  const job = data?.data || null;
  const status = job?.status;

  useEffect(() => {
    // A 404 means the server forgot the job — almost always a restart
    // mid-pull. Say so plainly instead of spinning forever.
    if (isError) {
      toast.error('Lost track of the sync — the server restarted while it was running. Start it again.');
      onSettled(kind);
      return;
    }
    if (!status || status === 'running') return;

    // "Full Resync" is the right word for mirroring a list of contacts or
    // items; it is the wrong one for adopting orders, which is an import, not
    // a re-download. The label follows the kind so the toast says what the
    // button said.
    const modeLabel =
      kind === 'salesorders'
        ? job.mode === 'full'
          ? 'Sales Order import'
          : 'Sales Order quick sync'
        : job.mode === 'full'
          ? 'Full Resync'
          : 'Quick Sync';

    if (status === 'done') {
      for (const key of config.invalidate) qc.invalidateQueries({ queryKey: key });
      const r = job.result || {};
      // The import's cap is by design, not a failure — see the salesorders
      // entry in KINDS above. Reported as "there is more to fetch, run it
      // again", rather than through the generic truncation warning below,
      // which exists for a pull that could not finish.
      if (kind === 'salesorders' && r.remaining) {
        toast.success(
          `${modeLabel} complete — ${config.done(r)}. ` +
            `${r.remaining} Sales Order(s) still to import, beyond this run's limit of ${r.capped_at} — ` +
            'press it again to take the next batch.',
          { icon: '📥', duration: 12000 }
        );
      } else if (r.truncated) {
        toast.error(
          `⚠️ ${modeLabel} pulled ${r.total_from_zoho ?? 0} ${config.truncatedNoun}(s), but Zoho reported even ` +
            `more beyond this pull's safety limit — incomplete (${config.done(r)}). Nothing was written to Zoho.`,
          { icon: '⚠️', duration: 15000 }
        );
      } else {
        toast.success(
          `${modeLabel} complete — ${config.done(r)}` + (r.skipped ? `, ${r.skipped} skipped` : '') + '.',
          { icon: '🔄' }
        );
      }
    } else if (status === 'error') {
      toast.error(`${modeLabel} failed: ${job.error || 'unknown error'}`);
    }

    onSettled(kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, isError]);

  return null;
};

export const SyncJobsProvider = ({ children }) => {
  const [jobIds, setJobIds] = useState(readStored);
  // The last status seen for each kind, so a page that mounts halfway
  // through a pull can draw the progress bar immediately instead of waiting
  // for the next poll tick.
  const [jobs, setJobs] = useState({});
  const qc = useQueryClient();

  useEffect(() => writeStored(jobIds), [jobIds]);

  // Mirror each running job's latest status out of the query cache, so
  // consumers get it without subscribing to the query themselves.
  useEffect(() => {
    const unsubscribe = qc.getQueryCache().subscribe(() => {
      const next = {};
      for (const [kind, id] of Object.entries(jobIds)) {
        if (!id) continue;
        const cached = qc.getQueryData(['sync-job', kind, id]);
        if (cached?.data) next[kind] = cached.data;
      }
      setJobs((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    });
    return unsubscribe;
  }, [qc, jobIds]);

  const clear = (kind) => {
    setJobIds((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
    setJobs((prev) => {
      const next = { ...prev };
      delete next[kind];
      return next;
    });
  };

  const startMutation = useMutation({
    mutationFn: ({ kind, mode }) => KINDS[kind].start(mode),
    onSuccess: (res, { kind }) => setJobIds((prev) => ({ ...prev, [kind]: res.data.job_id })),
    onError: (err) => {
      const msg = err.response?.data?.error?.message || err.response?.data?.message || err.message;
      toast.error(`Could not start sync: ${msg}`);
    }
  });

  const startSync = (kind, mode) => startMutation.mutate({ kind, mode });

  const value = {
    startSync,
    isStarting: startMutation.isPending,
    // The job a page should render, or null. Present as soon as the id is
    // known, so the buttons disable on the first click rather than on the
    // first poll response.
    jobFor: (kind) => (jobIds[kind] ? jobs[kind] || { status: 'running', mode: null, processed: 0, percent: null } : null),
    isRunning: (kind) => !!jobIds[kind]
  };

  return (
    <SyncJobsContext.Provider value={value}>
      {Object.entries(jobIds).map(([kind, id]) =>
        id ? <JobWatcher key={`${kind}-${id}`} kind={kind} jobId={id} onSettled={clear} /> : null
      )}
      {children}
    </SyncJobsContext.Provider>
  );
};

export const useSyncJobs = () => {
  const ctx = useContext(SyncJobsContext);
  if (!ctx) throw new Error('useSyncJobs must be used within a SyncJobsProvider');
  return ctx;
};
