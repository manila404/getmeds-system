const { isTestModeEnabled, requireTestMode } = require('../src/middleware/testMode');
const testController = require('../src/controllers/test.controller');
const db = require('../src/db/database');

describe('Test Mode Security & Controller', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('isTestModeEnabled', () => {
    test('returns true when TEST_MODE=true and NODE_ENV=development', () => {
      process.env.TEST_MODE = 'true';
      process.env.NODE_ENV = 'development';
      expect(isTestModeEnabled()).toBe(true);
    });

    test('returns false when TEST_MODE is not "true"', () => {
      process.env.TEST_MODE = 'false';
      process.env.NODE_ENV = 'development';
      expect(isTestModeEnabled()).toBe(false);

      delete process.env.TEST_MODE;
      expect(isTestModeEnabled()).toBe(false);
    });

    test('returns false in production even if TEST_MODE=true (Production Safeguard)', () => {
      process.env.TEST_MODE = 'true';
      process.env.NODE_ENV = 'production';
      expect(isTestModeEnabled()).toBe(false);
    });
  });

  describe('requireTestMode middleware', () => {
    test('calls next() when TEST_MODE is active', () => {
      process.env.TEST_MODE = 'true';
      process.env.NODE_ENV = 'development';
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const req = { method: 'POST', originalUrl: '/api/test/accounts' };

      requireTestMode(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    test('returns 403 Forbidden when TEST_MODE is disabled', () => {
      process.env.TEST_MODE = 'false';
      process.env.NODE_ENV = 'development';
      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const req = { method: 'POST', originalUrl: '/api/test/accounts' };

      requireTestMode(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'FORBIDDEN' })
        })
      );
    });
  });

  describe('Bulk Account Creation & Cleanup', () => {
    beforeEach(async () => {
      process.env.TEST_MODE = 'true';
      process.env.NODE_ENV = 'development';
      await testController.cleanupTestAccounts({}, { json: () => {} }, () => {});
    });

    afterEach(async () => {
      // Clean up any test users created during test
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await testController.cleanupTestAccounts({}, res, () => {});
    });

    test('creates test accounts in bulk with proper naming and roles', async () => {
      const req = {
        body: {
          count: 3,
          prefix: 'testunit',
          role: 'medrep',
          password: 'TestPassword123!',
          domain: 'test.getmeds.ph'
        }
      };
      let responseData = null;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((data) => {
          responseData = data;
        })
      };

      await testController.createBulkAccounts(req, res, (err) => { throw err; });

      expect(res.status).toHaveBeenCalledWith(201);
      expect(responseData.success).toBe(true);
      expect(responseData.data.createdCount).toBe(3);
      expect(responseData.data.accounts).toHaveLength(3);
      expect(responseData.data.accounts[0].email).toBe('testunit001@test.getmeds.ph');
      expect(responseData.data.accounts[1].email).toBe('testunit002@test.getmeds.ph');
      expect(responseData.data.accounts[2].email).toBe('testunit003@test.getmeds.ph');
      expect(responseData.data.accounts[0].role).toBe('medrep');

      // Verify users are saved in DB
      const userInDb = await db.prepare('SELECT * FROM users WHERE email = ?').get('testunit001@test.getmeds.ph');
      expect(userInDb).toBeDefined();
      expect(userInDb.name).toBe('Testunit User 001');
    });

    test('supports mixed roles distribution', async () => {
      const req = {
        body: {
          count: 5,
          prefix: 'testmixed',
          role: 'mixed',
          password: 'TestPassword123!',
          domain: 'test.getmeds.ph'
        }
      };
      let responseData = null;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((data) => { responseData = data; })
      };

      await testController.createBulkAccounts(req, res, (err) => { throw err; });

      expect(responseData.data.createdCount).toBe(5);
      const roles = responseData.data.accounts.map(a => a.role);
      expect(roles).toEqual(['medrep', 'finance', 'dispatch', 'management', 'admin']);
    });

    test('safely cleans up only test accounts without touching protected system accounts', async () => {
      // Seeded / protected account check
      const adminBefore = await db.prepare("SELECT * FROM users WHERE email = 'admin@getmeds.ph'").get();
      
      // Create some test accounts
      const createReq = {
        body: { count: 2, prefix: 'testuser', role: 'medrep' }
      };
      const dummyRes = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await testController.createBulkAccounts(createReq, dummyRes, () => {});

      // Perform cleanup
      let cleanupData = null;
      const cleanupRes = {
        json: jest.fn((data) => { cleanupData = data; })
      };
      await testController.cleanupTestAccounts({}, cleanupRes, () => {});

      expect(cleanupData.success).toBe(true);
      expect(cleanupData.data.deletedCount).toBeGreaterThanOrEqual(2);

      // Verify test accounts were deleted
      const testUser = await db.prepare("SELECT * FROM users WHERE email = 'testuser001@test.getmeds.ph'").get();
      expect(testUser).toBeUndefined();

      // Verify protected admin still exists
      if (adminBefore) {
        const adminAfter = await db.prepare("SELECT * FROM users WHERE email = 'admin@getmeds.ph'").get();
        expect(adminAfter).toBeDefined();
        expect(adminAfter.email).toBe('admin@getmeds.ph');
      }
    });

    test('authenticates user via quickLogin without password check when test mode is enabled', async () => {
      // Ensure admin@getmeds.ph exists
      const req = { body: { email: 'admin@getmeds.ph' } };
      let responseData = null;
      const res = {
        json: jest.fn((data) => { responseData = data; })
      };

      await testController.quickLogin(req, res, (err) => { throw err; });

      expect(responseData.success).toBe(true);
      expect(responseData.data.token).toBeDefined();
      expect(responseData.data.user.email).toBe('admin@getmeds.ph');
      expect(responseData.data.user.role).toBe('admin');
    });

    test('returns 404 when quickLogin is attempted with nonexistent email', async () => {
      const req = { body: { email: 'nonexistent@test.getmeds.ph' } };
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
      };

      await testController.quickLogin(req, res, (err) => { throw err; });

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.objectContaining({ code: 'NOT_FOUND' })
        })
      );
    });

    test('setZohoOutage/getZohoOutage: toggles the mock Zoho outage flag for demoing Scenario 4', () => {
      const zoho = require('../src/integrations/zoho');

      let responseData = null;
      const res = { json: jest.fn((data) => { responseData = data; }) };
      testController.setZohoOutage({ body: { enabled: true } }, res, (err) => { throw err; });
      expect(responseData.success).toBe(true);
      expect(responseData.data.simulatedOutage).toBe(true);
      expect(zoho.isSimulatedOutage()).toBe(true);

      const res2 = { json: jest.fn((data) => { responseData = data; }) };
      testController.getZohoOutage({}, res2, (err) => { throw err; });
      expect(responseData.data.simulatedOutage).toBe(true);

      const res3 = { json: jest.fn((data) => { responseData = data; }) };
      testController.setZohoOutage({ body: { enabled: false } }, res3, (err) => { throw err; });
      expect(responseData.data.simulatedOutage).toBe(false);
      expect(zoho.isSimulatedOutage()).toBe(false);
    });

    test('resolveActor: maps Admin actions to seeded role users in Test Mode', async () => {
      const { resolveActor } = require('../src/services/auditService');
      const adminUser = { id: 1, name: 'Admin User', email: 'admin@getmeds.ph', role: 'admin' };
      
      process.env.TEST_MODE = 'true';
      process.env.NODE_ENV = 'development';

      const medrepActor = await resolveActor(adminUser, 'medrep');
      expect(medrepActor.email).toBe('medrep@getmeds.ph');
      expect(medrepActor.role).toBe('medrep');

      const financeActor = await resolveActor(adminUser, 'finance');
      expect(financeActor.email).toBe('finance@getmeds.ph');
      expect(financeActor.role).toBe('finance');

      const dispatchActor = await resolveActor(adminUser, 'dispatch');
      expect(dispatchActor.email).toBe('dispatch@getmeds.ph');
      expect(dispatchActor.role).toBe('dispatch');

      // Unchanged when acting as admin
      const adminActor = await resolveActor(adminUser, 'admin');
      expect(adminActor.email).toBe('admin@getmeds.ph');
    });

    test('requireRole: allows Admin to bypass role restrictions in Test Mode', () => {
      const { requireRole } = require('../src/middleware/auth');
      process.env.TEST_MODE = 'true';
      process.env.NODE_ENV = 'development';

      const next = jest.fn();
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const req = { user: { id: 1, name: 'Admin User', role: 'admin' } };

      const medrepMiddleware = requireRole('medrep');
      medrepMiddleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      const financeMiddleware = requireRole('finance');
      financeMiddleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(2);

      const dispatchMiddleware = requireRole('dispatch');
      dispatchMiddleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(3);
    });
  });
});
