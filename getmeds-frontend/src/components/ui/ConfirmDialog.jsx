import React from 'react';
import Modal from './Modal';
import { AlertTriangle } from 'lucide-react';

const ConfirmDialog = ({ isOpen, onClose, onConfirm, title, message, confirmText = 'Confirm', cancelText = 'Cancel', variant = 'danger' }) => {
  const buttonColor = variant === 'danger' ? 'bg-red-600 hover:bg-red-700 focus:ring-red-500' : 'bg-getmeds-blue hover:bg-getmeds-blue-hover focus:ring-getmeds-blue';

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title}>
      <div className="flex items-start gap-3.5 pt-1">
        <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${variant === 'danger' ? 'bg-red-100 text-red-600' : 'bg-getmeds-blue/15 text-getmeds-blue'}`}>
          <AlertTriangle className="h-5 w-5" aria-hidden="true" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-ink-secondary leading-relaxed">{message}</p>
        </div>
      </div>
      <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-2 sm:gap-3">
        <button
          type="button"
          className="inline-flex w-full sm:w-auto justify-center rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-xs sm:text-sm font-semibold text-ink-primary shadow-xs hover:bg-surface transition-colors focus:outline-none"
          onClick={onClose}
        >
          {cancelText}
        </button>
        <button
          type="button"
          className={`inline-flex w-full sm:w-auto justify-center rounded-lg px-4 py-2.5 text-xs sm:text-sm font-semibold text-white shadow-sm transition-colors focus:outline-none ${buttonColor}`}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmText}
        </button>
      </div>
    </Modal>
  );
};

export default ConfirmDialog;
