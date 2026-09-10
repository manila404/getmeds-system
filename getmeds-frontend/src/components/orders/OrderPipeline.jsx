import React, { useState } from 'react';
import { Check, Minus, ChevronRight, Clock, XCircle, Info } from 'lucide-react';
import { formatPHT } from '../../utils/dateUtils';

/**
 * The order's life as a ten-stage pipeline.
 *
 * Sep 10, 2026 (2d). Replaces a flat list that showed every event equally —
 * ZOHO-SO-67262 rendered 20 rows for an order that did six things, most of them
 * Zoho Inventory workflow chatter, and the six real ones were impossible to
 * pick out.
 *
 * Simple by default, detailed on request. Ten rows always; anything that is not
 * a stage collapses under the stage it followed as "N updates", one click away.
 *
 * The backend decides what a stage IS and what belongs under it — see
 * services/orderTimelineService.js. This file only draws it, so re-tiering an
 * event type later is a backend edit and this component needs no change.
 */

const STATE_STYLE = {
  done: {
    ring: 'bg-pharmacy-green text-white',
    text: 'text-ink-primary',
    icon: (
      <Check className="w-3.5 h-3.5" strokeWidth={3} />
    )
  },
  // Sep 10, 2026 (3b): true, but known only from Zoho's current status — no
  // timestamp and no person, because Zoho's `shipped_status` says THAT an
  // order shipped and never when or by whom. Drawn as a hollow tick so a
  // reader can tell at a glance which stages are precise and which are merely
  // certain; filling it in solid would claim a precision we do not have.
  done_from_state: {
    ring: 'bg-white text-pharmacy-green border-2 border-pharmacy-green',
    text: 'text-ink-primary',
    icon: <Check className="w-3 h-3" strokeWidth={3} />
  },
  pending: {
    ring: 'bg-slate-100 text-slate-400 border border-slate-200',
    text: 'text-ink-secondary',
    icon: <Clock className="w-3 h-3" />
  },
  // Real, but it happened somewhere else — see the note the backend attaches.
  not_applicable: {
    ring: 'bg-amber-50 text-amber-600 border border-amber-200',
    text: 'text-ink-secondary',
    icon: <Minus className="w-3.5 h-3.5" strokeWidth={3} />
  },
  terminal: {
    ring: 'bg-state-error text-white',
    text: 'text-red-800',
    icon: <XCircle className="w-3.5 h-3.5" />
  }
};

const SourceBadge = ({ source }) => {
  if (!source) return null;
  // Which system this actually happened in. Worth showing: an order can be
  // raised here and fulfilled in Zoho, and "who do I chase" depends on it.
  const zoho = source === 'zoho';
  return (
    <span
      className={`ml-2 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${
        zoho
          ? 'bg-getmeds-blue/10 text-getmeds-blue-dark border-getmeds-blue/25'
          : 'bg-slate-100 text-slate-600 border-slate-200'
      }`}
    >
      {zoho ? 'Zoho' : 'GetMeds'}
    </span>
  );
};

const Updates = ({ updates }) => {
  const [open, setOpen] = useState(false);
  if (!updates?.length) return null;

  return (
    <div className="mt-1.5">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-[11px] font-semibold text-getmeds-blue hover:text-getmeds-blue-dark"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {updates.length} update{updates.length === 1 ? '' : 's'}
      </button>

      {open && (
        <div className="mt-1.5 space-y-1.5 border-l-2 border-slate-100 pl-3">
          {updates.map((u) => (
            <div key={u.id} className="text-[11px]">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold text-ink-primary">
                  {(u.event_type || '').replace(/^ZOHO_/, '').replace(/_/g, ' ')}
                  <SourceBadge source={u.source} />
                </span>
                <span className="text-ink-secondary shrink-0">
                  {u.at ? formatPHT(u.at, 'timeline') : ''}
                </span>
              </div>
              {u.note && <p className="text-ink-secondary mt-0.5">{u.note}</p>}
              {u.by && <p className="text-ink-secondary/80 mt-0.5">By: {u.by}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

const OrderPipeline = ({ timeline }) => {
  const stages = timeline?.stages || [];
  const counts = timeline?.counts || {};

  if (!stages.length) {
    return <p className="text-sm text-ink-secondary text-center py-8">No events recorded yet.</p>;
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-4">
        <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide">
          Progress
          <span className="ml-2 font-bold text-ink-primary normal-case tracking-normal">
            {counts.reached ?? 0} of {counts.of ?? stages.length} stages
          </span>
        </p>
        <div className="text-[11px] text-ink-secondary text-right">
          {counts.updates > 0 && (
            <p>{counts.updates} update{counts.updates === 1 ? '' : 's'} along the way</p>
          )}
          {counts.from_state > 0 && (
            <p>
              {counts.from_state} stage{counts.from_state === 1 ? '' : 's'} from Zoho status — exact
              times arrive with the next history sync
            </p>
          )}
        </div>
      </div>

      <div className="space-y-0">
        {stages.map((s, i) => {
          const byState = s.state === 'done' && s.evidence === 'state';
          const style = byState
            ? STATE_STYLE.done_from_state
            : STATE_STYLE[s.state] || STATE_STYLE.pending;
          const last = i === stages.length - 1;

          return (
            <div key={`${s.key}-${i}`} className="flex gap-3">
              <div className="flex flex-col items-center">
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 ${style.ring}`}
                >
                  {style.icon}
                </div>
                {/* The connector is solid up to where the order has got to and
                    dashed beyond it, so how far along it is reads without
                    counting ticks. */}
                {!last && (
                  <div
                    className={`w-0.5 flex-1 my-1 min-h-[1rem] ${
                      s.state === 'done'
                        ? 'bg-pharmacy-green/30'
                        : 'bg-slate-150 border-l border-dashed border-slate-200'
                    }`}
                  />
                )}
              </div>

              <div className={`pb-4 flex-1 min-w-0 ${last ? 'pb-0' : ''}`}>
                <div className="flex items-baseline justify-between gap-3">
                  <p className={`text-sm font-semibold ${style.text}`}>
                    {s.label}
                    <SourceBadge source={s.source} />
                  </p>
                  <p className="text-xs text-ink-secondary shrink-0">
                    {s.at ? formatPHT(s.at, 'timeline') : ''}
                  </p>
                </div>

                {s.by && <p className="text-xs text-ink-secondary mt-0.5">By: {s.by}</p>}

                {/* A stage known only from Zoho's status. Said plainly rather
                    than left as a tick with a blank date, which reads like
                    missing data instead of a different kind of certainty. */}
                {byState && (
                  <p className="mt-1 flex items-start gap-1.5 text-[11px] text-ink-secondary bg-surface border border-slate-200 rounded px-2 py-1.5">
                    <Info className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{s.note}</span>
                  </p>
                )}

                {/* Only shown for the stages that did not happen HERE. The
                    backend supplies the wording; the point is that a stage
                    which quietly vanished would be indistinguishable from a
                    control somebody skipped. */}
                {s.state === 'not_applicable' && s.note && (
                  <p className="mt-1 flex items-start gap-1.5 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    <Info className="w-3 h-3 mt-0.5 shrink-0" />
                    <span>{s.note}</span>
                  </p>
                )}

                {s.state === 'done' && !byState && s.note && (
                  <p className="text-xs text-ink-secondary mt-0.5">{s.note}</p>
                )}

                {s.state === 'terminal' && s.note && (
                  <p className="text-xs text-red-800 mt-0.5">{s.note}</p>
                )}

                <Updates updates={s.updates} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default OrderPipeline;
