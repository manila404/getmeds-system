import React, { useState } from 'react';
import Modal from '../ui/Modal';
import { StockAnnouncementLine } from '../stock/StockAnnouncements';

/**
 * Sep 18, 2026: Dispatch has said an item in this order is out of stock or
 * running low. The line under the product search already showed that
 * quietly (a warning, never a block) — this is the moment it actually
 * matters, right before the order is raised: proceed, or go back and fix
 * the items. Proceeding needs a note, so Dispatch and Management see WHY
 * (a customer insisting, a substitute already agreed, whatever it is)
 * rather than just that it happened.
 */
const StockWarningModal = ({ flagged, onClose, onProceed, saving }) => {
  const [note, setNote] = useState('');

  return (
    <Modal isOpen onClose={onClose} title="Dispatch has flagged an item in this order">
      <div className="space-y-3">
        <p className="text-[13px] text-ink-secondary">
          Submitting this order anyway is fine — just say why, so Dispatch and Management aren't left guessing.
        </p>

        <div className="space-y-1.5">
          {flagged.map((a) => <StockAnnouncementLine key={a.id} a={a} />)}
        </div>

        <label className="block">
          <span className="block text-[11px] font-bold uppercase tracking-wide text-ink-secondary mb-1">
            Why are you proceeding? *
          </span>
          <textarea
            autoFocus
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
            placeholder="e.g. Customer is aware and wants to order regardless / substitute already agreed with them"
            className="w-full border border-slate-300 rounded px-2 py-1.5 text-sm focus:outline-none focus:border-getmeds-blue focus:ring-1 focus:ring-getmeds-blue"
          />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-slate-300 text-ink-secondary rounded hover:bg-surface"
          >
            ← Go back and edit items
          </button>
          <button
            type="button"
            disabled={saving || !note.trim()}
            onClick={() => onProceed(note.trim())}
            className="px-3 py-1.5 text-sm font-semibold bg-getmeds-blue text-white rounded hover:bg-getmeds-blue-dark disabled:opacity-50"
          >
            Proceed anyway
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default StockWarningModal;
