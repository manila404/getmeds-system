/**
 * requireAuth: a login that has ended is a 401; a database that can't be asked
 * is a 503. Oct 2, 2026.
 *
 * The browser logs the user out on every 401. requireAuth used to answer 401
 * for both, so any database timeout or connection limit signed people out of
 * the live system. These tests keep the two answers apart.
 *
 * The database is mocked: this is about what the middleware answers, not about
 * what is in a table.
 */
jest.mock('../src/db/database', () => ({ prepare: jest.fn() }));

const jwt = require('jsonwebtoken');
const db = require('../src/db/database');
const { requireAuth } = require('../src/middleware/auth');

const SECRET = process.env.JWT_SECRET || 'getmeds_secret_change_in_production';

function fakeRes() {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.set = (k, v) => { res.headers[k] = v; return res; };
  return res;
}

function withUserRow(row) {
  db.prepare.mockReturnValue({ get: jest.fn().mockResolvedValue(row) });
}

const goodToken = (id = 1) => jwt.sign({ id, role: 'finance' }, SECRET, { expiresIn: '1h' });
const reqWith = (token) => ({ headers: token ? { authorization: `Bearer ${token}` } : {} });

describe('requireAuth', () => {
  beforeEach(() => { jest.clearAllMocks(); jest.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => console.error.mockRestore());

  test('no token is a 401 UNAUTHORIZED', async () => {
    const res = fakeRes(); const next = jest.fn();
    await requireAuth(reqWith(null), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(next).not.toHaveBeenCalled();
  });

  test('a token signed with the wrong secret is a 401 UNAUTHORIZED', async () => {
    const res = fakeRes(); const next = jest.fn();
    await requireAuth(reqWith(jwt.sign({ id: 1 }, 'some-other-secret')), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
    expect(next).not.toHaveBeenCalled();
  });

  test('an expired token is a 401 UNAUTHORIZED', async () => {
    const res = fakeRes(); const next = jest.fn();
    const expired = jwt.sign({ id: 1 }, SECRET, { expiresIn: -10 });
    await requireAuth(reqWith(expired), res, next);
    expect(res.statusCode).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  test('a deactivated account is a 401 UNAUTHORIZED', async () => {
    withUserRow({ id: 1, is_active: 0, approval_status: 'approved' });
    const res = fakeRes(); const next = jest.fn();
    await requireAuth(reqWith(goodToken()), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('a database error is a 503, NOT a 401, and tells the browser when to retry', async () => {
    db.prepare.mockReturnValue({ get: jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')) });
    const res = fakeRes(); const next = jest.fn();
    await requireAuth(reqWith(goodToken()), res, next);
    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(res.headers['Retry-After']).toBeDefined();
    expect(next).not.toHaveBeenCalled();
  });

  test('a valid login attaches the user and carries on', async () => {
    const row = { id: 7, name: 'Fin', role: 'finance', is_active: 1, approval_status: 'approved' };
    withUserRow(row);
    const req = reqWith(goodToken(7)); const res = fakeRes(); const next = jest.fn();
    await requireAuth(req, res, next);
    expect(req.user).toEqual(row);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeNull();
  });

  test('an error thrown by what runs after it is not reported as a login failure', async () => {
    withUserRow({ id: 7, is_active: 1, approval_status: 'approved' });
    const res = fakeRes();
    const next = jest.fn(() => { throw new Error('handler blew up'); });
    await expect(requireAuth(reqWith(goodToken(7)), res, next)).rejects.toThrow('handler blew up');
    expect(res.statusCode).toBeNull();
  });
});

describe('requireAuth user cache', () => {
  function loadWithCache(ms) {
    process.env.AUTH_USER_CACHE_MS = String(ms);
    let mod;
    jest.isolateModules(() => { mod = require('../src/middleware/auth'); });
    delete process.env.AUTH_USER_CACHE_MS;
    return mod;
  }
  const row = { id: 9, name: 'Cached', role: 'finance', is_active: 1, approval_status: 'approved' };

  test('a second request inside the window does not query the database again', async () => {
    const { requireAuth: ra } = loadWithCache(60000);
    const get = jest.fn().mockResolvedValue(row);
    db.prepare.mockReturnValue({ get });
    await ra(reqWith(goodToken(9)), fakeRes(), jest.fn());
    await ra(reqWith(goodToken(9)), fakeRes(), jest.fn());
    expect(get).toHaveBeenCalledTimes(1);
  });

  test('a deactivated account is never cached', async () => {
    const { requireAuth: ra } = loadWithCache(60000);
    const get = jest.fn().mockResolvedValue({ ...row, is_active: 0 });
    db.prepare.mockReturnValue({ get });
    const res = fakeRes();
    await ra(reqWith(goodToken(9)), res, jest.fn());
    await ra(reqWith(goodToken(9)), fakeRes(), jest.fn());
    expect(res.statusCode).toBe(401);
    expect(get).toHaveBeenCalledTimes(2);
  });

  test('a cache of 0 turns it off', async () => {
    const { requireAuth: ra } = loadWithCache(0);
    const get = jest.fn().mockResolvedValue(row);
    db.prepare.mockReturnValue({ get });
    await ra(reqWith(goodToken(9)), fakeRes(), jest.fn());
    await ra(reqWith(goodToken(9)), fakeRes(), jest.fn());
    expect(get).toHaveBeenCalledTimes(2);
  });
});
