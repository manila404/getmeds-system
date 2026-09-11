import React, { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X, Building2, MapPin, FileText, Loader2, AlertTriangle, UserCheck, CheckCircle2, CloudOff } from 'lucide-react';
import client from '../../api/client';

/**
 * Create a customer that Zoho has never seen, without leaving the order.
 *
 * Sep 11, 2026. A MedRep who typed a name that matched nothing was told to
 * "ask an Admin to add or sync them from Zoho first" — which meant the order
 * did not get placed today, and often did not get placed at all.
 *
 * ── THIS WRITES TO ZOHO ─────────────────────────────────────────────────────
 *
 * Submitting creates a real, permanent contact in the company's Zoho org. It
 * is the only contact-creating write this app can make (see ZohoAdapter.js's
 * Sep 11 note), so the form says so plainly rather than looking like a local
 * draft that can be tidied up later.
 *
 * ── DUPLICATES COME BACK AS AN OFFER, NOT AN ERROR ──────────────────────────
 *
 * The server answers 409 with the existing customers attached. Nothing went
 * wrong in that case — the customer already exists — so this shows them as
 * buttons to select and carry on with, which is what the rep actually wanted.
 * Reporting "failed" and leaving them on a full form would be technically
 * accurate and useless.
 */

const REQUIRED = ['display_name', 'contact_number', 'phone'];

/**
 * What kind of customer this is — and, for 'hospital', what the order form
 * will then demand.
 *
 * Sep 11, 2026: confirmed with the business that this field MEANS "hospital
 * order rules apply". Picking Hospital is what makes an order require a GL
 * Number, a receiver type, and four attachments; leaving it blank is what
 * makes all four quietly optional.
 *
 * "Not sure" is offered on purpose. Every one of the 95,063 customers already
 * in the system is uncategorised, so a blank is the status quo rather than an
 * anomaly — and forcing a guess would be wrong in both directions: claimed and
 * the rep is blocked on attachments they do not have, missed and four controls
 * disappear with nothing on screen to say so.
 */
const CATEGORIES = [
  { value: 'hospital', label: 'Hospital', hint: 'Orders will require a GL Number, receiver type and four attachments.' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'distributor', label: 'Distributor' },
  { value: 'pwd', label: 'PWD' },
  { value: '', label: 'Not sure yet', hint: 'Can be set later from the Clients Directory.' }
];

const Field = ({ label, required, help, children }) => (
  <div>
    <label className="block text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-1">
      {label}
      {required && <span className="text-state-error ml-0.5">*</span>}
    </label>
    {children}
    {help && <p className="mt-1 text-[11px] text-ink-secondary">{help}</p>}
  </div>
);

const input =
  'w-full text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent';

const Section = ({ icon: Icon, title, children }) => (
  <div className="border-t border-slate-100 pt-4 mt-4 first:border-0 first:pt-0 first:mt-0">
    <p className="flex items-center gap-2 text-sm font-bold text-ink-primary mb-3">
      <Icon className="w-4 h-4 text-getmeds-blue" />
      {title}
    </p>
    {children}
  </div>
);

const NewCustomerModal = ({ initialName = '', onClose, onCreated }) => {
  const [form, setForm] = useState({
    display_name: initialName,
    first_name: '',
    last_name: '',
    company_name: '',
    email: '',
    phone: '',
    contact_number: '',
    license_owner: '',
    lto_license_number: '',
    lto_type: '',
    license_issuance_date: '',
    license_expiry_date: '',
    is_doctor: false,
    tin: '',
    category: '',
    billing_address: { address: '', city: '', country: 'Philippines', phone: '' },
    shipping_address: { address: '', city: '', country: 'Philippines', phone: '' }
  });
  const [sameAsBilling, setSameAsBilling] = useState(true);
  const [duplicates, setDuplicates] = useState(null);
  // A blocking problem that no amount of retyping will fix — kept on screen
  // rather than shown as a toast that disappears while the rep is still
  // looking at a full form wondering what they got wrong.
  const [blocked, setBlocked] = useState(null);
  /**
   * What actually happened, kept on screen until acknowledged.
   *
   * Sep 11, 2026: this replaces a toast that said "created in Zoho" for BOTH
   * outcomes — including the one where the customer never reached Zoho at all.
   * A rep had no way to tell a finished customer from a held one, and the
   * message told them the wrong thing in the case where it mattered.
   */
  const [outcome, setOutcome] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setAddr = (which, k, v) =>
    setForm((f) => ({ ...f, [which]: { ...f[which], [k]: v } }));

  const create = useMutation({
    mutationFn: (body) => client.post('/api/customers', body).then((r) => r.data),
    onSuccess: (res) => {
      // Deliberately does NOT close the modal or claim Zoho. `held` is the
      // difference between "this customer exists in Zoho" and "this customer
      // exists here and is queued", and the rep has to be told which.
      setOutcome({
        held: !!res.data.held,
        customer: res.data.customer,
        message: res.data.message
      });
    },
    onError: (err) => {
      const e = err.response?.data?.error;
      if (e?.code === 'CUSTOMER_EXISTS') {
        // Not a failure. Show what already exists so it can be picked.
        setDuplicates(e.duplicates || []);
        return;
      }
      if (e?.code === 'ZOHO_SCOPE_MISSING') {
        // Nothing the rep can do. Say so plainly instead of letting them try
        // again five times.
        setBlocked(e.message);
        return;
      }
      toast.error(e?.message || 'Could not create this customer.');
    }
  });

  const missing = REQUIRED.filter((k) => !String(form[k] || '').trim());
  const billingOk = form.billing_address.address.trim() && form.billing_address.phone.trim();
  const shippingOk =
    sameAsBilling || (form.shipping_address.address.trim() && form.shipping_address.phone.trim());
  const canSubmit = missing.length === 0 && billingOk && shippingOk && !create.isPending;

  const submit = (e) => {
    // Called from a click now rather than a form submission, but guarded so it
    // still behaves if it is ever wired to one again.
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    if (!canSubmit) return;
    setDuplicates(null);
    setBlocked(null);
    create.mutate({ ...form, shipping_same_as_billing: sameAsBilling });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-8">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-bold text-ink-primary">New Customer</h2>
            {!outcome && (
              <p className="text-xs text-ink-secondary mt-0.5">
                This creates the customer in <strong>Zoho</strong> straight away, and selects them
                for this order.
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-ink-secondary hover:text-ink-primary">
            <X className="w-5 h-5" />
          </button>
        </div>

        {blocked && (
          <div className="mx-5 mt-4 rounded-lg border border-state-error/40 bg-red-50 px-4 py-3">
            <p className="flex items-start gap-2 text-[13px] font-semibold text-red-900">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Cannot create customers in Zoho yet</span>
            </p>
            <p className="mt-1 text-[12px] text-red-900/90">{blocked}</p>
            <p className="mt-1.5 text-[11px] text-red-900/70">
              Nothing was created. Retrying will not help — this needs an admin to change the
              Zoho connection.
            </p>
          </div>
        )}

        {/* The 409 answer: these already exist, so offer them instead. */}
        {duplicates && duplicates.length > 0 && (
          <div className="mx-5 mt-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
            <p className="flex items-center gap-2 text-[13px] font-semibold text-amber-900">
              <AlertTriangle className="w-4 h-4" />
              This customer already exists — select them instead of creating a second.
            </p>
            <div className="mt-2 space-y-1.5">
              {duplicates.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => onCreated(d)}
                  className="w-full text-left px-3 py-2 rounded-md bg-white border border-amber-200 hover:border-amber-400 text-[13px]"
                >
                  <span className="font-semibold text-ink-primary">{d.name}</span>
                  {d.contact_number && <span className="text-ink-secondary"> · {d.contact_number}</span>}
                  <span className="text-[11px] text-amber-800 ml-2">
                    matched on {d.matched_on === 'licence' ? 'LTO licence' : d.matched_on === 'name_and_licence' ? 'name and licence' : 'name'}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {outcome ? (
          <div className="px-5 py-6">
            {outcome.held ? (
              <>
                <p className="flex items-center gap-2 text-base font-bold text-amber-900">
                  <CloudOff className="w-5 h-5" />
                  Saved — but not in Zoho yet
                </p>
                <p className="mt-2 text-[13px] text-ink-primary">
                  <strong>{outcome.customer.name}</strong> is saved in GetMeds and selected for this
                  order. Zoho could not be reached, so the customer has been queued and an admin
                  will push them through.
                </p>

                <ul className="mt-3 space-y-1.5 text-[12px] text-ink-secondary">
                  <li>• You can finish this order, submit it, and have it approved as normal.</li>
                  <li>
                    • The order cannot become a Zoho Sales Order until the customer reaches Zoho —
                    it will go through automatically once they do.
                  </li>
                  <li>• Nothing is lost. Nothing needs re-typing.</li>
                </ul>

                {outcome.message && (
                  <p className="mt-3 text-[11px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
                    {outcome.message}
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="flex items-center gap-2 text-base font-bold text-pharmacy-green">
                  <CheckCircle2 className="w-5 h-5" />
                  Created in Zoho
                </p>
                <p className="mt-2 text-[13px] text-ink-primary">
                  <strong>{outcome.customer.name}</strong> now exists in Zoho and is selected for
                  this order.
                </p>
                {/* The contact id is the proof. Without it "created in Zoho" is
                    just a sentence the app decided to print. */}
                {outcome.customer.zoho_contact_id && (
                  <p className="mt-2 text-[11px] text-ink-secondary">
                    Zoho contact ID:{' '}
                    <code className="bg-surface border border-slate-200 rounded px-1 py-0.5">
                      {outcome.customer.zoho_contact_id}
                    </code>
                  </p>
                )}
              </>
            )}

            <div className="flex justify-end mt-6">
              <button
                type="button"
                onClick={() => onCreated(outcome.customer)}
                className="px-4 py-2 rounded-md bg-getmeds-blue text-white text-sm font-semibold"
              >
                Continue with this customer
              </button>
            </div>
          </div>
        ) : (
        <div className="px-5 py-4">
          {/* A DIV, not a form.
              Sep 11, 2026: this modal renders inside OrderForm's own form, and
              nested forms are invalid HTML. The browser drops the inner one, so
              onSubmit never fired and the "Create customer" button — being
              type="submit" — acted on the OUTER order form instead. The symptom
              was a button that appeared to do nothing at all.
              React said so plainly in the console: "validateDOMNesting: form
              cannot appear as a descendant of form". */}
          <Section icon={Building2} title="Customer Type">
            <div className="flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c.value || 'unset'}
                  type="button"
                  onClick={() => set('category', c.value)}
                  className={`px-3 py-1.5 rounded-md border text-sm font-medium ${
                    form.category === c.value
                      ? 'bg-getmeds-blue text-white border-getmeds-blue'
                      : 'bg-white text-ink-primary border-slate-300 hover:border-slate-400'
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            {/* Said at the moment of choosing, because this is the one field
                here that changes what a LATER screen will demand. */}
            {CATEGORIES.find((c) => c.value === form.category)?.hint && (
              <p className="mt-2 text-[11px] text-ink-secondary">
                {CATEGORIES.find((c) => c.value === form.category).hint}
              </p>
            )}
          </Section>

          <Section icon={Building2} title="Primary Contact">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="First Name">
                <input className={input} value={form.first_name} onChange={(e) => set('first_name', e.target.value)} />
              </Field>
              <Field label="Last Name">
                <input className={input} value={form.last_name} onChange={(e) => set('last_name', e.target.value)} />
              </Field>
              <Field label="Company Name">
                <input className={input} value={form.company_name} onChange={(e) => set('company_name', e.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3">
              <Field
                label="Display Name"
                required
                help="The name Zoho files this customer under, and what you will search for next time."
              >
                <input
                  autoFocus
                  className={input}
                  value={form.display_name}
                  onChange={(e) => set('display_name', e.target.value)}
                />
              </Field>
              <Field label="Email Address">
                <input type="email" className={input} value={form.email} onChange={(e) => set('email', e.target.value)} />
              </Field>
              <Field label="Phone" required>
                <input className={input} placeholder="+63…" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
              </Field>
            </div>
          </Section>

          <Section icon={MapPin} title="Billing Address">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Field label="Address" required>
                <input className={input} value={form.billing_address.address} onChange={(e) => setAddr('billing_address', 'address', e.target.value)} />
              </Field>
              <Field label="City">
                <input className={input} value={form.billing_address.city} onChange={(e) => setAddr('billing_address', 'city', e.target.value)} />
              </Field>
              <Field label="Country/Region">
                <input className={input} value={form.billing_address.country} onChange={(e) => setAddr('billing_address', 'country', e.target.value)} />
              </Field>
              <Field label="Phone" required>
                <input className={input} value={form.billing_address.phone} onChange={(e) => setAddr('billing_address', 'phone', e.target.value)} />
              </Field>
            </div>
          </Section>

          <Section icon={MapPin} title="Shipping Address">
            <label className="inline-flex items-center gap-2 text-sm text-ink-primary mb-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={sameAsBilling}
                onChange={(e) => setSameAsBilling(e.target.checked)}
                className="rounded text-getmeds-blue focus:ring-getmeds-blue"
              />
              Same as billing address
            </label>

            {!sameAsBilling && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Address" required>
                  <input className={input} value={form.shipping_address.address} onChange={(e) => setAddr('shipping_address', 'address', e.target.value)} />
                </Field>
                <Field label="City">
                  <input className={input} value={form.shipping_address.city} onChange={(e) => setAddr('shipping_address', 'city', e.target.value)} />
                </Field>
                <Field label="Country/Region">
                  <input className={input} value={form.shipping_address.country} onChange={(e) => setAddr('shipping_address', 'country', e.target.value)} />
                </Field>
                <Field label="Phone" required>
                  <input className={input} value={form.shipping_address.phone} onChange={(e) => setAddr('shipping_address', 'phone', e.target.value)} />
                </Field>
              </div>
            )}
          </Section>

          <Section icon={FileText} title="Licence &amp; Tax">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Field label="License Owner">
                <input className={input} value={form.license_owner} onChange={(e) => set('license_owner', e.target.value)} />
              </Field>
              <Field
                label="LTO License Number"
                help="Unique in Zoho — a licence already on another customer will be refused."
              >
                <input className={input} value={form.lto_license_number} onChange={(e) => set('lto_license_number', e.target.value)} />
              </Field>
              <Field label="LTO Type">
                <input className={input} value={form.lto_type} onChange={(e) => set('lto_type', e.target.value)} />
              </Field>
              <Field label="License Issuance Date">
                <input type="date" className={input} value={form.license_issuance_date} onChange={(e) => set('license_issuance_date', e.target.value)} />
              </Field>
              <Field label="License Expiry Date">
                <input type="date" className={input} value={form.license_expiry_date} onChange={(e) => set('license_expiry_date', e.target.value)} />
              </Field>
              <Field label="TIN">
                <input className={input} value={form.tin} onChange={(e) => set('tin', e.target.value)} />
              </Field>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
              <Field
                label="Contact Number"
                required
                help="Mandatory in Zoho for every customer — an order cannot be raised without it."
              >
                <input className={input} value={form.contact_number} onChange={(e) => set('contact_number', e.target.value)} />
              </Field>
              <div className="flex items-end pb-2">
                <label className="inline-flex items-center gap-2 text-sm text-ink-primary cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={form.is_doctor}
                    onChange={(e) => set('is_doctor', e.target.checked)}
                    className="rounded text-getmeds-blue focus:ring-getmeds-blue"
                  />
                  Is Doctor
                </label>
              </div>
            </div>
          </Section>

          <div className="flex items-center justify-between gap-3 border-t border-slate-200 pt-4 mt-5">
            <p className="text-[11px] text-ink-secondary">
              Created as a <strong>Business</strong> customer in Zoho.
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm font-semibold text-ink-secondary hover:text-ink-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submit}
                disabled={!canSubmit}
                className="px-4 py-2 rounded-md bg-getmeds-blue text-white text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {create.isPending ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Creating in Zoho…
                  </>
                ) : (
                  <>
                    <UserCheck className="w-4 h-4" />
                    Create customer
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
};

export default NewCustomerModal;
