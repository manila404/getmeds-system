/**
 * Nov 27, 2026 — alert sounds. The backend side:
 *   - every in-app notification keeps its kind (payload.event_type), so the
 *     app can tell an "order on hold" notice apart;
 *   - GET /api/notifications/attention lists the orders waiting on Finance
 *     (to verify) or Management (Approval Queue), for the "to approve" sound.
 * Stubbed database, no Postgres.
 */
const mockRuns = [];
const mockAll = [];
jest.mock('../src/db/database', () => ({
  prepare: (sql) => ({
    run: async (...args) => { mockRuns.push({ sql, args }); return {}; },
    all: async (...args) => { mockAll.push({ sql, args }); return [{ id: 64075 }, { id: 64001 }]; },
    get: async () => ({ order_scope: null }),
  }),
}));
jest.mock('../src/services/orderScopeService', () => ({
  loadScope: async () => ({ mode: 'all', rules: [] }),
  scopeSql: () => ({ sql: null, params: [] }),
}));

const { notify } = require('../src/services/notificationService');
const { getAttention } = require('../src/controllers/notifications.controller');

const call = async (role) => {
  let body;
  await getAttention({ user: { id: 1, role } }, { json: (b) => { body = b; } }, (e) => { throw e; });
  return body;
};

describe('notification kind', () => {
  beforeEach(() => { mockRuns.length = 0; });

  it('stores event_type with the payload', async () => {
    await notify({ orderId: 5, recipientIds: [7], message: 'held', eventType: 'FINANCE_REJECTED', payload: { reason: 'Overdue' } });
    const ins = mockRuns.find((r) => /INSERT INTO notifications/.test(r.sql));
    expect(JSON.parse(ins.args[3])).toEqual({ reason: 'Overdue', event_type: 'FINANCE_REJECTED' });
  });

  it('adds event_type even without a payload', async () => {
    await notify({ orderId: 5, recipientIds: [7], message: 'sent back', eventType: 'MANAGEMENT_SENT_BACK' });
    const ins = mockRuns.find((r) => /INSERT INTO notifications/.test(r.sql));
    expect(JSON.parse(ins.args[3])).toEqual({ event_type: 'MANAGEMENT_SENT_BACK' });
  });
});

describe('GET /api/notifications/attention', () => {
  beforeEach(() => { mockAll.length = 0; });

  it('Finance: orders to verify', async () => {
    const body = await call('finance');
    expect(body.data.ids).toEqual([64075, 64001]);
    expect(mockAll[0].args[0][0]).toEqual(['ready_for_finance_verified']);
  });

  it('Management: the Approval Queue', async () => {
    await call('management');
    expect(mockAll[0].args[0][0]).toEqual(['pending_management_approval']);
  });

  it('anyone else: nothing, and no query', async () => {
    expect((await call('medrep')).data.ids).toEqual([]);
    expect(mockAll).toHaveLength(0);
  });
});
