import React, { useState } from 'react';
import client from '../../api/client';
import Modal from '../ui/Modal';
import ErrorMessage from '../ui/ErrorMessage';
import LoadingSpinner from '../ui/LoadingSpinner';
import { Eye, EyeOff, RefreshCw, Copy, CheckCircle2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { DIVISIONS, SUB_DIVISIONS_BY_DIVISION } from '../../constants/divisions';

/**
 * Create account — Sep 11, 2026.
 *
 * The only way an account comes into existence now. Self-service sign-up was
 * removed: an admin creates each account here and hands the login to the
 * person. There is nothing to approve afterwards — the account can sign in
 * the moment it exists.
 *
 * Posts to POST /api/admin/users, which enforces all of this independently;
 * the checks here only save a round trip.
 *
 * The Zoho Salesperson is NOT set here. It is picked from Zoho's own list in
 * the Users table, on the row this creates — the same picker every other
 * account uses.
 */
const MIN_PASSWORD_LENGTH = 8;

const ROLES = [
  { value: 'medrep', label: 'MedRep' },
  { value: 'management', label: 'Management' },
  { value: 'finance', label: 'Finance' },
  { value: 'dispatch', label: 'Dispatch' },
  { value: 'admin', label: 'Admin' },
];

// No 0/O or 1/l/I: this password is read off a screen and typed by someone
// else, often from a chat message.
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const generatePassword = (length = 12) => {
  const bytes = new Uint32Array(length);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length]).join('');
};

const emptyForm = () => ({
  first_name: '',
  middle_name: '',
  last_name: '',
  display_name: '',
  email: '',
  role: 'medrep',
  division: '',
  sub_division: '',
  password: generatePassword(),
});

const inputClass =
  'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-sm text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue shadow-2xs transition-colors';
const primaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md text-sm font-semibold text-white bg-getmeds-blue hover:bg-getmeds-blue-hover shadow-sm transition-colors disabled:opacity-60';
const secondaryButtonClass =
  'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 border border-slate-200 rounded-md text-sm font-medium text-ink-secondary bg-white hover:bg-surface hover:text-ink-primary transition-colors';

const Field = ({ label, required, optional, help, children }) => (
  <div>
    <label className="block text-xs font-bold uppercase tracking-wide text-ink-secondary mb-1.5">
      {label} {required && <span className="text-state-error">*</span>}
      {optional && <span className="normal-case font-normal tracking-normal">(optional)</span>}
    </label>
    {children}
    {help && <p className="text-[11px] text-ink-secondary mt-1">{help}</p>}
  </div>
);

const CreateUserModal = ({ isOpen, onClose, onCreated }) => {
  const [form, setForm] = useState(emptyForm);
  // Display name follows first + last until the admin edits it — after that
  // typing a name never overwrites it again.
  const [displayNameTouched, setDisplayNameTouched] = useState(false);
  // Visible by default: the admin is about to read it out or paste it to
  // someone, so hiding it only adds a click.
  const [showPassword, setShowPassword] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  // Once created: what to hand to the person. The form is replaced by this so
  // the password stays on screen long enough to be passed on — it is never
  // shown again — and a second click cannot resubmit the same email.
  const [created, setCreated] = useState(null);

  const reset = () => {
    setForm(emptyForm());
    setDisplayNameTouched(false);
    setShowPassword(true);
    setError(null);
    setCreated(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const set = (field) => (e) => {
    const value = e.target.value;
    setForm((f) => {
      const next = { ...f, [field]: value };
      // Branches named under one Division are rarely right under another, so
      // a Division change clears the sub-division rather than carrying it.
      if (field === 'division') next.sub_division = '';
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

  const isMedrep = form.role === 'medrep';
  const subDivisionOptions = SUB_DIVISIONS_BY_DIVISION[form.division] || null;

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (form.password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (isMedrep && !form.division) {
      setError('A MedRep needs a Division.');
      return;
    }

    setSaving(true);
    try {
      const res = await client.post('/api/admin/users', { ...form, email: form.email.trim() });
      const user = res.data?.data?.user;
      setCreated({ user, password: form.password });
      onCreated?.(user);
    } catch (err) {
      setError(
        err.response?.data?.error?.message ||
          err.response?.data?.message ||
          'Could not create the account.'
      );
    } finally {
      setSaving(false);
    }
  };

  const copyDetails = async () => {
    const text =
      `Getmeds System login\n` +
      `Email: ${created.user?.email}\n` +
      `Password: ${created.password}\n\n` +
      `You can change your password under Profile Settings after signing in.`;
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Login details copied.');
    } catch {
      toast.error('Could not copy — select the details and copy them by hand.');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={close} title={created ? 'Account created' : 'Create account'}>
      {created ? (
        <div className="space-y-4 text-left">
          <div className="flex gap-2 rounded-lg border border-pharmacy-green/40 bg-pharmacy-green/10 p-3">
            <CheckCircle2 className="w-5 h-5 text-pharmacy-green-dark shrink-0 mt-0.5" />
            <p className="text-sm text-ink-primary">
              <span className="font-semibold">{created.user?.name}</span> can sign in now. Pass these
              details on — the password will not be shown again.
            </p>
          </div>

          <dl className="rounded-lg border border-slate-200 divide-y divide-slate-100 text-sm">
            <div className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-ink-secondary">Email</dt>
              <dd className="font-medium text-ink-primary break-all text-right">{created.user?.email}</dd>
            </div>
            <div className="flex justify-between gap-4 px-3 py-2">
              <dt className="text-ink-secondary">Password</dt>
              <dd className="font-mono font-medium text-ink-primary break-all text-right">{created.password}</dd>
            </div>
          </dl>

          {created.user?.role === 'medrep' && (
            <p className="text-[13px] text-amber-800">
              Next: pick their Zoho Salesperson in the table. A MedRep cannot place an order until one is set.
            </p>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <button type="button" onClick={copyDetails} className={secondaryButtonClass}>
              <Copy className="w-4 h-4" />
              Copy login details
            </button>
            <button type="button" onClick={reset} className={secondaryButtonClass}>
              Create another
            </button>
            <button type="button" onClick={close} className={primaryButtonClass}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4 text-left">
          <ErrorMessage message={error} onClose={() => setError(null)} />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="First name" required>
              <input type="text" required className={inputClass} value={form.first_name} onChange={set('first_name')} />
            </Field>
            <Field label="Last name" required>
              <input type="text" required className={inputClass} value={form.last_name} onChange={set('last_name')} />
            </Field>
          </div>

          <Field label="Middle name" optional>
            <input type="text" className={inputClass} value={form.middle_name} onChange={set('middle_name')} />
          </Field>

          <Field
            label="Display name"
            required
            help="Filled in from first and last name — edit it if they go by something else."
          >
            <input type="text" required className={inputClass} value={form.display_name} onChange={onDisplayNameChange} />
          </Field>

          <Field label="Email" required help="What they sign in with.">
            <input
              type="email"
              required
              autoComplete="off"
              placeholder="name@getmeds.ph"
              className={inputClass}
              value={form.email}
              onChange={set('email')}
            />
          </Field>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Role" required>
              <select required className={inputClass} value={form.role} onChange={set('role')}>
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Division" required={isMedrep} optional={!isMedrep}>
              <select required={isMedrep} className={inputClass} value={form.division} onChange={set('division')}>
                <option value="">-- Select division --</option>
                {DIVISIONS.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </Field>
          </div>

          {form.division && (
            <Field label="Sub-division" optional help="Type any value — separate several with commas.">
              <input
                type="text"
                list="create-user-sub-division-options"
                placeholder="e.g. GENSAN, or GENSAN, BAGUIO"
                className={inputClass}
                value={form.sub_division}
                onChange={set('sub_division')}
              />
              {subDivisionOptions && (
                <datalist id="create-user-sub-division-options">
                  {subDivisionOptions.map((sd) => (
                    <option key={sd} value={sd} />
                  ))}
                </datalist>
              )}
            </Field>
          )}

          <Field
            label="Starting password"
            required
            help={`At least ${MIN_PASSWORD_LENGTH} characters. They can change it under Profile Settings.`}
          >
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  autoComplete="new-password"
                  className={`${inputClass} pr-10 font-mono`}
                  value={form.password}
                  onChange={set('password')}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2.5 top-2 text-ink-secondary hover:text-ink-primary focus:outline-none focus:ring-2 focus:ring-getmeds-blue rounded"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, password: generatePassword() }))}
                className={secondaryButtonClass}
                title="Generate a new random password"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Generate
              </button>
            </div>
          </Field>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={close} className={secondaryButtonClass}>
              Cancel
            </button>
            <button type="submit" disabled={saving} className={primaryButtonClass}>
              {saving ? <LoadingSpinner size="sm" className="mr-1" /> : null}
              Create account
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
};

export default CreateUserModal;
