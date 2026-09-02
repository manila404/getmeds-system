/**
 * The webhook endpoint must not accept anonymous callers in production.
 *
 * Sep 2, 2026 (2). `verifyWebhookAuth` treated an unset ZOHO_WEBHOOK_SECRET as
 * "allow everything" — reasonable while the only route in was a tunnel to a
 * developer's laptop, dangerous the moment the URL is public. Anyone who found
 * /api/webhooks/zoho could post fabricated Zoho events and drive real orders
 * through the pipeline: invoiced, shipped, paid, deleted.
 *
 * Development still allows it, because requiring a secret to run the app
 * locally is friction with no safety return. Production fails closed.
 */
const request = require('supertest');
const app = require('../src/app');

const post = () =>
  request(app)
    .post('/api/webhooks/zoho')
    .send({ event_type: 'salesorder.confirmed', salesorder: { salesorder_id: 'AUTH-PROBE-1' } });

describe('webhook authentication', () => {
  const originalEnv = process.env.NODE_ENV;
  const originalSecret = process.env.ZOHO_WEBHOOK_SECRET;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
    process.env.ZOHO_WEBHOOK_SECRET = originalSecret || '';
  });

  test('no secret + production = refused', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ZOHO_WEBHOOK_SECRET = '';

    const res = await post();
    expect(res.status).toBe(401);
  });

  test('no secret + development = allowed, so local work needs no setup', async () => {
    process.env.NODE_ENV = 'test';
    process.env.ZOHO_WEBHOOK_SECRET = '';

    const res = await post();
    expect(res.status).toBe(200);
  });

  test('secret set + correct token = allowed, in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ZOHO_WEBHOOK_SECRET = 'probe-secret-value';

    const res = await request(app)
      .post('/api/webhooks/zoho')
      .set('X-Zoho-Webhook-Token', 'probe-secret-value')
      .send({ event_type: 'salesorder.confirmed', salesorder: { salesorder_id: 'AUTH-PROBE-2' } });

    expect(res.status).toBe(200);
  });

  test('secret set + wrong token = refused', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ZOHO_WEBHOOK_SECRET = 'probe-secret-value';

    const res = await request(app)
      .post('/api/webhooks/zoho')
      .set('X-Zoho-Webhook-Token', 'not-the-secret')
      .send({ event_type: 'salesorder.confirmed', salesorder: { salesorder_id: 'AUTH-PROBE-3' } });

    expect(res.status).toBe(401);
  });
});
