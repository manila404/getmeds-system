const db = require('../db/database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { isTestModeEnabled } = require('../middleware/testMode');
const zoho = require('../integrations/zoho');

const SECRET = process.env.JWT_SECRET || 'getmeds_secret_change_in_production';
const VALID_ROLES = ['medrep', 'finance', 'dispatch', 'management', 'admin'];

// Protected system accounts that must never be deleted by test mode cleanup
const PROTECTED_EMAILS = [
  'admin@getmeds.ph',
  'medrep@getmeds.ph',
  'medrep2@getmeds.ph',
  'finance@getmeds.ph',
  'dispatch@getmeds.ph',
  'manager@getmeds.ph'
];

/**
 * GET /api/test/status
 * Check Test Mode status safely without exposing secrets
 */
exports.getStatus = (req, res) => {
  const enabled = isTestModeEnabled();
  const debug = process.env.DEBUG === 'true';
  
  res.json({
    success: true,
    data: {
      testMode: enabled,
      debug: debug,
      environment: process.env.NODE_ENV || 'development'
    }
  });
};

/**
 * GET /api/test/accounts
 * List all current test accounts
 */
exports.getTestAccounts = async (req, res, next) => {
  try {
    const isDebug = process.env.DEBUG === 'true';
    if (isDebug) {
      console.log('[DEBUG] [TEST_MODE] Fetching list of test accounts');
    }

    // Query all accounts that are not protected system accounts
    const placeholders = PROTECTED_EMAILS.map(() => '?').join(',');
    const query = `
      SELECT id, name, email, role, is_active, is_test_account, created_at 
      FROM users 
      WHERE (is_test_account = 1 OR email LIKE 'test%' OR email LIKE '%@test.%' OR name LIKE '%User%' OR id > 6)
        AND email NOT IN (${placeholders})
      ORDER BY id ASC
    `;
    const accounts = await db.prepare(query).all(...PROTECTED_EMAILS);

    res.json({
      success: true,
      data: {
        total: accounts.length,
        accounts
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/test/accounts
 * Dedicated test-only bulk account creation endpoint
 */
exports.createBulkAccounts = async (req, res, next) => {
  try {
    const count = Math.min(Math.max(parseInt(req.body.count, 10) || 3, 1), 50);
    const prefix = (req.body.prefix || 'testuser').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'testuser';
    const rawRole = req.body.role || 'medrep';
    const defaultPassword = req.body.password || 'TestPass123!';
    const domain = (req.body.domain || 'test.getmeds.ph').trim().toLowerCase();
    const isActive = req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : 1;
    const startIndex = parseInt(req.body.startIndex, 10) || 1;

    console.log(`\n🧪 [TEST_MODE] Bulk account creation requested: count=${count}, prefix="${prefix}", role="${rawRole}", domain="${domain}"`);

    const results = [];
    const hash = bcrypt.hashSync(defaultPassword, 10);
    const insertStmt = db.prepare('INSERT INTO users (name, email, password_hash, role, is_active, is_test_account) VALUES (?, ?, ?, ?, ?, 1)');
    const checkStmt = db.prepare('SELECT id, name, email, role FROM users WHERE email = ?');

    let createdCount = 0;
    let failedCount = 0;

    for (let i = 0; i < count; i++) {
      const num = startIndex + i;
      const numStr = String(num).padStart(3, '0');
      const email = `${prefix}${numStr}@${domain}`;
      
      // Capitalize prefix for human-friendly name
      const cleanPrefixName = prefix.charAt(0).toUpperCase() + prefix.slice(1);
      const name = `${cleanPrefixName} User ${numStr}`;

      // Assign role (mixed distributes across valid roles)
      let role = rawRole;
      if (rawRole === 'mixed' || rawRole === 'all') {
        role = VALID_ROLES[i % VALID_ROLES.length];
      } else if (!VALID_ROLES.includes(rawRole)) {
        role = 'medrep';
      }

      // Check if user already exists
      const existing = await checkStmt.get(email);
      if (existing) {
        failedCount++;
        results.push({
          index: num,
          id: existing.id,
          name: existing.name,
          email: existing.email,
          role: existing.role,
          password: defaultPassword,
          status: 'failed',
          error: 'Email already in use'
        });
        if (process.env.DEBUG === 'true') {
          console.log(`[DEBUG] [TEST_MODE] User already exists: ${email}`);
        }
        continue;
      }

      try {
        const result = await insertStmt.run(name, email, hash, role, isActive);
        createdCount++;
        results.push({
          index: num,
          id: result.lastInsertRowid,
          name,
          email,
          role,
          password: defaultPassword,
          status: 'created',
          error: null
        });

        if (process.env.DEBUG === 'true') {
          console.log(`[DEBUG] [TEST_MODE] Created test account: id=${result.lastInsertRowid}, email=${email}, role=${role}`);
        }
      } catch (insertError) {
        failedCount++;
        results.push({
          index: num,
          name,
          email,
          role,
          password: defaultPassword,
          status: 'failed',
          error: insertError.message || 'Database error'
        });
        console.error(`❌ [TEST_MODE] Failed to create test account ${email}:`, insertError.message);
      }
    }

    console.log(`✅ [TEST_MODE] Bulk account creation completed: ${createdCount} created, ${failedCount} failed.\n`);

    res.status(201).json({
      success: true,
      data: {
        totalRequested: count,
        createdCount,
        failedCount,
        defaultPassword,
        accounts: results
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/test/accounts/:id
 * Delete an individual test account
 */
exports.deleteSingleAccount = async (req, res, next) => {
  try {
    const { id } = req.params;
    const user = await db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(id);
    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Test account not found' } });
    }
    if (PROTECTED_EMAILS.includes(user.email)) {
      return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Cannot delete protected system account' } });
    }

    const performDelete = db.transaction(async () => {
      await db.prepare('DELETE FROM notifications WHERE recipient_id = ?').run(user.id);
      await db.prepare('UPDATE order_events SET actor_id = NULL WHERE actor_id = ?').run(user.id);
      await db.prepare('UPDATE payments SET verified_by = NULL WHERE verified_by = ?').run(user.id);
      await db.prepare('UPDATE dispatch_records SET dispatched_by = NULL WHERE dispatched_by = ?').run(user.id);
      await db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    });

    await performDelete();
    console.log(`✅ [TEST_MODE] Deleted single test account ${user.email} (id: ${user.id})`);
    res.json({ success: true, data: { deletedAccount: user } });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/test/accounts or POST /api/test/accounts/cleanup
 * Safely delete all test accounts without affecting production / seeded accounts
 */
exports.cleanupTestAccounts = async (req, res, next) => {
  try {
    console.log('\n🧹 [TEST_MODE] Test account cleanup requested');

    const placeholders = PROTECTED_EMAILS.map(() => '?').join(',');
    const selectQuery = `
      SELECT id, name, email, role 
      FROM users 
      WHERE (is_test_account = 1 OR email LIKE 'test%' OR email LIKE '%@test.%')
        AND email NOT IN (${placeholders})
    `;
    const accountsToDelete = await db.prepare(selectQuery).all(...PROTECTED_EMAILS);

    if (accountsToDelete.length === 0) {
      console.log('ℹ️  [TEST_MODE] No test accounts found to delete.');
      return res.json({
        success: true,
        data: {
          deletedCount: 0,
          deletedAccounts: [],
          message: 'No test accounts found to clean up.'
        }
      });
    }

    const deleteUserIds = accountsToDelete.map(a => a.id);
    const idPlaceholders = deleteUserIds.map(() => '?').join(',');

    // Use transaction for safe multi-table cleanup
    const performCleanup = db.transaction(async () => {
      // 1. Clean notifications recipient links for test users
      await db.prepare(`DELETE FROM notifications WHERE recipient_id IN (${idPlaceholders})`).run(...deleteUserIds);

      // 2. Clear actor references in order_events for test users if any
      await db.prepare(`UPDATE order_events SET actor_id = NULL WHERE actor_id IN (${idPlaceholders})`).run(...deleteUserIds);

      // 3. Clear verified_by and dispatched_by references if any
      await db.prepare(`UPDATE payments SET verified_by = NULL WHERE verified_by IN (${idPlaceholders})`).run(...deleteUserIds);
      await db.prepare(`UPDATE dispatch_records SET dispatched_by = NULL WHERE dispatched_by IN (${idPlaceholders})`).run(...deleteUserIds);

      // 4. Reassign medrep_id in orders to default user (id 1 or first protected user) to preserve order records
      const defaultUser = await db.prepare('SELECT id FROM users LIMIT 1').get();
      if (defaultUser) {
        await db.prepare(`UPDATE orders SET medrep_id = ? WHERE medrep_id IN (${idPlaceholders})`).run(defaultUser.id, ...deleteUserIds);
      }

      // 5. Finally delete the test users
      await db.prepare(`DELETE FROM users WHERE id IN (${idPlaceholders})`).run(...deleteUserIds);
    });

    await performCleanup();

    console.log(`✅ [TEST_MODE] Successfully deleted ${accountsToDelete.length} test accounts.\n`);

    res.json({
      success: true,
      data: {
        deletedCount: accountsToDelete.length,
        deletedAccounts: accountsToDelete.map(a => ({ id: a.id, email: a.email, name: a.name, role: a.role }))
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/test/quick-login
 * Direct 1-click login for test accounts when Test Mode is active
 */
exports.quickLogin = async (req, res, next) => {
  try {
    const { email, role } = req.body;
    if (!email && !role) {
      return res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Email or role is required for quick login' } });
    }

    let user;
    if (email) {
      user = await db.prepare('SELECT id, name, email, role, is_active FROM users WHERE email = ?').get(email);
    }
    
    // Fallback by role if user by email not found or only role provided
    if (!user && role) {
      user = await db.prepare('SELECT id, name, email, role, is_active FROM users WHERE role = ? AND is_active = 1 ORDER BY id ASC LIMIT 1').get(role);
    }

    if (!user) {
      return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: `User not found` } });
    }
    if (!user.is_active) {
      return res.status(403).json({ success: false, error: { code: 'ACCOUNT_INACTIVE', message: 'Account is deactivated' } });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, SECRET, { expiresIn: '8h' });

    if (process.env.DEBUG === 'true') {
      console.log(`[DEBUG] [TEST_MODE] Quick login successful for ${user.email} (${user.role})`);
    }

    res.json({
      success: true,
      data: {
        token,
        user: { id: user.id, name: user.name, email: user.email, role: user.role }
      }
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/test/zoho/outage
 * Demo control: flip a simulated Zoho outage on/off (mock mode only — a
 * no-op against LiveZohoAdapter). Lets Aaron demo Scenario 4 live: enable
 * the outage, submit an order (it still succeeds with zoho_sync_status
 * 'failed' and gets queued), disable the outage, then trigger a retry pass
 * via POST /api/admin/zoho/queue/retry and watch it sync.
 */
exports.setZohoOutage = (req, res, next) => {
  try {
    const enabled = !!req.body.enabled;
    zoho.setSimulatedOutage(enabled);
    console.log(`🧪 [TEST_MODE] Zoho simulated outage set to: ${enabled}`);
    res.json({ success: true, data: { simulatedOutage: zoho.isSimulatedOutage() } });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/test/zoho/outage
 * Check current simulated-outage state.
 */
exports.getZohoOutage = (req, res, next) => {
  try {
    res.json({ success: true, data: { simulatedOutage: zoho.isSimulatedOutage() } });
  } catch (err) {
    next(err);
  }
};
