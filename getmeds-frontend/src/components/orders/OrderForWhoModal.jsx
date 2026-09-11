import React, { useState } from 'react';
import { User, Users, ArrowRight } from 'lucide-react';

/**
 * Asked before the order form opens: whose order is this?
 *
 * Sep 11, 2026. A MedRep can now raise an order for a colleague — covering
 * someone on leave, out on call, or sharing a territory.
 *
 * It is a gate rather than a field inside the form for one reason: the answer
 * changes what the form MEANS. Division, Salesperson and the name the Sales
 * Order carries all come from whoever the order belongs to, so learning it
 * after the form is filled in means re-reading everything already entered
 * against a different owner. Asked first, the form is about one person from
 * the start.
 *
 * There is deliberately no default and no way past without answering. A
 * pre-selected "Myself" is the same as not asking — it would be accepted by
 * whoever is in a hurry, which is everyone, and the orders that needed to say
 * otherwise are exactly the ones that would not.
 *
 * Sep 11, 2026: it asks the QUESTION and nothing else. Choosing WHICH
 * colleague happens on the form, in a searchable picker over this system's
 * accounts — deliberately separate from the form's Salesperson field, which is
 * a Zoho list and a different thing entirely. Putting both in one dropdown
 * invited reading a Zoho Salesperson as an account, and they do not
 * correspond one to one.
 */
const OrderForWhoModal = ({ currentUser, onChoose }) => {
  const [mode, setMode] = useState(null);
  const canContinue = mode !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg">
        <div className="px-5 py-4 border-b border-slate-200">
          <h2 className="text-lg font-bold text-ink-primary">Who is this order for?</h2>
          <p className="text-xs text-ink-secondary mt-0.5">
            The order is attributed to this person, and their Zoho Salesperson is the one sent on
            the Sales Order.
          </p>
        </div>

        <div className="px-5 py-4 space-y-3">
          <button
            type="button"
            onClick={() => setMode('self')}
            className={`w-full text-left px-4 py-3 rounded-lg border flex items-start gap-3 transition-colors ${
              mode === 'self'
                ? 'border-getmeds-blue bg-getmeds-blue/5'
                : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <User className={`w-5 h-5 mt-0.5 shrink-0 ${mode === 'self' ? 'text-getmeds-blue' : 'text-ink-secondary'}`} />
            <span>
              <span className="block text-sm font-semibold text-ink-primary">Myself</span>
              <span className="block text-[12px] text-ink-secondary mt-0.5">
                {currentUser?.salesperson
                  ? `Sent to Zoho as “${currentUser.salesperson}”.`
                  : 'Your own account.'}
              </span>
            </span>
          </button>

          <button
            type="button"
            onClick={() => setMode('other')}
            className={`w-full text-left px-4 py-3 rounded-lg border flex items-start gap-3 transition-colors ${
              mode === 'other'
                ? 'border-getmeds-blue bg-getmeds-blue/5'
                : 'border-slate-200 hover:border-slate-300'
            }`}
          >
            <Users className={`w-5 h-5 mt-0.5 shrink-0 ${mode === 'other' ? 'text-getmeds-blue' : 'text-ink-secondary'}`} />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink-primary">Another MedRep</span>
              <span className="block text-[12px] text-ink-secondary mt-0.5">
                Covering for a colleague. You will choose which one on the form; the order belongs
                to them, and the trail still records that you raised it.
              </span>
            </span>
          </button>

        </div>

        <div className="px-5 py-3 border-t border-slate-200 flex justify-end">
          <button
            type="button"
            disabled={!canContinue}
            onClick={() => onChoose(mode)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-getmeds-blue text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Continue
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default OrderForWhoModal;
