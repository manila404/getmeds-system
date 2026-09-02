import React, { useEffect, useState } from 'react';
import OrderForm from '../../components/orders/OrderForm';
import client from '../../api/client';
import { AlertTriangle } from 'lucide-react';

/**
 * Sep 2, 2026: the Salesperson pre-check.
 *
 * Zoho has "Salesperson" as a MANDATORY field on every Sales Order in this
 * org and matches it by NAME — the MedRep's own "<division> | <display name>"
 * from sign-up. A name Zoho does not recognise means the Sales Order is
 * rejected, which without this banner is discovered only after the whole form
 * has been filled in and submitted.
 *
 * Deliberately here, in the page wrapper, rather than inside OrderForm: the
 * check has nothing to do with the form's own state and this keeps a 56KB
 * component out of the diff.
 *
 * The three outcomes are distinct on purpose. "Zoho says it does not exist"
 * is worth a warning; "we could not reach Zoho to ask" is not — treating
 * those the same would put a scary, wrong banner on the page every time the
 * network hiccuped.
 */
const SalespersonNotice = () => {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let cancelled = false;
    client
      .get('/api/orders/meta/salesperson', { skipAuthRedirect: true })
      .then(({ data }) => { if (!cancelled) setStatus(data.data); })
      .catch(() => { /* never block the order form on this */ });
    return () => { cancelled = true; };
  }, []);

  if (!status) return null;

  // No mapping at all — an account created before sign-up collected a
  // division (the seeded logins), or one an admin made directly.
  if (!status.salesperson) {
    return (
      <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex gap-3">
        <AlertTriangle size={18} className="text-amber-700 shrink-0 mt-0.5" />
        <div className="text-[13px] text-amber-900">
          <p className="font-semibold">This account has no Salesperson set.</p>
          <p className="mt-0.5">
            Zoho requires one on every Sales Order. Ask an administrator to add a Division and
            Display name to your account, or sign up with them.
          </p>
        </div>
      </div>
    );
  }

  // Zoho answered, and it has never heard of this name.
  if (status.checked && status.exists === false) {
    return (
      <div className="mb-5 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 flex gap-3">
        <AlertTriangle size={18} className="text-amber-700 shrink-0 mt-0.5" />
        <div className="text-[13px] text-amber-900">
          <p className="font-semibold">
            Zoho does not have a Salesperson called “{status.salesperson}”.
          </p>
          <p className="mt-0.5">
            Orders you submit will be rejected until someone adds that exact name in Zoho
            (Settings → Salespersons). Your order is still saved here and can be retried
            afterwards — nothing is lost.
          </p>
        </div>
      </div>
    );
  }

  // Verified, or unverifiable. Neither needs to interrupt anyone.
  return null;
};

const NewOrderPage = () => {
  return (
    <div className="max-w-4xl mx-auto">
      <SalespersonNotice />
      <OrderForm />
    </div>
  );
};

export default NewOrderPage;
