'use strict';

/**
 * Sep 13, 2026: db.afterCommit (src/db/pg.js).
 *
 * The Discord audit post hangs off this, so its guarantee is the thing to pin
 * down: nothing runs until the transaction has committed, and nothing runs at
 * all for one that rolled back.
 */
const db = require('../src/db/database');

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('db.afterCommit', () => {
  test('waits for COMMIT inside a transaction', async () => {
    const calls = [];
    await db.transaction(async () => {
      db.afterCommit(() => calls.push('after commit'));
      await db.prepare('SELECT 1 AS one').get();
      expect(calls).toEqual([]);
    })();
    await settle();
    expect(calls).toEqual(['after commit']);
  });

  test('is dropped when the transaction rolls back', async () => {
    const calls = [];
    await expect(
      db.transaction(async () => {
        db.afterCommit(() => calls.push('should not run'));
        throw new Error('undo');
      })()
    ).rejects.toThrow('undo');
    await settle();
    expect(calls).toEqual([]);
  });

  test('runs right away outside a transaction, and its errors stay out of the caller', async () => {
    const calls = [];
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    db.afterCommit(() => calls.push('now'));
    db.afterCommit(() => { throw new Error('side effect failed'); });
    await settle();
    expect(calls).toEqual(['now']);
    expect(spy).toHaveBeenCalledWith('[db] after-commit callback failed:', 'side effect failed');
    spy.mockRestore();
  });

  test('queries made from the callback run outside the finished transaction', async () => {
    let result;
    await db.transaction(async () => {
      db.afterCommit(async () => { result = await db.prepare('SELECT 2 AS two').get(); });
    })();
    await settle();
    await settle();
    expect(result).toEqual({ two: 2 });
  });
});
