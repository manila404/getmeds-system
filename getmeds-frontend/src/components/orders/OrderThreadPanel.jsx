import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { MessageSquare, Paperclip, Send, X, AlertTriangle, CheckCircle2, Truck, FileText, Pencil, Circle } from 'lucide-react';
import client from '../../api/client';
import { formatPHT } from '../../utils/dateUtils';
import { uploadOrderAttachment } from '../../utils/attachmentUpload';
import { ATTACHMENT_TYPES } from '../../constants/attachmentTypes';
import { roleLabel } from '../../constants/roles';
import { HOLD_FIELDS, HOLD_ATTACHMENTS, holdItemLabel } from '../../constants/holdItems';
import { attachmentName, orderRef } from '../../utils/attachmentNames';

/**
 * Nov 27, 2026: the order's conversation, beside the order.
 *
 * Everything people said or did that the MedRep has to know about, as one
 * thread, oldest first:
 *   - holds and their reasons (Finance, Management, Dispatch, Pharmacy)
 *   - the MedRep's resubmit notes, and plain messages from anyone
 *   - files added, and what Dispatch did (catered, confirmed, tracking, proof)
 *   - when a hold was lifted or the order verified
 *
 * The reply box at the bottom:
 *   - on hold (and the MedRep can act): "Resubmit with this reply" — the
 *     reply is the resubmit note, and the files go up with it, so answering
 *     the hold and adding the missing document is one step
 *   - sent back by Management: "Submit to Management again" the same way
 *   - otherwise a plain message (POST /api/orders/:id/messages), with files
 *
 * Built only from the order's own events (already on the page) plus the new
 * ORDER_MESSAGE event, so nothing else needs storing.
 */
const KINDS = {
  hold: ['FINANCE_REJECTED', 'EXCEPTION_SET', 'MANAGEMENT_SENT_BACK', 'MANAGEMENT_REJECTED', 'DISPATCH_HOLD',
    'TRACKING_ON_HOLD', 'PAYMENT_PROOF_REJECTED', 'RX_REJECTED', 'STOCK_HOLD', 'RX_REQUESTED'],
  reply: ['RETURNED_TO_FINANCE', 'ORDER_RESUBMITTED', 'RX_RESUBMITTED'],
  message: ['ORDER_MESSAGE'],
  resolved: ['ORDER_RESUMED', 'FINANCE_VERIFIED', 'DISPATCH_HOLD_LIFTED', 'TRACKING_HOLD_RELEASED', 'MANAGEMENT_APPROVED', 'RX_VERIFIED'],
  dispatch: ['DISPATCH_CATERED', 'DELIVERY_CONFIRMED', 'DISPATCH_TRACKING_ADDED', 'DISPATCH_PROOF_UPLOADED', 'ZOHO_DISPATCHED', 'DR_ISSUED'],
  file: ['ATTACHMENT_UPLOADED', 'PAYMENT_PROOF_UPLOADED', 'RX_UPLOADED'],
  update: ['ORDER_DETAILS_EDITED'],
};
const KIND_OF = Object.fromEntries(Object.entries(KINDS).flatMap(([k, types]) => types.map((t) => [t, k])));

const TITLES = {
  FINANCE_REJECTED: 'Finance put it on hold',
  EXCEPTION_SET: 'Put on hold',
  MANAGEMENT_SENT_BACK: 'Management sent it back',
  MANAGEMENT_REJECTED: 'Management rejected it',
  DISPATCH_HOLD: 'Dispatch put it on hold',
  TRACKING_ON_HOLD: 'Tracking number on hold',
  PAYMENT_PROOF_REJECTED: 'Proof of payment rejected',
  RX_REJECTED: 'Prescription rejected',
  RX_REQUESTED: 'Prescription requested',
  STOCK_HOLD: 'Stock hold',
  RETURNED_TO_FINANCE: 'Resubmitted to Finance',
  ORDER_RESUBMITTED: 'Resubmitted',
  RX_RESUBMITTED: 'Prescription resubmitted',
  ORDER_RESUMED: 'Hold lifted',
  FINANCE_VERIFIED: 'Verified by Finance',
  DISPATCH_HOLD_LIFTED: 'Dispatch hold lifted',
  TRACKING_HOLD_RELEASED: 'Tracking hold lifted',
  MANAGEMENT_APPROVED: 'Approved by Management',
  RX_VERIFIED: 'Prescription verified',
  DISPATCH_CATERED: 'Dispatch is preparing it',
  DELIVERY_CONFIRMED: 'Confirmed for delivery',
  DISPATCH_TRACKING_ADDED: 'Tracking added',
  DISPATCH_PROOF_UPLOADED: 'Dispatch proof uploaded',
  ZOHO_DISPATCHED: 'Shipped',
  DR_ISSUED: 'Delivery Receipt issued',
  ATTACHMENT_UPLOADED: 'File added',
  PAYMENT_PROOF_UPLOADED: 'Proof of payment added',
  RX_UPLOADED: 'Prescription added',
  ORDER_DETAILS_EDITED: 'Details updated',
};

// Nov 27, 2026 (2): the trail's notes start with automatic wording ("Rejected
// by Finance: …", "Re-submitted for verification by Juan dela Cruz: …",
// "File attached (IMG.jpeg)."). The thread shows only what the person wrote;
// who did it is already on the bubble.
const PREFIXES = [
  /^rejected by finance:\s*/i,
  /^re-?submitted[^:]{0,120}:\s*/i,
  /^sent back for resubmission by management:\s*/i,
  /^rejected by management:\s*/i,
  /^proof of payment rejected by finance:\s*/i,
  /^(put )?on hold( by [^:]{1,80})?:\s*/i,
  /^held by [^:]{1,80}:\s*/i,
];
function cleanNote(e) {
  let n = String(e.notes || '').trim();
  if (!n) return '';
  if (e.kind === 'file') {
    const m = n.match(/\(([^)]+)\)/);
    return m ? m[1] : n;
  }
  for (const re of PREFIXES) n = n.replace(re, '');
  return n.trim();
}

// Nov 27, 2026: a file uploaded from the Conversation gets a name that says what it
// is, so it reads clearly on the Zoho Sales Order: NEW-proof_of_payment_SO-0021.jpeg
// (a second one of the same kind on the same send: …_SO-0021-2.jpeg).
function uploadName(file, type, order, n = 1) {
  // Same names as the order form (utils/attachmentNames.js), marked NEW- as a file sent to fix a hold.
  return attachmentName(file, type, orderRef(order), { n: n > 1 ? n : 0, prefix: 'NEW-' });
}
const renamed = (file, name) => new File([file], name, { type: file.type, lastModified: file.lastModified });

// Opens a file the person picked but has not sent yet.
function previewLocal(file) {
  const url = URL.createObjectURL(file);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

const parseMeta = (m) => {
  if (!m) return {};
  if (typeof m === 'object') return m;
  try { return JSON.parse(m) || {}; } catch { return {}; }
};

const RoleTag = ({ role }) => (role ? (
  <span className="ml-1.5 text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-slate-100 text-slate-600">
    {roleLabel(role)}
  </span>
) : null);

const OrderThreadPanel = ({ order, events = [], user, canActOnOrder }) => {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [fileType, setFileType] = useState('other');
  const [alsoResubmit, setAlsoResubmit] = useState(true);
  // Nov 27, 2026: fixes for what the hold flagged — changed field values and
  // the missing documents, all sent with "Fix & resubmit".
  const [fieldFix, setFieldFix] = useState({});
  const [docFix, setDocFix] = useState({});
  const fileInput = useRef(null);
  const bottom = useRef(null);

  const entries = useMemo(
    () => events.filter((e) => KIND_OF[e.event_type]).map((e) => ({ ...e, kind: KIND_OF[e.event_type], meta: parseMeta(e.metadata) })),
    [events]
  );
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [entries.length]);

  const onHold = ['on_hold', 'exception'].includes(order.status);
  const canResubmit = onHold && order.resubmittable && canActOnOrder;
  const canSubmitAgain = order.status === 'draft' && order.sent_back && canActOnOrder;
  const action = canResubmit && alsoResubmit ? 'resubmit' : canSubmitAgain && alsoResubmit ? 'submit' : 'message';
  const openHold = onHold || order.sent_back ? [...entries].reverse().find((e) => e.kind === 'hold') : null;
  const holdItems = (openHold && Array.isArray(openHold.meta.hold_items)) ? openHold.meta.hold_items : [];
  const fixFields = canResubmit ? HOLD_FIELDS.filter((h) => holdItems.some((i) => i.key === h.key)) : [];
  const fixDocs = canResubmit ? HOLD_ATTACHMENTS.filter((h) => holdItems.some((i) => i.key === h.key)) : [];
  const fixPrices = holdItems.some((i) => i.key === 'prices');
  const changedFields = fixFields.filter((h) => fieldFix[h.key] !== undefined && String(fieldFix[h.key]).trim() && String(fieldFix[h.key]).trim() !== String(order[h.orderKey] || '').trim());
  const chosenDocs = fixDocs.filter((h) => docFix[h.type]);
  const fixCount = changedFields.length + chosenDocs.length;
  const fixesWanted = fixFields.length + fixDocs.length;

  const send = useMutation({
    mutationFn: async () => {
      const body = text.trim();
      const uploadAll = async () => {
        const done = [];
        let n = 0;
        for (const f of files) {
          n += 1;
          const named = renamed(f, uploadName(f, fileType, order, files.length > 1 ? n : 1));
          await uploadOrderAttachment(client, order.id, named, fileType);
          done.push({ file_name: named.name, file_type: fileType });
        }
        return done;
      };
      if (action === 'resubmit') {
        const fixedLabels = [...changedFields.map((h) => h.label), ...chosenDocs.map((h) => h.label)];
        const reason = body || (fixedLabels.length ? `Fixed: ${fixedLabels.join(', ')}` : '');
        if (!reason) throw new Error('Write what you fixed — it goes to Finance with the resubmit.');
        // 1. the flagged details, while the order is still on hold (updates the Zoho Sales Order too)
        if (changedFields.length) {
          const patch = Object.fromEntries(changedFields.map((h) => [h.key, String(fieldFix[h.key]).trim()]));
          await client.patch(`/api/orders/${order.id}/details`, patch);
        }
        // 2. resubmit — before any upload, which on a Finance hold would send it back by itself
        await client.post(`/api/orders/${order.id}/resubmit`, { reason: reason.slice(0, 500) });
        // 3. the missing documents, each as its own type, then any other files
        for (const h of chosenDocs) await uploadOrderAttachment(client, order.id, renamed(docFix[h.type], uploadName(docFix[h.type], h.type, order)), h.type);
        await uploadAll();
        return fixedLabels.length ? `Fixed ${fixedLabels.length} item(s) and resubmitted.` : 'Resubmitted with your reply.';
      }
      const uploaded = await uploadAll();
      // Files with no words: the "File added" line already says it, so no
      // second bubble repeating the file name.
      if (body) {
        await client.post(`/api/orders/${order.id}/messages`, { text: body, files: uploaded });
      }
      if (action === 'submit') {
        await client.post(`/api/orders/${order.id}/submit`);
        return 'Sent to Management again with your reply.';
      }
      return 'Message sent.';
    },
    onSuccess: (msg) => {
      toast.success(msg);
      setText('');
      setFiles([]);
      setFieldFix({});
      setDocFix({});
      qc.invalidateQueries({ queryKey: ['order', String(order.id)] });
      qc.invalidateQueries({ queryKey: ['order'] });
      qc.invalidateQueries({ queryKey: ['order-attachments', String(order.id)] });
    },
    onError: (err) => toast.error(err.response?.data?.error?.message || err.message || 'Could not send.', { duration: 8000 }),
  });

  const mine = (e) => user && Number(e.actor_id) === Number(user.id);

  // The order's files, for opening one from the thread.
  const attachmentsQ = useQuery({
    queryKey: ['order-attachments', String(order.id)],
    queryFn: async () => (await client.get(`/api/orders/${order.id}/attachments`)).data?.data?.attachments || [],
    staleTime: 60000,
  });
  const attachments = attachmentsQ.data || [];
  const linkFor = (fileName, storagePath) => {
    const a = attachments.find((x) => (storagePath && x.storage_path === storagePath))
      || [...attachments].reverse().find((x) => x.file_name === fileName);
    return a ? (a.viewUrl || a.view_url || null) : null;
  };
  const FileLink = ({ name, path, className = '' }) => {
    const url = linkFor(name, path);
    return url
      ? <a href={url} target="_blank" rel="noopener noreferrer" className={`underline decoration-dotted underline-offset-2 hover:decoration-solid ${className}`} title="Open">{name}</a>
      : <span className={className}>{name}</span>;
  };

  return (
    <aside className="bg-white shadow rounded-lg flex flex-col lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] mt-6 lg:mt-0">
      <div className="px-4 py-3 border-b border-slate-200 flex items-center gap-2">
        <MessageSquare className="w-4 h-4 text-getmeds-blue" />
        <h3 className="text-sm font-semibold text-ink-primary">Conversation</h3>
        <span className="text-xs text-ink-secondary">({entries.length})</span>
      </div>

      {openHold && (
        <div className="mx-3 mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-900">
          <p className="font-semibold flex items-center gap-1"><AlertTriangle className="w-3.5 h-3.5" /> Waiting on you</p>
          <p className="mt-0.5 text-sm font-medium">{cleanNote(openHold) || TITLES[openHold.event_type]}</p>
          <p className="mt-0.5 text-red-800/80">{openHold.actor_name} · {formatPHT(openHold.created_at, 'timeline')}</p>
          {holdItems.length > 0 && (
            <div className="mt-2 space-y-2 border-t border-red-200 pt-2">
              <p className="font-semibold">Fix these{fixesWanted ? ` (${fixCount}/${fixesWanted} done)` : ''}:</p>
              {fixFields.map((h) => {
                const current = order[h.orderKey] || '';
                const value = fieldFix[h.key] !== undefined ? fieldFix[h.key] : current;
                const done = changedFields.includes(h);
                const Input = h.multiline ? 'textarea' : 'input';
                return (
                  <label key={h.key} className="block">
                    <span className="flex items-center gap-1 font-semibold text-ink-primary">
                      {done ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <Circle className="w-3.5 h-3.5 text-red-400" />}
                      {h.label}
                    </span>
                    <Input
                      type={h.multiline ? undefined : (h.type || 'text')}
                      rows={h.multiline ? 2 : undefined}
                      value={value}
                      onChange={(ev) => setFieldFix((p) => ({ ...p, [h.key]: ev.target.value }))}
                      className="mt-0.5 w-full rounded border border-red-200 bg-white px-2 py-1 text-xs text-ink-primary focus:outline-none focus:ring-1 focus:ring-red-300"
                    />
                  </label>
                );
              })}
              {fixDocs.map((h) => (
                <div key={h.key} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1 font-semibold text-ink-primary min-w-0">
                    {docFix[h.type] ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" /> : <Circle className="w-3.5 h-3.5 text-red-400 shrink-0" />}
                    <span className="truncate">{h.label}</span>
                  </span>
                  {docFix[h.type] && (
                    <button type="button" onClick={() => previewLocal(docFix[h.type])} title={`Open ${docFix[h.type].name}`} className="shrink-0 text-[11px] font-semibold text-getmeds-blue-dark underline">
                      View
                    </button>
                  )}
                  <label className="shrink-0 cursor-pointer rounded border border-red-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-red-800 hover:bg-red-100">
                    {docFix[h.type] ? 'Change' : 'Upload'}
                    <input type="file" className="hidden" onChange={(ev) => { const file = ev.target.files && ev.target.files[0]; if (file) setDocFix((p) => ({ ...p, [h.type]: file })); ev.target.value = ''; }} />
                  </label>
                </div>
              ))}
              {chosenDocs.length > 0 && (
                <div className="text-[11px] text-red-900/80 space-y-0.5">
                  {chosenDocs.map((h) => (
                    <p key={h.type} className="truncate">
                      <button type="button" onClick={() => previewLocal(docFix[h.type])} className="underline">{docFix[h.type].name}</button>
                      {' '}uploads as <span className="font-mono font-semibold">{uploadName(docFix[h.type], h.type, order)}</span>
                    </p>
                  ))}
                </div>
              )}
              {fixPrices && (
                <p className="text-red-900"><span className="font-semibold">Prices / total:</span> explain in your reply below. Only Management can change prices on an order already in Zoho.</p>
              )}
              {!canResubmit && <p className="text-red-800/80">Only the MedRep of this order can fix and resubmit.</p>}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 min-h-[160px]">
        {!entries.length && (
          <p className="text-xs text-ink-secondary text-center py-6">No conversation yet. Holds, replies and Dispatch updates on this order show here.</p>
        )}
        {entries.map((e) => {
          if (e.kind === 'dispatch' || e.kind === 'file' || e.kind === 'resolved' || e.kind === 'update') {
            const Icon = e.kind === 'dispatch' ? Truck : e.kind === 'file' ? FileText : e.kind === 'update' ? Pencil : CheckCircle2;
            const tone = e.kind === 'resolved' ? 'text-emerald-700' : 'text-ink-secondary';
            const detail = cleanNote(e);
            return (
              <div key={e.id} className={`flex items-start gap-1.5 text-xs ${tone} px-1`}>
                <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <span className="font-semibold">{TITLES[e.event_type]}</span>
                  {detail ? (
                    <span className="break-words font-medium text-ink-primary"> · {e.kind === 'file'
                      ? <FileLink name={detail} path={e.meta.storagePath} className="text-getmeds-blue-dark" />
                      : detail}</span>
                  ) : null}
                  <span className="block text-[10px] opacity-75">{e.actor_name || 'System'} · {formatPHT(e.created_at, 'timeline')}</span>
                </div>
              </div>
            );
          }
          const isMine = mine(e) && !(e.kind === 'hold');
          const isHold = e.kind === 'hold';
          const bubble = isHold
            ? 'bg-red-50 border-red-300 border-l-4 border-l-red-500'
            : isMine ? 'bg-getmeds-blue border-getmeds-blue' : 'bg-white border-slate-300';
          const textTone = isMine ? 'text-white' : 'text-ink-primary';
          const subTone = isMine ? 'text-white/75' : 'text-ink-secondary';
          const files = Array.isArray(e.meta.files) ? e.meta.files : [];
          const said = cleanNote(e);
          return (
            <div key={e.id} className={`flex ${isMine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[90%] rounded-lg border px-3 py-2 shadow-sm ${bubble}`}>
                {/* who · role · when — small, above what they said */}
                <p className={`text-[11px] flex items-center flex-wrap gap-x-1 ${subTone}`}>
                  <span className={`font-semibold ${isMine ? 'text-white' : 'text-ink-primary'}`}>{isMine ? 'You' : (e.actor_name || 'System')}</span>
                  {!isMine && <RoleTag role={e.actor_role} />}
                  <span>· {formatPHT(e.created_at, 'timeline')}</span>
                </p>
                {e.kind !== 'message' && (
                  <p className={`mt-1 text-[10px] font-bold uppercase tracking-wide flex items-center gap-1 ${isHold ? 'text-red-700' : subTone}`}>
                    {isHold && <AlertTriangle className="w-3 h-3" />}
                    {TITLES[e.event_type]}
                  </p>
                )}
                {said && <p className={`mt-1 text-sm font-medium leading-snug whitespace-pre-wrap break-words ${isHold ? 'text-red-950' : textTone}`}>{said}</p>}
                {isHold && Array.isArray(e.meta.hold_items) && e.meta.hold_items.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {e.meta.hold_items.map((i) => (
                      <span key={i.key} className="px-1.5 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-semibold">{holdItemLabel(i.key)}</span>
                    ))}
                  </div>
                )}
                {files.length > 0 && (
                  <p className={`mt-1 text-xs flex items-center gap-1 ${subTone}`}>
                    <Paperclip className="w-3 h-3 shrink-0" />
                    <span className="flex flex-wrap gap-x-2">{files.map((f) => <FileLink key={f.file_name} name={f.file_name} />)}</span>
                  </p>
                )}
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      <div className="border-t border-slate-200 p-3 space-y-2">
        {(canResubmit || canSubmitAgain) && (
          <label className="flex items-center gap-2 text-xs font-semibold text-ink-primary">
            <input type="checkbox" checked={alsoResubmit} onChange={(e) => setAlsoResubmit(e.target.checked)} />
            {canResubmit ? 'Resubmit with this reply' : 'Submit to Management again with this reply'}
          </label>
        )}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          maxLength={action === 'resubmit' ? 500 : 1000}
          placeholder={action === 'resubmit' ? 'What did you fix? e.g. "Payment collected, receipt attached"' : 'Write a reply…'}
          className="w-full rounded-md border border-slate-300 px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-getmeds-blue/40"
        />
        {files.length > 0 && (
          <div className="space-y-1">
            {files.map((f, i) => (
              <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-xs bg-slate-50 rounded px-2 py-1">
                <span className="truncate">
                  <Paperclip className="inline w-3 h-3 mr-1" />
                  <button type="button" onClick={() => previewLocal(f)} className="underline" title="Open">{f.name}</button>
                  <span className="text-ink-secondary"> → {uploadName(f, fileType, order, files.length > 1 ? i + 1 : 1)}</span>
                </span>
                <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="text-ink-secondary hover:text-red-600"><X className="w-3.5 h-3.5" /></button>
              </div>
            ))}
            <select value={fileType} onChange={(e) => setFileType(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1 text-xs">
              {ATTACHMENT_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <input ref={fileInput} type="file" multiple className="hidden" onChange={(e) => { setFiles((p) => [...p, ...Array.from(e.target.files || [])]); e.target.value = ''; }} />
          <button type="button" onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-1 text-xs font-semibold text-ink-secondary hover:text-ink-primary">
            <Paperclip className="w-3.5 h-3.5" /> Attach file
          </button>
          <button
            type="button"
            disabled={send.isPending || (!text.trim() && !files.length && !(action === 'resubmit' && fixCount))}
            onClick={() => send.mutate()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-getmeds-blue text-white text-xs font-semibold hover:bg-getmeds-blue-dark disabled:opacity-50"
          >
            <Send className="w-3.5 h-3.5" />
            {send.isPending ? 'Sending…' : action === 'resubmit' ? (fixCount ? 'Fix & resubmit' : 'Reply & resubmit') : action === 'submit' ? 'Reply & submit' : 'Send'}
          </button>
        </div>
      </div>
    </aside>
  );
};

export default OrderThreadPanel;
