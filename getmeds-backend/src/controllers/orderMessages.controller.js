'use strict';

const db = require('../db/database');
const { logEvent, resolveActor } = require('../services/auditService');
const { notify, getUserIdsByRole } = require('../services/notificationService');
const { canAccessOrder } = require('../services/orderScopeService');
const teamScopeService = require('../services/teamScopeService');

/**
 * Nov 27, 2026: POST /api/orders/:id/messages — one message in the order's
 * conversation (the "Conversation" panel beside the order, see
 * frontend components/orders/OrderThreadPanel.jsx).
 *
 * Holds, resubmits, send-backs and Dispatch updates already live on the
 * order's trail; what was missing was a plain reply. A message is just one
 * more order event (ORDER_MESSAGE), so no database change is needed, and it
 * shows wherever the trail shows.
 *
 * Body: { text, files?: [{ file_name, file_type }] } — files are uploaded
 * first through the normal attachment upload; their names ride along so the
 * message can say what came with it.
 *
 * Who hears about it: the order's MedRep (and whoever raised it), plus
 * everyone else who has held, sent back or written on this order. When
 * nobody has yet, the team whose turn it is at the order's stage.
 */
const MAX_TEXT = 1000;
const STAFF_THREAD_EVENTS = [
  'ORDER_MESSAGE', 'FINANCE_REJECTED', 'EXCEPTION_SET', 'MANAGEMENT_SENT_BACK', 'MANAGEMENT_REJECTED',
  'DISPATCH_HOLD', 'TRACKING_ON_HOLD', 'PAYMENT_PROOF_REJECTED', 'RX_REJECTED', 'STOCK_HOLD',
];

function roleForStage(status) {
  if (['draft', 'pending_management_approval', 'submitted'].includes(status)) return ['management'];
  if (['ready_for_finance_verified', 'on_hold', 'exception'].includes(status)) return ['finance'];
  return ['dispatch'];
}

exports.postMessage = async (req, res, next) => {
  try {
    const text = String(req.body?.text || '').trim();
    const files = Array.isArray(req.body?.files) ? req.body.files.slice(0, 10) : [];
    if (!text && !files.length) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Write a message or attach a file.' } });
    }
    if (text.length > MAX_TEXT) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `The message is too long (${MAX_TEXT} characters at most).` } });
    }

    const order = await db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!order) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Order not found' } });
    const allowed = req.user.role === 'team_lead'
      ? await teamScopeService.canAccessOrder(req.user, order)
      : await canAccessOrder(req.user, order);
    if (!allowed) return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });

    const actor = await resolveActor(req.user);
    const fileList = files
      .map((f) => ({ file_name: String(f?.file_name || '').slice(0, 200), file_type: String(f?.file_type || 'other').slice(0, 40) }))
      .filter((f) => f.file_name);

    await logEvent({
      orderId: order.id,
      eventType: 'ORDER_MESSAGE',
      oldStatus: order.status,
      newStatus: order.status,
      actorId: actor.id,
      actorName: actor.name,
      notes: text || `Attached ${fileList.map((f) => f.file_name).join(', ')}`,
      metadata: { files: fileList },
    });

    const participants = await db.prepare(`
      SELECT DISTINCT actor_id FROM order_events
       WHERE order_id = ? AND actor_id IS NOT NULL AND event_type = ANY(?)
    `).all(order.id, STAFF_THREAD_EVENTS);
    let recipients = new Set([order.medrep_id, order.raised_by_id, ...participants.map((p) => p.actor_id)]
      .filter((id) => id && Number(id) !== Number(actor.id)));
    const staffOthers = [...recipients].filter((id) => Number(id) !== Number(order.medrep_id) && Number(id) !== Number(order.raised_by_id));
    if (!staffOthers.length) {
      for (const id of await getUserIdsByRole(...roleForStage(order.status))) {
        if (Number(id) !== Number(actor.id)) recipients.add(id);
      }
    }
    recipients = [...recipients];
    if (recipients.length) {
      const preview = (text || fileList.map((f) => f.file_name).join(', ')).slice(0, 140);
      await notify({
        orderId: order.id,
        recipientIds: recipients,
        message: `${actor.name} on ${order.getmeds_order_id}: ${preview}`,
        eventType: 'ORDER_MESSAGE',
        orderData: { ...order, actorName: actor.name },
      });
    }

    res.status(201).json({ success: true, data: { notified: recipients.length } });
  } catch (err) {
    next(err);
  }
};
