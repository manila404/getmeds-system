import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { useNavigate, Link } from 'react-router-dom';
import ErrorMessage from '../components/ui/ErrorMessage';
import LoadingSpinner from '../components/ui/LoadingSpinner';
import { Eye, EyeOff, ArrowLeft } from 'lucide-react';
import employeeBg from '../assets/employee.jpg';

// Sep 2, 2026. Self-service sign-up, so MedReps stop sharing the seeded
// demo123 logins. Every account created here is a MedRep — the backend
// hard-codes the role and ignores anything the client sends, so there is
// deliberately no role picker on this form to imply otherwise. Finance,
// Dispatch, Management and Admin accounts are still made by an admin on
// /admin/users.
//
// Sep 2, 2026 (2): name parts + Division, and the Salesperson line they
// build. That string is what this Zoho org requires on every Sales Order
// ("Salesperson" is a mandatory field there) and it always reads
// "<division> | <display name>" — e.g. "TEST | Aaron Manila". It is shown
// read-only rather than typed, and the value that counts is computed by the
// database, not by this component: what you see here is a preview of it.
const MIN_PASSWORD_LENGTH = 8;

// Sep 5, 2026: mirrors the backend's DIVISIONS in auth.controller.js
// exactly — see that file's comment for why this became a fixed dropdown
// instead of free text (a free-typed division created junk Salespersons in
// the live Zoho org before, since division feeds `salesperson`, the exact
// string sent to every Zoho Sales Order). Kept in the order given.
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

const buildSalesperson = (division, displayName) => {
  const d = (division || '').trim();
  const n = (displayName || '').trim();
  return d && n ? `${d} | ${n}` : '';
};

const SignupPage = () => {
  const [form, setForm] = useState({
    first_name: '',
    middle_name: '',
    last_name: '',
    display_name: '',
    division: '',
    sub_division: '',
    email: '',
    password: '',
    confirm: ''
  });
  // Display name follows first + last until the user edits it themselves —
  // after that it is theirs and typing a name never overwrites it again.
  const [displayNameTouched, setDisplayNameTouched] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const { signup } = useAuth();
  const navigate = useNavigate();

  const set = (field) => (e) => {
    const value = e.target.value;
    setForm((f) => {
      const next = { ...f, [field]: value };
      if (field === 'display_name') return next;
      // Sep 5, 2026 (2): Sub-division's own options depend on which Division
      // is selected (see SUB_DIVISIONS_BY_DIVISION) — clear it on every
      // Division change so a value that doesn't belong to the newly chosen
      // Division is never silently carried over and submitted.
      if (field === 'division') {
        next.sub_division = '';
        return next;
      }
      if (!displayNameTouched && (field === 'first_name' || field === 'last_name')) {
        next.display_name = [next.first_name.trim(), next.last_name.trim()].filter(Boolean).join(' ');
      }
      return next;
    });
  };

  const onDisplayNameChange = (e) => {
    setDisplayNameTouched(true);
    setForm((f) => ({ ...f, display_name: e.target.value }));
  };

  const salesperson = buildSalesperson(form.division, form.display_name);

  // null when the selected Division has no fixed Sub-division list — the
  // field below renders free text in that case, same as it always has.
  const subDivisionOptions = SUB_DIVISIONS_BY_DIVISION[form.division] || null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    // Checked here only to save a round trip — the backend enforces all of
    // this independently and is the actual authority.
    if (form.password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (form.password !== form.confirm) {
      setError('The two passwords do not match.');
      return;
    }

    setIsLoading(true);
    try {
      const { confirm, ...fields } = form;
      await signup(fields);
      navigate('/dashboard');
    } catch (err) {
      setError(
        err.response?.data?.error?.message ||
          err.response?.data?.message ||
          'Could not create your account. Please try again.'
      );
    } finally {
      setIsLoading(false);
    }
  };

  const inputClass =
    'w-full px-4 py-3 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent placeholder-ink-secondary/50';
  const labelClass = 'block text-[13px] font-semibold text-ink-primary mb-1.5';
  const optionalClass = 'font-normal text-ink-secondary';

  return (
    <div className="min-h-screen w-full flex font-sans relative overflow-auto bg-gray-900">
      <div
        className="absolute inset-0 z-0 bg-cover bg-center bg-fixed"
        style={{ backgroundImage: `url(${employeeBg})` }}
      ></div>

      <div className="absolute inset-0 z-0 bg-gradient-to-r from-getmeds-blue-dark/90 to-getmeds-blue/40 mix-blend-multiply"></div>
      <div className="absolute inset-0 z-0 bg-getmeds-blue-dark/30"></div>

      <div className="relative z-10 flex flex-col lg:flex-row items-center justify-between w-full min-h-screen max-w-7xl mx-auto p-6 md:p-12 gap-10">

        <div className="flex-1 flex flex-col justify-center text-white">
          <h1 className="text-4xl md:text-5xl font-semibold mb-4 tracking-tight leading-tight">
            Getmeds System
          </h1>
          <p className="text-base md:text-lg text-blue-100/90 max-w-lg font-medium">
            Create your Medical Representative account to start raising orders.
          </p>
        </div>

        <div className="w-full max-w-[520px] bg-white rounded-2xl p-8 md:p-10 shadow-2xl">
          <div className="w-full mx-auto">
            <h2 className="text-[26px] font-semibold text-center text-ink-primary">
              Create your account
            </h2>
            <p className="text-[14px] text-ink-secondary text-center mt-2 mb-8">
              For Medical Representatives. Other roles are set up by an administrator.
            </p>

            <form className="space-y-6" onSubmit={handleSubmit}>
              <ErrorMessage message={error} onClose={() => setError(null)} />

              {/* ── Name ──────────────────────────────────────────────── */}
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className={labelClass}>First name</label>
                    <input
                      type="text"
                      required
                      autoComplete="given-name"
                      placeholder="Enter first name"
                      className={inputClass}
                      value={form.first_name}
                      onChange={set('first_name')}
                    />
                  </div>
                  <div>
                    <label className={labelClass}>
                      Middle name <span className={optionalClass}>(optional)</span>
                    </label>
                    <input
                      type="text"
                      autoComplete="additional-name"
                      placeholder="Enter middle name"
                      className={inputClass}
                      value={form.middle_name}
                      onChange={set('middle_name')}
                    />
                  </div>
                </div>

                <div>
                  <label className={labelClass}>Last name</label>
                  <input
                    type="text"
                    required
                    autoComplete="family-name"
                    placeholder="Enter last name"
                    className={inputClass}
                    value={form.last_name}
                    onChange={set('last_name')}
                  />
                </div>

                <div>
                  <label className={labelClass}>Display name</label>
                  <input
                    type="text"
                    required
                    placeholder="Enter display name"
                    className={inputClass}
                    value={form.display_name}
                    onChange={onDisplayNameChange}
                  />
                  <p className="text-[12px] text-ink-secondary mt-1.5">
                    Filled in from your first and last name — edit it if you go by something else.
                  </p>
                </div>
              </div>

              {/* ── Division ──────────────────────────────────────────── */}
              <div className="space-y-4 pt-2 border-t border-slate-100">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
                  <div>
                    <label className={labelClass}>Division</label>
                    <select
                      required
                      className={inputClass}
                      value={form.division}
                      onChange={set('division')}
                    >
                      <option value="">-- Select division --</option>
                      {DIVISIONS.map((d) => (
                        <option key={d} value={d}>{d}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelClass}>
                      Sub-division <span className={optionalClass}>(optional)</span>
                    </label>
                    {subDivisionOptions ? (
                      <select className={inputClass} value={form.sub_division} onChange={set('sub_division')}>
                        <option value="">-- Select sub-division --</option>
                        {subDivisionOptions.map((sd) => (
                          <option key={sd} value={sd}>{sd}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type="text"
                        placeholder="Enter sub-division"
                        className={inputClass}
                        value={form.sub_division}
                        onChange={set('sub_division')}
                      />
                    )}
                  </div>
                </div>

                {/* Read-only: the database derives this from Division +
                    Display name, so it is shown, never typed. */}
                <div>
                  <label className={labelClass}>Salesperson</label>
                  <div
                    className="w-full px-4 py-3 rounded-xl border border-slate-200 bg-slate-50 text-sm font-medium text-ink-primary min-h-[46px] flex items-center"
                    aria-live="polite"
                  >
                    {salesperson || (
                      <span className="text-ink-secondary/60 font-normal">
                        Division | Display name
                      </span>
                    )}
                  </div>
                  <p className="text-[12px] text-ink-secondary mt-1.5">
                    Built automatically and used as the Salesperson on your Zoho Sales Orders.
                  </p>
                </div>
              </div>

              {/* ── Sign-in details ───────────────────────────────────── */}
              <div className="space-y-4 pt-2 border-t border-slate-100">
                <div className="pt-4">
                  <label className={labelClass}>Work email</label>
                  <input
                    type="email"
                    required
                    autoComplete="email"
                    placeholder="you@getmeds.ph"
                    className={inputClass}
                    value={form.email}
                    onChange={set('email')}
                  />
                  <p className="text-[12px] text-ink-secondary mt-1.5">
                    Use your @getmeds.ph address.
                  </p>
                </div>

                <div>
                  <label className={labelClass}>Password</label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      autoComplete="new-password"
                      minLength={MIN_PASSWORD_LENGTH}
                      placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                      className={inputClass}
                      value={form.password}
                      onChange={set('password')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-4 top-3 text-ink-secondary hover:text-ink-primary focus:outline-none focus:ring-2 focus:ring-getmeds-blue rounded"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {/*
                        Sep 3, 2026: icons swapped to agree with the aria-label
                        above. This button showed EyeOff while its own label
                        read "Show password" — and the reverse when revealed.
                        Eye means "reveal", EyeOff means "hide": the icon names
                        the action the click performs, which is also what
                        LoginPage now does, so the two auth screens match.
                      */}
                      {showPassword
                        ? <EyeOff className="h-5 w-5" />
                        : <Eye className="h-5 w-5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className={labelClass}>Confirm password</label>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    className={inputClass}
                    value={form.confirm}
                    onChange={set('confirm')}
                  />
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full bg-getmeds-blue text-white rounded-xl py-3.5 text-[15px] font-medium hover:bg-getmeds-blue-hover transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-getmeds-blue disabled:opacity-70 flex items-center justify-center shadow-lg shadow-getmeds-blue/25"
                >
                  {isLoading ? <LoadingSpinner size="sm" className="mr-2" /> : null}
                  Create account
                </button>
              </div>

              <p className="text-[13px] text-ink-secondary text-center">
                Already have an account?{' '}
                <Link
                  to="/"
                  className="text-getmeds-blue font-semibold hover:underline inline-flex items-center gap-1"
                >
                  <ArrowLeft size={13} />
                  Sign in
                </Link>
              </p>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignupPage;
