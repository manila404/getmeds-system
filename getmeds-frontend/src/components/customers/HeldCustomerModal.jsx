import React, { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X, Loader2, AlertTriangle, CheckCircle2, Link2, Trash2, Send, Save } from 'lucide-react';
import client from '../../api/client';

/**
 * Management opens a customer waiting for Zoho. Oct 8, 2026.
 *
 * The same details as the New Customer form, filled with what the MedRep entered, so
 * anything missing (email, TIN, license) can be completed here. Then Management decides:
 * save, save and push as a NEW customer, link to a customer Zoho already has, or delete.
 * What counts as missing mirrors lackingDetails() in customerCreateService.js.
 */

const LACKABLE_BUSINESS = [
  ['email', 'Email'], ['tin', 'TIN'], ['license_owner', 'License Owner'], ['lto_license_number', 'LTO Number'],
  ['lto_type', 'LTO Type'], ['license_issuance_date', 'License Issuance Date'], ['license_expiry_date', 'License Expiry Date']
];
const LACKABLE = { doctor: [['email', 'Email']], hospital: LACKABLE_BUSINESS, distributor: LACKABLE_BUSINESS };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TYPES = [
  { value: 'patient', label: 'Patient' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'hospital', label: 'Hospital' },
  { value: 'distributor', label: 'Distributor' }
];
const errorMessage = (err, fallback) => err?.response?.data?.error?.message || fallback;

const input = 'w-full text-sm border border-slate-300 rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-getmeds-blue focus:border-transparent';
const missingInput = 'border-amber-400 bg-amber-50/60';

const Field = ({ label, required, missing, children }) => (
  <label className="block">
    <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-1">
      {label}
      {required && <span className="text-state-error ml-0.5">*</span>}
      {missing && <span className="ml-1.5 normal-case font-semibold text-amber-700">missing</span>}
    </span>
    {children}
  </label>
);

const HeldCustomerModal = ({ customerId, onClose, onChanged, onLink, onDelete, onPush, busy }) => {
  const q = useQuery({
    queryKey: ['held-customer', customerId],
    queryFn: () => client.get(`/api/customers/${customerId}/pending`).then((r) => r.data?.data),
    staleTime: 0
  });
  const [form, setForm] = useState(null);
  useEffect(() => {
    if (!q.data) return;
    const d = q.data.details || {};
    setForm({
      category: d.category || '',
      display_name: d.display_name || q.data.name || '',
      salutation: d.salutation || '',
      first_name: d.first_name || '',
      last_name: d.last_name || '',
      email: d.email || '',
      phone: d.phone || d.contact_number || '',
      tin: d.tin || '',
      license_owner: d.license_owner || '',
      lto_license_number: d.lto_license_number || '',
      lto_type: d.lto_type || '',
      license_issuance_date: d.license_issuance_date || '',
      license_expiry_date: d.license_expiry_date || '',
      billing_address: { address: '', city: '', country: 'Philippines', ...(d.billing_address || {}) }
    });
  }, [q.data]);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const setAddr = (k, v) => setForm((f) => ({ ...f, billing_address: { ...f.billing_address, [k]: v } }));

  const lacking = useMemo(() => {
    if (!form) return [];
    return (LACKABLE[form.category] || [])
      .filter(([k]) => (k === 'email' ? !EMAIL_RE.test(String(form.email || '').trim()) : !String(form[k] || '').trim()))
      .map(([k]) => k);
  }, [form]);
  const lackingLabels = (LACKABLE[form?.category] || []).filter(([k]) => lacking.includes(k)).map(([, l]) => l);
  const emailBad = !!form && !!form.email.trim() && !EMAIL_RE.test(form.email.trim());
  const basicsOk = !!form && form.category && form.display_name.trim() && form.phone.trim() && form.billing_address.address.trim();

  const save = useMutation({
    mutationFn: () =>
      client.patch(`/api/customers/${customerId}/pending`, {
        details: { ...form, shipping_same_as_billing: true }
      }).then((r) => r.data?.data)
  });

  const doSave = async (thenPush) => {
    try {
      const res = await save.mutateAsync();
      onChanged();
      if (thenPush) onPush({ id: customerId, name: form.display_name, lacking: res.lacking || [] });
      else toast.success(res.message);
    } catch (err) {
      toast.error(errorMessage(err, 'Could not save the customer.'), { duration: 8000 });
    }
  };

  const isBusiness = form?.category === 'hospital' || form?.category === 'distributor';
  const miss = (k) => lacking.includes(k);
  const working = save.isPending || busy;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 overflow-y-auto">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8">
        <div className="flex items-start justify-between px-5 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-base font-bold text-ink-primary">{q.data?.name || 'Customer'}</h2>
            <p className="text-xs text-ink-secondary mt-0.5">
              Waiting for Zoho{q.data?.order_count ? ` · ${q.data.order_count} order${q.data.order_count === 1 ? '' : 's'}` : ''}.
              Complete or correct the details, then decide.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={working} className="text-ink-secondary hover:text-ink-primary" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        {q.isLoading || !form ? (
          <p className="px-5 py-8 text-sm text-ink-secondary flex items-center gap-2">
            {q.isError ? errorMessage(q.error, 'Could not load this customer.') : <><Loader2 className="w-4 h-4 animate-spin" />Loading…</>}
          </p>
        ) : (
          <>
            <div className="px-5 py-4 space-y-4">
              {q.data.zoho_sync_status === 'failed' && q.data.zoho_sync_error && (
                <p className="flex items-start gap-1.5 text-[12px] text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>Zoho refused the last push: {q.data.zoho_sync_error}</span>
                </p>
              )}

              <div>
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-ink-secondary mb-1">Customer type<span className="text-state-error ml-0.5">*</span></span>
                <div className="flex flex-wrap gap-2">
                  {TYPES.map((t) => (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => set('category', t.value)}
                      className={`px-3 py-1.5 rounded-md border text-sm font-medium ${form.category === t.value ? 'bg-getmeds-blue text-white border-getmeds-blue' : 'bg-white text-ink-primary border-slate-300'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <Field label="Display name" required>
                  <input className={input} value={form.display_name} onChange={(e) => set('display_name', e.target.value)} />
                </Field>
                <Field label="Phone" required>
                  <input className={input} value={form.phone} onChange={(e) => set('phone', e.target.value)} />
                </Field>
                {!isBusiness && (
                  <>
                    <Field label="First name">
                      <input className={input} value={form.first_name} onChange={(e) => set('first_name', e.target.value)} />
                    </Field>
                    <Field label="Last name">
                      <input className={input} value={form.last_name} onChange={(e) => set('last_name', e.target.value)} />
                    </Field>
                  </>
                )}
                <Field label="Email" missing={miss('email')}>
                  <input type="email" className={`${input} ${miss('email') ? missingInput : ''}`} value={form.email} onChange={(e) => set('email', e.target.value)} placeholder="name@example.com" />
                </Field>
                {(isBusiness || form.category === 'patient') && (
                  <Field label="TIN" missing={miss('tin')}>
                    <input className={`${input} ${miss('tin') ? missingInput : ''}`} value={form.tin} onChange={(e) => set('tin', e.target.value)} />
                  </Field>
                )}
              </div>

              {isBusiness && (
                <div className="border-t border-slate-100 pt-3">
                  <p className="text-xs font-semibold text-ink-secondary uppercase tracking-wide mb-2">License</p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Field label="License owner" missing={miss('license_owner')}>
                      <input className={`${input} ${miss('license_owner') ? missingInput : ''}`} value={form.license_owner} onChange={(e) => set('license_owner', e.target.value)} />
                    </Field>
                    <Field label="LTO number" missing={miss('lto_license_number')}>
                      <input className={`${input} ${miss('lto_license_number') ? missingInput : ''}`} value={form.lto_license_number} onChange={(e) => set('lto_license_number', e.target.value)} />
                    </Field>
                    <Field label="LTO type" missing={miss('lto_type')}>
                      <input className={`${input} ${miss('lto_type') ? missingInput : ''}`} value={form.lto_type} onChange={(e) => set('lto_type', e.target.value)} />
                    </Field>
                    <Field label="Issued" missing={miss('license_issuance_date')}>
                      <input type="date" className={`${input} ${miss('license_issuance_date') ? missingInput : ''}`} value={form.license_issuance_date} onChange={(e) => set('license_issuance_date', e.target.value)} />
                    </Field>
                    <Field label="Expires" missing={miss('license_expiry_date')}>
                      <input type="date" className={`${input} ${miss('license_expiry_date') ? missingInput : ''}`} value={form.license_expiry_date} onChange={(e) => set('license_expiry_date', e.target.value)} />
                    </Field>
                  </div>
                </div>
              )}

              <div className="border-t border-slate-100 pt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="md:col-span-2">
                  <Field label="Street address" required>
                    <input className={input} value={form.billing_address.address || ''} onChange={(e) => setAddr('address', e.target.value)} />
                  </Field>
                </div>
                <Field label="City">
                  <input className={input} value={form.billing_address.city || ''} onChange={(e) => setAddr('city', e.target.value)} />
                </Field>
              </div>

              {emailBad ? (
                <p className="text-[12px] text-red-800 bg-red-50 border border-red-200 rounded px-3 py-2">
                  "{form.email.trim()}" is not an email address. Type a real one, or clear it.
                </p>
              ) : lackingLabels.length ? (
                <p className="text-[12px] text-amber-900 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                  <strong>Still missing:</strong> {lackingLabels.join(', ')}. Fill in what you can. You can still push it as a new
                  customer without them, or link it to a customer Zoho already has.
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-[12px] text-emerald-900 bg-emerald-50 border border-emerald-200 rounded px-3 py-2">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Nothing is missing.
                </p>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-t border-slate-200 bg-slate-50 rounded-b-xl">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={working}
                  onClick={() => onLink()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-slate-300 bg-white text-[13px] font-semibold text-ink-primary disabled:opacity-60"
                >
                  <Link2 className="w-4 h-4" /> Link to existing customer
                </button>
                <button
                  type="button"
                  disabled={working || q.data.order_count > 0}
                  title={q.data.order_count > 0 ? 'Has orders: link it to the customer in Zoho instead, so the orders move with it.' : ''}
                  onClick={() => onDelete()}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md text-[13px] font-semibold text-red-700 disabled:text-slate-400"
                >
                  <Trash2 className="w-4 h-4" /> Delete
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={working || !basicsOk || emailBad}
                  onClick={() => doSave(false)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md border border-getmeds-blue/40 bg-white text-[13px] font-semibold text-getmeds-blue disabled:opacity-60"
                >
                  {save.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
                </button>
                <button
                  type="button"
                  disabled={working || !basicsOk || emailBad}
                  onClick={() => doSave(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-getmeds-blue text-white text-[13px] font-semibold disabled:opacity-60"
                >
                  <Send className="w-4 h-4" /> Save & push as new customer
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default HeldCustomerModal;
