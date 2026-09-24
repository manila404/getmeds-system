import React from 'react';
import { ArrowUpRight } from 'lucide-react';
import Skeleton from '../ui/Skeleton';

/**
 * A dashboard KPI. Clickable when given `onClick` — the whole card is the
 * target, it lifts on hover, and `active` rings it while its filter is applied
 * so the table below visibly belongs to it.
 *
 * Sep 24, 2026: the old cards were plain <div>s. Nothing about them said
 * "count", and nothing let you act on the count — you read "32 exceptions" and
 * then had to go find them.
 *
 * Colours are the design tokens (tailwind.config.js), not raw Tailwind hues —
 * the previous cards mixed both, which is why purple/indigo/orange looked
 * unrelated to the rest of the app.
 */
const TONES = {
  blue: { chip: 'bg-getmeds-blue/10 text-getmeds-blue', ring: 'ring-getmeds-blue' },
  warning: { chip: 'bg-state-warning-light text-state-warning', ring: 'ring-state-warning' },
  success: { chip: 'bg-pharmacy-green/15 text-pharmacy-green-dark', ring: 'ring-pharmacy-green' },
  danger: { chip: 'bg-state-error-light text-state-error', ring: 'ring-state-error' },
  neutral: { chip: 'bg-slate-100 text-ink-secondary', ring: 'ring-slate-400' }
};

export const KpiCardSkeleton = () => (
  <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
    <Skeleton className="h-9 w-9 rounded-lg mb-4" />
    <Skeleton className="h-7 w-20 mb-2" />
    <Skeleton className="h-3 w-28 mb-1.5" />
    <Skeleton className="h-3 w-20" />
  </div>
);

const KpiCard = ({ title, value, sub, icon: Icon, tone = 'blue', onClick, active = false, hint }) => {
  const t = TONES[tone] || TONES.blue;
  const interactive = typeof onClick === 'function';
  const Tag = interactive ? 'button' : 'div';

  return (
    <Tag
      {...(interactive ? { type: 'button', onClick, 'aria-pressed': active } : {})}
      title={hint}
      className={[
        'group relative text-left bg-white rounded-xl border p-4 shadow-sm transition-all',
        active ? `border-transparent ring-2 ${t.ring} shadow-md` : 'border-slate-200',
        interactive
          ? 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus-visible:ring-2 focus-visible:ring-getmeds-blue'
          : ''
      ].join(' ')}
    >
      <div className="flex items-start justify-between mb-3">
        <span className={`inline-flex items-center justify-center w-9 h-9 rounded-lg ${t.chip}`}>
          {Icon && <Icon className="w-[18px] h-[18px]" />}
        </span>
        {interactive && (
          <ArrowUpRight className="w-4 h-4 text-slate-300 group-hover:text-ink-secondary transition-colors" />
        )}
      </div>
      <p className="text-2xl font-bold tracking-tight text-ink-primary tabular-nums">{value}</p>
      <p className="text-xs font-semibold text-ink-primary mt-0.5">{title}</p>
      {sub && <p className="text-xs text-ink-secondary mt-0.5">{sub}</p>}
    </Tag>
  );
};

export default KpiCard;
