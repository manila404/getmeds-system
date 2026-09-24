import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, ChevronDown, CheckSquare, Square, FileText, Trash2, Upload, ExternalLink, AlertTriangle, CloudOff } from 'lucide-react';
import toast from 'react-hot-toast';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';

/**
 * Client Details — Sep 24, 2026.
 *
 * Opened from a row of the Clients Directory. Laid out like Zoho's own "Edit
 * Customer" screen, and read live from Zoho when opened (see
 * controllers/customerDetails.controller.js for where each field comes from and
 * why it is fetched on demand rather than stored). Nothing here writes to Zoho.
 *
 *   always visible   Custom ID, Customer Type, Company Name, Primary Contact,
 *                    Display Name, Email, Phone(s), Address (billing + shipping),
 *                    Is Doctor
 *   "Additional Info" Company ID, LTO License Number / Type, License Issuance /
 *   (collapsed)      Expiry, TIN, and Documents (up to 10, 10 MB each)
 *
 * The 10 MB and 10-document limits are checked here so nobody uploads a file
 * only to be refused, and again on the server, which is the one that counts.
 */

const MAX_DOCUMENTS = 10;
const MAX_BYTES = 10 * 1024 * 1024;
const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/heic,image/heif,.doc,.docx,.xls,.xlsx';
const ALLOWED_TYPES = [
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const errorText = (err, fallback) =>
  err?.response?.data?.error?.message || err?.response?.data?.message || err?.message || fallback;

const formatBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** yyyy-mm-dd -> "Mar 14, 2026", without the timezone shifting a bare date by a day. */
const formatDay = (iso) => {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
};

const Empty = () => <span className="text-slate-400">—</span>;

/** Monospace only when there is a value, so a missing one still reads as "—". */
const mono = (v) => (v ? <span className="font-mono">{v}</span> : null);

const Field = ({ label, children, wide }) => (
  <div className={wide ? 'sm:col-span-2' : undefined}>
    <dt className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-0.5">{label}</dt>
    <dd className="text-sm text-slate-900 break-words">{children || <Empty />}</dd>
  </div>
);

const AddressBlock = ({ title, address }) => (
  <div className="rounded-lg border border-slate-200 p-3">
    <h4 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">{title}</h4>
    {address ? (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        <Field label="Street 1" wide>{address.street1}</Field>
        <Field label="Street 2" wide>{address.street2}</Field>
        <Field label="City">{address.city}</Field>
        <Field label="State">{address.state}</Field>
        <Field label="ZIP">{address.zip}</Field>
        <Field label="Country">{address.country}</Field>
        <Field label="Phone" wide>{address.phone}</Field>
      </dl>
    ) : (
      <p className="text-sm text-slate-400">No address on file.</p>
    )}
  </div>
);

const DocumentsSection = ({ customerId, documents, limits, onChanged }) => {
  const inputRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  const max = limits?.max_documents || MAX_DOCUMENTS;
  const maxBytes = limits?.max_bytes || MAX_BYTES;
  const remaining = max - documents.length;

  const uploadOne = async (file) => {
    const meta = { file_name: file.name, content_type: file.type, file_size: file.size };
    const { data: step1 } = await client.post(`/api/customers/${customerId}/documents/upload-url`, meta);
    const { signedUrl, storagePath } = step1.data;
    // Plain fetch straight to storage, so the session token never goes to another origin.
    const put = await fetch(signedUrl, { method: 'PUT', headers: { 'content-type': file.type }, body: file });
    if (!put.ok) throw new Error(`Upload to storage failed (${put.status}). Nothing was saved.`);
    await client.post(`/api/customers/${customerId}/documents`, { ...meta, storage_path: storagePath });
  };

  const onPick = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // so picking the same file again still fires
    if (!files.length) return;

    const issues = [];
    const accepted = [];
    for (const f of files) {
      if (f.size > maxBytes) issues.push(`${f.name} is ${formatBytes(f.size)}, over the ${formatBytes(maxBytes)} limit.`);
      else if (f.size === 0) issues.push(`${f.name} is empty.`);
      else if (!ALLOWED_TYPES.includes(f.type)) issues.push(`${f.name} is not a supported type (PDF, image, Word or Excel).`);
      else if (accepted.length >= remaining) issues.push(`${f.name} was not added: this customer can hold ${max} documents.`);
      else accepted.push(f);
    }
    setProblems(issues);
    if (!accepted.length) return;

    setBusy(true);
    let added = 0;
    for (const f of accepted) {
      try {
        await uploadOne(f);
        added += 1;
      } catch (err) {
        issues.push(`${f.name}: ${errorText(err, 'could not be uploaded.')}`);
      }
    }
    setProblems([...issues]);
    setBusy(false);
    if (added) {
      toast.success(added === 1 ? 'Document added.' : `${added} documents added.`);
      await onChanged();
    }
  };

  const open = async (doc) => {
    try {
      const { data } = await client.get(`/api/customers/${customerId}/documents/${doc.id}/url`);
      window.open(data.data.url, '_blank', 'noopener');
    } catch (err) {
      toast.error(errorText(err, 'Could not open that document.'));
    }
  };

  const remove = async (doc) => {
    setBusy(true);
    try {
      await client.delete(`/api/customers/${customerId}/documents/${doc.id}`);
      toast.success('Document deleted.');
      await onChanged();
    } catch (err) {
      toast.error(errorText(err, 'Could not delete that document.'));
    } finally {
      setBusy(false);
    }
  };

  const [confirmId, setConfirmId] = useState(null);

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-2">
        <h4 className="text-[11px] font-bold uppercase tracking-wide text-slate-500">Documents</h4>
        <span className="text-xs text-slate-500 tabular-nums">{documents.length} of {max} used · up to {formatBytes(maxBytes)} each</span>
      </div>

      <ul className="space-y-1.5">
        {documents.map((d) => (
          <li key={d.id} className="flex items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
            <FileText className="w-4 h-4 text-slate-400 shrink-0" />
            <button type="button" onClick={() => open(d)} className="min-w-0 flex-1 text-left" title="Open">
              <span className="block truncate text-sm font-medium text-slate-900 hover:text-getmeds-blue">{d.file_name}</span>
              <span className="block text-[11px] text-slate-500">
                {formatBytes(d.file_size)}{d.uploaded_by_name ? ` · ${d.uploaded_by_name}` : ''}{d.created_at ? ` · ${formatPHT(d.created_at, 'date')}` : ''}
              </span>
            </button>
            <button type="button" onClick={() => open(d)} aria-label={`Open ${d.file_name}`} className="p-1.5 rounded text-slate-400 hover:text-getmeds-blue hover:bg-slate-100">
              <ExternalLink className="w-4 h-4" />
            </button>
            {confirmId === d.id ? (
              <span className="flex items-center gap-1.5 text-xs">
                <button type="button" disabled={busy} onClick={() => { setConfirmId(null); remove(d); }} className="font-semibold text-red-700 hover:text-red-800">Delete</button>
                <button type="button" onClick={() => setConfirmId(null)} className="text-slate-500 hover:text-slate-700">Keep</button>
              </span>
            ) : (
              <button type="button" disabled={busy} onClick={() => setConfirmId(d.id)} aria-label={`Delete ${d.file_name}`} className="p-1.5 rounded text-slate-400 hover:text-red-600 hover:bg-red-50 disabled:opacity-50">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </li>
        ))}

        {remaining > 0 ? (
          <li>
            <button
              type="button"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              className="w-full flex items-center justify-center gap-2 rounded-lg border border-dashed border-slate-300 px-3 py-3 text-sm font-semibold text-getmeds-blue hover:bg-slate-50 disabled:opacity-60"
            >
              <Upload className="w-4 h-4" />
              {busy ? 'Uploading…' : documents.length ? `Add another document (${remaining} slot${remaining === 1 ? '' : 's'} left)` : 'Add a document'}
            </button>
          </li>
        ) : (
          <li className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            All {max} slots are used. Delete a document to add another.
          </li>
        )}
      </ul>

      <input ref={inputRef} type="file" accept={ACCEPT} multiple className="hidden" onChange={onPick} aria-label="Choose documents to add" />

      {problems.length > 0 && (
        <ul role="alert" className="mt-2 space-y-1 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
          {problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      <p className="mt-2 text-[11px] text-slate-500">
        Stored in GetMeds, not attached to the contact in Zoho. PDF, images, Word or Excel.
      </p>
    </div>
  );
};

const ClientDetailsModal = ({ customerId, fallbackName, onClose }) => {
  const qc = useQueryClient();
  const [showMore, setShowMore] = useState(false);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['client-details', customerId],
    queryFn: () => client.get(`/api/customers/${customerId}/details`).then((r) => r.data.data),
    // Read live from Zoho: keep it for the length of the visit, not for good.
    staleTime: 60 * 1000,
    retry: false,
  });

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const refreshDocs = async () => {
    await qc.invalidateQueries({ queryKey: ['client-details', customerId] });
  };

  const d = data;
  const isBusiness = d?.customer_type === 'business';
  const isIndividual = d?.customer_type === 'individual';
  const phones = d?.phones || {};
  const extra = d?.additional || {};

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 sm:py-10" role="dialog" aria-modal="true" aria-labelledby="client-details-title">
      <div className="fixed inset-0 bg-slate-900/50" onClick={onClose} aria-hidden="true" />

      <div className="relative w-full max-w-3xl rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0">
            <h2 id="client-details-title" className="text-base font-semibold text-slate-900 truncate">
              {d?.display_name || fallbackName || 'Client details'}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
              {d?.custom_id && <span className="font-mono font-semibold text-slate-700">{d.custom_id}</span>}
              {d && (
                <span className={`px-2 py-0.5 rounded-md font-bold text-[10.5px] ${d.source === 'zoho' ? 'bg-purple-50 text-purple-700 border border-purple-200' : 'bg-slate-100 text-slate-600 border border-slate-200'}`}>
                  {d.source === 'zoho' ? 'Read live from Zoho' : 'Stored locally'}
                </span>
              )}
              {d && d.is_active === false && <span className="px-2 py-0.5 rounded-md font-bold text-[10.5px] bg-slate-100 text-slate-500 border border-slate-200">INACTIVE</span>}
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-900">
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading && (
          <div className="flex flex-col items-center gap-3 py-16 text-sm text-slate-500">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-getmeds-blue" />
            Reading this customer from Zoho…
          </div>
        )}

        {isError && (
          <div className="px-5 py-8 text-center space-y-3">
            <AlertTriangle className="w-8 h-8 mx-auto text-red-500" />
            <p className="text-sm text-red-800">{errorText(error, 'Could not load this customer.')}</p>
            <button type="button" onClick={() => refetch()} className="px-3.5 py-2 rounded-md border border-slate-200 text-sm font-semibold text-slate-700 hover:bg-slate-50">Try again</button>
          </div>
        )}

        {d && (
          <div className="px-5 py-5 space-y-5">
            {d.zoho_error && (
              <div role="status" className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                <CloudOff className="w-4 h-4 shrink-0 mt-0.5" />
                <span>Zoho could not be reached, so these are the values stored in GetMeds and may be out of date. ({d.zoho_error})</span>
              </div>
            )}
            {!d.zoho_contact_id && (
              <div role="status" className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
                This customer is not in Zoho{d.zoho_sync_status === 'pending' ? ' yet (waiting to be pushed)' : ''}, so only what was entered here is shown.
              </div>
            )}

            {/* Primary details */}
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              <Field label="Custom ID">{mono(d.custom_id)}</Field>
              <Field label="Customer Type">
                {d.customer_type && (
                  <span className="inline-flex items-center gap-3">
                    <span className={`inline-flex items-center gap-1.5 ${isBusiness ? 'font-semibold' : 'text-slate-400'}`}>
                      <span className={`inline-block w-3 h-3 rounded-full border ${isBusiness ? 'border-getmeds-blue bg-getmeds-blue' : 'border-slate-300'}`} /> Business
                    </span>
                    <span className={`inline-flex items-center gap-1.5 ${isIndividual ? 'font-semibold' : 'text-slate-400'}`}>
                      <span className={`inline-block w-3 h-3 rounded-full border ${isIndividual ? 'border-getmeds-blue bg-getmeds-blue' : 'border-slate-300'}`} /> Individual
                    </span>
                  </span>
                )}
              </Field>
              <Field label="Company Name">{d.company_name}</Field>
              <Field label="Primary Contact">{d.primary_contact?.full}</Field>
              <Field label="Display Name">{d.display_name}</Field>
              <Field label="Email Address">{d.email}</Field>
              <Field label="Phone Number(s)" wide>
                {phones.work || phones.mobile || phones.contact_number ? (
                  <ul className="flex flex-wrap gap-x-6 gap-y-1">
                    {phones.work && <li><span className="text-slate-500 text-xs mr-1">Work</span>{phones.work}</li>}
                    {phones.mobile && <li><span className="text-slate-500 text-xs mr-1">Mobile</span>{phones.mobile}</li>}
                    {phones.contact_number && <li><span className="text-slate-500 text-xs mr-1">Contact no.</span>{phones.contact_number}</li>}
                  </ul>
                ) : null}
              </Field>
              <Field label="Is Doctor">
                {d.is_doctor === null || d.is_doctor === undefined ? null : (
                  <span className="inline-flex items-center gap-1.5">
                    {d.is_doctor ? <CheckSquare className="w-4 h-4 text-getmeds-blue" /> : <Square className="w-4 h-4 text-slate-400" />}
                    {d.is_doctor ? 'Yes' : 'No'}
                  </span>
                )}
              </Field>
            </dl>

            {/* Address breakdown */}
            <div>
              <h3 className="text-[11px] font-bold uppercase tracking-wide text-slate-500 mb-2">Address</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <AddressBlock title="Billing" address={d.billing_address} />
                <AddressBlock title="Shipping" address={d.shipping_address} />
              </div>
            </div>

            {/* Additional Info (collapsed by default) */}
            <div className="rounded-lg border border-slate-200">
              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                aria-expanded={showMore}
                aria-controls="client-additional-info"
                className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left text-sm font-semibold text-slate-900 hover:bg-slate-50 rounded-lg"
              >
                <span>
                  Additional Info
                  <span className="ml-2 font-normal text-xs text-slate-500">
                    License, TIN and documents{d.documents.length ? ` · ${d.documents.length} document${d.documents.length === 1 ? '' : 's'}` : ''}
                  </span>
                </span>
                <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${showMore ? 'rotate-180' : ''}`} />
              </button>

              {showMore && (
                <div id="client-additional-info" className="border-t border-slate-200 px-4 py-4">
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                    <Field label="Company ID">{extra.company_id}</Field>
                    <Field label="TIN">{mono(extra.tin)}</Field>
                    <Field label="LTO License Number">{mono(extra.lto_license_number)}</Field>
                    <Field label="LTO Type">{extra.lto_type}</Field>
                    <Field label="License Issuance Date">{formatDay(extra.license_issuance_date)}</Field>
                    <Field label="License Expiry Date">{formatDay(extra.license_expiry_date)}</Field>
                    {d.zoho_documents?.length > 0 && (
                      <Field label="Files already on the contact in Zoho" wide>
                        {d.zoho_documents.map((z) => z.file_name).join(', ')}
                      </Field>
                    )}
                  </dl>
                  <div className="mt-5 border-t border-slate-100 pt-4">
                    <DocumentsSection customerId={customerId} documents={d.documents} limits={d.document_limits} onChanged={refreshDocs} />
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default ClientDetailsModal;
