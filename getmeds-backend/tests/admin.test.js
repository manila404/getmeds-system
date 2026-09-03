const { isAdmin } = require('../src/middleware/auth');
const adminController = require('../src/controllers/admin.controller');
const db = require('../src/db/database');

describe('Admin Layer Unit Tests', () => {
  describe('isAdmin Security Middleware', () => {
    test('blocks request with 401 when no user is attached to request', () => {
      const req = {};
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      isAdmin(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: expect.stringContaining('Authentication required')
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    test('blocks request with 403 when user role is not admin (e.g. medrep)', () => {
      const req = { user: { id: 2, name: 'Juan MedRep', role: 'medrep' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      isAdmin(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          message: expect.stringContaining('Access denied')
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    test('calls next() when user has admin role', () => {
      const req = { user: { id: 1, name: 'Admin User', role: 'admin' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      isAdmin(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    });

    test('calls next() when role is capitalized "Admin"', () => {
      const req = { user: { id: 1, name: 'Admin User', role: 'Admin' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      const next = jest.fn();

      isAdmin(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe('adminController.getAllUsers', () => {
    test('fetches user list with HTTP 200', async () => {
      const req = {};
      let responseBody = null;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((body) => { responseBody = body; })
      };

      await adminController.getAllUsers(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(responseBody.success).toBe(true);
      expect(Array.isArray(responseBody.data)).toBe(true);
      expect(responseBody.data.length).toBeGreaterThan(0);
    });
  });

  describe('adminController.deactivateUser', () => {
    test('soft deletes / deactivates user by setting is_active = 0', async () => {
      // Insert temporary user
      const insert = await db.prepare("INSERT INTO users (name, email, password_hash, role, is_active) VALUES ('Temp User', 'temp_unit_deact@test.com', 'hash', 'medrep', 1)").run();
      const tempId = insert.lastInsertRowid;

      const req = { params: { id: tempId } };
      let responseBody = null;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn((body) => { responseBody = body; })
      };

      await adminController.deactivateUser(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(responseBody.success).toBe(true);
      expect(responseBody.message).toContain(`User ${tempId} deactivated successfully.`);

      const userInDb = await db.prepare('SELECT is_active FROM users WHERE id = ?').get(tempId);
      expect(userInDb.is_active).toBe(0);

      // Clean up
      await db.prepare('DELETE FROM users WHERE id = ?').run(tempId);
    });

    test('returns 404 if user does not exist', async () => {
      const req = { params: { id: 999999 } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

      await adminController.deactivateUser(req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ success: false, message: 'User not found' })
      );
    });
  });
});
