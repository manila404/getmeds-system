import React, { useState } from 'react';
import toast from 'react-hot-toast';
import Modal from '../ui/Modal';
import AttachFileField from './AttachFileField';
import { uploadOrderAttachment } from '../../utils/attachmentUpload';
import client from '../../api/client';

/**
 * Nov 10, 2026: MedRep / Team Lead / Management confirms delivery of an order
 * at 'tracking_shared' (or 'dispatched') and marks it as 'completed'.
 *
 * Automatically pre-fills the receiver name from order.intake_receiver when available.
 */
const CompleteOrderModal = ({ order, onClose, onSuccess }) => {
  const [receiverName, setReceiverName] = useState(order.intake_receiver || order.intake_receiver_name || '');
  const [deliveryDate, setDeliveryDate] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');
  const [file, setFile] = useState(null);
  const [fileType, setFileType] = useState('other');
  const [saving, setSaving] = useState(false);

  const hasIntakeReceiver = Boolean(order.intake_receiver || order.intake_receiver_name);

  const handleFileChange = (f, error) => {
    if (error) { toast.error(error); return; }
    setFile(f);
  };

  const handleComplete = async (e) => {
    e.preventDefault();
    if (!deliveryDate) {
      toast.error('Please enter the delivery date.');
      return;
    }

    setSaving(true);
    try {
      const res = await client.post(`/api/orders/${order.id}/complete`, {
        receiver_name: receiverName.trim(),
        delivery_date: deliveryDate,
        notes: notes.trim()
      });

      if (file) {
        try {
          await uploadOrderAttachment(client, order.id, file, fileType);
        } catch (uploadErr) {
          toast.error('Order completed, but proof attachment upload failed — you can attach it from the attachments tab.');
        }
      }

      toast.success(res.data?.data?.message || `Order ${order.getmeds_order_id} marked as completed!`);
      if (onSuccess) onSuccess(res.data);
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error?.message || 'Could not complete this order');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Mark ${order.getmeds_order_id} as Completed`}>
      <form onSubmit={handleComplete} className="space-y-4">
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-xs text-emerald-900 flex items-start gap-2.5">
          <span className="text-base">✅</span>
          <div>
            <strong className="block font-semibold">Customer Received Goods</strong>
            <span>By confirming delivery, the order status will transition to <strong>Completed</strong>, crediting sales KPI and closing out delivery.</span>
          </div>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
            Delivered / Received Date *
          </label>
          <input
            type="date"
            required
            value={deliveryDate}
            onChange={(e) => setDeliveryDate(e.target.value)}
            className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide">
              Received By (Name / Staff)
            </label>
            {hasIntakeReceiver && (
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-teal-800 bg-teal-50 border border-teal-200 px-2 py-0.5 rounded">
                ⚡ Auto-filled from order receiver
              </span>
            )}
          </div>
          <input
            type="text"
            value={receiverName}
            onChange={(e) => setReceiverName(e.target.value)}
            placeholder="e.g. Nurse Brenda Gomez (SPMC Station 4)"
            className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
          />
          <p className="text-[11px] text-slate-500 mt-1">
            {hasIntakeReceiver
              ? 'Automatically pre-filled from the order receiver info. You can edit if physically received by another person on-site.'
              : 'Enter the person or hospital department who accepted the delivery.'}
          </p>
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
            Delivery Notes / Remarks (Optional)
          </label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={300}
            placeholder="e.g. Verified cold-chain storage intact upon turnover; signed DR received"
            className="w-full border border-slate-300 rounded px-3 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wide mb-1">
            Attach Signed Delivery Receipt / Proof (Optional)
          </label>
          <AttachFileField
            file={file}
            fileType={fileType}
            onFileChange={handleFileChange}
            onTypeChange={setFileType}
            disabled={saving}
          />
        </div>

        <div className="pt-3 border-t border-slate-200 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 rounded"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded hover:bg-emerald-700 flex items-center gap-1.5 disabled:opacity-50"
          >
            <span>✓</span> {saving ? 'Completing…' : 'Confirm Delivery & Complete Order'}
          </button>
        </div>
      </form>
    </Modal>
  );
};

export default CompleteOrderModal;
