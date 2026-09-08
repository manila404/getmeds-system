import React, { useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import client from '../api/client';
import toast from 'react-hot-toast';
import { UserRound, ShieldCheck, Loader2 } from 'lucide-react';

/**
 * Profile Settings — Sep 5, 2026.
 *
 * A signed-in user editing their own account: display name, division,
 * sub-division, and password. Reachable via the Topbar's user menu
 * (Topbar.jsx) for every role — this page has no allowedRoles restriction
 * in App.jsx, since "edit my own account" is not a role-gated action.
 *
 * Deliberately NOT here: first/middle/last legal name (collected at
 * sign-up, not shown or used anywhere else, so there's nothing this page
 * would keep in sync by exposing them), email (the login identifier —
 * changing it safely needs its own verification step), and role (an
 * admin-only decision, made from /admin/users).
 *
 * The Division/Display Name pair matters beyond cosmetics: `salesperson` is
 * a GENERATED column, "<division> | <display name>", and it's the exact
 * value LiveZohoAdapter puts on every Sales Order this account creates —
 * see the long comment on auth.controller.js's register(). Editing either
 * field here changes what gets sent to Zoho on the next order, which is
 * why both are shown next to a live preview of the resulting Salesperson
 * string, same as the sign-up form does.
 */
const MIN_PASSWORD_LENGTH = 8;

// Sep 5, 2026: mirrors the backend's DIVISIONS in auth.controller.js and
// SignupPage.jsx's copy exactly — see auth.controller.js's comment for why
// division is a fixed list rather than free text. Kept in the order given.
const DIVISIONS = [
  '2MG Incorporated',
  'GrabMart',
  'Office of the President',
  'PCSO',
  'DSWD',
  'B&B',
  'B2B',
  'B2C',
  'BID',
  'CLIDP',
  'HOS',
  'MSA',
  'STC',
  'TeleSales Anesthesia',
  'URO',
];

// Sep 5, 2026 (2): mirrors the backend's SUB_DIVISIONS_BY_DIVISION in
// auth.controller.js exactly — see that file's comment for why only these
// four Divisions get a fixed Sub-division dropdown. Any Division not listed
// here has no fixed sub-divisions, so the field below falls back to free
// text for it, same as before this change.
const SUB_DIVISIONS_BY_DIVISION = {
  'B&B': ['CEBU', 'DAVAO', 'E. RODRIGUEZ', 'EAST AVE', 'NCL', 'SOUTH LUZON', 'TAFT'],
  HOS: [
    'GENSAN',
    'PALAWAN',
    'BAGUIO',
    'BICOL',
    'CABANATUAN',
    'CAMANAVA',
    'CAVITE',
    'CDO',
    'COMMONWEALTH',
    'DAVAO NORTH',
    'DAVAO SOUTH',
    'ILOILO',
    'LAGUNA',
    'LAS PINAS',
    'MANILA VACANT',
    'MARIKINA',
    'NORTH CEBU',
    'PAMPANGA',
    'PARANAQUE',
    'PASAY',
    'QUEZON PROVINCE',
    'SOUTH CEBU',
    'TUGUEGARAO',
    'ZAMBOANGA',
  ],
  STC: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
  URO: ['CEBU', 'COMMONWEALTH', 'DAVAO', 'KALAW', 'NCL', 'SOUTH LUZON', 'TMC ORTIGAS'],
};

const inputClass =
  'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue shadow-2xs transition-colors disabled:bg-surface disabled:text-ink-secondary';
const readOnlyPillClass =
  'w-full bg-surface border border-slate-200 rounded-lg px-3 py-2 text-sm font-semibold text-ink-primary flex items-center gap-2';

const Field = ({ label, required, help, children }) => (
  <div>
    <label className="block text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">
      {label} {required && <span className="text-state-error">*</span>}
    </label>
    {children}
    {help && <p className="text-[11px] text-ink-secondary mt-1">{help}</p>}
  </div>
);

const buildSalesperson = (division, displayName) => {
  const d = (division || '').trim();
  const n = (displayName || '').trim();
  return d && n ? `${d} | ${n}` : '';
};

const ProfilePage = () => {
  const { user, refreshUser } = useAuth();

  const [profileForm, setProfileForm] = useState({
    display_name: user?.name || '',
    division: user?.division || '',
    sub_division: user?.sub_division || '',
  });
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  const [passwordForm, setPasswordForm] = useState({
    current_password: '',
    new_password: '',
    confirm: '',
  });
  const [showPasswords, setShowPasswords] = useState(false);
  const [isSavingPassword, setIsSavingPassword] = useState(false);

  const salesperson = buildSalesperson(profileForm.division, profileForm.display_name);

  // Sep 5, 2026: an account may already carry a division from before this
  // became a fixed list (e.g. the seeded accounts' 'TEST'). Rather than
  // silently dropping it from the dropdown (which would either blank the
  // field or force a save to change it), it's added as its own option so
  // it stays visible and selectable until the user actually picks a real
  // one — updateProfile() on the backend allows keeping it unchanged but
  // rejects moving it to any OTHER off-list value.
  const legacyDivision = (user?.division || '').trim();
  const divisionOptions =
    legacyDivision && !DIVISIONS.includes(legacyDivision) ? [legacyDivision, ...DIVISIONS] : DIVISIONS;

  // null when the currently-selected Division has no fixed Sub-division
  // list — the field below renders free text in that case, same as always.
  const subDivisionOptions = SUB_DIVISIONS_BY_DIVISION[profileForm.division] || null;

  // Same legacy carve-out as Division just above, but only shown while the
  // form still has the account's ORIGINAL division selected — if the user
  // has switched to a different Division (which clears Sub-division via
  // handleDivisionChange below), the old value no longer means anything and
  // shouldn't be offered as if it still applied.
  const legacySubDivision = (user?.sub_division || '').trim();
  const subDivisionIsOnOriginalDivision = profileForm.division === legacyDivision;
  const subDivisionSelectOptions =
    subDivisionOptions && subDivisionIsOnOriginalDivision && legacySubDivision && !subDivisionOptions.includes(legacySubDivision)
      ? [legacySubDivision, ...subDivisionOptions]
      : subDivisionOptions;

  // Sep 5, 2026 (2): Sub-division's own options depend on which Division is
  // selected — clear it on every Division change so a value that doesn't
  // belong to the newly chosen Division is never silently carried over and
  // submitted.
  const handleDivisionChange = (e) => {
    setProfileForm((f) => ({ ...f, division: e.target.value, sub_division: '' }));
  };

  const handleProfileSubmit = async (e) => {
    e.preventDefault();
    const displayName = profileForm.display_name.trim();
    const division = profileForm.division.trim();
    if (!displayName || !division) {
      toast.error('Display Name and Division are required.');
      return;
    }

    setIsSavingProfile(true);
    try {
      await client.patch('/api/auth/profile', {
        display_name: displayName,
        division,
        sub_division: profileForm.sub_division.trim(),
      });
      // Re-fetches /me so the Topbar's name/role and the New Order form's
      // Salesperson/Division fields all pick up the change immediately,
      // without a page reload.
      await refreshUser();
      toast.success('Profile updated.');
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Could not update profile.');
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handlePasswordSubmit = async (e) => {
    e.preventDefault();
    if (passwordForm.new_password.length < MIN_PASSWORD_LENGTH) {
      toast.error(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (passwordForm.new_password !== passwordForm.confirm) {
      toast.error('The two new passwords do not match.');
      return;
    }

    setIsSavingPassword(true);
    try {
      await client.patch('/api/auth/password', {
        current_password: passwordForm.current_password,
        new_password: passwordForm.new_password,
      });
      toast.success('Password updated.');
      setPasswordForm({ current_password: '', new_password: '', confirm: '' });
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Could not update password.');
    } finally {
      setIsSavingPassword(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-ink-primary">Profile Settings</h1>
        <p className="text-sm text-ink-secondary mt-1">Manage your account details and password.</p>
      </div>

      {/* Profile Information */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-visible">
        <form onSubmit={handleProfileSubmit} className="p-6 sm:p-8 space-y-5">
          <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100">
            <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
              <UserRound size={16} />
            </div>
            <h2 className="text-base font-bold text-ink-primary">Profile Information</h2>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Email">
              <span className={readOnlyPillClass}>{user?.email}</span>
            </Field>
            <Field label="Role" help="Set by an administrator.">
              <span className={`${readOnlyPillClass} capitalize`}>{user?.role}</span>
            </Field>
          </div>

          <Field
            label="Display Name"
            required
            help="Shown throughout the app, and used to build your Salesperson name for Zoho."
          >
            <input
              type="text"
              value={profileForm.display_name}
              onChange={(e) => setProfileForm((f) => ({ ...f, display_name: e.target.value }))}
              className={inputClass}
              required
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Division" required>
              <select
                value={profileForm.division}
                onChange={handleDivisionChange}
                className={inputClass}
                required
              >
                <option value="">-- Select division --</option>
                {divisionOptions.map((d) => (
                  <option key={d} value={d}>
                    {d}
                    {d === legacyDivision && !DIVISIONS.includes(d) ? ' (current — not in standard list)' : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Sub-division" help="Optional.">
              {subDivisionSelectOptions ? (
                <select
                  value={profileForm.sub_division}
                  onChange={(e) => setProfileForm((f) => ({ ...f, sub_division: e.target.value }))}
                  className={inputClass}
                >
                  <option value="">-- Select sub-division --</option>
                  {subDivisionSelectOptions.map((sd) => (
                    <option key={sd} value={sd}>
                      {sd}
                      {sd === legacySubDivision && subDivisionOptions && !subDivisionOptions.includes(sd)
                        ? ' (current — not in standard list)'
                        : ''}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={profileForm.sub_division}
                  onChange={(e) => setProfileForm((f) => ({ ...f, sub_division: e.target.value }))}
                  className={inputClass}
                />
              )}
            </Field>
          </div>

          {/* Read-only: the database derives this from Division + Display
              name, same preview the sign-up form shows. */}
          <Field
            label="Salesperson"
            help="Built automatically from Division + Display Name — this is what's sent to Zoho on your Sales Orders."
          >
            <div className={readOnlyPillClass}>
              {salesperson || <span className="text-ink-secondary font-normal">Division | Display Name</span>}
            </div>
          </Field>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={isSavingProfile}
              className="flex items-center gap-2 px-6 py-2.5 bg-getmeds-blue text-white rounded-lg text-sm font-bold hover:bg-getmeds-blue-hover disabled:opacity-60 shadow-md shadow-getmeds-blue/20"
            >
              {isSavingProfile && <Loader2 size={15} className="animate-spin" />}
              Save Changes
            </button>
          </div>
        </form>
      </div>

      {/* Change Password */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-visible">
        <form onSubmit={handlePasswordSubmit} className="p-6 sm:p-8 space-y-5">
          <div className="flex items-center gap-2.5 pb-2 border-b border-slate-100">
            <div className="w-7 h-7 rounded-md bg-getmeds-blue/15 flex items-center justify-center text-getmeds-blue">
              <ShieldCheck size={16} />
            </div>
            <h2 className="text-base font-bold text-ink-primary">Change Password</h2>
          </div>

          <Field label="Current Password" required>
            <input
              type={showPasswords ? 'text' : 'password'}
              autoComplete="current-password"
              value={passwordForm.current_password}
              onChange={(e) => setPasswordForm((f) => ({ ...f, current_password: e.target.value }))}
              className={inputClass}
              required
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="New Password" required help={`At least ${MIN_PASSWORD_LENGTH} characters.`}>
              <input
                type={showPasswords ? 'text' : 'password'}
                autoComplete="new-password"
                minLength={MIN_PASSWORD_LENGTH}
                value={passwordForm.new_password}
                onChange={(e) => setPasswordForm((f) => ({ ...f, new_password: e.target.value }))}
                className={inputClass}
                required
              />
            </Field>
            <Field label="Confirm New Password" required>
              <input
                type={showPasswords ? 'text' : 'password'}
                autoComplete="new-password"
                value={passwordForm.confirm}
                onChange={(e) => setPasswordForm((f) => ({ ...f, confirm: e.target.value }))}
                className={inputClass}
                required
              />
            </Field>
          </div>

          <label className="inline-flex items-center gap-2 text-xs text-ink-secondary cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showPasswords}
              onChange={(e) => setShowPasswords(e.target.checked)}
              className="rounded border-slate-300 text-getmeds-blue focus:ring-getmeds-blue"
            />
            Show passwords
          </label>

          <div className="flex justify-end pt-2">
            <button
              type="submit"
              disabled={isSavingPassword}
              className="flex items-center gap-2 px-6 py-2.5 bg-getmeds-blue text-white rounded-lg text-sm font-bold hover:bg-getmeds-blue-hover disabled:opacity-60 shadow-md shadow-getmeds-blue/20"
            >
              {isSavingPassword && <Loader2 size={15} className="animate-spin" />}
              Update Password
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ProfilePage;
