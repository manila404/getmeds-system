import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import client from '../api/client';
import { playAlertSound, unlockAlertSound } from '../utils/alertSound';

/**
 * Nov 27, 2026: the alert sounds.
 *
 *   MedRep / Team Lead   'hold' when a new notification says their order is
 *                        on hold: Finance hold, Management sent it back, an
 *                        exception / hold, a stock hold (and its reminder).
 *   Finance / Management 'approval' when an order joins the list waiting on
 *                        them — Finance's "to verify", Management's Approval
 *                        Queue (GET /api/notifications/attention).
 *
 * Only for what arrives while the hub is open: whatever is already there
 * when the page loads stays quiet. Both checks keep running while the tab
 * is in the background (every 30s; Chrome may slow a hidden tab to once a
 * minute), which is when a sound matters most.
 */
const HOLD_EVENTS = new Set([
  'ORDER_EXCEPTION',
  'FINANCE_REJECTED',
  'MANAGEMENT_SENT_BACK',
  'STOCK_HOLD',
  'STOCK_HOLD_REMINDER',
]);
const HOLD_ROLES = new Set(['medrep', 'team_lead']);
const APPROVER_ROLES = new Set(['finance', 'management']);

const eventTypeOf = (n) => {
  if (!n || !n.payload) return null;
  try {
    const p = typeof n.payload === 'string' ? JSON.parse(n.payload) : n.payload;
    return (p && p.event_type) || null;
  } catch { return null; }
};

export function useAlertSounds({ role, notifications = [], notificationsLoaded = false }) {
  const qc = useQueryClient();
  const r = String(role || '').toLowerCase();
  const wantsHold = HOLD_ROLES.has(r);
  const wantsApproval = APPROVER_ROLES.has(r);

  // The browser allows sound only after a click or key press on the page.
  useEffect(() => {
    const unlock = () => unlockAlertSound();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  // ── 'hold' ──────────────────────────────────────────────────────────────
  // The unread count, also while the tab is hidden. When it goes up, the
  // list is fetched straight away instead of waiting for its own 60s turn.
  const unread = useQuery({
    queryKey: ['notifications', 'unread-count'],
    queryFn: async () => (await client.get('/api/notifications/unread-count')).data.data.count,
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
    enabled: wantsHold,
  });
  const lastCount = useRef(null);
  useEffect(() => {
    if (!wantsHold || unread.data === undefined) return;
    if (lastCount.current !== null && unread.data > lastCount.current) {
      qc.invalidateQueries({ queryKey: ['notifications'], exact: true });
    }
    lastCount.current = unread.data;
  }, [wantsHold, unread.data, qc]);

  const seenNotifications = useRef(null);
  useEffect(() => {
    if (!wantsHold || !notificationsLoaded) return;
    if (seenNotifications.current === null) {
      seenNotifications.current = new Set(notifications.map((n) => n.id));
      return;
    }
    const fresh = notifications.filter((n) => !seenNotifications.current.has(n.id));
    fresh.forEach((n) => seenNotifications.current.add(n.id));
    if (fresh.some((n) => !n.is_read && HOLD_EVENTS.has(eventTypeOf(n)))) playAlertSound('hold');
  }, [wantsHold, notificationsLoaded, notifications]);

  // ── 'approval' ──────────────────────────────────────────────────────────
  const attention = useQuery({
    queryKey: ['notifications', 'attention'],
    queryFn: async () => (await client.get('/api/notifications/attention')).data.data.ids || [],
    refetchInterval: 30000,
    refetchIntervalInBackground: true,
    enabled: wantsApproval,
  });
  const seenApprovals = useRef(null);
  useEffect(() => {
    if (!wantsApproval || !attention.data) return;
    if (seenApprovals.current === null) {
      seenApprovals.current = new Set(attention.data);
      return;
    }
    const fresh = attention.data.filter((id) => !seenApprovals.current.has(id));
    fresh.forEach((id) => seenApprovals.current.add(id));
    if (fresh.length) playAlertSound('approval');
  }, [wantsApproval, attention.data]);
}
