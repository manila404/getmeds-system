import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import { formatPHT } from '../../utils/dateUtils';

/**
 * The order's raw, flat event log — every audit event in strict time order,
 * un-grouped — behind a button instead of permanently at the bottom of the page.
 *
 * Sep 24, 2026: the Audit Timeline now nests every event under the milestone it
 * happened during, so a second, flat copy of the same list on the page was
 * clutter. It's kept here rather than deleted because it is the one view that
 * shows events exactly as recorded (event id, raw type, timestamp), which is
 * what you want when the grouped view looks wrong — a stage's own timestamp
 * once put unrelated updates under the wrong milestone, and the flat order is
 * how that was found. Also a safety net: the timeline can choose to omit an
 * event type (orderTimelineService's "system" tier); this cannot.
 */
const RawEventLogModal = ({ isOpen, onClose, events, order, titleFor, iconFor, roleLabel }) => {
  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-10" role="dialog" aria-modal="true" aria-labelledby="raw-log-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={onClose} aria-hidden="true" />

      <div className="relative w-full max-w-3xl rounded-xl bg-white shadow-xl">
        <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="raw-log-title" className="text-base font-semibold text-ink-primary">Raw event log</h2>
            <p className="text-xs text-ink-secondary mt-0.5">
              {events.length} {events.length === 1 ? 'entry' : 'entries'} · {order?.getmeds_order_id} · oldest first, exactly as recorded
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-ink-primary">
            <X className="h-5 w-5" />
          </button>
        </div>

        <ol className="divide-y divide-slate-100 px-5">
          {events.map((event) => (
            <li key={event.id} className="flex gap-3 py-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-getmeds-blue/10 text-sm" aria-hidden="true">
                {iconFor(event)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-4">
                  <p className="text-sm font-semibold text-ink-primary">
                    {titleFor(event)}
                    {event.old_status && event.new_status && event.old_status !== event.new_status && (
                      <span className="ml-2 text-xs font-normal text-ink-secondary">
                        {event.old_status} → <span className="font-semibold text-ink-primary">{event.new_status}</span>
                      </span>
                    )}
                  </p>
                  <p className="shrink-0 text-xs text-ink-secondary tabular-nums" title={event.created_at}>
                    {event.created_at ? formatPHT(event.created_at, 'datetime') : ''}
                  </p>
                </div>
                {event.notes && <p className="mt-0.5 text-xs text-ink-secondary">{event.notes}</p>}
                <p className="mt-0.5 text-xs text-ink-secondary">
                  By: {event.actor_name || 'System'}
                  {event.actor_role && <span className="font-semibold"> · {roleLabel(event.actor_role)}</span>}
                </p>
                <p className="mt-1 font-mono text-[10px] text-slate-400">
                  #{event.id} · {event.event_type}
                  {event.occurred_at_exact === false && ' · date only (no time from Zoho)'}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
};

export default RawEventLogModal;
