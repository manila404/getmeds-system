const db = require('../db/database');
const nodemailer = require('nodemailer');

/**
 * Send a notification to one or more recipients.
 * Creates in_app DB record, and always logs email + Google Chat payloads to
 * the console (this log IS the audit trail / the safe default — Test Mode,
 * demos, and any environment without real credentials configured rely on
 * it). When SMTP_* / GOOGLE_CHAT_WEBHOOK_URL are set, real delivery is also
 * attempted, fire-and-forget: a delivery failure is logged but never thrown
 * back at the caller — Google Chat/email are notification channels, never
 * the system of record, and a flaky mail server must not break order
 * processing.
 */

// ─── Real SMTP delivery (opt-in via SMTP_HOST) ──────────────────────────────

let _transporter; // undefined = not yet built, null = build failed/not configured

function getTransporter() {
  if (_transporter !== undefined) return _transporter;

  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST) {
    _transporter = null; // not configured — console log remains the only channel
    return _transporter;
  }

  try {
    _transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: parseInt(SMTP_PORT, 10) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
    });
  } catch (err) {
    console.error('[EMAIL] Failed to configure SMTP transporter — falling back to console-log-only:', err.message);
    _transporter = null;
  }
  return _transporter;
}

async function sendRealEmail(payload) {
  const transporter = getTransporter();
  if (!transporter) return; // SMTP not configured; the console log above is the delivery

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || '"Getmeds Orders" <no-reply@getmeds.ph>',
      to: payload.to,
      subject: payload.subject,
      text: payload.body,
      html: renderEmailHtml(payload)
    });
  } catch (err) {
    // Failure scenario the QA mandate calls out explicitly: SMTP downtime
    // must never break order processing. Log it and move on.
    console.error(`[EMAIL] Failed to send real email to ${payload.to}:`, err.message);
  }
}

function renderEmailHtml(payload) {
  const rows = Object.entries(payload)
    .filter(([k]) => !['to', 'subject', 'body'].includes(k))
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<tr><td style="padding:2px 8px;color:#667;font-size:12px;">${k}</td><td style="padding:2px 8px;font-size:12px;"><strong>${v}</strong></td></tr>`)
    .join('');
  return `<div style="font-family:sans-serif;font-size:14px;color:#222;">
    <p>${payload.body}</p>
    <table style="margin-top:12px;border-collapse:collapse;">${rows}</table>
  </div>`;
}

// ─── Real Google Chat webhook delivery (opt-in via GOOGLE_CHAT_WEBHOOK_URL) ─

async function sendRealGoogleChat(chatPayload) {
  const url = process.env.GOOGLE_CHAT_WEBHOOK_URL;
  if (!url) return; // not configured; the console log above is the delivery

  if (typeof fetch !== 'function') {
    console.error('[GOOGLE_CHAT] GOOGLE_CHAT_WEBHOOK_URL is set but this Node runtime has no global fetch (Node 18+ required) — skipping real delivery this time.');
    return;
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards: chatPayload.cards })
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[GOOGLE_CHAT] Webhook responded ${res.status}: ${body.slice(0, 300)}`);
    }
  } catch (err) {
    console.error('[GOOGLE_CHAT] Failed to POST webhook:', err.message);
  }
}

// ─── notify() ────────────────────────────────────────────────────────────────

function notify({ orderId, recipientIds, message, eventType, orderData = {} }) {
  const now = new Date().toISOString();

  // 1. In-App notification (stored in DB for each recipient)
  if (recipientIds && recipientIds.length > 0) {
    const ins = db.prepare(`
      INSERT INTO notifications (order_id, recipient_id, channel, message, payload, sent_at)
      VALUES (?, ?, 'in_app', ?, ?, ?)
    `);
    for (const rid of recipientIds) {
      if (rid) ins.run(orderId || null, rid, message, null, now);
    }
  }

  const appBaseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';
  const orderIdentifier = orderData.getmeds_order_id || orderId || '';
  const triggeredBy = orderData.actorName || orderData.triggered_by || (eventType === 'ORDER_READY_FOR_DISPATCH' && orderData.customer_type === 'credit' ? 'System (Auto-Approval)' : 'System');

  // Determine next operational step for internal team
  let nextAction = 'None';
  if (orderData.status === 'ready_for_draft_invoice') {
    nextAction = 'Awaiting Finance: Confirm Sales Order & Convert to Invoice in Zoho';
  } else if (orderData.status === 'ready_for_invoice_sent') {
    nextAction = 'Awaiting Finance: Record Customer Payment in Zoho';
  } else if (orderData.status === 'ready_for_dispatch') {
    nextAction = 'Awaiting Pharmacy: Create Package in Zoho (Picking & Packing)';
  } else if (orderData.status === 'picking_packing') {
    nextAction = 'Awaiting Pharmacy: Create Shipment in Zoho (Courier & Tracking)';
  } else if (orderData.status === 'dispatched') {
    nextAction = 'Awaiting Zoho Shipment Confirmation';
  } else if (orderData.status === 'on_hold' || orderData.status === 'exception') {
    nextAction = 'Action Required: Resolve Order Exception';
  }

  // 2a. Enhanced Internal Email (Staff/MedRep)
  const internalEmailPayload = {
    to: orderData.medrep_email || 'medrep@getmeds.ph',
    subject: `[Getmeds] Order ${orderData.getmeds_order_id || ''} — ${eventType}`,
    body: message,
    order_id: orderData.getmeds_order_id || 'N/A',
    customer_name: orderData.customer_name || 'N/A',
    order_total: orderData.total_amount ? `PHP ${Number(orderData.total_amount).toLocaleString('en-PH', { minimumFractionDigits: 2 })}` : undefined,
    status: orderData.status || 'N/A',
    next_action_required: nextAction,
    action_link: `${appBaseUrl}/orders/${orderIdentifier}`,
    timestamp: now,
    triggered_by: triggeredBy
  };
  console.log('[EMAIL_LOG]', JSON.stringify(internalEmailPayload, null, 2));
  sendRealEmail(internalEmailPayload); // fire-and-forget; no-op if SMTP isn't configured

  // 2b. Customer-Facing Email Variant (Conditional on customer-relevant events)
  const customerFacingEvents = ['ORDER_SUBMITTED', 'PAYMENT_VERIFIED', 'ORDER_DISPATCHED', 'ORDER_COMPLETED'];
  if (customerFacingEvents.includes(eventType) && orderData.customer_name) {
    let customerStatus = 'Processing';
    let customerMessage = `Thank you for your order! Your Getmeds order ${orderData.getmeds_order_id || ''} is being prepared by our pharmacy team.`;

    if (eventType === 'PAYMENT_VERIFIED') {
      customerStatus = 'Payment Confirmed';
      customerMessage = `Your payment for order ${orderData.getmeds_order_id || ''} has been confirmed. Your medicines will now be prepared for delivery.`;
    } else if (eventType === 'ORDER_DISPATCHED' || eventType === 'ORDER_COMPLETED') {
      customerStatus = 'Dispatched';
      customerMessage = orderData.tracking_number
        ? `Your order is on the way! Courier: ${orderData.courier || 'Express'}, Tracking Number: ${orderData.tracking_number}.`
        : `Your order has been packed and handed over to our delivery partner.`;
    }

    const customerEmailPayload = {
      recipient_type: 'customer',
      to: orderData.customer_email || `patient.${orderData.customer_name.toLowerCase().replace(/[^a-z0-9]/g, '')}@gmail.com`,
      subject: `Getmeds Order Update: ${orderData.getmeds_order_id || ''} — ${customerStatus}`,
      body: customerMessage,
      order_id: orderData.getmeds_order_id || 'N/A',
      customer_name: orderData.customer_name,
      status: customerStatus,
      tracking_details: orderData.tracking_number ? {
        courier: orderData.courier,
        tracking_number: orderData.tracking_number
      } : undefined,
      timestamp: now
    };
    console.log('[CUSTOMER_EMAIL_LOG]', JSON.stringify(customerEmailPayload, null, 2));
    sendRealEmail(customerEmailPayload); // fire-and-forget; no-op if SMTP isn't configured
  }

  // 3. Google Chat (log the full card payload always; POST it for real too if configured)

  const chatPayload = {
    webhook_url: process.env.GOOGLE_CHAT_WEBHOOK_URL || 'NOT_CONFIGURED',
    _note: process.env.GOOGLE_CHAT_WEBHOOK_URL
      ? 'GOOGLE_CHAT_WEBHOOK_URL is configured — this payload is also POSTed for real.'
      : 'This is a simulated payload only. Set GOOGLE_CHAT_WEBHOOK_URL in .env to send real messages.',
    cards: [{
      header: {
        title: `Getmeds Order Update`,
        subtitle: `Order: ${orderData.getmeds_order_id || 'N/A'}`,
        imageUrl: 'https://fonts.gstatic.com/s/i/productlogos/googleg/v6/24px.svg'
      },
      sections: [{
        widgets: [
          { keyValue: { topLabel: 'Event', content: eventType } },
          { keyValue: { topLabel: 'Order ID', content: orderData.getmeds_order_id || 'N/A' } },
          { keyValue: { topLabel: 'Customer', content: orderData.customer_name || 'N/A' } },
          { keyValue: { topLabel: 'Status', content: orderData.status || 'N/A' } },
          { keyValue: { topLabel: 'Triggered By', content: triggeredBy } },
          { keyValue: { topLabel: 'Message', content: message } },
          { keyValue: { topLabel: 'Timestamp', content: now } },
          {
            buttons: [
              {
                textButton: {
                  text: 'VIEW IN GETMEDS',
                  onClick: {
                    openLink: {
                      url: `${appBaseUrl}/orders/${orderIdentifier}`
                    }
                  }
                }
              }
            ]
          }
        ]
      }]
    }],
    timestamp: now
  };
  console.log('[GOOGLE_CHAT_LOG]', JSON.stringify(chatPayload));
  sendRealGoogleChat(chatPayload); // fire-and-forget; no-op if the webhook URL isn't configured
}

/**
 * Get user IDs by role(s)
 */
function getUserIdsByRole(...roles) {
  const placeholders = roles.map(() => '?').join(',');
  const users = db.prepare(
    `SELECT id FROM users WHERE role IN (${placeholders}) AND is_active = 1`
  ).all(...roles);
  return users.map(u => u.id);
}

module.exports = { notify, getUserIdsByRole, _sendRealEmail: sendRealEmail, _sendRealGoogleChat: sendRealGoogleChat };
