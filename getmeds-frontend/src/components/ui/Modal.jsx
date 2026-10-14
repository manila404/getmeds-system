import React from 'react';
import { X } from 'lucide-react';

const Modal = ({ isOpen, onClose, title, children }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-full items-end sm:items-center justify-center p-2 sm:p-4 text-center sm:block">
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs transition-opacity" onClick={onClose} aria-hidden="true" />
        <span className="hidden sm:inline-block sm:h-screen sm:align-middle" aria-hidden="true">&#8203;</span>
        
        <div className="relative inline-block w-full transform overflow-hidden rounded-2xl bg-white text-left align-bottom sm:align-middle shadow-2xl transition-all sm:my-8 sm:max-w-lg max-h-[90vh] flex flex-col">
          <div className="bg-white p-4 sm:p-6 flex flex-col max-h-[90vh] w-full">
            <div className="flex justify-between items-center pb-3 border-b border-slate-100 flex-shrink-0">
              <h3 className="text-base sm:text-lg font-bold text-ink-primary pr-2" id="modal-title">
                {title}
              </h3>
              <button
                type="button"
                onClick={onClose}
                className="p-1 rounded-lg text-slate-400 hover:text-ink-primary hover:bg-surface transition-colors shrink-0"
                aria-label="Close dialog"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-3 overflow-y-auto pr-0.5 flex-1 thin-scroll text-left">
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Modal;
