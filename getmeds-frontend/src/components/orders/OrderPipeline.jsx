import React, { useState } from 'react';
import { Check, Minus, ChevronRight, Clock, XCircle, Info, Filter, X } from 'lucide-react';
import { formatPHT } from '../../utils/dateUtils';
import { roleLabel } from '../../constants/roles';

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

// Sep 18, 2026: which role did this, next to whose name it was — "By:
// Veronica" alone reads as just a name; the badge says at a glance whether
// this was Management overriding something, the MedRep themselves, Finance,
// or Dispatch, so nobody has to already know who Veronica is.
const ROLE_BADGE_STYLE = {
  management: 'bg-purple-50 text-purple-800 border-purple-200',
  admin: 'bg-purple-50 text-purple-800 border-purple-200',
  medrep: 'bg-getmeds-blue/10 text-getmeds-blue-dark border-getmeds-blue/25',
  finance: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  dispatch: 'bg-teal-50 text-teal-800 border-teal-200'
};

// Sep 21, 2026: exported so OrderDetailPage's Remarks summary (a different
// list of events than this component draws) can use the exact same badge
// rather than a second copy of ROLE_BADGE_STYLE.
export const RoleBadge = ({ role }) => {
  if (!role) return null;
  const cls = ROLE_BADGE_STYLE[role] || 'bg-slate-100 text-slate-600 border-slate-200';
  return (
    <span className={`ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide border ${cls}`}>
      {roleLabel(role)}
    </span>
  );
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
                  {/* Sep 23, 2026: at_exact === false means Zoho only gave us
                      a DATE for this one (an invoice/package/shipment date),
                      not a time — order_events.occurred_at_exact floors it to
                      midnight as the closest honest stand-in. Showing that as
                      a clock time would claim a precision that isn't real. */}
                  {u.at ? formatPHT(u.at, u.at_exact === false ? 'date' : 'timeline') : ''}
                </span>
              </div>
              {u.note && <p className="text-ink-secondary mt-0.5">{u.note}</p>}
              {u.by && (
                <p className="text-ink-secondary/80 mt-0.5 flex items-center flex-wrap">
                  By: {u.by}<RoleBadge role={u.by_role} />
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

/**
 * Sep 22, 2026: split-invoicing orders — `focusEntity` narrows the timeline
 * to one Sales Order's own events, set when its card in the Zoho Integration
 * panel is clicked (see OrderDetailPage.jsx). Raw invoicing_from string, or
 * null to show everything (the default, and the only case for a non-split
 * order). Matched against `perEntity[].entity` / `updates[].entity`, which
 * orderTimelineService.js only ever populates for a split order — this
 * component otherwise renders exactly as it did before this existed.
 */
const OrderPipeline = ({ timeline, focusEntity = null, onClearFocus }) => {
  const stages = timeline?.stages || [];
  const counts = timeline?.counts || {};

  if (!stages.length) {
    return <p className="text-sm text-ink-secondary text-center py-8">No events recorded yet.</p>;
  }

  // The primary's own perEntity entry is always first (see
  // orderTimelineService.js) — used to tell "focused on the primary" (whose
  // own events carry no entity tag at all) apart from "focused on a split".
  const primaryEntity = stages.find((s) => s.perEntity)?.perEntity?.[0]?.entity || null;
  const focusIsPrimary = Boolean(focusEntity) && focusEntity === primaryEntity;
  const matchesFocus = (u) => {
    if (!focusEntity) return true;
    return focusIsPrimary ? !u.entity : u.entity === focusEntity;
  };

  return (
    <div>
      {focusEntity && (
        <div className="mb-4 flex items-center justify-between gap-2 rounded-md border border-getmeds-blue/30 bg-getmeds-blue/5 px-3 py-2">
          <p className="text-xs text-getmeds-blue-dark flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 shrink-0" />
            Focused on <span className="font-semibold">{focusEntity}</span>{focusIsPrimary ? ' (primary)' : ''} — other entities' updates are hidden.
          </p>
          <button
            type="button"
            onClick={onClearFocus}
            className="inline-flex items-center gap-1 text-xs font-semibold text-getmeds-blue hover:text-getmeds-blue-dark shrink-0"
          >
            <X className="w-3.5 h-3.5" /> Clear
          </button>
        </div>
      )}

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
          const visibleUpdates = focusEntity ? (s.updates || []).filter(matchesFocus) : s.updates;

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
                    {/* See the Updates component's same check just above —
                        a stage dated only from a bare Zoho date (no time)
                        shows its date alone rather than a fabricated
                        midnight clock time. */}
                    {s.at ? formatPHT(s.at, s.at_exact === false ? 'date' : 'timeline') : ''}
                  </p>
                </div>

                {s.by && (
                  <p className="text-xs text-ink-secondary mt-0.5 flex items-center flex-wrap">
                    By: {s.by}<RoleBadge role={s.by_role} />
                  </p>
                )}

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

                {/* Sep 22, 2026: split-invoicing orders — this stage spans
                    more than one Sales Order (Confirmed / Finance Verified /
                    Invoiced / Paid, each with its own entity). Shown
                    whenever the backend supplies a breakdown, so a split
                    that's on hold or racing ahead reads as itself, not as
                    the whole order stuck or done. */}
                {s.perEntity && (
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
                    {s.perEntity.map((p) => (
                      <span
                        key={p.entity}
                        className={`inline-flex items-center gap-1 text-[11px] ${
                          focusEntity && p.entity === focusEntity ? 'px-1.5 py-0.5 rounded bg-getmeds-blue/10 ring-1 ring-getmeds-blue/30' : ''
                        }`}
                      >
                        {p.done ? (
                          <Check className="w-3 h-3 text-pharmacy-green shrink-0" strokeWidth={3} />
                        ) : (
                          <Clock className="w-3 h-3 text-slate-400 shrink-0" />
                        )}
                        <span className={p.done ? 'text-ink-primary font-medium' : 'text-ink-secondary'}>
                          {p.label}
                        </span>
                      </span>
                    ))}
                  </div>
                )}

                <Updates updates={visibleUpdates} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default OrderPipeline;
