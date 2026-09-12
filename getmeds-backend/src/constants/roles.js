/**
 * The roles an account may hold.
 *
 * Sep 12, 2026. Must match the CHECK constraint on users.role in
 * schema.pg.sql. A value this list allows and the constraint rejects reaches
 * the database and returns a raw Postgres error to the caller; a value the
 * constraint allows and this list rejects simply cannot be set.
 *
 * Written down because an admin can now change a role from the Users screen.
 * Until that shipped, a role was only ever set at account creation, by someone
 * who already knew the five names.
 */
const ROLES = ['medrep', 'finance', 'dispatch', 'management', 'admin'];

/** What each role is called on screen. */
const ROLE_LABELS = {
  medrep: 'MedRep',
  finance: 'Finance',
  dispatch: 'Dispatch',
  management: 'Management',
  admin: 'Admin',
};

const isValidRole = (value) => ROLES.includes(String(value || '').trim().toLowerCase());

module.exports = { ROLES, ROLE_LABELS, isValidRole };
