const db = require('../db/database');
const bcrypt = require('bcryptjs');
const zohoRetryService = require('../services/zohoRetryService');

// Get all users with their roles
const getAllUsers = async (req, res, next) => {
  try {
    const users = await db.prepare('SELECT id, name, email, role, is_active, created_at FROM users ORDER BY name').all();
    const enriched = users.map(u => ({
      ...u,
      username: u.email ? u.email.split('@')[0] : `user_${u.id}`,
      role_name: u.role ? (u.role.charAt(0).toUpperCase() + u.role.slice(1)) : 'User',
      first_name: u.name ? u.name.split(' ')[0] : '',
      last_name: u.name ? u.name.split(' ').slice(1).join(' ') : ''
    }));
    res.status(200).json({ success: true, data: enriched });
  } catch (err) {
    if (next) return next(err);
    res.status(500).json({ success: false, message: 'Failed to retrieve users', error: err.message });
  }
};

// Deactivate a user (Soft Delete)
const deactivateUser = async (req, res, next) => {
  try {
    const userId = req.params.id;
    const user = await db.prepare('SELECT id, name, is_active FROM users WHERE id = ?').get(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    await db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
    res.status(200).json({ 
      success: true, 
      message: `User ${userId} deactivated successfully.` 
    });
  } catch (err) {
    if (next) return next(err);
    res.status(500).json({ success: false, message: 'Failed to deactivate user', error: err.message });
  }
};

// Create a new user
const create = async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'name, email, password, role required' } });
    }
    const valid_roles = ['medrep', 'finance', 'dispatch', 'management', 'admin'];
    if (!valid_roles.includes(role.toLowerCase())) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: `role must be one of: ${valid_roles.join(', ')}` } });
    }
    // Sep 5, 2026: normalize to lowercase before storing — seed.js,
    // create-user.js and the public sign-up endpoint all already do this;
    // this was the one path that didn't, so an admin-created account could
    // carry a mixed-case email that then could never log in (see the fix in
    // auth.controller.js's login — LOWER() there covers accounts already
    // created with mixed case, but new ones should just be stored correctly).
    const normalizedEmail = email.trim().toLowerCase();
    const existing = await db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').get(normalizedEmail);
    if (existing) return res.status(409).json({ success: false, error: { code: 'CONFLICT', message: 'Email already in use' } });

    const hash = bcrypt.hashSync(password, 10);
    const result = await db.prepare('INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)').run(name, normalizedEmail, hash, role.toLowerCase());
    const user = await db.prepare('SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json({ success: true, data: { user } });
  } catch (err) {
    if (next) next(err);
    else res.status(500).json({ success: false, error: err.message });
  }
};

// Update an existing user
const update = async (req, res, next) => {
  try {
    const { role, is_active } = req.body;
    const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
    if (!user) return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'User not found' } });

    if (role !== undefined) await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role.toLowerCase(), user.id);
    if (is_active !== undefined) await db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(is_active ? 1 : 0, user.id);

    const updated = await db.prepare('SELECT id, name, email, role, is_active, created_at FROM users WHERE id = ?').get(user.id);
    res.json({ success: true, data: { user: updated } });
  } catch (err) {
    if (next) next(err);
    else res.status(500).json({ success: false, error: err.message });
  }
};

// GET /api/admin/zoho/queue — view the Zoho sync retry outbox
const getZohoQueue = async (req, res, next) => {
  try {
    const queue = await zohoRetryService.listQueue();
    res.json({
      success: true,
      data: {
        queue,
        summary: {
          pending: queue.filter((q) => q.status === 'pending').length,
          succeeded: queue.filter((q) => q.status === 'succeeded').length,
          failed_permanent: queue.filter((q) => q.status === 'failed_permanent').length
        }
      }
    });
  } catch (err) {
    if (next) return next(err);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
};

// POST /api/admin/zoho/queue/retry — trigger an immediate retry pass (ignores backoff window)
const retryZohoQueue = async (req, res, next) => {
  try {
    const results = await zohoRetryService.processQueue({ force: true });
    res.json({ success: true, data: { processed: results.length, results } });
  } catch (err) {
    if (next) return next(err);
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: err.message } });
  }
};

module.exports = {
  getAllUsers,
  getAll: getAllUsers,
  deactivateUser,
  create,
  update,
  getZohoQueue,
  retryZohoQueue
};

