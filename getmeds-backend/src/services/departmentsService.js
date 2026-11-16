const db = require('../db/database');
const { hasColumn } = require('./schemaColumns');

/**
 * Departments. Nov 16, 2026 (Aaron).
 *
 * The four main departments are fixed: Admin, Finance, Sales (CHC), Operation. They follow the
 * account's role, so nothing is stored for them. What is stored here:
 *  - Operation's two units: users.operation_unit = 'Pharmacy' | 'Dispatcher';
 *  - departments an admin ADDS (the first: PAP, with Fhaye as its only person), and who is in
 *    them (department_members). Being in an added department does not change the account's
 *    role, Zoho Salesperson or what it can see: it is the structure only, like the sales_* tables.
 *
 * Until the migration has run (reconcileDepartmentStructure, or departments-structure.sql on
 * live), reads return nothing and writes answer "run the migration" instead of failing.
 */

const OPERATION_UNITS = ['Pharmacy', 'Dispatcher'];

const bad = (message, code = 'VALIDATION_ERROR', status = 400) => ({ error: { message, code, status } });
const clean = (v) => String(v == null ? '' : v).trim().replace(/\s+/g, ' ');
const NOT_READY = () => bad('Departments are not set up on this database yet. Run the departments migration first.', 'NOT_READY', 409);

const ready = () => hasColumn('departments', 'id');
const isId = (v) => Number.isInteger(v) && v > 0;
const NOT_FOUND = (what) => bad(`${what} not found.`, 'NOT_FOUND', 404);

async function list() {
  if (!(await ready())) return { ready: false, departments: [] };
  const depts = await db.prepare('SELECT id, name, note, created_at FROM departments ORDER BY LOWER(name)').all();
  const members = await db.prepare(
    `SELECT m.department_id, u.id, u.name, u.email, u.role, u.salesperson, u.is_active, u.approval_status
       FROM department_members m JOIN users u ON u.id = m.user_id
      ORDER BY u.name`
  ).all();
  return {
    ready: true,
    departments: depts.map((d) => ({ ...d, members: members.filter((m) => m.department_id === d.id) })),
  };
}

async function create(body, actorId) {
  if (!(await ready())) return NOT_READY();
  const name = clean(body.name);
  const note = clean(body.note) || null;
  if (!name) return bad('A department name is required.');
  if (name.length > 60) return bad('Keep the department name under 60 characters.');
  const main = ['admin', 'finance', 'sales', 'sales (chc)', 'operation', 'operations'];
  if (main.includes(name.toLowerCase())) return bad(`"${name}" is already a main department.`, 'CONFLICT', 409);
  const clash = await db.prepare('SELECT id FROM departments WHERE LOWER(name) = ?').get(name.toLowerCase());
  if (clash) return bad(`A department called "${name}" already exists.`, 'CONFLICT', 409);
  // RETURNING asked for here: the db wrapper only adds it for tables it saw at startup, and this
  // table can be created by the migration while the server is running.
  const r = await db.prepare('INSERT INTO departments (name, note, created_by) VALUES (?, ?, ?) RETURNING id').get(name, note, actorId || null);
  return { id: r && r.id, created: true };
}

async function remove(id) {
  if (!(await ready())) return NOT_READY();
  if (!isId(id)) return NOT_FOUND('Department');
  const d = await db.prepare('SELECT id FROM departments WHERE id = ?').get(id);
  if (!d) return bad('Department not found.', 'NOT_FOUND', 404);
  const n = await db.prepare('SELECT COUNT(*) AS n FROM department_members WHERE department_id = ?').get(id);
  if (Number(n.n) > 0) return bad('Remove the people in this department first.', 'CONFLICT', 409);
  await db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  return { id, removed: true };
}

async function addMember(deptId, body, actorId) {
  if (!(await ready())) return NOT_READY();
  const userId = parseInt(body.user_id, 10);
  if (!isId(deptId)) return NOT_FOUND('Department');
  if (!(await db.prepare('SELECT id FROM departments WHERE id = ?').get(deptId))) return bad('Department not found.', 'NOT_FOUND', 404);
  if (!isId(userId) || !(await db.prepare('SELECT id FROM users WHERE id = ?').get(userId))) return bad('user_id must be an existing account.');
  const has = await db.prepare('SELECT 1 AS x FROM department_members WHERE department_id = ? AND user_id = ?').get(deptId, userId);
  if (has) return { department_id: deptId, user_id: userId };
  await db.prepare('INSERT INTO department_members (department_id, user_id, created_by) VALUES (?, ?, ?)').run(deptId, userId, actorId || null);
  return { department_id: deptId, user_id: userId, created: true };
}

async function removeMember(deptId, userId) {
  if (!(await ready())) return NOT_READY();
  if (!isId(deptId) || !isId(userId)) return NOT_FOUND('Department member');
  await db.prepare('DELETE FROM department_members WHERE department_id = ? AND user_id = ?').run(deptId, userId);
  return { department_id: deptId, user_id: userId, removed: true };
}

/** The added departments an account is in (names), e.g. ['PAP']. [] before the migration. */
async function namesFor(userId) {
  if (!(await ready())) return [];
  const rows = await db.prepare(
    'SELECT d.name FROM department_members m JOIN departments d ON d.id = m.department_id WHERE m.user_id = ? ORDER BY d.name'
  ).all(userId);
  return rows.map((r) => r.name);
}

/** Pharmacy / Dispatcher for an Operation account; null clears it. */
async function setOperationUnit(userId, body) {
  if (!(await hasColumn('users', 'operation_unit'))) return NOT_READY();
  if (!isId(userId)) return NOT_FOUND('Account');
  const u = await db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId);
  if (!u) return bad('Account not found.', 'NOT_FOUND', 404);
  if (String(u.role).toLowerCase() !== 'dispatch') return bad('Only Operation accounts have a Pharmacy / Dispatcher unit.');
  const unit = body.operation_unit == null || body.operation_unit === '' ? null : clean(body.operation_unit);
  if (unit !== null && !OPERATION_UNITS.includes(unit)) return bad(`Unit must be one of: ${OPERATION_UNITS.join(', ')}.`);
  await db.prepare('UPDATE users SET operation_unit = ? WHERE id = ?').run(unit, userId);
  return { id: userId, operation_unit: unit };
}

module.exports = { OPERATION_UNITS, list, create, remove, addMember, removeMember, setOperationUnit, namesFor };
