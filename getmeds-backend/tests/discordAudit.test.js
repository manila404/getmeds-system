'use strict';

/**
 * Sep 13, 2026: the Discord audit mirror (services/discordAuditService.js).
 *
 * An in-memory store and transport stand in for the database and Discord, so
 * these tests exercise the mirror's own rules: one thread per order, events in
 * order, only who/what/when reaching Discord, and what is skipped.
 */
const { createAuditMirror, humanize } = require('../src/services/discordAuditService');

const ORDERS = {
  1: { id: 1, getmeds_order_id: 'GM-20260913-0001' },
  2: { id: 2, getmeds_order_id: 'ZOHO-5501234' },
};
const ROLES = { 220: 'medrep', 222: 'finance' };

function memoryStore() {
  const threads = new Map();
  return {
    threads,
    order: async (id) => ORDERS[id],
    actorRole: async (id) => ROLES[id] ?? null,
    thread: async (id) => threads.get(id),
    saveThread: async (id, starter, thread) => { threads.set(id, { starter_message_id: starter, thread_id: thread }); },
  };
}

function fakeTransport({ mode = 'live', failFirstThread = false } = {}) {
  let fail = failFirstThread;
  const t = {
    enabled: true,
    mode,
    posts: [],
    started: [],
    async post(payload, { threadId } = {}) {
      const messageId = String(t.posts.length + 1);
      t.posts.push({ messageId, threadId: threadId ?? null, payload });
      return { messageId };
    },
    async startThread(messageId, name) {
      if (fail) {
        fail = false;
        throw new Error('Discord answered 500');
      }
      t.started.push({ messageId, name });
      return { id: `thread-${messageId}` };
    },
  };
  return t;
}

const titles = (t) => t.posts.filter((p) => p.threadId).map((p) => p.payload.embeds[0].title);

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('discordAuditService', () => {
  test('names events and statuses the way people say them', () => {
    expect(humanize('PAYMENT_PROOF_UPLOADED')).toBe('Payment proof uploaded');
    expect(humanize('ZOHO_SO_EDITED')).toBe('Zoho Sales Order edited');
    expect(humanize('ready_for_dispatch')).toBe('Ready for dispatch');
  });

  test('one thread per order, named after it, with events in the order they happened', async () => {
    const store = memoryStore();
    const transport = fakeTransport();
    const { mirror } = createAuditMirror({ store, transport });

    const results = await Promise.all([
      mirror({ orderId: 1, eventType: 'ORDER_CREATED', newStatus: 'draft', actorId: 220, actorName: 'Test Salesperson' }),
      mirror({ orderId: 1, eventType: 'ORDER_SUBMITTED', oldStatus: 'draft', newStatus: 'so_created', actorId: 220, actorName: 'Test Salesperson' }),
      mirror({ orderId: 1, eventType: 'FINANCE_VERIFIED', oldStatus: 'so_created', newStatus: 'ready_for_dispatch', actorId: 222, actorName: 'Test Finance' }),
    ]);

    expect(results).toEqual(['posted', 'posted', 'posted']);
    expect(transport.started).toEqual([{ messageId: '1', name: 'GM-20260913-0001' }]);
    expect(store.threads.get(1)).toEqual({ starter_message_id: '1', thread_id: 'thread-1' });
    expect(titles(transport)).toEqual(['Order created', 'Order submitted', 'Finance verified']);
    expect(transport.posts.filter((p) => !p.threadId)).toHaveLength(1);   // a single starter message
  });

  test('says who did it, in which role, and what changed', async () => {
    const transport = fakeTransport();
    const { mirror } = createAuditMirror({ store: memoryStore(), transport });
    await mirror({ orderId: 1, eventType: 'FINANCE_VERIFIED', oldStatus: 'so_created', newStatus: 'ready_for_dispatch', actorId: 222, actorName: 'Test Finance' });
    await mirror({ orderId: 1, eventType: 'ORDER_SUBMITTED', newStatus: 'so_created', actorId: 220, actorName: 'Test Salesperson' });
    await mirror({ orderId: 1, eventType: 'ORDER_COMPLETED', oldStatus: 'dispatched', newStatus: 'completed' });

    const [verified, submitted, completed] = transport.posts.filter((p) => p.threadId).map((p) => p.payload.embeds[0]);
    expect(verified.description).toBe('Sales Order created → Ready for dispatch');
    expect(verified.footer.text).toBe('Test Finance · Finance');
    expect(submitted.footer.text).toBe('Test Salesperson · Salesperson');
    expect(completed.footer.text).toBe('System');
  });

  test('notes and metadata never reach Discord, and nothing can ping @everyone', async () => {
    const transport = fakeTransport();
    const { mirror } = createAuditMirror({ store: memoryStore(), transport });
    await mirror({
      orderId: 1,
      eventType: 'PAYMENT_PROOF_UPLOADED',
      actorId: 220,
      actorName: 'Test Salesperson',
      notes: 'Juan Dela Cruz paid PHP 1,500, GCash ref 88123',
      metadata: { customer: 'Juan Dela Cruz', amount: 1500 },
    });
    const sent = JSON.stringify(transport.posts);
    expect(sent).not.toMatch(/Juan|1,500|88123/);
    expect(transport.posts.every((p) => p.payload.allowed_mentions.parse.length === 0)).toBe(true);
  });

  test('skips imported orders, backfilled Zoho history, and everything when off', async () => {
    const transport = fakeTransport();
    const { mirror } = createAuditMirror({ store: memoryStore(), transport });
    expect(await mirror({ orderId: 2, eventType: 'ZOHO_SO_EDITED' })).toBe('skipped');
    expect(await mirror({ orderId: 1, eventType: 'ZOHO_SO_CONFIRMED', occurredAt: '2026-01-31T08:08:00.000Z' })).toBe('backfill');
    expect(transport.posts).toHaveLength(0);

    const off = createAuditMirror({ store: memoryStore(), transport: { enabled: false } });
    expect(await off.mirror({ orderId: 1, eventType: 'ORDER_CREATED' })).toBe('off');
  });

  test('mock mode logs the post and saves nothing, so switching to live starts clean', async () => {
    const store = memoryStore();
    const transport = fakeTransport({ mode: 'mock' });
    const { mirror } = createAuditMirror({ store, transport });
    expect(await mirror({ orderId: 1, eventType: 'ORDER_CREATED', actorId: 220, actorName: 'Test Salesperson' })).toBe('mocked');
    expect(store.threads.size).toBe(0);
    expect(transport.started).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[DISCORD_MOCK] GM-20260913-0001 thread: Order created'));
  });

  test('a failure is logged, not thrown, and the next event finishes the thread on the same starter', async () => {
    const store = memoryStore();
    const transport = fakeTransport({ failFirstThread: true });
    const { mirror } = createAuditMirror({ store, transport });

    expect(await mirror({ orderId: 1, eventType: 'ORDER_CREATED' })).toBe('failed');
    expect(store.threads.get(1)).toEqual({ starter_message_id: '1', thread_id: null });

    expect(await mirror({ orderId: 1, eventType: 'ORDER_SUBMITTED' })).toBe('posted');
    expect(transport.started).toEqual([{ messageId: '1', name: 'GM-20260913-0001' }]);
    expect(transport.posts.filter((p) => !p.threadId)).toHaveLength(1);   // no second starter
  });

  test('a missing order_audit_threads table pauses the mirror with one warning', async () => {
    const store = memoryStore();
    store.thread = async () => { throw Object.assign(new Error('relation "order_audit_threads" does not exist'), { code: '42P01' }); };
    const { mirror } = createAuditMirror({ store, transport: fakeTransport() });

    expect(await mirror({ orderId: 1, eventType: 'ORDER_CREATED' })).toBe('failed');
    expect(await mirror({ orderId: 1, eventType: 'ORDER_SUBMITTED' })).toBe('off');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn.mock.calls[0][0]).toMatch(/npm run migrate:pg/);
  });
});
