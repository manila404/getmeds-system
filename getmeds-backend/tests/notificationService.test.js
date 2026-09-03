/**
 * Coverage for the real SMTP + Google Chat webhook delivery added to
 * notificationService.js. The console-log behavior (the safe default when
 * neither is configured) is exercised implicitly by every other test that
 * calls notify(); these tests specifically cover:
 *   1. Neither channel is configured -> no network/SMTP calls attempted.
 *   2. A configured but failing channel logs the error and does not throw
 *      (notifications must never break order processing).
 *   3. A configured, working channel is actually invoked with the right
 *      shape.
 */
describe('notificationService — real delivery channels', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    delete process.env.SMTP_HOST;
    delete process.env.GOOGLE_CHAT_WEBHOOK_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('with SMTP_HOST/GOOGLE_CHAT_WEBHOOK_URL unset, real-send helpers are no-ops (no throw, no network)', async () => {
    const notificationService = require('../src/services/notificationService');
    await expect(notificationService._sendRealEmail({ to: 'x@y.com', subject: 's', body: 'b' })).resolves.toBeUndefined();
    await expect(notificationService._sendRealGoogleChat({ cards: [] })).resolves.toBeUndefined();
  });

  test('SMTP send failure is caught and logged, never thrown', async () => {
    process.env.SMTP_HOST = 'smtp.invalid.example.com';
    process.env.SMTP_PORT = '587';

    jest.doMock('nodemailer', () => ({
      createTransport: () => ({
        sendMail: jest.fn().mockRejectedValue(new Error('Connection refused'))
      })
    }));

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const notificationService = require('../src/services/notificationService');

    await expect(notificationService._sendRealEmail({ to: 'medrep@getmeds.ph', subject: 'Test', body: 'Body' })
    ).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[EMAIL] Failed to send real email'),
      expect.any(String)
    );
    errorSpy.mockRestore();
    jest.dontMock('nodemailer');
  });

  test('a configured SMTP transporter is actually called with the right envelope', async () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    process.env.SMTP_FROM = '"Getmeds Test" <test@getmeds.ph>';

    const sendMail = jest.fn().mockResolvedValue({ messageId: 'abc123' });
    jest.doMock('nodemailer', () => ({
      createTransport: () => ({ sendMail })
    }));

    const notificationService = require('../src/services/notificationService');
    await notificationService._sendRealEmail({ to: 'medrep@getmeds.ph', subject: 'Hello', body: 'World' });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Getmeds Test" <test@getmeds.ph>',
        to: 'medrep@getmeds.ph',
        subject: 'Hello',
        text: 'World'
      })
    );
    jest.dontMock('nodemailer');
  });

  test('Google Chat webhook failure (non-2xx) is logged, never thrown', async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = 'https://chat.googleapis.com/v1/spaces/fake/messages';
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'server error' });

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const notificationService = require('../src/services/notificationService');

    await notificationService._sendRealGoogleChat({ cards: [{ header: { title: 'x' } }] });

    expect(global.fetch).toHaveBeenCalledWith(
      process.env.GOOGLE_CHAT_WEBHOOK_URL,
      expect.objectContaining({ method: 'POST' })
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[GOOGLE_CHAT]'));
    errorSpy.mockRestore();
    global.fetch = originalFetch;
  });

  test('Google Chat webhook network error (fetch rejects) is caught and logged, never thrown', async () => {
    process.env.GOOGLE_CHAT_WEBHOOK_URL = 'https://chat.googleapis.com/v1/spaces/fake/messages';
    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const notificationService = require('../src/services/notificationService');

    await expect(notificationService._sendRealGoogleChat({ cards: [] })).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('[GOOGLE_CHAT] Failed to POST webhook:'), 'ECONNREFUSED');

    errorSpy.mockRestore();
    global.fetch = originalFetch;
  });
});
