/**
 * Hours → something a person reads at a glance.
 *
 *   0.4   → "24m"
 *   2.9   → "2h 54m"
 *   26    → "1 day 2h"
 *   93.2  → "3 days 21h"
 *
 * Sep 24, 2026: the dashboard's Avg Processing Time used to print a raw
 * "25004.7h". Nobody reads 25,004 hours as anything; days and hours are what
 * an order's turnaround is actually discussed in.
 */
export function formatHours(hours) {
  if (hours == null || !Number.isFinite(Number(hours))) return '—';
  const totalMinutes = Math.round(Number(hours) * 60);
  if (totalMinutes < 1) return '< 1m';
  if (totalMinutes < 60) return `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (totalHours < 24) return minutes ? `${totalHours}h ${minutes}m` : `${totalHours}h`;

  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  const dayLabel = `${days} ${days === 1 ? 'day' : 'days'}`;
  return remHours ? `${dayLabel} ${remHours}h` : dayLabel;
}
