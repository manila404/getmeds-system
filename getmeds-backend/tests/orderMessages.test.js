/**
 * Nov 27, 2026 — the order Conversation: POST /api/orders/:id/messages.
 * Stubbed database and services, no Postgres.
 */
const mockState = { order: null, participants: [], allowed: true, events: [], notified: [] };

jest.mock('../src/db/database', () => ({
  prepare: (sql) => ({
    get: async () => (/FROM orders WHERE id/.test(sql) ? mockState.order : null),
    all: async () => (/SELECT DISTINCT actor_id FROM order_events/.test(sql) ? mockState.participants : []),
    run: async () => ({}),
  }),
}));
jest.mock('../src/services/auditService', () => ({
  logEvent: jest.fn(async (e) => { mockState.events.push(e); }),
  resolveActor: async (u) => ({ id: u.id, name: u.name }),
}));
jest.mock('../src/services/notificationService', () => ({
  notify: jest.fn(async (n) => { mockState.notified.push(n); }),
  getUserIdsByRole: async (...roles) => (roles.includes('finance') ? [301, 302] : roles.includes('management') ? [401] : [501]),
}));
jest.mock('../src/services/orderScopeService', () => ({ canAccessOrder: async () => mockState.allowed }));
jest.mock('../src/services/teamScopeService', () => ({ canAccessOrder: async () => mockState.allowed }));

const { postMessage } = require('../src/controllers/orderMessages.controller');

const run = async (user, body) => {
  let status = 200;
  let json;
  const res = { status: (s) => { status = s; return res; }, json: (j) => { json = j; return res; } };
  await postMessage({ params: { id: '9' }, user, body }, res, (e) => { throw e; });
  return { status, json };
};
const medrep = { id: 210, name: 'Khalygen', role: 'medrep' };

beforeEach(() => {
  mockState.order = { id: 9, getmeds_order_id: 'GM-1', status: 'on_hold', medrep_id: 210, raised_by_id: null };
  mockState.participants = [];
  mockState.allowed = true;
  mockState.events = [];
  mockState.notified = [];
});

describe('POST /api/orders/:id/messages', () => {
  it('saves the message as an ORDER_MESSAGE event with its files', async () => {
    const { status } = await run(medrep, { text: 'Payment done, receipt attached', files: [{ file_name: 'receipt.jpg', file_type: 'payment_proof' }] });
    expect(status).toBe(201);
    expect(mockState.events[0]).toMatchObject({
      eventType: 'ORDER_MESSAGE',
      notes: 'Payment done, receipt attached',
      metadata: { files: [{ file_name: 'receipt.jpg', file_type: 'payment_proof' }] },
    });
  });

  it('notifies whoever held the order, not the sender', async () => {
    mockState.participants = [{ actor_id: 77 }, { actor_id: 210 }];
    await run(medrep, { text: 'Done' });
    expect(mockState.notified[0].recipientIds).toEqual([77]);
  });

  it('with nobody on the thread yet, the team whose turn it is (Finance for a hold)', async () => {
    await run(medrep, { text: 'Hello' });
    expect(mockState.notified[0].recipientIds.sort()).toEqual([301, 302]);
  });

  it('Finance writing reaches the MedRep', async () => {
    await run({ id: 301, name: 'Finance One', role: 'finance' }, { text: 'Please send the OR' });
    expect(mockState.notified[0].recipientIds).toContain(210);
  });

  it('refuses an empty message, and someone who cannot see the order', async () => {
    expect((await run(medrep, { text: '  ' })).status).toBe(400);
    mockState.allowed = false;
    expect((await run(medrep, { text: 'hi' })).status).toBe(403);
  });
});
