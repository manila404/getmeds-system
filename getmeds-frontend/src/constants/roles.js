/**
 * The roles an account may hold, and what each one can do.
 *
 * Sep 12, 2026. Mirrors the backend's src/constants/roles.js, which mirrors the
 * CHECK constraint on users.role. A role offered here that the server rejects
 * produces a 400 the admin cannot act on.
 *
 * The `can` line is not decoration. Changing someone's role changes what they
 * can see and do across the whole system, and the person making the change is
 * usually doing it for one reason without thinking about the rest — so the
 * consequence is stated at the point of choosing.
 */
export const ROLES = [
  { value: 'medrep',     label: 'MedRep',     can: 'Raises orders and sees their own.' },
  { value: 'finance',    label: 'Finance',    can: 'Sees every order; confirms customer accounts.' },
  { value: 'dispatch',   label: 'Dispatch',   can: 'Sees the dispatch queue and records shipments.' },
  { value: 'management', label: 'Management', can: 'Sees every order and approves what MedReps raise.' },
  { value: 'admin',      label: 'Admin',      can: 'Full access, including this Users screen.' },
];

export const roleLabel = (value) =>
  (ROLES.find((r) => r.value === String(value || '').toLowerCase()) || {}).label ||
  value ||
  'User';

export const roleCan = (value) =>
  (ROLES.find((r) => r.value === String(value || '').toLowerCase()) || {}).can || '';
