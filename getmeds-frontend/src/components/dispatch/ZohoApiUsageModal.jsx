import React, { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, AlertTriangle, CheckCircle2, RefreshCw, X } from 'lucide-react';
import client from '../../api/client';

/**
 * Native <dialog> modal showing Hub's daily Zoho API usage from Postgres sync_state
 * (costs 0 Zoho API calls). Visible strictly to Admin and Aaron Dispatch.
 */
const ZohoApiUsageModal = ({ open, onClose }) => {
  const dialogRef = useRef(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['dispatch-zoho-quota'],
    queryFn: () => client.get('/api/dispatch/zoho-quota').then((r) => r.data?.data),
    enabled: open,
    staleTime: 15_000,
    retry: false
  });

  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  // Progressive enhancement fallback for browsers without <dialog closedby="any"> (e.g. Safari)
  useEffect(() => {
    const dlg = dialogRef.current;
    if (!dlg || ('closedBy' in HTMLDialogElement.prototype)) return undefined;
    let pressedOutside = false;
    const isOutside = (e) => {
      const r = dlg.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    const onDown = (e) => { pressedOutside = isOutside(e); };
    const onUp = (e) => { if (pressedOutside && isOutside(e)) dlg.close(); };
    dlg.addEventListener('pointerdown', onDown);
    dlg.addEventListener('pointerup', onUp);
    return () => {
      dlg.removeEventListener('pointerdown', onDown);
      dlg.removeEventListener('pointerup', onUp);
    };
  }, []);

  if (!open) return null;

  const callsToday = Number(data?.callsToday || 0);
  const dailyCap = Number(data?.dailyCap || 10000);
  const remaining = Math.max(0, Number(data?.remainingEstimate ?? (dailyCap - callsToday)));
  const pct = Math.min(100, Math.round((callsToday / Math.max(1, dailyCap)) * 100));
  const isLimited = Boolean(data?.limited);
  const isHigh = pct >= 80;

  return (
    <>
      <style>{`
        dialog.zoho-quota-dialog:modal { overscroll-behavior: contain; }
        dialog.zoho-quota-dialog::backdrop {
          background: rgba(15, 23, 42, 0.45);
          overflow: hidden;
          overscroll-behavior: contain;
        }
      `}</style>
      <dialog
        ref={dialogRef}
        closedby="any"
        aria-labelledby="zoho-quota-title"
        onClose={onClose}
        className="zoho-quota-dialog m-auto w-full max-w-lg rounded-lg border border-slate-200 bg-white p-0 shadow-xl text-ink-primary"
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-getmeds-blue" />
            <h1 id="zoho-quota-title" className="text-base font-semibold text-ink-primary">
              Zoho Inventory API Usage (Today)
            </h1>
          </div>
          <button
            type="button"
            autoFocus
            onClick={onClose}
            aria-label="Close API usage dialog"
            className="rounded-md p-1 text-ink-secondary hover:bg-slate-100 hover:text-ink-primary"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {isLoading ? (
            <div className="py-8 text-center text-sm text-ink-secondary">Loading today&apos;s API counter…</div>
          ) : error ? (
            <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              {error?.response?.data?.error?.message || 'Could not load Zoho API usage.'}
            </div>
          ) : (
            <>
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <p className="text-xs uppercase tracking-wide text-ink-secondary font-medium">
                    Hub Calls Today ({data?.ymd})
                  </p>
                  <p className="text-2xl font-bold tabular-nums text-ink-primary mt-0.5">
                    {callsToday.toLocaleString()} <span className="text-sm font-normal text-ink-secondary">/ {dailyCap.toLocaleString()}</span>
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-ink-secondary">Est. Remaining</p>
                  <p className="text-lg font-semibold tabular-nums text-ink-primary">{remaining.toLocaleString()}</p>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100 border border-slate-200">
                  <div
                    className={`h-full transition-all ${isLimited ? 'bg-red-600' : isHigh ? 'bg-amber-500' : 'bg-pharmacy-green'}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-xs text-ink-secondary">
                  <span>{pct}% of 10,000 daily org cap</span>
                  <span className={`inline-flex items-center gap-1 font-medium ${isLimited ? 'text-red-700' : 'text-pharmacy-green-dark'}`}>
                    {isLimited ? <AlertTriangle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                    {isLimited ? 'Daily Limit Circuit Open' : 'Healthy'}
                  </span>
                </div>
              </div>

              {isLimited && data?.pausedUntil && (
                <div className="rounded-md border border-red-200 bg-red-50 px-3.5 py-2.5 text-xs text-red-800">
                  <p className="font-semibold">Zoho Daily Limit Reached</p>
                  <p className="mt-0.5">{data.reason}</p>
                  <p className="mt-1">Next automatic probe: {new Date(data.pausedUntil).toLocaleString()}</p>
                </div>
              )}

              <div className="rounded-md border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-relaxed text-amber-950">
                <p className="font-semibold flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-700" />
                  Heads up: Shared Zoho Organization Limit
                </p>
                <p className="mt-1">
                  Zoho&apos;s 10,000 calls/day limit is shared across <strong>every application and integration connected to our Zoho org</strong> (not just Getmeds Hub — including external connectors, scripts, or Zoho Deluge API tasks). This counter tracks calls sent by <strong>Getmeds Hub</strong>; for the org-wide total across all systems, check Zoho Inventory Settings → Developer Data → API Usage (built-in Admin/Super Admin only).
                </p>
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-slate-200 bg-slate-50 px-5 py-3 rounded-b-lg">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-ink-primary hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            Refresh Counter
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md bg-slate-900 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </dialog>
    </>
  );
};

export default ZohoApiUsageModal;
