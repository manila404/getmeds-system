'use strict';

/**
 * Isolated unit tests for anti-stale-tab / multi-user concurrency protection
 * and controller gating in dispatchBatchService + dispatch.controller.
 */
describe('Dispatch concurrency & stale-tab protection (mocked DB)', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('rejects with 409 CATERED_BY_ANOTHER when another dispatcher caters the order', async () => {
    jest.doMock('../src/db/database', () => ({
      prepare: jest.fn((sql) => {
        if (/FROM orders/i.test(sql)) {
          return {
            get: jest.fn().mockResolvedValue({
              id: 77,
              getmeds_order_id: 'GM-20261114-0015',
              status: 'ready_for_dispatch',
              updated_at: '2026-11-16T02:00:00.000Z'
            })
          };
        }
        return {
          get: jest.fn().mockResolvedValue({
            event_type: 'DISPATCH_CATERED',
            actor_id: 99,
            actor_name: 'RALPH RENZO BELO',
            created_at: '2026-11-16T02:05:00.000Z'
          })
        };
      })
    }));

    const { assertCanActOnOrder } = require('../src/services/dispatchBatchService');
    await expect(
      assertCanActOnOrder({ orderId: 77, user: { id: 12, name: 'Aaron Dispatch' } })
    ).rejects.toMatchObject({ status: 409, code: 'CATERED_BY_ANOTHER' });
  });

  it('rejects with 409 STALE_STATE when expectedUpdatedAt differs from latest DB timestamp', async () => {
    jest.doMock('../src/db/database', () => ({
      prepare: jest.fn((sql) => {
        if (/FROM orders/i.test(sql)) {
          return {
            get: jest.fn().mockResolvedValue({
              id: 77,
              getmeds_order_id: 'GM-20261114-0015',
              status: 'ready_for_dispatch',
              updated_at: '2026-11-16T02:10:00.000Z'
            })
          };
        }
        return {
          get: jest.fn().mockResolvedValue({
            event_type: 'DISPATCH_CATERED',
            actor_id: 12,
            actor_name: 'Aaron Dispatch',
            created_at: '2026-11-16T02:00:00.000Z'
          })
        };
      })
    }));

    const { assertCanActOnOrder } = require('../src/services/dispatchBatchService');
    await expect(
      assertCanActOnOrder({
        orderId: 77,
        user: { id: 12, name: 'Aaron Dispatch' },
        expectedUpdatedAt: '2026-11-16T02:01:00.000Z'
      })
    ).rejects.toMatchObject({ status: 409, code: 'STALE_STATE' });
  });

  it('allows acting when caller is current caterer and expectedUpdatedAt matches', async () => {
    jest.doMock('../src/db/database', () => ({
      prepare: jest.fn((sql) => {
        if (/FROM orders/i.test(sql)) {
          return {
            get: jest.fn().mockResolvedValue({
              id: 77,
              getmeds_order_id: 'GM-20261114-0015',
              status: 'ready_for_dispatch',
              updated_at: '2026-11-16T02:10:00.000Z'
            })
          };
        }
        return {
          get: jest.fn().mockResolvedValue({
            event_type: 'DISPATCH_CATERED',
            actor_id: 12,
            actor_name: 'Aaron Dispatch',
            created_at: '2026-11-16T02:00:00.000Z'
          })
        };
      })
    }));

    const { assertCanActOnOrder } = require('../src/services/dispatchBatchService');
    const res = await assertCanActOnOrder({
      orderId: 77,
      user: { id: 12, name: 'Aaron Dispatch' },
      expectedUpdatedAt: '2026-11-16T02:10:00.000Z',
      expectedCateredBy: 12
    });
    expect(res.order.id).toBe(77);
    expect(res.currentCaterer.actor_name).toBe('Aaron Dispatch');
  });
});
