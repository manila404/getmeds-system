import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CloudOff, RefreshCw, AlertTriangle, Clock, Building2, Info, Copy, Trash2, Link2, Check, PencilLine } from 'lucide-react';
import client from '../../api/client';
import ConfirmDialog from '../../components/ui/ConfirmDialog';
import Modal from '../../components/ui/Modal';

/**
 * Customers saved here that Zoho has not accepted yet.
 *
 * Sep 11, 2026. Rather than turn a MedRep away mid-order when Zoho cannot
 * create a customer, the customer is kept here as pending and pushed later.
 * This screen is where that promise becomes visible: a held customer that
 * lives only in a database column is one nobody honours.
 *
 * Sep 14, 2026. A waiting customer can already be in Zoho — someone creates it
 * there by hand, or under a slightly different spelling (1ST SPECIALITY PHARMA
 * waited here while "1ST SPECIALTY PHARMA" was created in Zoho). Pushing it
 * would put the same business in Zoho twice, so a likely match is shown side
 * by side — read live from Zoho, whose record holds far more than the local
 * copy — and held back until someone answers: use the Zoho customer, update
 * the Zoho customer's details and use it, or push as new anyway.
 */

const timeAgo = (iso) => {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
};

const MATCH_LABEL = {
  lto: 'Same LTO licence',
  tin: 'Same TIN',
  same_name: 'Same name',
  similar_name: 'Similar name',
  email: 'Same email',
  phone: 'Same phone'
};

// The rows of the side-by-side comparison.
const FIELDS = [
  { label: 'Name', key: 'name' },
  { label: 'Contact person', key: 'contact_person' },
  { label: 'Contact number', key: 'contact_number' },
  { label: 'Phone', key: 'phone' },
  { label: 'Email', key: 'email' },
  { label: 'TIN', key: 'tin' },
  { label: 'LTO licence', key: 'lto_license_number' },
  { label: 'LTO type', key: 'lto_type' },
  { label: 'Licence owner', key: 'license_owner' },
  { label: 'Licence issued', key: 'license_issuance_date' },
  { label: 'Licence expires', key: 'license_expiry_date' },
  { label: 'Address', key: 'address' },
  { label: 'City', key: 'city' },
  { label: 'Customer type', key: 'category' },
  { label: 'Orders here', key: 'order_count' }
];

const digits = (v) => String(v ?? '').replace(/\D/g, '');
const text = (v) => String(v ?? '').trim();

/** Do two values say the same thing? Phone numbers and TINs by their digits. */
const sameValue = (key, a, b) => {
  if (key === 'contact_number' || key === 'phone') return digits(a).slice(-10) === digits(b).slice(-10);
  if (key === 'tin') return digits(a).slice(0, 9) === digits(b).slice(0, 9);
  return text(a).toLowerCase().replace(/[^a-z0-9]/g, '') === text(b).toLowerCase().replace(/[^a-z0-9]/g, '');
};

const errorMessage = (err, fallback) => err?.response?.data?.error?.message || fallback;

const Blank = () => <span className="text-slate-400">—</span>;

/** A waiting customer next to the Zoho customer it looks like, and the three answers. */
const DuplicateReview = ({ customer, onAsk, onUpdate, busy }) => {
  const [pick, setPick] = useState(0);
  const match = customer.matches[Math.min(pick, customer.matches.length - 1)];

  // Live from Zoho: the local copy of a Zoho customer has little more than a
  // name, and a comparison built from it shows blanks where Zoho has values.
  const cmp = useQuery({
    queryKey: ['zoho-compare', customer.id, match.id],
    queryFn: () =>
      client
        .get(`/api/customers/${customer.id}/zoho-compare`, { params: { target_id: match.id } })
        .then((r) => r.data?.data),
    staleTime: 60000,
    retry: false
  });

  const waiting = cmp.data?.waiting || customer;
  const zoho = cmp.data?.zoho || match;
  const matched = cmp.data?.matched || match.matched;
  const live = cmp.data?.source === 'zoho';
  const orders = waiting.order_count ?? customer.order_count;

  return (
    <div className="mt-3 rounded-lg border border-orange-300 bg-orange-50/60 p-3">
      <p className="text-[13px] font-semibold text-orange-900 flex items-center gap-1.5">
        <Copy className="w-4 h-4 shrink-0" />
        Possible duplicate — Zoho already has a customer that looks like this one.
      </p>
      <p className="text-[12px] text-orange-900/80 mt-0.5">
        Pushing it would create the same business in Zoho twice, so it is held back until you choose below.
      </p>

      {customer.matches.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {customer.matches.map((m, i) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setPick(i)}
              className={`px-2 py-1 rounded text-[11px] font-semibold border ${
                i === pick ? 'bg-white border-orange-400 text-orange-900' : 'bg-orange-100/50 border-orange-200 text-orange-800'
              }`}
            >
              {m.name}
            </button>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {matched.map((m) => (
          <span key={m} className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-green-100 text-green-800 border border-green-200">
            {MATCH_LABEL[m] || m}
          </span>
        ))}
        <span className="ml-auto text-[11px] text-ink-secondary">
          {cmp.isLoading
            ? 'Reading the customer from Zoho…'
            : live
              ? 'Zoho column read live from Zoho'
              : cmp.data?.zoho_error
                ? `Zoho could not be read (${cmp.data.zoho_error}) — showing the app's copy`
                : ''}
        </span>
      </div>

      <div className="mt-2 overflow-x-auto rounded border border-slate-200 bg-white">
        <table className="min-w-full text-[12px]">
          <thead className="bg-surface text-ink-secondary">
            <tr>
              <th className="px-3 py-1.5 text-left font-semibold w-32"></th>
              <th className="px-3 py-1.5 text-left font-semibold">Waiting here (to push)</th>
              <th className="px-3 py-1.5 text-left font-semibold">Already in Zoho</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {FIELDS.map((f) => {
              const a = f.key === 'order_count' ? orders : waiting[f.key];
              const b = zoho[f.key];
              const both = text(a) !== '' && text(b) !== '' && f.key !== 'order_count';
              const same = both && sameValue(f.key, a, b);
              return (
                <tr key={f.key} className={same ? 'bg-green-50' : both ? 'bg-amber-50/60' : ''}>
                  <td className="px-3 py-1.5 font-semibold text-ink-secondary whitespace-nowrap">
                    {f.label}
                    {same && <Check className="inline w-3 h-3 ml-1 text-green-700" />}
                  </td>
                  <td className="px-3 py-1.5 text-ink-primary">{text(a) ? String(a) : <Blank />}</td>
                  <td className="px-3 py-1.5 text-ink-primary">
                    {text(b) ? String(b) : <Blank />}
                    {f.key === 'name' && match.is_active === 0 && (
                      <span className="ml-1.5 text-[10px] font-bold uppercase text-slate-500">inactive</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[11px] text-ink-secondary">
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-100 border border-green-200 align-middle mr-1" />
        same in both
        <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-100 border border-amber-200 align-middle ml-3 mr-1" />
        different
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onAsk({
              title: `Use ${match.name}?`,
              message:
                `${match.name} is already in Zoho. ` +
                (orders ? `${orders} order(s) of ${customer.name} will move to it, ` : '') +
                `and the waiting copy "${customer.name}" is deleted. Nothing is created or changed in Zoho.`,
              confirmText: 'Use the Zoho customer',
              variant: 'info',
              run: { kind: 'link', id: customer.id, target_id: match.id }
            })
          }
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-[12px] font-semibold disabled:opacity-60"
        >
          <Link2 className="w-3.5 h-3.5" />
          Same customer — use the one in Zoho
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onAsk({
              title: `Push ${customer.name} as a new customer?`,
              message:
                `This creates ${customer.name} in Zoho as a NEW customer. ` +
                `Only do this if it is a different business from ${match.name}.`,
              confirmText: 'Push as new',
              variant: 'info',
              run: { kind: 'push', id: customer.id }
            })
          }
          className="px-3 py-1.5 rounded-md border border-slate-300 bg-white text-[12px] font-semibold text-ink-primary disabled:opacity-60"
        >
          Different customer — push as new
        </button>
        <button
          type="button"
          disabled={busy || !live}
          title={live ? '' : 'Needs the customer read from Zoho first'}
          onClick={() => onUpdate({ customer, match, cmp: cmp.data })}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-getmeds-blue text-getmeds-blue bg-white text-[12px] font-semibold disabled:opacity-50"
        >
          <PencilLine className="w-3.5 h-3.5" />
          Update customer — update details
        </button>
      </div>
    </div>
  );
};

// The Update form. Sent to Zoho: every field except the last two.
const FORM_FIELDS = [
  { key: 'name', label: 'Name', required: true, wide: true },
  { key: 'contact_number', label: 'Contact number', required: true },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email', wide: true },
  { key: 'tin', label: 'TIN' },
  { key: 'lto_license_number', label: 'LTO licence' },
  { key: 'lto_type', label: 'LTO type' },
  { key: 'license_owner', label: 'Licence owner' },
  { key: 'license_issuance_date', label: 'Licence issued', type: 'date' },
  { key: 'license_expiry_date', label: 'Licence expires', type: 'date' },
  { key: 'address', label: 'Address', wide: true },
  { key: 'city', label: 'City' }
];
const CATEGORIES = ['doctor', 'hospital', 'distributor', 'pwd', 'patient'];

/**
 * Update the Zoho customer from the waiting one, then use it.
 *
 * Each field starts with Zoho's value where Zoho has one and the waiting
 * customer's where it does not; where the two differ, both are shown to pick
 * from. Only fields that end up different from Zoho are sent, and an empty
 * field is never sent — so clearing a box keeps what Zoho has.
 */
const UpdateCustomerModal = ({ customer, match, cmp, onClose, onSave, saving }) => {
  const [form, setForm] = useState(() => {
    const init = {};
    for (const f of FORM_FIELDS) init[f.key] = text(cmp.zoho[f.key]) || text(cmp.waiting[f.key]);
    init.contact_person = text(cmp.waiting.contact_person) || text(cmp.zoho.contact_person);
    init.category = text(cmp.zoho.category) || text(cmp.waiting.category);
    return init;
  });
  const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));
  const willChange = FORM_FIELDS.filter((f) => text(form[f.key]) && text(form[f.key]) !== text(cmp.zoho[f.key]));
  const missing = FORM_FIELDS.filter((f) => f.required && !text(form[f.key]));
  const orders = cmp.waiting.order_count || 0;
  const inputClass =
    'w-full border border-slate-300 rounded px-2 py-1.5 text-[13px] text-ink-primary focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue';

  return (
    <Modal isOpen onClose={onClose} title={`Update ${match.name} in Zoho`}>
      <div className="max-h-[65vh] overflow-y-auto pr-1 -mr-1">
        <p className="text-[12px] text-ink-secondary mb-3">
          Starts with what Zoho has, filled in from <strong>{customer.name}</strong> where Zoho is blank. Leaving a
          field empty keeps what Zoho has.
        </p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          {FORM_FIELDS.map((f) => {
            const z = text(cmp.zoho[f.key]);
            const w = text(cmp.waiting[f.key]);
            const conflict = z && w && !sameValue(f.key, z, w);
            const changing = text(form[f.key]) && text(form[f.key]) !== z;
            return (
              <label key={f.key} className={f.wide ? 'col-span-2' : ''}>
                <span className="block text-[11px] font-semibold text-ink-secondary mb-0.5">
                  {f.label}
                  {f.required && <span className="text-red-600"> *</span>}
                  {changing && <span className="ml-1.5 text-[10px] font-bold uppercase text-getmeds-blue">will update</span>}
                </span>
                <input
                  type={f.type || 'text'}
                  value={form[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                  className={inputClass}
                />
                {conflict && (
                  <span className="mt-0.5 flex flex-wrap gap-x-2 text-[11px] text-ink-secondary">
                    <button type="button" onClick={() => set(f.key, z)} className="hover:text-getmeds-blue">
                      Zoho: <strong>{z}</strong>
                    </button>
                    <button type="button" onClick={() => set(f.key, w)} className="hover:text-getmeds-blue">
                      Waiting: <strong>{w}</strong>
                    </button>
                  </span>
                )}
              </label>
            );
          })}
        </div>

        <p className="mt-4 mb-1.5 text-[11px] font-bold uppercase tracking-wider text-ink-secondary">Saved in this app only</p>
        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <label>
            <span className="block text-[11px] font-semibold text-ink-secondary mb-0.5">Contact person</span>
            <input value={form.contact_person} onChange={(e) => set('contact_person', e.target.value)} className={inputClass} />
          </label>
          <label>
            <span className="block text-[11px] font-semibold text-ink-secondary mb-0.5">Customer type</span>
            <select value={form.category} onChange={(e) => set('category', e.target.value)} className={inputClass}>
              <option value="">Not set</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.charAt(0).toUpperCase() + c.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <div className="mt-4 rounded-md bg-surface border border-slate-200 px-3 py-2 text-[12px] text-ink-secondary">
        {willChange.length ? (
          <>
            Will update in Zoho: <strong className="text-ink-primary">{willChange.map((f) => f.label).join(', ')}</strong>.
          </>
        ) : (
          'Nothing differs from Zoho — nothing will be sent there.'
        )}{' '}
        {orders ? `${orders} order(s) move to ${match.name}; ` : ''}the waiting copy is deleted.
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-[13px] border border-slate-300 text-ink-secondary rounded hover:bg-surface"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving || missing.length > 0}
          title={missing.length ? `${missing.map((f) => f.label).join(', ')} required` : ''}
          onClick={() => onSave({ kind: 'update', id: customer.id, target_id: match.id, update: form })}
          className="px-3 py-1.5 text-[13px] font-semibold bg-getmeds-blue text-white rounded disabled:opacity-50"
        >
          {saving ? 'Saving…' : willChange.length ? 'Save to Zoho' : 'Use this customer'}
        </button>
      </div>
    </Modal>
  );
};

const PendingCustomersPage = () => {
  const qc = useQueryClient();
  const [ask, setAsk] = useState(null);
  const [editing, setEditing] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['pending-customers'],
    queryFn: () => client.get('/api/customers/pending').then((r) => r.data?.data)
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['pending-customers'] });
    qc.invalidateQueries({ queryKey: ['zoho-compare'] });
    qc.invalidateQueries({ queryKey: ['customers'] });
  };

  // Sep 11, 2026: a customer can be marked "Needs attention" for a reason that
  // was never about the customer — a push attempted during a token outage did
  // exactly that. Without a way back, the only remedies were SQL or re-typing.
  const retry = useMutation({
    mutationFn: (id) => client.post(`/api/customers/${id}/retry`).then((r) => r.data?.data),
    onSuccess: (res) => {
      toast.success(res.message);
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not requeue.'))
  });

  const sync = useMutation({
    mutationFn: () => client.post('/api/customers/pending/sync').then((r) => r.data?.data),
    onSuccess: (res) => {
      // "0 pushed" is not a success. Reporting it as one is how an admin
      // concludes the queue is working while nothing actually moves.
      if (res.blocked) {
        toast(res.message, { icon: '⏳', duration: 8000 });
      } else if (res.ok) {
        toast.success(res.message);
      } else {
        toast(res.message, { icon: '⚠️', duration: 8000 });
      }
      refresh();
    },
    onError: (err) => toast.error(errorMessage(err, 'Could not push customers to Zoho.'))
  });

  // The answers to a possible duplicate, and "stop pushing this one".
  const act = useMutation({
    mutationFn: ({ kind, id, target_id, update }) => {
      if (kind === 'link' || kind === 'update') {
        return client.post(`/api/customers/${id}/link`, { target_id, ...(update ? { update } : {}) }).then((r) => r.data?.data);
      }
      if (kind === 'push') return client.post(`/api/customers/${id}/push`, { confirm_new: true }).then((r) => r.data?.data);
      return client.delete(`/api/customers/${id}/pending`).then((r) => r.data?.data);
    },
    onSuccess: (res) => {
      toast.success(res.message, { duration: 7000 });
      setEditing(null);
      refresh();
    },
    onError: (err) => {
      toast.error(errorMessage(err, 'That did not go through.'), { duration: 9000 });
      refresh();
    }
  });

  const customers = data?.customers || [];
  const pending = data?.pending || 0;
  const failed = data?.failed || 0;
  // What the button will actually push: a likely duplicate is held back.
  const pushable = customers.filter((c) => c.zoho_sync_status === 'pending' && !(c.matches || []).length).length;
  const lastError = customers.find((c) => c.zoho_sync_status === 'pending' && c.zoho_sync_error)?.zoho_sync_error;

  const askDelete = (c) =>
    setAsk({
      title: `Delete ${c.name}?`,
      message:
        `${c.name} will not be pushed to Zoho, and is removed from this app. ` +
        'It was never in Zoho, so nothing there changes.',
      confirmText: 'Delete',
      variant: 'danger',
      run: { kind: 'delete', id: c.id }
    });

  if (isLoading) return <p className="p-6 text-sm text-ink-secondary">Loading…</p>;

  return (
    <div className="p-6 max-w-4xl">
      <div className="flex items-start justify-between gap-4 mb-5">
        <div>
          <h1 className="text-xl font-bold text-ink-primary flex items-center gap-2">
            <CloudOff className="w-5 h-5 text-amber-600" />
            Customers waiting for Zoho
          </h1>
          <p className="text-sm text-ink-secondary mt-1">
            Created here while Zoho could not accept them. Orders for these customers can be raised
            and approved — they just cannot become Sales Orders until the customer exists in Zoho.
          </p>
        </div>

        {pushable > 0 && (
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="shrink-0 inline-flex items-center gap-2 px-4 py-2 rounded-md bg-getmeds-blue text-white text-sm font-semibold disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${sync.isPending ? 'animate-spin' : ''}`} />
            {sync.isPending ? 'Pushing…' : `Push ${pushable} to Zoho`}
          </button>
        )}
      </div>

      {customers.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-8 text-center">
          <p className="text-sm text-ink-secondary">
            Nothing waiting — every customer created here has reached Zoho.
          </p>
        </div>
      ) : (
        <>
          {/* Why they are stuck, named once at the top — the last answer Zoho
              gave, rather than a guess at the cause. */}
          {pending > 0 && lastError && (
            <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
              <Info className="w-4 h-4 mt-0.5 shrink-0 text-amber-700" />
              <div className="text-[13px] text-amber-900">
                <p className="font-semibold">Zoho did not accept the last push.</p>
                <p className="mt-0.5 text-amber-900/90">
                  Zoho said: “{lastError}”. If the Zoho token was just reissued, the live server needs the new{' '}
                  <code className="text-[11px] bg-amber-100 px-1 py-0.5 rounded">ZOHO_REFRESH_TOKEN</code> and a
                  redeploy before pushing again. Nothing here is lost in the meantime.
                </p>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-slate-200 bg-white divide-y divide-slate-100">
            {customers.map((c) => {
              const matches = c.matches || [];
              return (
                <div key={c.id} className="px-4 py-3">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink-primary flex items-center gap-2">
                        <Building2 className="w-3.5 h-3.5 text-ink-secondary shrink-0" />
                        {c.name}
                        {c.category === 'hospital' && (
                          <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-800 border border-indigo-200">
                            Hospital
                          </span>
                        )}
                      </p>
                      <p className="text-[12px] text-ink-secondary mt-0.5">
                        {[c.contact_number, c.email].filter(Boolean).join(' · ')}
                        {c.created_at && <span> · added {timeAgo(c.created_at)}</span>}
                        {c.order_count > 0 && <span> · {c.order_count} order{c.order_count === 1 ? '' : 's'}</span>}
                      </p>

                      {/* Only shown for a 'failed' row. A pending row's error is
                          the one already stated above, and repeating it per row
                          would bury the one row that is genuinely different. */}
                      {c.zoho_sync_status === 'failed' && c.zoho_sync_error && (
                        <>
                          <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-red-800 bg-red-50 border border-red-200 rounded px-2 py-1.5">
                            <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                            <span>{c.zoho_sync_error}</span>
                          </p>
                          <button
                            type="button"
                            onClick={() => retry.mutate(c.id)}
                            disabled={retry.isPending}
                            className="mt-1.5 text-[11px] font-semibold text-getmeds-blue hover:text-getmeds-blue-dark disabled:opacity-60"
                          >
                            Put back in the queue
                          </button>
                        </>
                      )}
                    </div>

                    <div className="shrink-0 flex flex-col items-end gap-1.5">
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                          matches.length
                            ? 'bg-orange-100 text-orange-900 border-orange-300'
                            : c.zoho_sync_status === 'failed'
                              ? 'bg-red-50 text-red-800 border-red-200'
                              : 'bg-amber-100 text-amber-900 border-amber-300'
                        }`}
                      >
                        {matches.length ? (
                          <>
                            <Copy className="w-3 h-3" />
                            Check duplicate
                          </>
                        ) : c.zoho_sync_status === 'failed' ? (
                          <>
                            <AlertTriangle className="w-3 h-3" />
                            Needs attention
                          </>
                        ) : (
                          <>
                            <Clock className="w-3 h-3" />
                            Waiting
                          </>
                        )}
                      </span>
                      {/* Stop pushing this one. Not offered while orders point at
                          it — they would lose their customer; those move with
                          "use the one in Zoho" instead. */}
                      <button
                        type="button"
                        disabled={act.isPending || c.order_count > 0}
                        onClick={() => askDelete(c)}
                        title={
                          c.order_count > 0
                            ? `Has ${c.order_count} order(s) — use the matching Zoho customer instead, so the orders move with it.`
                            : 'Do not push this customer; remove it from this app'
                        }
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-700 hover:text-red-800 disabled:text-slate-400 disabled:cursor-not-allowed"
                      >
                        <Trash2 className="w-3 h-3" />
                        Delete
                      </button>
                    </div>
                  </div>

                  {matches.length > 0 && (
                    <DuplicateReview customer={c} onAsk={setAsk} onUpdate={setEditing} busy={act.isPending} />
                  )}
                </div>
              );
            })}
          </div>

          {/* A 'failed' row will never clear itself, so it is separated from
              the waiting ones rather than being pushed again on every attempt. */}
          {failed > 0 && (
            <p className="mt-3 text-[12px] text-ink-secondary">
              {failed} customer{failed === 1 ? '' : 's'} marked <strong>Needs attention</strong> —
              Zoho refused {failed === 1 ? 'it' : 'them'} for a reason retrying will not fix, usually
              a duplicate LTO licence. Fix the detail in the Clients Directory, or create the
              customer directly in Zoho and re-sync.
            </p>
          )}

          <p className="mt-3 text-[11px] text-ink-secondary">
            Possible duplicates are found by comparing with the customer list as last pulled from Zoho. A customer
            created in Zoho since the last customer sync is only caught after the next one.
          </p>
        </>
      )}

      <ConfirmDialog
        isOpen={!!ask}
        onClose={() => setAsk(null)}
        onConfirm={() => ask && act.mutate(ask.run)}
        title={ask?.title || ''}
        message={ask?.message || ''}
        confirmText={ask?.confirmText}
        variant={ask?.variant}
      />

      {editing && (
        <UpdateCustomerModal
          customer={editing.customer}
          match={editing.match}
          cmp={editing.cmp}
          onClose={() => setEditing(null)}
          onSave={(run) => act.mutate(run)}
          saving={act.isPending}
        />
      )}
    </div>
  );
};

export default PendingCustomersPage;
